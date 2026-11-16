package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadShareRejectsLeakyOrMalformed(t *testing.T) {
	dir := t.TempDir()
	cases := map[string]string{
		"items が無い": `{}`,
		"リンク":       `{"items":[{"name":"https://x.example の件","state":"動いている"}]}`,
		"メンション":     `{"items":[{"name":"<@U123>から","state":"動いている"}]}`,
		"メールアドレス":   `{"items":[{"name":"a@example.com","state":"動いている"}]}`,
		"改行":        `{"items":[{"name":"a\nb","state":"動いている"}]}`,
		"状態が決まりの外":  `{"items":[{"name":"ミエマス","state":"忙しい"}]}`,
		"期限の形":      `{"items":[{"name":"ミエマス","state":"動いている","due":"11/20"}]}`,
		"長すぎる案件名":   `{"items":[{"name":"` + strings.Repeat("あ", 41) + `","state":"動いている"}]}`,
		"空の案件名":     `{"items":[{"name":" ","state":"動いている"}]}`,
		"壊れたJSON":   `{"items":[`,
	}
	for name, body := range cases {
		p := filepath.Join(dir, "s.json")
		write(t, p, body)
		if _, err := loadShare(p); err == nil {
			t.Errorf("%s: 受け付けてしまった", name)
		}
	}
	many := make([]string, 13)
	for i := range many {
		many[i] = `{"name":"案件","state":"動いている"}`
	}
	p := filepath.Join(dir, "many.json")
	write(t, p, `{"items":[`+strings.Join(many, ",")+`]}`)
	if _, err := loadShare(p); err == nil {
		t.Error("13件を受け付けてしまった")
	}
	write(t, p, `{"items":[]}`)
	if items, err := loadShare(p); err != nil || len(items) != 0 {
		t.Errorf("空の配列（MTDのほかの案件なし）を受け付けない: %v %v", items, err)
	}
}

// --share：投稿の子スレッドの最後に「管理者に届く内容」が出て、同じ中身（案件名・状態・期限だけ）が窓口に届く
func TestPostWithShare(t *testing.T) {
	h := setupHome(t)
	f := newFakeRelay(t)
	useRelayKey(t, f, "s3cret")
	write(t, slackPostPath(), `{"channel": "COWN"}`)
	payload := filepath.Join(h, "p.json")
	write(t, payload, `{"parent": ":date: *11/17(火) 07:04*  :warning:超過1\n\n1. 秘密の題名", "replies": ["子1"]}`)
	share := filepath.Join(h, "share.json")
	write(t, share, `{"items":[{"name":"ミエマス（ポータル・MTD）","state":"動いている","due":"2026-11-20","title":"秘密の題名","source":"DM"},{"name":"社内DX","state":"相手待ち"}]}`)

	a, _ := parseArgs([]string{"--payload", payload, "--share", share}, "no-team")
	out, err := captureStdout(t, func() error { return runPost(a) })
	must(t, err)
	if len(f.posts) != 1 {
		t.Fatalf("投稿されていない: %s", out)
	}
	rs := f.posts[0]["replies"].([]any)
	want := ":eyes: *管理者に届く内容*（チームのまとめに、案件ごとの状態だけが出ます。タスクの題名・メールやDMの中身は届きません）\n" +
		"• ミエマス（ポータル・MTD） — 動いている（次の期限 11/20）\n• 社内DX — 相手待ち"
	if len(rs) != 2 || rs[0] != "子1" || rs[1] != want {
		t.Errorf("子スレッドの最後に管理者に届く内容が出ていない: %q", rs)
	}
	if len(f.shares) != 1 {
		t.Fatalf("要約が窓口に届いていない: %s", out)
	}
	allowed := map[string]bool{"id": true, "k": true, "action": true, "items": true, "version": true, "os": true}
	for k := range f.shares[0] {
		if !allowed[k] {
			t.Errorf("要約のほかに %q を送っている", k)
		}
	}
	sent, _ := json.Marshal(f.shares[0]["items"])
	var got []map[string]any
	must(t, json.Unmarshal(sent, &got))
	if len(got) != 2 || len(got[0]) != 3 || got[0]["name"] != "ミエマス（ポータル・MTD）" || got[0]["due"] != "2026-11-20" ||
		len(got[1]) != 2 || got[1]["state"] != "相手待ち" {
		t.Errorf("送った要約（案件名・状態・期限だけのはず）: %s", sent)
	}
	for _, p := range []string{payload, share} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("使い終わった %s が残っている", p)
		}
	}
	if left, _ := filepath.Glob(filepath.Join(filepath.Dir(payload), "..", "*", "post-with-share-*.json")); len(left) > 0 {
		t.Errorf("一時ファイルが残っている: %v", left)
	}
}

// 形の悪い要約なら投稿の前に止まる（投稿してから気づくと、やり直しで二重になる）
func TestPostWithBadShareStopsBeforePosting(t *testing.T) {
	h := setupHome(t)
	f := newFakeRelay(t)
	useRelayKey(t, f, "s3cret")
	write(t, slackPostPath(), `{"channel": "COWN"}`)
	payload := filepath.Join(h, "p.json")
	write(t, payload, `{"parent": "親", "replies": []}`)
	share := filepath.Join(h, "share.json")
	write(t, share, `{"items":[{"name":"<https://x|リンク>","state":"動いている"}]}`)
	a, _ := parseArgs([]string{"--payload", payload, "--share", share}, "no-team")
	if _, err := captureStdout(t, func() error { return runPost(a) }); err == nil {
		t.Fatal("止まらなかった")
	}
	if len(f.posts) != 0 {
		t.Error("形の悪い要約のまま投稿した")
	}
}

// 窓口が古くて要約を受け取れなくても、投稿は成功のまま。要約のファイルは残して送り直せるようにする
func TestPostWithShareOldRelay(t *testing.T) {
	h := setupHome(t)
	f := newFakeRelay(t)
	f.noShare = true
	useRelayKey(t, f, "s3cret")
	write(t, slackPostPath(), `{"channel": "COWN"}`)
	payload := filepath.Join(h, "p.json")
	write(t, payload, `{"parent": "親", "replies": []}`)
	share := filepath.Join(h, "share.json")
	write(t, share, `{"items":[]}`)
	a, _ := parseArgs([]string{"--payload", payload, "--share", share}, "no-team")
	if _, err := captureStdout(t, func() error { return runPost(a) }); err != nil {
		t.Fatalf("投稿は済んでいるのに失敗にした: %v", err)
	}
	if len(f.posts) != 1 {
		t.Fatal("投稿されていない")
	}
	if _, err := os.Stat(share); err != nil {
		t.Error("送れなかった要約のファイルを消した")
	}
}
