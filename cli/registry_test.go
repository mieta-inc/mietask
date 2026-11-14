package main

// 管理台帳との連携のテスト。Google の代わりに、テストの中で偽物の台帳サーバーを立てる。

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fakeRegistry(t *testing.T, reg Registry, beats *[]map[string]string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			var m map[string]string
			b, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(b, &m)
			if beats != nil {
				*beats = append(*beats, m)
			}
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		if r.URL.Query().Get("key") != "secret" {
			_, _ = w.Write([]byte(`{"ok":false,"error":"bad key"}`))
			return
		}
		b, _ := json.Marshal(struct {
			OK bool `json:"ok"`
			Registry
		}{true, reg})
		_, _ = w.Write(b)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func useKey(t *testing.T, k mietaskKey) {
	t.Helper()
	p := filepath.Join(t.TempDir(), "slack-token")
	must(t, os.WriteFile(p, []byte(encodeKey(k)), 0o600))
	t.Setenv("MIETASK_TOKEN_FILE", p)
	registryMemo.done = false
}

var sampleRegistry = Registry{
	Teams: []Team{
		{ID: "pm", Name: "PM", Channel: "CPM"},
		{ID: "pm1", Name: "PM1", Parent: "pm", Channel: "CPM1"},
		{ID: "pm2", Name: "PM2", Parent: "PM"},
		{ID: "pd", Name: "PD", Channel: "CPD"},
	},
	Members: []Member{
		{Name: "テスト", SlackID: "U1", Teams: []string{"pd", "pm1"}, Status: "有効"},
		{Name: "退職者", SlackID: "U9", Teams: []string{"pd"}, Status: "停止"},
	},
}

func TestKeyRoundTrip(t *testing.T) {
	k := mietaskKey{Slack: "xoxb-1-2", RegistryURL: "https://script.google.com/x/exec", RegistryKey: "s"}
	got, err := decodeKey(" " + encodeKey(k) + "\n")
	if err != nil || got != k {
		t.Fatalf("got %+v %v", got, err)
	}
	// 生の Botトークンもこれまでどおり読める
	if got, _ := decodeKey("xoxb-raw\n"); got.Slack != "xoxb-raw" || got.RegistryURL != "" {
		t.Errorf("raw token: %+v", got)
	}
	if _, err := decodeKey("mietask1.!!!"); err == nil {
		t.Error("壊れた鍵を受け付けた")
	}
}

func TestSubtree(t *testing.T) {
	got := sampleRegistry.subtree("PM")
	if !reflect.DeepEqual(got, []string{"pm", "pm1", "pm2"}) {
		t.Errorf("subtree = %v", got)
	}
	// 親子が循環していても止まる
	r := Registry{Teams: []Team{{ID: "a", Parent: "b"}, {ID: "b", Parent: "a"}}}
	if got := r.subtree("a"); len(got) != 2 {
		t.Errorf("循環: %v", got)
	}
}

func TestCheckActiveAndTeams(t *testing.T) {
	setupHome(t)
	srv := fakeRegistry(t, sampleRegistry, nil)
	useKey(t, mietaskKey{Slack: "xoxb-x", RegistryURL: srv.URL, RegistryKey: "secret"})

	if err := checkActive(); err != nil {
		t.Fatalf("有効な人が止められた: %v", err)
	}
	chans, name, err := teamChannels()
	must(t, err)
	if name != "テスト" || !reflect.DeepEqual(chans, [][2]string{{"pd", "CPD"}, {"pm1", "CPM1"}}) {
		t.Errorf("teams = %v / %s", chans, name)
	}

	// 停止にされた人は投稿しない
	write(t, configPath(), `{"owner": {"slack_user_id": "U9"}}`)
	registryMemo.done = false
	if err := checkActive(); err == nil || !strings.Contains(err.Error(), "停止") {
		t.Errorf("停止の人が止まらない: %v", err)
	}
}

func TestRegistryFallsBackToCache(t *testing.T) {
	setupHome(t)
	srv := fakeRegistry(t, sampleRegistry, nil)
	useKey(t, mietaskKey{Slack: "xoxb-x", RegistryURL: srv.URL, RegistryKey: "secret"})
	if _, _, err := fetchRegistry(); err != nil {
		t.Fatal(err)
	}
	srv.Close() // 台帳が読めない日
	registryMemo.done = false
	reg, stale, err := fetchRegistry()
	if reg == nil || !stale || err == nil {
		t.Fatalf("前回の内容に戻らない: reg=%v stale=%v err=%v", reg != nil, stale, err)
	}
	if reg.member("U1") == nil {
		t.Error("前回の内容が空")
	}
}

func TestWrongRegistryKey(t *testing.T) {
	setupHome(t)
	srv := fakeRegistry(t, sampleRegistry, nil)
	useKey(t, mietaskKey{Slack: "xoxb-x", RegistryURL: srv.URL, RegistryKey: "wrong"})
	if _, _, err := fetchRegistry(); err == nil || !strings.Contains(err.Error(), "bad key") {
		t.Errorf("合言葉違いが分からない: %v", err)
	}
}

func TestChannelCandidates(t *testing.T) {
	got := channelCandidates("Yasuhiko.Kawamura@mietaplus.com")
	want := []string{"ミエタスク-kawamura", "ミエタスク-yasuhiko-kawamura", "mietask-kawamura", "mietask-yasuhiko-kawamura"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v", got)
	}
	if got := channelCandidates("kai_zuka@x.jp"); !reflect.DeepEqual(got, []string{"ミエタスク-kai-zuka", "mietask-kai-zuka"}) {
		t.Errorf("got %v", got)
	}
}

// 通信エラーの文に台帳の合言葉（URL の key=）が出ないこと
func TestRegistryErrorHidesKey(t *testing.T) {
	setupHome(t)
	useKey(t, mietaskKey{Slack: "xoxb-x", RegistryURL: "http://127.0.0.1:1/", RegistryKey: "topsecret"})
	_, _, err := fetchRegistry()
	if err == nil || strings.Contains(err.Error(), "topsecret") {
		t.Errorf("合言葉がエラー文に出ている: %v", err)
	}
}
