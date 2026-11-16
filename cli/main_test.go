package main

import (
	"os"
	"testing"
)

// TestMain は、どのテストも本物の Claude Code の設定ファイル（~/.claude/settings.json）に
// 触れないようにする。setup は自動更新を入れるために設定ファイルを書き換えるため。
func TestMain(m *testing.M) {
	d, err := os.MkdirTemp("", "mietask-claude-config-")
	if err != nil {
		panic(err)
	}
	os.Setenv("CLAUDE_CONFIG_DIR", d)
	code := m.Run()
	os.RemoveAll(d)
	os.Exit(code)
}
