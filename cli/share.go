package main

// 管理者向けの、案件ごとの要約。
//
// 各自のミエタスクが毎朝、その日の一覧（Slack・メール・議事録・MTD から拾ったタスク）を「案件ごとの状態」に束ねて窓口に送る。
// 管理者のページ（ダッシュボード）は、これと MTD を合わせて案件ごとに並べる。
// 送るのは 案件名・状態・一言（いま何をしているか）・次の期限・残りの件数・超過の件数 だけ。
// タスクの題名、メールや DM の文面、人の名前は入れない
// （作るのは本人の手元の Claude。ここでは形と、リンク・メンション・メールアドレスが無いことを確かめる）。
// 管理者に届くのと同じものを、本人のチャンネルにも出す（何が上に見えているかを本人が知っているように）。
//
// 案件の名前が人によってゆれないよう、束ねる前に `mietask share hints` で手がかり（本人の MTD の案件名と、
// 同じチームの人が最近使った案件名）を受け取り、同じ案件ならその名前を使う。

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

type shareItem struct {
	Name     string `json:"name"`
	State    string `json:"state"`
	Due      string `json:"due,omitempty"`
	Note     string `json:"note,omitempty"`      // いま何をしているかの一言（題名・人の名前は入れない）
	Detail   string `json:"detail,omitempty"`    // 詳細（2〜3行。持ち案件の台帳から）
	Role     string `json:"role,omitempty"`      // 関わり方（リード・担当・手伝い など）
	LastSeen string `json:"last_seen,omitempty"` // 最後に動いた日（持ち案件の台帳から）
	Open     *int   `json:"open,omitempty"`      // まとまりの中で、まだ終わっていないタスクの数
	Overdue  *int   `json:"overdue,omitempty"`   // そのうち期限が過ぎているものの数
}

var shareStates = []string{"動いている", "相手待ち", "期限が過ぎたものあり", stateIdle}

const (
	shareMax      = 40
	shareNameMax  = 40
	shareCountMax = 999
	shareNoteMax  = 40
)

var (
	reShareBad = regexp.MustCompile(`(?i)[\r\n<>@]|https?:`)
	reYMD      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// loadShare は要約のファイル（{"items":[{"name","state","due"}]}）を読み、形を確かめる。
// 決まった項目のほかは読み捨てる（送らない）。
func loadShare(path string) ([]shareItem, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("要約のファイルが見つかりません: %s", path)
	}
	var doc struct {
		Items *[]map[string]any `json:"items"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("%s のJSONが壊れています: %v", path, err)
	}
	if doc.Items == nil {
		return nil, fmt.Errorf("%s に items がありません（案件が1つも無ければ空の配列にする）", path)
	}
	if len(*doc.Items) > shareMax {
		return nil, fmt.Errorf("要約は%d件までです（%d件あります）。案件をまとめてください", shareMax, len(*doc.Items))
	}
	out := make([]shareItem, 0, len(*doc.Items))
	for i, it := range *doc.Items {
		where := fmt.Sprintf("items[%d]", i)
		name, _ := it["name"].(string)
		name = strings.TrimSpace(name)
		state, _ := it["state"].(string)
		due, _ := it["due"].(string)
		note, _ := it["note"].(string)
		note = strings.TrimSpace(note)
		role, _ := it["role"].(string)
		role = strings.TrimSpace(role)
		last, _ := it["last_seen"].(string)
		detail, _ := it["detail"].(string)
		detail = strings.TrimSpace(detail)
		switch {
		case name == "":
			return nil, fmt.Errorf("%s の案件名が空です", where)
		case utf8.RuneCountInString(name) > shareNameMax:
			return nil, fmt.Errorf("%s の案件名が長すぎます（%d文字まで）: %s", where, shareNameMax, name)
		case reShareBad.MatchString(name):
			return nil, fmt.Errorf("%s の案件名に改行・リンク・メンション・メールアドレスは入れられません: %s", where, name)
		case !contains(shareStates, state):
			return nil, fmt.Errorf("%s の状態は %s のどれかです（%q になっています）", where, strings.Join(shareStates, "・"), state)
		case due != "" && !reYMD.MatchString(due):
			return nil, fmt.Errorf("%s の期限は yyyy-mm-dd で書きます（%q になっています）", where, due)
		case utf8.RuneCountInString(note) > shareNoteMax:
			return nil, fmt.Errorf("%s の一言が長すぎます（%d文字まで）: %s", where, shareNoteMax, note)
		case reShareBad.MatchString(note):
			return nil, fmt.Errorf("%s の一言に改行・リンク・メンション・メールアドレスは入れられません: %s", where, note)
		case utf8.RuneCountInString(role) > projectRoleMax || reShareBad.MatchString(role):
			return nil, fmt.Errorf("%s の関わり方は%d文字までで、改行・リンク・メンションは入れられません: %s", where, projectRoleMax, role)
		case last != "" && !reYMD.MatchString(last):
			return nil, fmt.Errorf("%s の最後に動いた日は yyyy-mm-dd で書きます（%q になっています）", where, last)
		}
		if err := checkProjectText(where, "詳細", detail, projectDetail); err != nil {
			return nil, err
		}
		open, err := shareCount(it, "open", where+" の残りの件数（open）")
		if err != nil {
			return nil, err
		}
		overdue, err := shareCount(it, "overdue", where+" の超過の件数（overdue）")
		if err != nil {
			return nil, err
		}
		if open != nil && overdue != nil && *overdue > *open {
			return nil, fmt.Errorf("%s の超過の件数（%d）が残りの件数（%d）より多くなっています", where, *overdue, *open)
		}
		out = append(out, shareItem{Name: name, State: state, Due: due, Note: note, Detail: detail, Role: role, LastSeen: last, Open: open, Overdue: overdue})
	}
	return out, nil
}

// shareCount は件数（0〜999の整数）を読む。書かれていなければ nil。
func shareCount(it map[string]any, key, label string) (*int, error) {
	v, ok := it[key]
	if !ok || v == nil {
		return nil, nil
	}
	f, ok := v.(float64)
	if !ok || f < 0 || f > shareCountMax || f != float64(int(f)) {
		return nil, fmt.Errorf("%s は0〜%dの整数で書きます（%v になっています）", label, shareCountMax, v)
	}
	n := int(f)
	return &n, nil
}

// countLabel は「残り5件（うち超過2件）」。件数が無ければ空。
func countLabel(it shareItem) string {
	if it.Open == nil {
		return ""
	}
	s := fmt.Sprintf("残り%d件", *it.Open)
	if it.Overdue != nil && *it.Overdue > 0 {
		s += fmt.Sprintf("（うち超過%d件）", *it.Overdue)
	}
	return s
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func shortDate(ymd string) string {
	p := strings.Split(ymd, "-")
	if len(p) != 3 {
		return ymd
	}
	m, _ := strconv.Atoi(p[1])
	d, _ := strconv.Atoi(p[2])
	return fmt.Sprintf("%d/%d", m, d)
}

// sharePreview は本人のチャンネルに出す「管理者に届く内容」。
func sharePreview(items []shareItem) string {
	lines := []string{":eyes: *管理者に届く内容*（管理者のページに、持っている案件と、それぞれのいまの状態の一言が出ます。タスクの題名・メールやDMの中身は届きません）"}
	if len(items) == 0 {
		lines = append(lines, "• 案件なし")
	}
	for _, it := range items {
		l := "• " + it.Name
		if it.Role != "" {
			l += "（" + it.Role + "）"
		}
		l += " — " + it.State

		if c := countLabel(it); c != "" {
			l += "・" + c
		}
		if it.Due != "" {
			l += "（次の期限 " + shortDate(it.Due) + "）"
		}
		if it.Note != "" {
			l += "：" + it.Note
		}
		if it.LastSeen != "" && it.LastSeen != ymd(todayJST()) {
			l += "（最後に動いた " + shortDate(it.LastSeen) + "）"
		}
		if it.Detail != "" {
			l += "\n　　" + it.Detail
		}

		lines = append(lines, l)
	}
	return strings.Join(lines, "\n")
}

// sendShare は要約を窓口に送る。管理台帳を使っていなければ何もしない。
func sendShare(items []shareItem, dryRun bool) error {
	if dryRun {
		fmt.Printf("[dry-run] 管理者向けの要約（%d件）は送りません\n", len(items))
		return nil
	}
	k := relayKeyFromFile()
	if k == nil {
		fmt.Println("管理台帳を使っていないので、管理者向けの要約は送りません。")
		return nil
	}
	p := relayVersionParams()
	p["items"] = items
	if _, err := relayCall(k, "share", p); err != nil {
		return err
	}
	fmt.Printf("管理者向けの要約を送りました（%d件）\n", len(items))
	return nil
}

// cmdShareHints は案件の名前の手がかりを窓口から受け取って出す。
// 手がかりが取れなくても失敗にしない（手がかり無しで束ねればよいため）。理由は出す。
func cmdShareHints() error {
	k := relayKeyFromFile()
	if k == nil {
		fmt.Println("管理台帳を使っていないので、手がかりはありません。案件の名前は自分で決めてください。")
		return nil
	}
	out, err := relayCall(k, "hints", relayVersionParams())
	if err != nil {
		var re *RelayError
		if errors.As(err, &re) && re.Code == "unknown_action" {
			fmt.Println("窓口がまだ手がかりに対応していません。案件の名前は自分で決めてください。")
			return nil
		}
		return err
	}
	names := func(key string) []string {
		var xs []string
		raw, _ := out[key].([]any)
		for _, v := range raw {
			if s, ok := v.(string); ok && strings.TrimSpace(s) != "" {
				xs = append(xs, s)
			}
		}
		return xs
	}
	show := func(title string, xs []string) {
		fmt.Println(title)
		if len(xs) == 0 {
			fmt.Println("  （なし）")
		}
		for _, x := range xs {
			fmt.Println("  • " + x)
		}
	}
	show("MTDで自分が関わっている案件（同じ案件なら、この名前をそのまま使う）:", names("mtd"))
	if e, _ := out["mtd_error"].(string); e != "" {
		fmt.Println("  ⚠ MTDを読めませんでした: " + e)
	}
	show("同じチームの人が最近使った案件名（同じ案件なら、この名前に寄せる）:", names("team"))
	return nil
}

func cmdShare(path string, dryRun bool) error {

	if path == "" {
		return errors.New("--file が要ります。")
	}
	items, err := loadShare(path)
	if err != nil {
		return err
	}
	if dryRun {
		fmt.Println(sharePreview(items))
	}
	if err := sendShare(items, dryRun); err != nil {
		return err
	}
	if !dryRun {
		consumeInput(path)
	}
	return nil
}

// withSharePreview は投稿内容の子スレッドの最後に「管理者に届く内容」を足した一時ファイルを作り、そのパスを返す。
// 元のファイルは書き換えない。
func withSharePreview(payloadPath string, items []shareItem) (string, error) {
	if payloadPath == "" {
		return "", errors.New("--share は --payload と一緒に使ってください。")
	}
	raw, err := os.ReadFile(payloadPath)
	if err != nil {
		return "", &PostError{"payloadが見つかりません: " + payloadPath}
	}
	v, err := ParseJSON(raw)
	if err != nil {
		return "", &PostError{payloadPath + " のJSONが壊れています: " + err.Error()}
	}
	data, ok := v.(*Obj)
	if !ok {
		return "", &PostError{payloadPath + " のトップレベルはオブジェクトである必要があります。"}
	}
	replies, _ := getDefault(data, "replies", []any{}).([]any)
	data.Set("replies", append(append([]any{}, replies...), splitPreview(sharePreview(items))...))

	dir, err := tmpDir()
	if err != nil {
		return "", err
	}
	out := filepath.Join(dir, fmt.Sprintf("post-with-share-%d.json", os.Getpid()))
	if err := os.WriteFile(out, []byte(DumpJSON(data, 0)), 0o600); err != nil {
		return "", err
	}
	return out, nil
}

// cmdShareProjects は持ち案件の一覧だけを窓口に送り直す（投稿のあとで送れなかったとき）。
func cmdShareProjects(dryRun bool) error {
	b, err := loadAgedBook()
	if err != nil {
		return err
	}
	items := projectShareItems(b)
	if dryRun {
		fmt.Println(sharePreview(items))
	}
	return sendShare(items, dryRun)
}

// splitPreview は「管理者に届く内容」が1通に収まらないとき、行の切れ目で複数の子スレッドに分ける
// （詳細を書くと案件が多い人は Slack の1通の上限を超えるため）。
func splitPreview(text string) []any {
	const limit = 3500
	var out []any
	cur := ""
	for _, line := range strings.Split(text, "\n") {
		// 詳細の行（全角の字下げで始まる）は、その案件の行と切り離さない
		if cur != "" && utf8.RuneCountInString(cur)+utf8.RuneCountInString(line)+1 > limit && !strings.HasPrefix(line, "　　") {
			out = append(out, cur)
			cur = ":eyes: *管理者に届く内容*（続き）"
		}
		if cur == "" {
			cur = line
		} else {
			cur += "\n" + line
		}
	}
	return append(out, cur)
}
