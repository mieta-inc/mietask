package main

// 返信の読み取りルールの回帰テスト。ルールを変えたらここに例を足す。
// 期待値は、Go 化する前の Python 版（task_sync.py）の出力と突き合わせて確かめたもの。

import (
	"reflect"
	"testing"
	"time"
)

func testMapping() *Obj {
	m := NewObj()
	for _, kv := range [][2]string{{"1", "t001"}, {"2", "t002"}, {"3", "t003"}, {"4", "t004"}, {"12", "t012"}, {"100", "t100"}} {
		m.Set(kv[0], kv[1])
	}
	return m
}

type parsed struct {
	done, stay []string
	memos      [][2]string
	unresolved []string
}

func parseOne(text string) parsed {
	rest, _ := splitAdds([]string{text})
	d, s, m, u := parseReplies(rest, testMapping())
	return parsed{d, s, m, u}
}

func TestParseReplies(t *testing.T) {
	cases := []struct {
		in   string
		want parsed
	}{
		// 完了
		{"1完了", parsed{done: []string{"t001"}}},
		{"1 完了", parsed{done: []string{"t001"}}},
		{"1番完了", parsed{done: []string{"t001"}}},
		{"1済", parsed{done: []string{"t001"}}},
		{"1 done", parsed{done: []string{"t001"}}},
		{"t091完了", parsed{done: []string{"t091"}}},
		{"1完了しました", parsed{done: []string{"t001"}}},
		{"2完了しました", parsed{done: []string{"t002"}}},
		{"1完了、2完了", parsed{done: []string{"t001", "t002"}}},
		// 未来の意思表明は完了にしない（メモとして残る）
		{"1完了します", parsed{memos: [][2]string{{"t001", "完了します"}}}},
		{"1完了予定", parsed{memos: [][2]string{{"t001", "完了予定"}}}},
		// 語中の数字は拾わない
		{"明日1完了", parsed{}},
		// ステイ
		{"2ステイ", parsed{stay: []string{"t002"}}},
		{"2ステイ 来週の会議で決める", parsed{stay: []string{"t002"}, memos: [][2]string{{"t002", "来週の会議で決める"}}}},
		{"2ステイ来週の会議で決める", parsed{stay: []string{"t002"}, memos: [][2]string{{"t002", "来週の会議で決める"}}}},
		// メモ（スペースはあってもなくてもよい）
		{"3 山田さんに電話済み", parsed{memos: [][2]string{{"t003", "山田さんに電話済み"}}}},
		{"3山田さんに電話済み", parsed{memos: [][2]string{{"t003", "山田さんに電話済み"}}}},
		{"12見積を送った", parsed{memos: [][2]string{{"t012", "見積を送った"}}}},
		{"4番山田さん待ち", parsed{memos: [][2]string{{"t004", "山田さん待ち"}}}},
		{"3. 資料送付済み", parsed{memos: [][2]string{{"t003", "資料送付済み"}}}},
		{"t003先方確認中", parsed{memos: [][2]string{{"t003", "先方確認中"}}}},
		{"3 資料は完了、あと承認待ち", parsed{memos: [][2]string{{"t003", "資料は完了、あと承認待ち"}}}},
		// 数や日付は番号指定とみなさない
		{"3日後に連絡する", parsed{}},
		{"2つ質問です", parsed{}},
		{"11/20に提出", parsed{}},
		{"3:00から会議", parsed{}},
		{"3件たまってる", parsed{}},
		{"3か月かかる", parsed{}},
		{"100人規模", parsed{}},
		// 一覧に無い番号は黙って捨てず、解決できなかったものとして返す
		{"99完了", parsed{unresolved: []string{"99完了"}}},
	}
	for _, c := range cases {
		got := parseOne(c.in)
		if !reflect.DeepEqual(norm(got), norm(c.want)) {
			t.Errorf("%q\n  got  %+v\n  want %+v", c.in, got, c.want)
		}
	}
}

func norm(p parsed) parsed {
	if len(p.done) == 0 {
		p.done = nil
	}
	if len(p.stay) == 0 {
		p.stay = nil
	}
	if len(p.memos) == 0 {
		p.memos = nil
	}
	if len(p.unresolved) == 0 {
		p.unresolved = nil
	}
	return p
}

func TestAddLines(t *testing.T) {
	today := time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC)
	cases := []struct{ in, title, due string }{
		{"追加 見積書を作る 11/20まで", "見積書を作る", "2026-11-20"},
		{"追加見積書を作る", "見積書を作る", ""},
		{"+ 資料 1/10", "資料", "2027-01-10"}, // 60日以上前になる日付は来年
		{"＋ 締め（12/31）", "締め", "2026-12-31"},
		{"タスク化: 13/40の件", "13/40の件", ""}, // 月日として成り立たないものはタイトルに残す
		{"追加 3完了の報告書", "3完了の報告書", ""},
	}
	for _, c := range cases {
		rest, adds := splitAdds([]string{c.in})
		if len(adds) != 1 {
			t.Fatalf("%q: 追加として拾われない (%v)", c.in, adds)
		}
		// 「追加」の行は完了・メモの読み取りから外す
		if d, s, m, _ := parseReplies(rest, testMapping()); len(d)+len(s)+len(m) != 0 {
			t.Errorf("%q: 追加の行が完了・メモとしても読まれた", c.in)
		}
		title, due := parseAdd(adds[0], today)
		if title != c.title || due != c.due {
			t.Errorf("%q: got (%q,%q) want (%q,%q)", c.in, title, due, c.title, c.due)
		}
	}
}

func TestSplitlinesLikePython(t *testing.T) {
	got := pySplitlines("a\r\nb\rc\n\nd\n")
	want := []string{"a", "b", "c", "", "d"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %q want %q", got, want)
	}
}
