package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
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

// --projects：持ち案件の一覧を窓口に送る（題名・件数は送らない）。投稿には「管理者に届く内容」を足さない（ページの「自分」で見られる）
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
	if len(rs) != 1 || rs[0] != "子1" {
		t.Fatalf("投稿に管理者に届く内容を足している: %q\n%s", rs, out)
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

// 詳細：台帳に残り、書かなかった日は前のものが残る。「管理者に届く内容」が長くなれば子スレッドを分ける
func TestProjectDetail(t *testing.T) {
	setupHome(t)
	fakeToday(t, "2026-11-01")
	_, err := runUpdate(t, `{"touched":[{"name":"社内DX","role":"リード","note":"経費精算の見直し","detail":"申請から承認までの流れを図にし、手作業の残る3か所を自動化する案を作っている。来週の定例で方向を決める","state":"動いている"}]}`)
	must(t, err)
	_, err = runUpdate(t, `{"touched":[{"name":"社内DX","state":"相手待ち"}]}`)
	must(t, err)
	b, _ := loadBook()
	if !strings.HasPrefix(b.Projects[0].Detail, "申請から承認まで") {
		t.Fatalf("詳細が残っていない: %+v", b.Projects[0])
	}
	if _, err := runUpdate(t, `{"touched":[{"name":"x","state":"動いている","detail":"`+strings.Repeat("あ", 301)+`"}]}`); err == nil {
		t.Error("長すぎる詳細を受け付けた")
	}
	if _, err := runUpdate(t, `{"touched":[{"name":"x","state":"動いている","detail":"<@U1> に確認"}]}`); err == nil {
		t.Error("メンションの入った詳細を受け付けた")
	}
	p := sharePreview(projectShareItems(b))
	if !strings.Contains(p, "• 社内DX（リード） — 相手待ち：経費精算の見直し\n　　申請から承認まで") {
		t.Errorf("管理者に届く内容に詳細が出ていない:\n%s", p)
	}
	// 40件・詳細つきでも、1通の上限を超えないように分ける（案件と詳細は切り離さない）
	var items []shareItem
	for i := 0; i < 40; i++ {
		items = append(items, shareItem{Name: fmt.Sprintf("案件%02d", i), State: "動いている", Note: strings.Repeat("い", 40), Detail: strings.Repeat("う", 300)})
	}
	parts := splitPreview(sharePreview(items))
	if len(parts) < 2 {
		t.Fatalf("分けていない: %d通", len(parts))
	}
	for i, x := range parts {
		s := x.(string)
		if utf8.RuneCountInString(s) > 3900 {
			t.Errorf("%d通目が長すぎる: %d文字", i, utf8.RuneCountInString(s))
		}
		if strings.HasPrefix(strings.SplitN(s, "\n", 2)[1], "　　") {
			t.Errorf("%d通目が詳細の行から始まっている", i)
		}
	}
}

// 段階と次の節目：書いた日に入れ替わり、書かなければ前のものが残る。形の違うものは止まる
func TestProjectStageAndMilestone(t *testing.T) {
	setupHome(t)
	fakeToday(t, "2026-11-17")
	_, err := runUpdate(t, `{"touched":[{"name":"契約DB","state":"動いている","stage":"進行中","next":"項目を固める打合せ","next_date":"2026-11-25"}]}`)
	must(t, err)
	_, err = runUpdate(t, `{"touched":[{"name":"契約DB","state":"動いている","note":"レビュー中"}]}`)
	must(t, err)
	b, _ := loadBook()
	p := b.Projects[0]
	if p.Stage != "進行中" || p.Next != "項目を固める打合せ" || p.NextDate != "2026-11-25" {
		t.Fatalf("前の段階と節目が残っていない: %+v", p)
	}
	// 次の節目を書き直すと、日付ごと入れ替わる（日付の無い節目に移ったら、古い日付は消える）
	_, err = runUpdate(t, `{"touched":[{"name":"契約DB","state":"動いている","stage":"仕上げ","next":"操作手順を文書に残す"}]}`)
	must(t, err)
	b, _ = loadBook()
	if p = b.Projects[0]; p.Stage != "仕上げ" || p.NextDate != "" {
		t.Fatalf("節目が入れ替わっていない: %+v", p)
	}
	if !strings.Contains(sharePreview(projectShareItems(b)), "• 契約DB — 動いている・仕上げ：レビュー中\n　　次: 日付未定　操作手順を文書に残す") {
		t.Errorf("管理者に届く内容に段階と節目が出ていない:\n%s", sharePreview(projectShareItems(b)))
	}
	for name, body := range map[string]string{
		"段階が決まりの外": `{"touched":[{"name":"x","state":"動いている","stage":"完了"}]}`,
		"節目が長い":    `{"touched":[{"name":"x","state":"動いている","next":"` + strings.Repeat("あ", 31) + `"}]}`,
		"日付の形":     `{"touched":[{"name":"x","state":"動いている","next":"打合せ","next_date":"11/25"}]}`,
		"日付だけ":     `{"touched":[{"name":"x","state":"動いている","next_date":"2026-11-25"}]}`,
	} {
		if _, err := runUpdate(t, body); err == nil {
			t.Errorf("%s: 受け付けてしまった", name)
		}
	}
}

// 本人が外した案件は、巡回で拾われても90日は黙って戻らない。「また持った」と言われたときだけ戻す
func TestRemovedProjectStaysOut(t *testing.T) {
	setupHome(t)
	fakeToday(t, "2026-11-01")
	_, err := runUpdate(t, `{"touched":[{"name":"渋谷区WS","state":"動いている"},{"name":"社内DX","state":"動いている"}]}`)
	must(t, err)
	_, err = captureStdout(t, func() error { return runProjects([]string{"remove", "渋谷区WS"}) })
	must(t, err)

	// 翌日、巡回で関係するものを拾っても足さない（空白のゆれも同じ案件）
	fakeToday(t, "2026-11-02")
	out, err := runUpdate(t, `{"touched":[{"name":"渋谷区 WS","state":"動いている"},{"name":"社内DX","state":"動いている"}]}`)
	must(t, err)
	if !strings.Contains(out, "外した案件なので足しませんでした: 渋谷区 WS（11/1") || !strings.Contains(out, "持っている案件 1件") {
		t.Fatalf("外した案件が戻ってきた:\n%s", out)
	}
	if !strings.Contains(out, "本人が外した案件（90日は足しません）: 渋谷区WS") {
		t.Fatalf("外した案件が一覧の下に出ていない:\n%s", out)
	}

	// 「また持った」と言われたら restore と一緒に足す
	out, err = runUpdate(t, `{"restore":["渋谷区WS"],"touched":[{"name":"渋谷区WS","state":"動いている"}]}`)
	must(t, err)
	if !strings.Contains(out, "外した案件から戻しました: 渋谷区WS") || !strings.Contains(out, "足しました: 渋谷区WS") {
		t.Fatalf("戻せていない:\n%s", out)
	}
	b, _ := loadBook()
	if len(b.Removed) != 0 || len(b.Projects) != 2 {
		t.Fatalf("戻したあとの台帳: %+v", b)
	}

	// 6週間動きが無くて外れたものは覚えない（また動けばそのまま戻る）
	fakeToday(t, "2026-12-20")
	out, err = runUpdate(t, `{"touched":[{"name":"社内DX","state":"動いている"}]}`)
	must(t, err)
	if !strings.Contains(out, "足しました: 社内DX") {
		t.Fatalf("自然に外れた案件が戻らない:\n%s", out)
	}

	// 外してから90日たてば忘れる
	_, err = captureStdout(t, func() error { return runProjects([]string{"remove", "社内DX"}) })
	must(t, err)
	fakeToday(t, "2027-03-21")
	out, err = runUpdate(t, `{"touched":[{"name":"社内DX","state":"動いている"}]}`)
	must(t, err)
	if !strings.Contains(out, "足しました: 社内DX") {
		t.Fatalf("90日たっても忘れていない:\n%s", out)
	}
	b, _ = loadBook()
	if len(b.Removed) != 0 {
		t.Fatalf("忘れていない: %+v", b.Removed)
	}
}
