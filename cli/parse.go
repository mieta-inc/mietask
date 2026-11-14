package main

// Slackスレッドへの返信から、完了・ステイ・メモ・追加を読み取る。
//
// 書き方のルールは「番号（または「追加」）のあとに続けて書く。スペースはあってもなくてもよい」。
//
//	1完了        → done にする。翌日から出ない
//	2ステイ      → 明日もそのまま出す（相手待ち・保留中のものも翌朝は必ず出す）
//	3 メモ本文   → そのタスクにメモを残し、翌朝の一覧に「前回のメモ」として出す
//	2ステイ 来週の会議で決める  → ステイ＋メモ
//	追加 見積書を作る 11/20まで → 新しいタスクとして足す
//
// 正規表現は Python 版と同じ動き（先読み・バックトラック・Unicode の \s \d）が要るので、
// 標準の regexp（RE2）ではなく regexp2 を使う。ここのパターンを変えるときは parse_test.go に例を足すこと。

import (
	"time"
	"unicode"

	"github.com/dlclark/regexp2"
)

func mustRe(p string) *regexp2.Regexp { return regexp2.MustCompile(p, regexp2.None) }

// 「1完了」「t091 完了」「3 済」「2 done」などを拾う。番号だけ / taskId のどちらでも受ける。
//
// 直前は行頭か空白・句読点に限る。「明日1完了」のように数字が語中に続く場合を弾くため。
// 末尾の否定先読みは、未来の意思表明を完了と誤読しないためのもの:
//
//	「1完了させます」「2完了します」「3完了予定」は完了ではない。「1完了しました」「2完了した」は完了。
//
// （2026-11-12 追加。誤って done にすると本人が気づけないため、迷ったら拾わない側に倒す）
const reDoneSrc = `(?:^|[\s、,。])` +
	`(?<key>t\d{3,}|\d{1,3})` +
	`\s*(?:番)?\s*` +
	`(?<verb>完了|かんりょう|済み|済|おわり|終わり|done|DONE|Done)` +
	`(?!させ|したい|する|しない|せず|します|しとく|しておく|予定|次第|したら|すれば)`

// 「2ステイ」「t091 stay」。明日もそのまま出す、の意味（2026-11-14 河村さん）。
// 「継続」「そのまま」はメモの文中に普通に出てくるので拾わない。
const reStaySrc = `(?:^|[\s、,。])` +
	`(?<key>t\d{3,}|\d{1,3})` +
	`\s*(?:番)?\s*` +
	`(?<verb>ステイ|すてい|stay|STAY|Stay)`

// 番号で始まる行をメモとして拾う。番号のあとの空白はあってもなくてもよい（2026-11-14「書き方は統一」）。
// ただし番号の直後が数字・日付や時刻の記号・助数詞なら番号指定とみなさない。
// 「11/20に…」「3:00に…」「3件…」「2つ…」「3日後に…」をメモと取り違えないため。
const memoNotKey = `(?![\d/／:：.．時分秒日月年週件人名回個つ点本枚台社校部案次期限倍位割円万千%％〜~\-ヶヵ]` +
	`|か月|カ月|コマ)`

const reMemoLineSrc = `^\s*(?<key>t\d{3,}|\d{1,3})\s*(?:番)?` +
	`(?:\s+|[.．、,)）]\s*|[:：](?!\d)\s*|` + memoNotKey + `)` +
	`(?<rest>\S.*)$`

// 指定のあとに付く語尾。メモの判定から外す
const cmdTail = `(?:しました|しましたー|した|です|でした|ました|でーす|中|しています|してます)?`

var (
	reDone      = mustRe(reDoneSrc)
	reStay      = mustRe(reStaySrc)
	reMemoLine  = mustRe(reMemoLineSrc)
	reDoneTail  = mustRe(reDoneSrc + cmdTail)
	reStayTail  = mustRe(reStaySrc + cmdTail)
	reTaskID    = mustRe(`^t\d{3,}$`)
	reAdd       = mustRe(`^\s*(?:追加|タスク追加|タスク化|\+|＋)\s*[:：]?\s*(?<body>\S.*)$`)
	reAddDue    = mustRe(`[（(]?\s*(?<m>\d{1,2})\s*/\s*(?<d>\d{1,2})\s*(?:まで|〆|締切|締め切り)?\s*[）)]?`)
	reKeyPrefix = map[string]*regexp2.Regexp{}
)

// メモから落とす前後の記号
const memoStrip = " \t　、,。.．:：・-ー"

func group(m *regexp2.Match, name string) string {
	g := m.GroupByName(name)
	if g == nil || len(g.Captures) == 0 {
		return ""
	}
	return g.String()
}

func findAll(re *regexp2.Regexp, s string) []*regexp2.Match {
	var out []*regexp2.Match
	m, _ := re.FindStringMatch(s)
	for m != nil {
		out = append(out, m)
		m, _ = re.FindNextMatch(m)
	}
	return out
}

// matchAtStart は Python の re.match（先頭から一致するか）。
func matchAtStart(re *regexp2.Regexp, s string) *regexp2.Match {
	m, _ := re.FindStringMatch(s)
	if m != nil && m.Index == 0 {
		return m
	}
	return nil
}

func resolveKey(key string, mapping *Obj) string {
	if len(key) > 0 && key[0] == 't' {
		if ok, _ := reTaskID.MatchString(key); ok {
			return key
		}
		return ""
	}
	if v, ok := mapping.Get(key); ok {
		return pyStrIfTruthy(v)
	}
	return ""
}

func appendUnique(list []string, s string) []string {
	for _, x := range list {
		if x == s {
			return list
		}
	}
	return append(list, s)
}

// parseDone は返信から完了指定を拾う。解決できたIDと、できなかった生テキストを返す。
func parseDone(texts []string, mapping *Obj) (ids, unresolved []string) {
	known := map[string]bool{}
	for _, k := range mapping.Keys() {
		known[pyStr(mapping.Val(k))] = true
	}
	for _, text := range texts {
		for _, m := range findAll(reDone, text) {
			key := group(m, "key")
			tid := ""
			if key[0] == 't' {
				if ok, _ := reTaskID.MatchString(key); known[key] || ok {
					tid = key
				}
			} else if v, ok := mapping.Get(key); ok && truthy(v) {
				tid = pyStr(v)
			}
			if tid != "" {
				ids = appendUnique(ids, tid)
			} else {
				unresolved = append(unresolved, pyStrip(m.String()))
			}
		}
	}
	return ids, unresolved
}

// splitAdds は「追加 …」の行を抜き出す。残りの本文と、追加の中身を返す。
func splitAdds(texts []string) (rest, adds []string) {
	for _, text := range texts {
		var keep []string
		for _, line := range pySplitlines(text) {
			if m := matchAtStart(reAdd, line); m != nil {
				adds = append(adds, pyStrip(group(m, "body")))
			} else {
				keep = append(keep, line)
			}
		}
		rest = append(rest, joinLines(keep))
	}
	return rest, adds
}

// parseAdd は「見積書を作る 11/20まで」→ (タイトル, "2026-11-20")。期限が無ければ ""。
//
// 年は書かれないので補う。今日より60日以上前の日付になるなら来年とみなす（12月に「1/10」と書いた場合）。
// 月日として成り立たない数字（13/40 など）は期限として扱わず、タイトルに残す。
func parseAdd(body string, today time.Time) (string, string) {
	due := ""
	title := body
	m, _ := reAddDue.FindStringMatch(body)
	if m != nil {
		mon := atoiUnicode(group(m, "m"))
		day := atoiUnicode(group(m, "d"))
		if d, ok := makeDate(today.Year(), mon, day); ok {
			ok2 := true
			if d.Before(today.AddDate(0, 0, -60)) {
				d, ok2 = makeDate(today.Year()+1, mon, day)
			}
			if ok2 {
				due = d.Format("2006-01-02")
				r := []rune(body)
				title = pyStripChars(string(r[:m.Index])+string(r[m.Index+m.Length:]), memoStrip)
			}
		}
	}
	if title == "" {
		title = body
	}
	return pyStrip(title), due
}

func makeDate(y, mo, d int) (time.Time, bool) {
	if mo < 1 || mo > 12 || d < 1 {
		return time.Time{}, false
	}
	t := time.Date(y, time.Month(mo), d, 0, 0, 0, 0, time.UTC)
	if t.Month() != time.Month(mo) || t.Day() != d {
		return time.Time{}, false
	}
	return t, true
}

func atoiUnicode(s string) int {
	n := 0
	for _, r := range s {
		v := digitValue(r)
		if v < 0 {
			return 0
		}
		n = n*10 + v
	}
	return n
}

// digitValue は Unicode の10進数字の値（全角の１なども Python の int() と同じく読む）。
func digitValue(r rune) int {
	if r >= '0' && r <= '9' {
		return int(r - '0')
	}
	if !unicode.IsDigit(r) {
		return -1
	}
	// Unicode の Nd は 0〜9 が連続して並ぶ。ゼロを探して差を取る
	for z := r; z >= r-9; z-- {
		if !unicode.IsDigit(z - 1) {
			return int(r - z)
		}
	}
	return -1
}

// parseReplies は返信から 完了・ステイ・メモ を拾う。
//
// メモは1行ずつ見る。行から完了・ステイの指定を取り除いて、まだ文が残っていればメモ。
// 「1完了、2完了」は何も残らないのでメモにならない。
func parseReplies(texts []string, mapping *Obj) (doneIDs, stayIDs []string, memos [][2]string, unresolved []string) {
	doneIDs, unresolved = parseDone(texts, mapping)

	for _, text := range texts {
		for _, m := range findAll(reStay, text) {
			if tid := resolveKey(group(m, "key"), mapping); tid != "" {
				stayIDs = appendUnique(stayIDs, tid)
			} else {
				unresolved = append(unresolved, pyStrip(m.String()))
			}
		}

		for _, line := range pySplitlines(text) {
			// 「3 メモ」の形か、「4ステイ メモ」「1完了 メモ」のように指定で始まる形
			var key string
			if lm := matchAtStart(reMemoLine, line); lm != nil {
				key = group(lm, "key")
			} else if h := matchAtStart(reStay, line); h != nil {
				key = group(h, "key")
			} else if h := matchAtStart(reDone, line); h != nil {
				key = group(h, "key")
			} else {
				continue
			}
			// 完了・ステイの指定を行から抜く。「完了しました」「ステイです」の語尾もいっしょに抜く
			rest := line
			for _, rx := range []*regexp2.Regexp{reDoneTail, reStayTail} {
				rest, _ = rx.Replace(rest, " ", -1, -1)
			}
			rest = pyStrip(rest)
			// 先頭に番号だけ残っていれば外す（「3 山田さんに…」の 3）
			rest, _ = keyPrefixRe(key).Replace(rest, "", -1, 1)
			memo := pyStripChars(rest, memoStrip)
			if memo == "" {
				continue
			}
			if tid := resolveKey(key, mapping); tid != "" {
				memos = append(memos, [2]string{tid, memo})
			} else {
				unresolved = append(unresolved, pyStrip(line))
			}
		}
	}
	return doneIDs, stayIDs, memos, unresolved
}

func keyPrefixRe(key string) *regexp2.Regexp {
	if re, ok := reKeyPrefix[key]; ok {
		return re
	}
	re := mustRe(`^` + regexp2.Escape(key) + `\s*(?:番)?(?:[.．、,)）:：])?`)
	reKeyPrefix[key] = re
	return re
}
