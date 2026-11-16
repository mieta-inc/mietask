package main

// 一人ずつの鍵（窓口経由）のテスト。偽物の窓口は Apps Script と同じく、POST を受けたら
// 結果を控えて 302 で別の URL へ転送し、そこへの GET で結果を返す。

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type fakeRelay struct {
	mu       sync.Mutex
	srv      *httptest.Server
	results  map[string][]byte
	seq      int
	posts    []map[string]any
	stopped  bool
	channels map[string]bool // 投稿してよいチャンネル
	setups   int
	statuses []map[string]any // 件数として届いたもの（送られた中身をそのまま控える）
	noStatus bool             // 件数の受け取りを知らない古い窓口のふり
	shares   []map[string]any // 要約として届いたもの（送られた中身をそのまま控える）
	noShare  bool             // 要約の受け取りを知らない古い窓口のふり
	noHints  bool             // 手がかりを知らない古い窓口のふり
	hints    []map[string]any // 手がかりを頼まれたときに送られた中身
}

func newFakeRelay(t *testing.T) *fakeRelay {
	f := &fakeRelay{results: map[string][]byte{}, channels: map[string]bool{"COWN": true, "CPD": true}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeRelay) handle(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/echo/") {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(f.results[strings.TrimPrefix(r.URL.Path, "/echo/")])
		return
	}
	var body map[string]any
	b, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(b, &body)
	out := f.respond(body)
	f.seq++
	id := fmt.Sprint(f.seq)
	f.results[id], _ = json.Marshal(out)
	http.Redirect(w, r, "/echo/"+id, http.StatusFound)
}

func (f *fakeRelay) respond(b map[string]any) map[string]any {
	if b["id"] != "U1" || b["k"] != "s3cret" {
		return map[string]any{"ok": false, "error": "bad_key", "message": "鍵が無効です（作り直されたか、無効にされています）。管理者に確認してください"}
	}
	if f.stopped {
		return map[string]any{"ok": false, "error": "stopped", "message": "ミエタスクの利用は管理台帳で停止されています。管理者に確認してください"}
	}
	switch b["action"] {
	case "me":
		return map[string]any{"ok": true,
			"me":    map[string]any{"name": "山田 太郎", "slack_id": "U1", "teams": []string{"pd", "pm1"}, "status": "有効", "channel": "COWN"},
			"teams": []any{map[string]any{"id": "pd", "name": "PD", "channel": "CPD"}, map[string]any{"id": "pm1", "name": "PM1", "channel": ""}},
			"managed": map[string]any{
				"teams":        []any{map[string]any{"id": "pm", "name": "PM"}, map[string]any{"id": "pm1", "name": "PM1", "parent": "pm"}, map[string]any{"id": "pd", "name": "PD"}},
				"members":      []any{map[string]any{"name": "A", "slack_id": "UA", "teams": []string{"pm1"}, "status": "有効", "last_run": "2026-11-16T07:00:00+09:00"}, map[string]any{"name": "B", "slack_id": "UB", "teams": []string{"pd"}, "status": "有効"}},
				"settings":     map[string]any{"notion_projects": "collection://p"},
				"system_admin": true, // 件数はシステム管理者にだけ返る
				"daily": []any{
					map[string]any{"date": "2026-11-17", "slack_id": "UA", "name": "A", "overdue": 1, "today": 2, "week": 3, "at": "2026-11-17T07:04:00+09:00"},
					map[string]any{"date": "2026-11-17", "slack_id": "UB", "name": "B", "overdue": 9, "today": 9, "week": 9, "at": "2026-11-17T07:05:00+09:00"},
				},
			},
			"settings": map[string]any{"workspace": "mietahq"}}
	case "setup":
		f.setups++
		return map[string]any{"ok": true, "channel": "COWN", "name": "ミエタスク-yamada", "message": "招待しました"}
	case "post":
		ch, _ := b["channel"].(string)
		if !f.channels[ch] {
			return map[string]any{"ok": false, "error": "forbidden_channel", "message": "この投稿先には投稿できません"}
		}
		f.posts = append(f.posts, b)
		return map[string]any{"ok": true, "ts": fmt.Sprintf("1700000000.%06d", len(f.posts))}
	case "status":
		if f.noStatus {
			break
		}
		f.statuses = append(f.statuses, b)
		return map[string]any{"ok": true}
	case "share":
		if f.noShare {
			break
		}
		f.shares = append(f.shares, b)
		return map[string]any{"ok": true}
	case "hints":
		if f.noHints {
			break
		}
		f.hints = append(f.hints, b)
		return map[string]any{"ok": true, "mtd": []any{"26順天高1ゼミ", "渋谷区WS"}, "team": []any{"社内DX"}, "mtd_error": ""}
	case "check":

		return map[string]any{"ok": true, "bot": "ok", "me": map[string]any{"name": "山田 太郎"},
			"teams":   []any{map[string]any{"id": "pd", "channel": "CPD"}},
			"channel": map[string]any{"id": "COWN", "name": "ミエタスク-yamada"}}
	}
	return map[string]any{"ok": false, "error": "unknown_action"}
}

func useRelayKey(t *testing.T, f *fakeRelay, secret string) {
	t.Helper()
	k, _ := json.Marshal(relayKey{URL: f.srv.URL + "/exec", ID: "U1", Secret: secret})
	p := filepath.Join(t.TempDir(), "slack-token")
	must(t, os.WriteFile(p, []byte(relayKeyPrefix+base64.RawURLEncoding.EncodeToString(k)+"\n"), 0o600))
	t.Setenv("MIETASK_TOKEN_FILE", p)
	relayMeMemo = nil
	registryMemo.done = false
}

func captureStdout(t *testing.T, fn func() error) (string, error) {
	t.Helper()
	old := os.Stdout
	r, w, _ := os.Pipe()
	os.Stdout = w
	err := fn()
	w.Close()
	os.Stdout = old
	b, _ := io.ReadAll(r)
	return string(b), err
}

func TestDecodeRelayKey(t *testing.T) {
	k, err := decodeRelayKey(" mietask2." + base64.RawURLEncoding.EncodeToString([]byte(`{"u":"https://x/exec","i":"U1","k":"s"}`)) + "\n")
	if err != nil || k == nil || k.ID != "U1" || k.URL != "https://x/exec" {
		t.Fatalf("got %+v %v", k, err)
	}
	if k, err := decodeRelayKey("xoxb-1"); k != nil || err != nil {
		t.Error("Botトークンを一人ずつの鍵と取り違えた")
	}
	if _, err := decodeRelayKey("mietask2.%%%"); err == nil {
		t.Error("壊れた鍵を受け付けた")
	}
	if _, err := decodeRelayKey("mietask2." + base64.RawURLEncoding.EncodeToString([]byte(`{"u":"x"}`))); err == nil {
		t.Error("中身の足りない鍵を受け付けた")
	}
}

func TestRelaySetupAndPost(t *testing.T) {
	h := setupHome(t)
	f := newFakeRelay(t)
	useRelayKey(t, f, "s3cret")
	_ = os.Remove(slackPostPath())

	a, _ := parseArgs([]string{"--slack-id", "U1", "--email", "taro.yamada@x.jp", "--name", "山田 太郎", "--workspace", "mietahq"})
	out, err := captureStdout(t, func() error { return cmdSetup(a) })
	must(t, err)
	if !strings.Contains(out, "channel: COWN") || f.setups != 1 {
		t.Fatalf("setup:\n%s", out)
	}
	if postChannel() != "COWN" {
		t.Errorf("slack-post.json に投稿先が書かれていない: %q", postChannel())
	}

	payload := filepath.Join(h, "p.json")
	write(t, payload, `{"parent": "親 ⚠", "replies": ["子1", "返信案\nx"]}`)
	out, err = captureStdout(t, func() error { return cmdPost(payload, "", "", false) })
	must(t, err)
	if !strings.Contains(out, "ts: 1700000000.000001") || !strings.Contains(out, "mietahq.slack.com") {
		t.Errorf("post:\n%s", out)
	}
	if got := f.posts[0]["replies"].([]any); len(got) != 2 {
		t.Errorf("子スレッドが窓口に渡っていない: %v", got)
	}

	// まとめ：まとめチャンネルのあるチーム（pd）にだけ、返信案を除いて出す
	_, err = captureStdout(t, func() error { return cmdPostTeam(payload, "", false) })
	must(t, err)
	last := f.posts[len(f.posts)-1]
	if last["channel"] != "CPD" || !strings.HasPrefix(last["parent"].(string), ":bust_in_silhouette: *山田 太郎*") {
		t.Errorf("まとめの投稿: %v", last)
	}
	if rs := last["replies"].([]any); len(rs) != 1 {
		t.Errorf("返信案がまとめに出ている: %v", rs)
	}
}

func TestRelayErrorsAreClear(t *testing.T) {
	h := setupHome(t)
	f := newFakeRelay(t)
	payload := filepath.Join(h, "p.json")
	write(t, payload, `{"parent": "親", "replies": []}`)

	useRelayKey(t, f, "wrong")
	if _, err := captureStdout(t, func() error { return cmdPost(payload, "COWN", "", false) }); err == nil || !strings.Contains(err.Error(), "鍵が無効") {
		t.Errorf("鍵違い: %v", err)
	}
	useRelayKey(t, f, "s3cret")
	f.stopped = true
	if _, err := captureStdout(t, func() error { return cmdPost(payload, "COWN", "", false) }); err == nil || !strings.Contains(err.Error(), "停止") {
		t.Errorf("停止: %v", err)
	}
	f.stopped = false
	if _, err := captureStdout(t, func() error { return cmdPost(payload, "CNOPE", "", false) }); err == nil || !strings.Contains(err.Error(), "投稿できません") {
		t.Errorf("許されない投稿先: %v", err)
	}
	// 管理の操作（Botトークンが要るもの）は、一人ずつの鍵では分かるエラーにする
	if _, err := readToken(""); err == nil || !strings.Contains(err.Error(), "メニュー") {
		t.Errorf("readToken: %v", err)
	}
	// 窓口の URL（鍵入り）をエラーに出さない
	k := relayKey{URL: "http://127.0.0.1:1/exec", ID: "U1", Secret: "topsecret"}
	if _, err := relayCall(&k, "me", nil); err == nil || strings.Contains(err.Error(), "127.0.0.1:1/exec") {
		t.Errorf("接続エラーに URL が出ている: %v", err)
	}
}

func TestRelayRegistryAndDoctor(t *testing.T) {
	setupHome(t)
	f := newFakeRelay(t)
	useRelayKey(t, f, "s3cret")
	out, err := captureStdout(t, func() error { return cmdRegistry("pm") })
	must(t, err)
	var reg Registry
	must(t, json.Unmarshal([]byte(out), &reg))
	if len(reg.Teams) != 2 || len(reg.Members) != 1 || reg.Members[0].SlackID != "UA" || reg.Members[0].LastRun == "" {
		t.Errorf("PM の絞り込み: %+v", reg)
	}
	out, _ = captureStdout(t, func() error {
		if code := cmdDoctor(); code != 0 {
			return fmt.Errorf("doctor code %d", code)
		}
		return nil
	})
	if !strings.Contains(out, "一人ずつの鍵") || !strings.Contains(out, "#ミエタスク-yamada") || strings.Contains(out, "❌") {
		t.Errorf("doctor:\n%s", out)
	}
}
