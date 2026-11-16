package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func useClaudeConfigDir(t *testing.T, content string) string {
	t.Helper()
	d := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", d)
	p := filepath.Join(d, "settings.json")
	if content != "" {
		must(t, os.WriteFile(p, []byte(content), 0o644))
	}
	return p
}

// 自動更新を入れても、ほかの設定（許可ルール・日本語・数値・並び順）は変えない
func TestEnsureAutoUpdateKeepsOtherSettings(t *testing.T) {
	orig := `{
  "model": "opus[1m]",
  "cleanupPeriodDays": 30,
  "extraKnownMarketplaces": {
    "mieta-tools": {
      "source": {
        "source": "git",
        "url": "https://github.com/mieta-inc/mietask.git"
      }
    }
  },
  "permissions": {
    "autoMode": {
      "allow": [
        "$defaults",
        "ミエタスクの投稿は本人の日報"
      ]
    }
  }
}
`
	p := useClaudeConfigDir(t, orig)
	st, err := ensureAutoUpdate(false)
	if err != nil || st != "入れました" {
		t.Fatalf("got %q, %v", st, err)
	}
	got, _ := os.ReadFile(p)
	want := strings.Replace(orig, `        "url": "https://github.com/mieta-inc/mietask.git"
      }
    }`, `        "url": "https://github.com/mieta-inc/mietask.git"
      },
      "autoUpdate": true
    }`, 1)
	if string(got) != want {
		t.Errorf("autoUpdate のほかが変わった:\n--- got\n%s\n--- want\n%s", got, want)
	}
	if bak, _ := os.ReadFile(p + ".bak-mietask"); string(bak) != orig {
		t.Errorf("書き換える前の控えが無い")
	}
	// 2回目は何もしない
	if st, _ := ensureAutoUpdate(false); st != "すでに入っています" {
		t.Errorf("2回目: %q", st)
	}
}

// マーケットプレイスの登録が無ければ、画面から追加したときと同じ形で足す
func TestEnsureAutoUpdateAddsEntry(t *testing.T) {
	p := useClaudeConfigDir(t, `{"theme": "light"}`)
	if _, err := ensureAutoUpdate(false); err != nil {
		t.Fatal(err)
	}
	s, _, _ := readClaudeSettings()
	if !autoUpdateOn(s) || s.Val("theme") != "light" {
		t.Errorf("足せていない: %s", DumpJSON(s, 0))
	}
	src := asObj(asObj(asObj(s.Val("extraKnownMarketplaces")).Val("mieta-tools")).Val("source"))
	if src == nil || src.Val("url") != marketplaceRepo {
		t.Errorf("source が無い: %s", DumpJSON(s, 0))
	}
	_ = p
}

// 設定ファイルが無ければ作る。壊れていれば触らない
func TestEnsureAutoUpdateMissingAndBroken(t *testing.T) {
	p := useClaudeConfigDir(t, "")
	if st, err := ensureAutoUpdate(false); err != nil || st != "入れました" {
		t.Fatalf("無いとき: %q %v", st, err)
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("作られていない: %v", err)
	}

	broken := `{"model": "opus",`
	p = useClaudeConfigDir(t, broken)
	if _, err := ensureAutoUpdate(false); err == nil {
		t.Fatal("壊れた設定ファイルを書き換えた")
	}
	if got, _ := os.ReadFile(p); string(got) != broken {
		t.Error("壊れた設定ファイルが変わった")
	}
}

// dry-run は書かない
func TestEnsureAutoUpdateDryRun(t *testing.T) {
	orig := `{"theme": "light"}`
	p := useClaudeConfigDir(t, orig)
	if st, _ := ensureAutoUpdate(true); !strings.Contains(st, "dry-run") {
		t.Errorf("got %q", st)
	}
	if got, _ := os.ReadFile(p); string(got) != orig {
		t.Error("dry-run なのに書き換えた")
	}
}

func TestMissedWeekdayRuns(t *testing.T) {
	jst := time.FixedZone("JST", 9*3600)
	at := func(s string) time.Time { tm, _ := time.ParseInLocation("2006-01-02 15:04", s, jst); return tm }
	cases := []struct {
		name      string
		last, now string
		want      int
	}{
		{"今朝の分がある", "2026-11-16 07:05", "2026-11-16 15:00", 0},
		{"金曜のあと、月曜の朝7時台はまだ数えない", "2026-11-13 07:05", "2026-11-16 08:00", 0},
		{"金曜のあと、月曜の9時を過ぎて無い", "2026-11-13 07:05", "2026-11-16 10:00", 1},
		{"木曜のあと、月曜の9時過ぎ（金・月が抜け）", "2026-11-12 07:05", "2026-11-16 10:00", 2},
		{"土日は数えない", "2026-11-13 07:05", "2026-11-15 20:00", 0},
		{"手で回した夜の分も数える", "2026-11-15 23:38", "2026-11-16 08:40", 0},
	}
	for _, c := range cases {
		if got := missedWeekdayRuns(at(c.last), at(c.now)); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}
