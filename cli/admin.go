package main

// 管理者が使うコマンド。チームの追加、管理者の交代、退職者の片付け、導入状況の確認。
// 台帳（スプレッドシート）を書き換えたあとに、Slack 側の作業をここで済ませる。
//
//	mietask admin status [--team pm]               メンバーごとの状態と、最後に動いた日時
//	mietask admin create-team --id pm1             まとめチャンネルを作り、管理者を招待する
//	mietask admin invite-managers --id pm1         管理者を替えたあと、新しい管理者を招待する
//	mietask admin archive-member --slack U0...     停止にした人の投稿先をアーカイブする
//	mietask admin make-key --slack-token-file F --registry-url U --registry-key-prompt
//	                                               ミエタスクの鍵を作ってクリップボードに入れる（合言葉は入力欄で受け取る）

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
)

func runAdmin(rest []string) error {
	a, err := parseArgs(rest, "registry-key-prompt")
	if err != nil {
		return err
	}
	if len(a.pos) == 0 {
		return errors.New("admin のあとに status / create-team / invite-managers / archive-member / make-key のどれかが要ります。")
	}
	switch a.pos[0] {
	case "status":
		return adminStatus(a.get("team"))
	case "create-team":
		return adminCreateTeam(a.get("id"), a.get("channel-name"), a.flags["dry-run"])
	case "invite-managers":
		return adminInviteManagers(a.get("id"), a.flags["dry-run"])
	case "archive-member":
		return adminArchiveMember(a.get("slack"), a.flags["dry-run"])
	case "make-key":
		regKey := a.get("registry-key")
		if regKey == "" && a.flags["registry-key-prompt"] {
			if regKey, err = promptHidden("Apps Script の showKey で表示した合言葉を貼り付けて「OK」を押してください"); err != nil {
				return err
			}
		}
		return adminMakeKey(a.get("slack-token-file"), a.get("registry-url"), regKey, a.get("out"))
	}
	return fmt.Errorf("不明な admin コマンドです: %s", a.pos[0])
}

func mustRegistry() (*Registry, error) {
	reg, stale, err := fetchRegistry()
	if reg == nil {
		if err != nil {
			return nil, err
		}
		return nil, errors.New("管理台帳を使っていません（鍵に台帳の窓口が入っていません）。")
	}
	if stale {
		return nil, fmt.Errorf("管理台帳が読めません（%s）。管理の操作は最新の台帳で行うため止めます", err)
	}
	return reg, nil
}

func adminStatus(teamID string) error {
	reg, err := mustRegistry()
	if err != nil {
		return err
	}
	last := map[string]Activity{}
	for _, act := range reg.Activity {
		last[act.SlackID] = act
	}
	in := map[string]bool{}
	if teamID != "" {
		ids := reg.subtree(teamID)
		if len(ids) == 0 {
			return fmt.Errorf("チーム %s が台帳にありません", teamID)
		}
		for _, id := range ids {
			in[strings.ToLower(id)] = true
		}
	}
	members := append([]Member(nil), reg.Members...)
	sort.SliceStable(members, func(i, j int) bool { return members[i].Status < members[j].Status })
	fmt.Println("名前\t状態\t所属\t最後に動いた\tバージョン")
	for _, m := range members {
		if teamID != "" {
			hit := false
			for _, t := range m.Teams {
				if in[strings.ToLower(strings.TrimSpace(t))] {
					hit = true
				}
			}
			if !hit {
				continue
			}
		}
		act, ok := last[m.SlackID]
		seen, ver := "未導入", "-"
		if ok {
			seen, ver = act.At, act.Version
		}
		fmt.Printf("%s\t%s\t%s\t%s\t%s\n", m.Name, m.Status, strings.Join(m.Teams, ","), seen, ver)
	}
	return nil
}

func adminCreateTeam(id, chName string, dry bool) error {
	if id == "" {
		return errors.New("--id（台帳のチームID）が要ります。")
	}
	reg, err := mustRegistry()
	if err != nil {
		return err
	}
	t := reg.team(id)
	if t == nil {
		return fmt.Errorf("チーム %s が台帳にありません。先にスプレッドシートの「チーム」に行を足してください", id)
	}
	if t.Channel != "" {
		return fmt.Errorf("チーム %s にはすでにまとめチャンネル（%s）があります", t.ID, t.Channel)
	}
	if chName == "" {
		chName = "ミエタスク-" + strings.ToLower(t.ID)
	}
	if dry {
		fmt.Printf("[dry-run] #%s を作り、管理者 %s を招待します\n", chName, strings.Join(t.Managers, ", "))
		return nil
	}
	token, err := readToken("")
	if err != nil {
		return err
	}
	chID, nm, err := createPrivateChannel(token, chName)
	if err != nil {
		return err
	}
	fmt.Printf("作りました: #%s\n", nm)
	for _, m := range t.Managers {
		msg, err := ensureMemberIn(token, chID, strings.TrimSpace(m))
		if err != nil {
			fmt.Printf("  %s: 招待できませんでした（%s）\n", m, err)
			continue
		}
		fmt.Printf("  %s: %s\n", m, msg)
	}
	fmt.Printf("channel: %s\n", chID)
	fmt.Printf("→ スプレッドシートの「チーム」の %s の行の「まとめチャンネル」に %s を入れてください\n", t.ID, chID)
	return nil
}

func adminInviteManagers(id string, dry bool) error {
	reg, err := mustRegistry()
	if err != nil {
		return err
	}
	t := reg.team(id)
	if t == nil || t.Channel == "" {
		return fmt.Errorf("チーム %s か、そのまとめチャンネルが台帳にありません", id)
	}
	if dry {
		fmt.Printf("[dry-run] %s に %s を招待します\n", t.Channel, strings.Join(t.Managers, ", "))
		return nil
	}
	token, err := readToken("")
	if err != nil {
		return err
	}
	for _, m := range t.Managers {
		msg, err := ensureMemberIn(token, t.Channel, strings.TrimSpace(m))
		if err != nil {
			fmt.Printf("  %s: 招待できませんでした（%s）\n", m, err)
			continue
		}
		fmt.Printf("  %s: %s\n", m, msg)
	}
	fmt.Println("※ 前の管理者をチャンネルから外す操作は、Slack の画面から行ってください（Bot は人を外せません）")
	return nil
}

// adminArchiveMember は停止にした人の投稿先をアーカイブする。
// 取り違えを防ぐため、台帳で「停止」になっている人しか対象にしない。
func adminArchiveMember(slackID string, dry bool) error {
	if slackID == "" {
		return errors.New("--slack（その人のSlack ID）が要ります。")
	}
	reg, err := mustRegistry()
	if err != nil {
		return err
	}
	m := reg.member(slackID)
	if m == nil {
		return fmt.Errorf("%s は台帳にいません", slackID)
	}
	if strings.TrimSpace(m.Status) != statusStopped {
		return fmt.Errorf("%s さんは台帳で「停止」になっていません。先にスプレッドシートで状態を「停止」にしてください", m.Name)
	}
	channel := ""
	for _, a := range reg.Activity {
		if a.SlackID == slackID && a.Channel != "" {
			channel = a.Channel
		}
	}
	if channel == "" {
		return fmt.Errorf("%s さんの投稿先が分かりません（一度も動いていないか、稼働の記録がありません）", m.Name)
	}
	if dry {
		fmt.Printf("[dry-run] %s さんの投稿先 %s をアーカイブします\n", m.Name, channel)
		return nil
	}
	token, err := readToken("")
	if err != nil {
		return err
	}
	if err := archiveChannel(token, channel); err != nil {
		return err
	}
	fmt.Printf("%s さんの投稿先 %s をアーカイブしました（Slack の画面から元に戻せます）\n", m.Name, channel)
	return nil
}

// adminMakeKey はミエタスクの鍵を作る。鍵には Botトークンが入るので、画面には出さない。
// Mac ではクリップボードに入れ、それ以外では --out のファイルに書く。そのまま 1Password に貼る。
func adminMakeKey(tokenPath, regURL, regKey, out string) error {
	if tokenPath == "" || regURL == "" || regKey == "" {
		return errors.New("--slack-token-file・--registry-url・--registry-key が要ります。")
	}
	b, err := os.ReadFile(tokenPath)
	if err != nil {
		return err
	}
	cur, err := decodeKey(string(b))
	if err != nil {
		return err
	}
	if !strings.HasPrefix(cur.Slack, "xoxb-") {
		return errors.New("Botトークン（xoxb-）が読めません")
	}
	k := mietaskKey{Slack: cur.Slack, RegistryURL: regURL, RegistryKey: strings.TrimSpace(regKey)}
	// 配る前に、その鍵で台帳を本当に読めるか確かめる（合言葉の貼り間違いをここで止める）
	reg, err := fetchRegistryFrom(k)
	if err != nil {
		return fmt.Errorf("この鍵では管理台帳を読めませんでした（%s）。鍵は作っていません", err)
	}
	fmt.Printf("管理台帳に接続できました（チーム %d・メンバー %d人）\n", len(reg.Teams), len(reg.Members))
	key := encodeKey(k)
	if out != "" {
		if err := os.WriteFile(out, []byte(key), 0o600); err != nil {
			return err
		}
		fmt.Printf("鍵を %s に書きました。1Password に貼ったら、このファイルは消してください\n", out)
		return nil
	}
	if runtime.GOOS != "darwin" {
		return errors.New("この環境ではクリップボードに入れられません。--out でファイルを指定してください")
	}
	cmd := exec.Command("pbcopy")
	cmd.Stdin = strings.NewReader(key)
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("クリップボードに入れられませんでした: %w", err)
	}
	fmt.Println("鍵をクリップボードに入れました。1Password の「ミエタスク Bot Token」に貼り替えてください")
	return nil
}

// promptHidden は伏せ字の入力欄を出して文字列を受け取る（Mac のみ）。受け取った値は画面にもログにも出さない。
func promptHidden(msg string) (string, error) {
	if runtime.GOOS != "darwin" {
		return "", errors.New("この環境では入力欄を出せません。--registry-key で渡してください")
	}
	script := `text returned of (display dialog "` + msg + `" default answer "" with hidden answer with title "ミエタスク" buttons {"キャンセル", "OK"} default button "OK" cancel button "キャンセル")`
	out, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		return "", errors.New("入力がキャンセルされました")
	}
	v := strings.TrimSpace(string(out))
	if v == "" {
		return "", errors.New("入力が空でした")
	}
	return v, nil
}
