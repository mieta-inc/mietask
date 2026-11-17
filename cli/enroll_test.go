package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 確認コードの窓口のふり。合札は sha256 だけを受け取り、コードと合札がそろえば鍵を返す
type fakeEnroll struct {
	srv      *httptest.Server
	verifier string
	got      []map[string]any
	team     string
}

func newFakeEnroll(t *testing.T) *fakeEnroll {
	f := &fakeEnroll{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var b map[string]any
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &b)
		f.got = append(f.got, b)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(f.respond(b))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeEnroll) key() string {
	j, _ := json.Marshal(map[string]string{"u": f.srv.URL, "i": "U0NEW1", "k": "kk"})
	return relayKeyPrefix + base64.RawURLEncoding.EncodeToString(j)
}

func (f *fakeEnroll) respond(b map[string]any) map[string]any {
	switch b["action"] {
	case "enroll_start":
		f.verifier, _ = b["verifier"].(string)
		return map[string]any{"ok": true, "enroll_id": "E1", "expires_in": 600}
	case "enroll_claim":
		sum := sha256.Sum256([]byte(b["secret"].(string)))
		if hex.EncodeToString(sum[:]) != f.verifier || b["enroll_id"] != "E1" {
			return map[string]any{"ok": false, "error": "bad_request", "message": "別の PC"}
		}
		if b["code"] != "123456" {
			return map[string]any{"ok": false, "error": "bad_code", "message": "確認コードが違います（あと 4 回）"}
		}
		return map[string]any{"ok": true, "key": f.key(), "name": "新人 一郎", "registered": true}
	case "teams":
		return map[string]any{"ok": true, "teams": []any{map[string]any{"id": "pm1", "name": "PM1", "path": "PD › PM › PM1"}}, "mine": []string{}}
	case "join_team":
		f.team, _ = b["team"].(string)
		return map[string]any{"ok": true, "team": "pm1", "name": "PM1", "notified": []string{"管理 花子"}}
	}
	return map[string]any{"ok": false, "error": "unknown_action"}
}

func TestEnrollByCode(t *testing.T) {
	h := t.TempDir()
	t.Setenv("MIETASK_HOME", h)
	t.Setenv("MIETASK_TOKEN_FILE", filepath.Join(h, "token"))
	f := newFakeEnroll(t)
	t.Setenv("MIETASK_RELAY_URL", f.srv.URL)

	out, err := captureStdout(t, func() error { return runEnroll([]string{"start", "--slack-id", "u0new1", "--name", "新人 一郎", "--email", "ichiro@example.com"}) })
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "新人のMac") && !strings.Contains(out, "新人の") {
		t.Errorf("PC の呼び名が出ていない: %s", out)
	}
	start := f.got[0]
	if start["slack_id"] != "U0NEW1" || len(f.verifier) != 64 || start["secret"] != nil {
		t.Fatalf("申し込みの中身が違う（合札そのものを送っていないか）: %v", start)
	}
	st, err := os.Stat(enrollStatePath())
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("申し込みの控えが 0600 で残っていない: %v %v", st, err)
	}

	// 違うコードは控えを残したまま断る（打ち直せる）
	if _, err := captureStdout(t, func() error { return runEnroll([]string{"finish", "--code", "654321"}) }); err == nil || !strings.Contains(err.Error(), "あと 4 回") {
		t.Fatalf("違うコードを通した: %v", err)
	}
	if _, err := os.Stat(enrollStatePath()); err != nil {
		t.Fatal("違うコードで控えが消えた")
	}
	if err := runEnroll([]string{"finish", "--code", "12"}); err == nil {
		t.Fatal("6桁でないコードを送った")
	}

	// 正しいコード（全角や区切りが混じっていてもよい）で鍵を受け取り、表示せずに保存する
	out, err = captureStdout(t, func() error { return runEnroll([]string{"finish", "--code", "１２３-456"}) })
	if err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(tokenFile())
	if string(b) != f.key() {
		t.Fatalf("鍵が保存されていない: %q", b)
	}
	if fi, _ := os.Stat(tokenFile()); fi.Mode().Perm() != 0o600 {
		t.Errorf("鍵ファイルが 0600 でない: %v", fi.Mode())
	}
	if strings.Contains(out, "mietask2.") || strings.Contains(out, "kk") || !strings.Contains(out, "新人 一郎 さん専用") || !strings.Contains(out, "新しく登録") {
		t.Fatalf("鍵を表示したか、知らせが違う: %s", out)
	}
	if _, err := os.Stat(enrollStatePath()); !os.IsNotExist(err) {
		t.Fatal("受け取ったあとも控えが残っている")
	}

	// 鍵が入っていれば、申し込み直さない
	n := len(f.got)
	out, _ = captureStdout(t, func() error { return runEnroll([]string{"start", "--slack-id", "U0NEW1", "--name", "新人 一郎"}) })
	if len(f.got) != n || !strings.Contains(out, "すでに入っています") {
		t.Fatalf("鍵があるのに申し込んだ: %s", out)
	}

	// チームを選ぶ
	out, err = captureStdout(t, cmdTeams)
	if err != nil || !strings.Contains(out, "1. PD › PM › PM1\tpm1") || !strings.Contains(out, "2. わからない\tnone") {
		t.Fatalf("チームの一覧: %s %v", out, err)
	}
	out, err = captureStdout(t, func() error { return cmdJoinTeam("pm1") })
	if err != nil || f.team != "pm1" || !strings.Contains(out, "PM1 に入りました") || !strings.Contains(out, "管理 花子") {
		t.Fatalf("チームに入る: %s %v", out, err)
	}
	n = len(f.got)
	out, _ = captureStdout(t, func() error { return cmdJoinTeam("none") })
	if len(f.got) != n || !strings.Contains(out, "選ばずに始めます") {
		t.Fatalf("わからないで窓口に送った: %s", out)
	}
}

func TestEnrollExpired(t *testing.T) {
	h := t.TempDir()
	t.Setenv("MIETASK_HOME", h)
	if err := saveEnrollState(enrollState{URL: "http://127.0.0.1:1", SlackID: "U1", EnrollID: "E", Secret: "s", Expires: 1}); err != nil {
		t.Fatal(err)
	}
	if err := runEnroll([]string{"finish", "--code", "123456"}); err == nil || !strings.Contains(err.Error(), "期限") {
		t.Fatalf("期限切れを通した: %v", err)
	}
	if _, err := os.Stat(enrollStatePath()); !os.IsNotExist(err) {
		t.Fatal("期限切れの控えが残っている")
	}
}
