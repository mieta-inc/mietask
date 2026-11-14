package main

// データの置き場所と、本人の識別子を一箇所で決める。
//
// プラグインは再インストールで中身が入れ替わる。だからデータをプラグインの中に置いてはいけない。
// タスクも設定もトークンもユーザーのホーム配下に置く。
//
//	データ   ~/.mietask/                     環境変数 MIETASK_HOME で上書き
//	トークン ~/.config/mietask/slack-token   環境変数 MIETASK_TOKEN_FILE で上書き
//
// トークンだけデータと別にしてあるのは、データ側を Google ドライブや iCloud に置く人がいるため。
// 同期フォルダにトークンを置かせない。

import (
	"os"
	"path/filepath"
	"strings"
)

type ConfigError struct{ msg string }

func (e *ConfigError) Error() string { return e.msg }

func userHome() string {
	h, err := os.UserHomeDir()
	if err != nil || h == "" {
		return "."
	}
	return h
}

func expandUser(p string) string {
	if p == "~" {
		return userHome()
	}
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		return filepath.Join(userHome(), p[2:])
	}
	return p
}

func homeDir() string {
	if env := os.Getenv("MIETASK_HOME"); env != "" {
		return expandUser(env)
	}
	return filepath.Join(userHome(), ".mietask")
}

func tokenFile() string {
	if env := os.Getenv("MIETASK_TOKEN_FILE"); env != "" {
		return expandUser(env)
	}
	return filepath.Join(userHome(), ".config", "mietask", "slack-token")
}

func dataDir() string       { return filepath.Join(homeDir(), "data") }
func configPath() string    { return filepath.Join(homeDir(), "config.json") }
func tasksPath() string     { return filepath.Join(dataDir(), "tasks.json") }
func statePath() string     { return filepath.Join(dataDir(), "state.json") }
func slackPostPath() string { return filepath.Join(homeDir(), "slack-post.json") }

// tmpDir は巡回の途中で書く一時ファイルの置き場所。/tmp は Windows に無いのでホーム配下にそろえる。
func tmpDir() (string, error) {
	d := filepath.Join(homeDir(), "tmp")
	return d, os.MkdirAll(d, 0o755)
}

func readJSONObj(path string) (*Obj, bool, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, false, nil
		}
		return nil, false, err
	}
	v, err := ParseJSON(b)
	if err != nil {
		return nil, true, err
	}
	o, ok := v.(*Obj)
	if !ok {
		return nil, true, &ConfigError{path + " のトップレベルがオブジェクトではありません"}
	}
	return o, true, nil
}

// loadConfig は config.json を読む。無ければセットアップへ誘導する。
func loadConfig() (*Obj, error) {
	p := configPath()
	o, exists, err := readJSONObj(p)
	if !exists && err == nil {
		return nil, &ConfigError{"設定がありません: " + p + "\n  Claude Code で /mietask:setup と打ってセットアップしてください。"}
	}
	if err != nil {
		return nil, &ConfigError{p + " のJSONが壊れています: " + err.Error()}
	}
	return o, nil
}

// ownerSlackID は本人のSlackユーザーID。「N完了」を本人の発言だけから拾うのに使う。
func ownerSlackID() string {
	c, err := loadConfig()
	if err != nil {
		return ""
	}
	return str(orObj(c.Val("owner")).Val("slack_user_id"))
}

// postChannel は投稿先チャンネルID。slack-post.json を正とし、config は予備。
func postChannel() string {
	if o, _, err := readJSONObj(slackPostPath()); err == nil && o != nil {
		if ch := pyStrIfTruthy(o.Val("channel")); ch != "" {
			return ch
		}
	}
	c, err := loadConfig()
	if err != nil {
		return ""
	}
	return pyStrIfTruthy(orObj(c.Val("slack")).Val("channel"))
}

func pyStrIfTruthy(v any) string {
	if truthy(v) {
		return pyStr(v)
	}
	return ""
}

func toSlash(p string) string { return filepath.ToSlash(p) }
