package main

// セットアップの中身を1回で済ませる。Claude がコネクタから本人の情報を集めて渡す。
//
//	mietask setup --slack-id U0... --email a.b@example.com --name "山田 太郎" [--workspace mietahq]
//
// 本人に質問しないで済むように、決められることはここで決める:
//   - 設定ファイルと台帳を作る（あるものは上書きしない）
//   - 投稿先チャンネルの名前をメールから決めて作り、本人を招待する
//   - まとめチャンネルは管理台帳から決める（ここでは何もしない。毎朝の投稿時に台帳を読む）

import (
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

//go:embed templates/*.json
var templates embed.FS

func readTemplate(name string) (*Obj, error) {
	b, err := templates.ReadFile("templates/" + name)
	if err != nil {
		return nil, err
	}
	v, err := ParseJSON(b)
	if err != nil {
		return nil, fmt.Errorf("テンプレート %s が壊れています: %w", name, err)
	}
	return orObj(v), nil
}

// writeIfMissing はファイルが無いときだけ書く。本人のタスクを消さないため、あるものは絶対に上書きしない。
func writeIfMissing(path string, o *Obj, dryRun bool) (bool, error) {
	if _, err := os.Stat(path); err == nil {
		return false, nil
	}
	if dryRun {
		return true, nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false, err
	}
	return true, os.WriteFile(path, []byte(DumpJSON(o, 2)+"\n"), 0o644)
}

// channelCandidates はメールから投稿先チャンネルの名前の候補を作る。
// 名字はメールの@より前を . で区切った最後の部分。同じ名字の人がいれば名前も付ける。
// 日本語のチャンネル名を受け付けないワークスペース向けに、英字の名前も用意する。
func channelCandidates(email string) []string {
	local := strings.ToLower(strings.SplitN(email, "@", 2)[0])
	local = strings.ReplaceAll(local, "_", "-")
	parts := strings.Split(local, ".")
	last := parts[len(parts)-1]
	full := last
	if len(parts) > 1 {
		full = parts[0] + "-" + last
	}
	out := []string{"ミエタスク-" + last}
	if full != last {
		out = append(out, "ミエタスク-"+full)
	}
	out = append(out, "mietask-"+last)
	if full != last {
		out = append(out, "mietask-"+full)
	}
	return out
}

func cmdSetup(a *args) error {
	slackID := strings.TrimSpace(a.get("slack-id"))
	email := strings.TrimSpace(a.get("email"))
	name := strings.TrimSpace(a.get("name"))
	workspace := strings.TrimSpace(strings.TrimSuffix(a.get("workspace"), ".slack.com"))
	calendar := strings.TrimSpace(a.get("calendar"))
	dry := a.flags["dry-run"]
	if slackID == "" || email == "" || name == "" {
		return errors.New("--slack-id・--email・--name が要ります（コネクタから取った本人の情報を渡す）。")
	}
	if calendar == "" {
		calendar = email
	}

	// 1. 設定と台帳
	cfg, err := readTemplate("config.json")
	if err != nil {
		return err
	}
	owner := cfg.SetDefaultObj("owner")
	owner.Set("name", name)
	owner.Set("email", email)
	owner.Set("slack_user_id", slackID)
	owner.Set("slack_workspace", workspace)
	owner.Set("calendar_id", calendar)
	if cal := asObj(cfg.Val("calendar")); cal != nil {
		cal.Set("primary", calendar)
	}
	if rn := asObj(orObj(cfg.Val("slack")).Val("reply_needed")); rn != nil {
		rn.Set("check_user_id", slackID)
	}
	// 別の人の設定が残っていたら、何も作らずに止める（他人の台帳に自分のタスクを混ぜない）
	if cur, err := loadConfig(); err == nil {
		if id := str(orObj(cur.Val("owner")).Val("slack_user_id")); id != "" && id != slackID {
			return fmt.Errorf("既存の設定は別の人（%s）のものです。止めます。%s を確かめてください", id, configPath())
		}
	}
	if wrote, err := writeIfMissing(configPath(), cfg, dry); err != nil {
		return err
	} else if wrote {
		fmt.Println("設定: 作りました")
	} else {
		fmt.Println("設定: すでにあるので、そのまま使います")
	}
	for _, f := range []string{"tasks.json", "state.json"} {
		t, err := readTemplate(f)
		if err != nil {
			return err
		}
		if _, err := writeIfMissing(filepath.Join(dataDir(), f), t, dry); err != nil {
			return err
		}
	}
	fmt.Println("台帳: OK")

	// 2. 鍵
	token, err := readToken("")
	if err != nil {
		return fmt.Errorf("鍵がまだ置かれていません。先に入力欄で鍵を貼ってください。\n%s", err)
	}
	fmt.Println("鍵: OK")

	// 3. 管理台帳
	reg, stale, rerr := fetchRegistry()
	if reg != nil {
		if stale {
			fmt.Printf("管理台帳: 読めませんでした（%s）。前回の内容で確かめます\n", rerr)
		}
		m := reg.member(slackID)
		switch {
		case m == nil:
			fmt.Println("管理台帳: 未登録です。管理者に登録を頼んでください（登録されるまで、まとめチャンネルには出ません）")
		case strings.TrimSpace(m.Status) == statusStopped:
			return errors.New("管理台帳でミエタスクの利用が停止されています。管理者に確認してください。")
		default:
			fmt.Printf("管理台帳: %s / 所属 %s\n", m.Name, strings.Join(m.Teams, ", "))
		}
	} else if rerr != nil {
		fmt.Printf("管理台帳: 読めませんでした（%s）。あとで「ミエタスクを診断して」で確かめてください\n", rerr)
	}

	// 4. 投稿先チャンネル
	post, err := slackPostConf()
	if err != nil {
		return err
	}
	if post == nil {
		if post, err = readTemplate("slack-post.json"); err != nil {
			return err
		}
	}
	channel := pyStrIfTruthy(post.Val("channel"))
	chName := pyStrIfTruthy(post.Val("channel_name"))
	if channel != "" {
		if dry {
			fmt.Printf("[dry-run] 既存の投稿先 %s に本人がいるか確かめます\n", channel)
		} else {
			msg, err := ensureMemberIn(token, channel, slackID)
			if err != nil {
				return err
			}
			fmt.Printf("投稿先: すでに設定済み（#%s / %s）。%s\n", chName, channel, msg)
		}
	} else {
		cands := channelCandidates(email)
		if n := strings.TrimSpace(a.get("channel-name")); n != "" {
			cands = []string{strings.TrimLeft(n, "#")}
		}
		if dry {
			fmt.Printf("[dry-run] 投稿先を次の順で作ります: %s\n", strings.Join(cands, " → "))
		} else {
			channel, chName, err = createOwnChannel(token, cands, slackID)
			if err != nil {
				return err
			}
		}
	}

	// 5. 投稿の設定
	post.Set("channel", channel)
	post.Set("channel_name", chName)
	if workspace != "" {
		post.Set("workspace", workspace)
	}
	if !dry {
		if err := os.WriteFile(slackPostPath(), []byte(DumpJSON(post, 2)+"\n"), 0o644); err != nil {
			return err
		}
	}
	fmt.Printf("channel: %s\n", channel)
	fmt.Printf("channel_name: %s\n", chName)
	return nil
}

// createOwnChannel は候補の名前を順に試して投稿先を作る。
// 同じ名前のチャンネルが本人のもの（前回のセットアップが途中で止まった等）なら、それを使う。
func createOwnChannel(token string, cands []string, owner string) (string, string, error) {
	var lastErr error
	for _, name := range cands {
		id, nm, err := createPrivateChannel(token, name)
		if err == nil {
			msg, err := ensureMemberIn(token, id, owner)
			if err != nil {
				return "", "", err
			}
			fmt.Printf("投稿先: #%s を作りました。%s\n", nm, msg)
			return id, nm, nil
		}
		lastErr = err
		switch {
		case strings.Contains(err.Error(), "name_taken"):
			// 本人がすでに入っているなら、前回作った本人のチャンネル
			if id, ferr := findPrivateChannel(token, name); ferr == nil {
				if who := channelMembers(token, id); who != nil && who[owner] {
					fmt.Printf("投稿先: #%s はすでに本人のものなので、それを使います\n", name)
					return id, name, nil
				}
			}
			fmt.Printf("投稿先: #%s は他の人が使っているので、別の名前にします\n", name)
		case strings.Contains(err.Error(), "invalid_name"):
			fmt.Printf("投稿先: #%s はこのワークスペースでは使えない名前なので、別の名前にします\n", name)
		default:
			return "", "", err
		}
	}
	return "", "", fmt.Errorf("投稿先チャンネルを作れませんでした。候補: %s\n%v", strings.Join(cands, ", "), lastErr)
}
