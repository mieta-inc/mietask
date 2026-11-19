package main

import (
	"os"
	"strings"
	"testing"
)

func usePluginRoot(t *testing.T, root string) {
	t.Helper()
	t.Setenv("CLAUDE_PLUGIN_ROOT", root)
}

// 版のフォルダは * にして、更新しても許可が効くようにする
func TestBinaryRulesWildcardVersion(t *testing.T) {
	got := binaryRules("/Users/a/.claude/plugins/cache/mieta-tools/mietask/0.17.7")
	want := `Bash(bash "/Users/a/.claude/plugins/cache/mieta-tools/mietask/*/bin/mietask" *)`
	if got[0] != want {
		t.Fatalf("got %q, want %q", got[0], want)
	}
	if !strings.HasPrefix(got[1], "Bash(bash /Users/a/") {
		t.Fatalf("引用符なしの形がありません: %q", got[1])
	}
	// キャッシュの外（手元のビルド）はそのまま
	if g := binaryRules("/dev/mietask/plugins/mietask")[0]; g != `Bash(bash "/dev/mietask/plugins/mietask/bin/mietask" *)` {
		t.Fatalf("got %q", g)
	}
}

// 読み取り以外の道具は入れない
func TestCheckReadOnlyTool(t *testing.T) {
	for _, ok := range []string{
		"mcp__a84ba3d1-79c2-42cd-9bd4-139d021d73b4__slack_read_thread",
		"mcp__d117c266-cb5b-478e-aa37-c3d8173fa837__search_threads",
		"mcp__claude_ai_Google_Calendar__list_events",
	} {
		if err := checkReadOnlyTool(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, ng := range []string{
		"mcp__a84ba3d1__slack_send_message",
		"mcp__x__create_draft",
		"Bash(rm *)",
		"slack_read_thread",
		"mcp__slack_read_thread",
	} {
		if err := checkReadOnlyTool(ng); err == nil {
			t.Errorf("%s が通ってしまいました", ng)
		}
	}
}

// 足すだけで、ほかの許可・設定は残し、並びも変えない。二度目は何もしない
func TestEnsurePermissionsKeepsOtherSettings(t *testing.T) {
	usePluginRoot(t, "/Users/a/.claude/plugins/cache/mieta-tools/mietask/0.17.7")
	t.Setenv("MIETASK_HOME", "")
	p := useClaudeConfigDir(t, `{
  "model": "opus[1m]",
  "permissions": {
    "allow": [
      "Bash(git status)",
      "Skill(mietask:task-daily)"
    ],
    "deny": [
      "Bash(rm -rf *)"
    ]
  }
}
`)
	tool := "mcp__a84ba3d1__slack_read_thread"
	st, err := ensurePermissions([]string{tool}, false)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(st, "足しました") {
		t.Fatalf("st=%q", st)
	}
	raw, _ := os.ReadFile(p)
	s := string(raw)
	for _, want := range []string{`"model": "opus[1m]"`, `"Bash(git status)"`, `"Bash(rm -rf *)"`, `"Read(~/.mietask/**)"`, `"Edit(~/.mietask/**)"`, tool,
		`mietask/*/bin/mietask`} {
		if !strings.Contains(s, want) {
			t.Errorf("%s がありません:\n%s", want, s)
		}
	}
	if strings.Index(s, "Bash(git status)") > strings.Index(s, "mietask/*/bin") {
		t.Error("もとの許可の並びが変わっています")
	}
	if strings.Count(s, "Skill(mietask:task-daily)") != 1 {
		t.Error("同じ許可が二重に入っています")
	}
	if _, err := os.Stat(p + ".bak-mietask"); err != nil {
		t.Error("控えがありません")
	}
	if st, _ := ensurePermissions([]string{tool}, false); st != "すでに入っています" {
		t.Fatalf("二度目: %q", st)
	}
	s2, _, _ := readClaudeSettings()
	if good, err := permissionsOK(s2); err != nil || !good {
		t.Fatalf("permissionsOK=%v err=%v", good, err)
	}
}

func TestEnsurePermissionsRefusesBadShapeAndWriteTools(t *testing.T) {
	usePluginRoot(t, "/x/plugins/cache/mieta-tools/mietask/1.0.0")
	p := useClaudeConfigDir(t, `{"permissions": {"allow": "Bash(*)"}}`)
	if _, err := ensurePermissions(nil, false); err == nil {
		t.Fatal("形の違う allow を書き換えてしまいました")
	}
	raw, _ := os.ReadFile(p)
	if string(raw) != `{"permissions": {"allow": "Bash(*)"}}` {
		t.Fatalf("触ってはいけないのに変わりました: %s", raw)
	}

	useClaudeConfigDir(t, "")
	if _, err := ensurePermissions([]string{"mcp__x__slack_send_message"}, false); err == nil {
		t.Fatal("書き込みの道具を受け付けてしまいました")
	}
}

func TestEnsurePermissionsDryRunAndMissingFile(t *testing.T) {
	usePluginRoot(t, "/x/plugins/cache/mieta-tools/mietask/1.0.0")
	p := useClaudeConfigDir(t, "")
	if st, _ := ensurePermissions(nil, true); !strings.Contains(st, "dry-run") {
		t.Fatalf("st=%q", st)
	}
	if _, err := os.Stat(p); err == nil {
		t.Fatal("dry-run なのにファイルができました")
	}
	if st, err := ensurePermissions(nil, false); err != nil || !strings.Contains(st, "足しました") {
		t.Fatalf("st=%q err=%v", st, err)
	}
}
