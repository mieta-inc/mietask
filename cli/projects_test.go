package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fakeToday(t *testing.T, ymd string) {
	t.Helper()
	t.Setenv("MIETASK_FAKE_NOW", ymd+"T07:00:00+09:00")
}

func runUpdate(t *testing.T, body string) (string, error) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "u.json")
	write(t, p, body)
	return captureStdout(t, func() error { return runProjects([]string{"update", "--file", p}) })
}

// 持ち案件の台帳：その日に動いた案件だけを更新し、動きの無い日が続けば決まりどおりに扱う
func TestProjectBookLifecycle(t *testing.T) {
	setupHome(t)
	fakeToday(t, "2026-11-01")
	out, err := runUpdate(t, `{"touched":[
		{"name":"渋谷区WS","role":"PM","note":"当日の進行案を先方に確認中","state":"相手待ち"},
		{"name":"社内DX","role":"リード","note":"経費精算の流れの見直し","state":"動いている"},
		{"name":"採用広報","state":"動いている"}]}`)
	must(t, err)
	if !strings.Contains(out, "持っている案件 3件") || !strings.Contains(out, "足しました: 渋谷区WS") {
		t.Fatalf("足していない:\n%s", out)
	}

	// 2週間後：社内DX だけ動いた（空白のゆれは同じ案件）。一言を書かなければ前の一言が残る
	fakeToday(t, "2026-11-15")
	_, err = runUpdate(t, `{"touched":[{"name":"社内 DX","state":"相手待ち"}]}`)
	must(t, err)
	b, _ := loadBook()
	if len(b.Projects) != 3 || b.Projects[1].LastSeen != "2026-11-15" || b.Projects[1].Note != "経費精算の流れの見直し" || b.Projects[1].State != "相手待ち" {
		t.Fatalf("更新のされ方: %+v", b.Projects)
	}

	// 3週間たつと「しばらく動きなし」、6週間で外れる
	fakeToday(t, "2026-11-23")
	items := projectShareItems(b)
	if items[0].Name != "社内DX" || items[2].State != stateIdle || items[1].State != stateIdle {
		t.Fatalf("3週間動きの無い案件が「しばらく動きなし」になっていない: %+v", items)
	}
	fakeToday(t, "2026-12-14") // 11/1 から6週間（42日）を過ぎた日
	out, err = captureStdout(t, func() error { return runProjects([]string{"list"}) })
	must(t, err)
	if !strings.Contains(out, "6週間動きが無かったので外しました: 渋谷区WS、採用広報") || !strings.Contains(out, "持っている案件 1件") {
		t.Fatalf("6週間で外れていない:\n%s", out)
	}

	// 本人が「終わった」と言ったら外す。名前を変えると、ある案件には1つにまとまる
	_, err = runUpdate(t, `{"touched":[{"name":"ミエタスク開発","state":"動いている"}],"rename":[{"from":"社内DX","to":"ミエタスク開発"}]}`)
	must(t, err)
	b, _ = loadBook()
	if len(b.Projects) != 1 || b.Projects[0].Name != "ミエタスク開発" || b.Projects[0].Since != "2026-11-01" {
		t.Fatalf("まとまっていない: %+v", b.Projects)
	}
	out, err = captureStdout(t, func() error { return runProjects([]string{"remove", "ミエタスク開発"}) })
	must(t, err)
	if !strings.Contains(out, "外しました: ミエタスク開発") || !strings.Contains(out, "持っている案件 0件") {
		t.Fatalf("外れていない:\n%s", out)
	}
}

// 形の違う更新は、台帳を何も変えずに止まる
func TestProjectUpdateRejectsMalformed(t *testing.T) {
	setupHome(t)
	fakeToday(t, "2026-11-01")
	_, err := runUpdate(t, `{"touched":[{"name":"残す","state":"動いている"}]}`)
	must(t, err)
	before, _ := os.ReadFile(projectsPath())
	for name, body := range map[string]string{
		"状態が決まりの外":    `{"touched":[{"name":"x","state":"忙しい"}]}`,
		"動きなしは付けられない": `{"touched":[{"name":"x","state":"しばらく動きなし"}]}`,
		"一言にリンク":      `{"touched":[{"name":"x","state":"動いている","note":"https://x.example"}]}`,
		"案件名が長い":      `{"touched":[{"name":"` + strings.Repeat("あ", 31) + `","state":"動いている"}]}`,
		"関わり方にメンション":  `{"touched":[{"name":"x","state":"動いている","role":"<@U1>"}]}`,
		"空の案件名":       `{"touched":[{"name":" ","state":"動いている"}]}`,
		"名前を変える先が無い":  `{"rename":[{"from":"残す"}]}`,
		"壊れたJSON":     `{"touched":[`,
	} {
		if _, err := runUpdate(t, body); err == nil {
			t.Errorf("%s: 受け付けてしまった", name)
		}
	}
	after, _ := os.ReadFile(projectsPath())
	if string(before) != string(after) {
		t.Error("形の違う更新で台帳が変わった")
	}
}

// --projects：持ち案件の一覧を「管理者に届く内容」に出し、同じものを窓口に送る（題名・件数は送らない）
func TestPostWithProjects(t *testing.T) {
	h := setupHome(t)
	f := newFakeRelay(t)
	useRelayKey(t, f, "s3cret")
	write(t, slackPostPath(), `{"channel": "COWN"}`)
	fakeToday(t, "2026-11-01")
	_, err := runUpdate(t, `{"touched":[{"name":"渋谷区WS","role":"PM","note":"当日の進行案を先方に確認中","state":"相手待ち"},{"name":"社内DX","state":"動いている"}]}`)
	must(t, err)
	fakeToday(t, "2026-11-25")
	_, err = runUpdate(t, `{"touched":[{"name":"渋谷区WS","state":"相手待ち"}]}`)
	must(t, err)
	payload := filepath.Join(h, "p.json")
	write(t, payload, `{"parent": "親", "replies": ["子1"]}`)
	a, _ := parseArgs([]string{"--payload", payload, "--projects"}, "no-team", "projects")
	out, err := captureStdout(t, func() error { return runPost(a) })
	must(t, err)
	rs := f.posts[0]["replies"].([]any)
	want := "• 渋谷区WS（PM） — 相手待ち：当日の進行案を先方に確認中\n• 社内DX — しばらく動きなし（最後に動いた 11/1）"
	if len(rs) != 2 || !strings.HasSuffix(rs[1].(string), want) {
		t.Fatalf("管理者に届く内容: %q\n%s", rs, out)
	}
	sent, _ := json.Marshal(f.shares[0]["items"])
	var got []map[string]any
	must(t, json.Unmarshal(sent, &got))
	if len(got) != 2 || got[0]["role"] != "PM" || got[0]["last_seen"] != "2026-11-25" || got[1]["state"] != stateIdle || got[1]["last_seen"] != "2026-11-01" {
		t.Errorf("送った一覧: %s", sent)
	}
	a, _ = parseArgs([]string{"--payload", payload, "--projects", "--share", "x.json"}, "no-team", "projects")
	if err := runPost(a); err == nil {
		t.Error("--projects と --share を一緒に受け付けた")
	}
}
