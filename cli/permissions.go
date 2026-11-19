package main

// 許可の登録。
//
// 会社の設定で自動承認（Auto）モードが使えないと、毎朝の実行は確認画面で止まり、投稿が届かない。
// そこで、ミエタスクが使う操作だけを Claude Code の設定の permissions.allow に前もって入れる。
// 入れるのは足すだけで、ほかの許可・設定は消さない・並べ替えない。書き換える前に控えを取る。
//
// 入れるもの:
//   - ミエタスクの実行ファイル（版の番号は * にして、更新しても効くようにする）
//   - ミエタスクのデータ（~/.mietask）の読み書き
//   - ミエタスクのスキル
//   - コネクタの読み取りの道具（setup が実際に見つけた名前を --tools で渡す。読み取り以外は受け付けない）

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// readOnlyTools はコネクタの道具のうち、許可に入れてよい読み取りだけのもの（mcp__<id>__ のあとの名前）。
var readOnlyTools = map[string]bool{
	// Slack
	"slack_read_thread": true, "slack_read_channel": true, "slack_read_user_profile": true,
	"slack_search_public": true, "slack_search_public_and_private": true,
	"slack_search_channels": true, "slack_search_users": true,
	// Gmail
	"search_threads": true, "get_thread": true, "list_labels": true,
	// Googleカレンダー
	"list_events": true, "get_event": true, "list_calendars": true,
	// Googleドライブ
	"list_recent_files": true, "search_files": true, "get_file_metadata": true, "read_file_content": true,
}

// checkReadOnlyTool は --tools に渡された名前が、コネクタの読み取りの道具かを確かめる。
func checkReadOnlyTool(name string) error {
	if !strings.HasPrefix(name, "mcp__") {
		return fmt.Errorf("%s はコネクタの道具の名前ではありません（mcp__ で始まる名前を渡してください）", name)
	}
	i := strings.LastIndex(name, "__")
	if i <= len("mcp_") {
		return fmt.Errorf("%s はコネクタの道具の名前の形になっていません", name)
	}
	if !readOnlyTools[name[i+2:]] {
		return fmt.Errorf("%s は読み取りの道具ではないので、許可に入れません", name)
	}
	return nil
}

// binaryRules は実行ファイルを呼ぶ Bash の許可。プラグインのキャッシュにある版のフォルダは * にする。
// root はプラグインのフォルダ（…/mietask/<版>）。
func binaryRules(root string) []string {
	root = filepath.ToSlash(root)
	if i := strings.Index(root, "/plugins/cache/"); i >= 0 {
		root = filepath.ToSlash(filepath.Dir(root)) + "/*"
	}
	bin := root + "/bin/mietask"
	return []string{
		fmt.Sprintf(`Bash(bash "%s" *)`, bin),
		fmt.Sprintf(`Bash(bash %s *)`, bin),
	}
}

// dataRules はミエタスクのデータの読み書きの許可。既定の場所なら ~ で書く。
func dataRules() []string {
	h := homeDir()
	p := "~/.mietask"
	if filepath.Clean(h) != filepath.Join(userHome(), ".mietask") {
		// MIETASK_HOME で場所を変えているとき。絶対パスは // で始める（Claude Code の書き方）
		p = "//" + strings.TrimPrefix(filepath.ToSlash(h), "/")
	}
	return []string{fmt.Sprintf("Read(%s/**)", p), fmt.Sprintf("Edit(%s/**)", p)}
}

var skillRules = []string{"Skill(mietask:task-daily)", "Skill(mietask:task-check)"}

// pluginRoot は実行中の実行ファイルから、プラグインのフォルダ（bin の親）を求める。
func pluginRoot() (string, error) {
	if r := os.Getenv("CLAUDE_PLUGIN_ROOT"); r != "" {
		return r, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	return filepath.Dir(filepath.Dir(exe)), nil
}

// wantedRules は入れる許可の一覧（並び順どおりに足す）。
func wantedRules(root string, tools []string) ([]string, error) {
	rules := append([]string{}, binaryRules(root)...)
	rules = append(rules, dataRules()...)
	rules = append(rules, skillRules...)
	for _, t := range tools {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if err := checkReadOnlyTool(t); err != nil {
			return nil, err
		}
		rules = append(rules, t)
	}
	return rules, nil
}

// missingRules は設定の permissions.allow に無いものだけを返す。
func missingRules(s *Obj, want []string) ([]string, error) {
	have := map[string]bool{}
	perm := asObj(s.Val("permissions"))
	if s.Has("permissions") && perm == nil {
		return nil, errors.New("設定の permissions の形が想定と違うので触りません")
	}
	if perm != nil {
		if v, ok := perm.Get("allow"); ok {
			arr, isArr := v.([]any)
			if !isArr {
				return nil, errors.New("設定の permissions.allow の形が想定と違うので触りません")
			}
			for _, a := range arr {
				have[str(a)] = true
			}
		}
	}
	var out []string
	for _, r := range want {
		if !have[r] {
			out = append(out, r)
			have[r] = true
		}
	}
	return out, nil
}

// ensurePermissions は足りない許可を足し、どうしたかを返す。
func ensurePermissions(tools []string, dry bool) (string, error) {
	root, err := pluginRoot()
	if err != nil {
		return "", fmt.Errorf("実行ファイルの場所が分かりません: %v", err)
	}
	want, err := wantedRules(root, tools)
	if err != nil {
		return "", err
	}
	s, existed, err := readClaudeSettings()
	if err != nil {
		return "", err
	}
	add, err := missingRules(s, want)
	if err != nil {
		return "", err
	}
	if len(add) == 0 {
		return "すでに入っています", nil
	}
	if dry {
		return fmt.Sprintf("[dry-run] %d件を足します: %s", len(add), strings.Join(add, " / ")), nil
	}
	perm := s.SetDefaultObj("permissions")
	var arr []any
	if v, ok := perm.Get("allow"); ok {
		arr = v.([]any)
	}
	for _, r := range add {
		arr = append(arr, r)
	}
	perm.Set("allow", arr)
	if err := writeClaudeSettings(s, existed); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d件を足しました", len(add)), nil
}

// writeClaudeSettings は控えを取ってから、設定ファイルを置き換える。
func writeClaudeSettings(s *Obj, existed bool) error {
	p := claudeSettingsPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	if existed {
		raw, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if err := os.WriteFile(p+".bak-mietask", raw, 0o644); err != nil {
			return fmt.Errorf("控えを取れなかったので書き換えません: %v", err)
		}
	}
	tmp := p + ".tmp-mietask"
	if err := os.WriteFile(tmp, []byte(DumpJSON(s, 2)+"\n"), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func cmdPermissions(toolsArg string, dry bool) error {
	var tools []string
	if toolsArg != "" {
		tools = strings.Split(toolsArg, ",")
	}
	st, err := ensurePermissions(tools, dry)
	if err != nil {
		return err
	}
	fmt.Printf("許可: %s\n", st)
	return nil
}

// permissionsOK は毎朝の実行に要る許可（実行ファイル・データ・スキル）がそろっているかを返す。
// コネクタの道具は人によって名前が違うので、ここでは見ない。
func permissionsOK(s *Obj) (bool, error) {
	root, err := pluginRoot()
	if err != nil {
		return false, err
	}
	want, _ := wantedRules(root, nil)
	add, err := missingRules(s, want)
	if err != nil {
		return false, err
	}
	return len(add) == 0, nil
}
