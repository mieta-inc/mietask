package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConsumeInputRemovesFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "task-replies.json")
	if err := os.WriteFile(p, []byte(`[{"user":"U1","text":"3完了"}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	consumeInput(p)
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatalf("使い終わったファイルが残っている: %v", err)
	}
}

func TestConsumeInputMissingOrEmptyIsQuiet(t *testing.T) {
	// 無いファイルや空のパスを渡しても落ちない（二度目の呼び出し・標準入力からの投稿）
	consumeInput(filepath.Join(t.TempDir(), "nothing.json"))
	consumeInput("")
}
