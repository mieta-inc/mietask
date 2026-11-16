package main

// 自動更新。
//
// 社内のマーケットプレイスは、既定では自動更新されない（自動なのは Anthropic 公式のものだけ）。
// 入れておかないと、直した版が各自に届かない。各自に設定ファイルを手で直してもらうのは確実でないので、
// セットアップのときに実行ファイルが入れる。触るのは、このプラグインのマーケットプレイスの
// autoUpdate だけ。ほかの設定（許可・モデルなど）には触らない。

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const (
	marketplaceName = "mieta-tools"
	marketplaceRepo = "https://github.com/mieta-inc/mietask.git"
)

// claudeSettingsPath は Claude Code の利用者ごとの設定ファイル。
func claudeSettingsPath() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return filepath.Join(expandUser(d), "settings.json")
	}
	return filepath.Join(userHome(), ".claude", "settings.json")
}

// readClaudeSettings は設定ファイルを読む。無ければ空、壊れていれば触らずにエラー。
func readClaudeSettings() (s *Obj, existed bool, err error) {
	p := claudeSettingsPath()
	raw, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		return NewObj(), false, nil
	}
	if err != nil {
		return nil, false, err
	}
	v, err := ParseJSON(raw)
	if err != nil {
		return nil, true, fmt.Errorf("%s が JSON として読めないので触りません: %v", toSlash(p), err)
	}
	o, ok := v.(*Obj)
	if !ok {
		return nil, true, fmt.Errorf("%s の形が想定と違うので触りません", toSlash(p))
	}
	return o, true, nil
}

func autoUpdateOn(s *Obj) bool {
	m := asObj(orObj(s.Val("extraKnownMarketplaces")).Val(marketplaceName))
	return m != nil && m.Val("autoUpdate") == true
}

// ensureAutoUpdate は自動更新を入れ、どうしたかを返す。書き換える前に控えを取る。
func ensureAutoUpdate(dry bool) (string, error) {
	s, existed, err := readClaudeSettings()
	if err != nil {
		return "", err
	}
	if autoUpdateOn(s) {
		return "すでに入っています", nil
	}
	if v, ok := s.Get("extraKnownMarketplaces"); ok && asObj(v) == nil {
		return "", errors.New("設定の extraKnownMarketplaces の形が想定と違うので触りません")
	}
	mk := s.SetDefaultObj("extraKnownMarketplaces")
	if v, ok := mk.Get(marketplaceName); ok && asObj(v) == nil {
		return "", fmt.Errorf("設定の %s の形が想定と違うので触りません", marketplaceName)
	}
	if dry {
		return "[dry-run] 入れます", nil
	}
	entry := asObj(mk.Val(marketplaceName))
	if entry == nil {
		// 画面からマーケットプレイスを追加すると入るものと同じ形にする
		src := NewObj()
		src.Set("source", "git")
		src.Set("url", marketplaceRepo)
		entry = NewObj()
		entry.Set("source", src)
		mk.Set(marketplaceName, entry)
	}
	entry.Set("autoUpdate", true)

	p := claudeSettingsPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return "", err
	}
	if existed {
		raw, err := os.ReadFile(p)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(p+".bak-mietask", raw, 0o644); err != nil {
			return "", fmt.Errorf("控えを取れなかったので書き換えません: %v", err)
		}
	}
	tmp := p + ".tmp-mietask"
	if err := os.WriteFile(tmp, []byte(DumpJSON(s, 2)+"\n"), 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return "入れました", nil
}

func cmdAutoUpdate(dry bool) error {
	st, err := ensureAutoUpdate(dry)
	if err != nil {
		return err
	}
	fmt.Printf("自動更新: %s\n", st)
	return nil
}
