package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseTeamCounts(t *testing.T) {
	cases := []struct {
		name   string
		parent string
		want   teamCounts
	}{
		{"全部ある", ":date: *11/16(月) 08:40*  :warning:超過5 / :red_circle:今日5 / :large_yellow_circle:今週23\n\n3. 見積書", teamCounts{5, 5, 23}},
		{"0件の区分は落ちている", ":date: *11/17(火) 07:04*  :large_yellow_circle:今週4", teamCounts{0, 0, 4}},
		{"1件もない", ":sparkles: 対応が必要なものはありません", teamCounts{}},
		// 2行目より下の「今日17:00」などを件数として拾わない
		{"見出しの語を拾わない", ":date: *11/16(月) 08:40*  :large_yellow_circle:今週2\n\n1. 今日17:00の定例に持っていく ← 超過3日", teamCounts{0, 0, 2}},
		{"空", "", teamCounts{}},
	}
	for _, c := range cases {
		if got := parseTeamCounts(c.parent); got != c.want {
			t.Errorf("%s: got %+v, want %+v", c.name, got, c.want)
		}
	}
}

// 管理者向けに送るのは件数だけ。題名・本文・返信案は一切送らない。
func TestSendTeamStatusSendsCountsOnly(t *testing.T) {
	f := newFakeRelay(t)
	useRelayKey(t, f, "s3cret")
	p := filepath.Join(t.TempDir(), "p.json")
	must(t, os.WriteFile(p, []byte(`{"parent": ":date: *11/17(火) 07:04*  :warning:超過5 / :red_circle:今日5 / :large_yellow_circle:今週23\n\n1. 秘密の案件の見積 ← DMで頼まれた件",
		"replies": ["返信案\n人事の件で相談"]}`), 0o644))

	out, _ := captureStdout(t, func() error { sendTeamStatus(p, false); return nil })
	if len(f.statuses) != 1 {
		t.Fatalf("件数が窓口に届いていない: %v / 出力: %s", f.statuses, out)
	}
	got := f.statuses[0]
	allowed := map[string]bool{"id": true, "k": true, "action": true, "counts": true, "version": true, "os": true}
	for k := range got {
		if !allowed[k] {
			t.Errorf("件数のほかに %q を送っている", k)
		}
	}
	c, _ := got["counts"].(map[string]any)
	if c["overdue"] != float64(5) || c["today"] != float64(5) || c["week"] != float64(23) {
		t.Errorf("件数が違う: %v", c)
	}
	sent, _ := json.Marshal(got)
	for _, leak := range []string{"秘密の案件", "DMで頼まれた件", "返信案", "人事の件"} {
		if strings.Contains(string(sent), leak) {
			t.Errorf("中身が窓口に送られている: %s", leak)
		}
	}
}

// 窓口が古く、件数の受け取りを知らなくても止めない（自分のチャンネルへの投稿は済んでいる）
func TestSendTeamStatusOldRelayDoesNotFail(t *testing.T) {
	f := newFakeRelay(t)
	f.noStatus = true
	useRelayKey(t, f, "s3cret")
	p := filepath.Join(t.TempDir(), "p.json")
	must(t, os.WriteFile(p, []byte(`{"parent": ":date: *11/17(火) 07:04*  :large_yellow_circle:今週2"}`), 0o644))
	sendTeamStatus(p, false) // 落ちなければよい
	if len(f.statuses) != 0 {
		t.Errorf("古い窓口なのに件数が受け取られている")
	}
}

// 管理者の画面：チームで絞ると、件数もそのチームの人の分だけになる
func TestRelayRegistryKeepsDailyOfFilteredMembers(t *testing.T) {
	f := newFakeRelay(t)
	useRelayKey(t, f, "s3cret")
	reg, err := relayRegistry(relayKeyFromFile(), "pm1")
	if err != nil {
		t.Fatal(err)
	}
	if len(reg.Daily) != 1 || reg.Daily[0].SlackID != "UA" || reg.Daily[0].Week != 3 {
		t.Errorf("pm1 の人の件数だけになっていない: %+v", reg.Daily)
	}
}
