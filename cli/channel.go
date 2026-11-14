package main

// 投稿先のプライベートチャンネルを作り、本人を招待して、IDを返す。
//
// なぜBotに作らせるか。手で作らせると、作る→Botを/inviteする→チャンネルIDをコピーして貼る、
// の3手が要る。ここが一番つまずく。
//
// 必ず本人を招待する。Botが作ったプライベートチャンネルには最初Botしかいない。
//
// 同名チャンネルを黙って使い回さない。ワークスペースでチャンネル名は一意なので、
// 別の人が同じ名前を入れると衝突する。Botは複数人のチャンネルに入っているため、
// 名前だけで突き合わせると他人のチャンネルに投稿先を向けてしまう。
// 既存を使うのは「本人がすでにそこに入っている」と確認できたときだけにする。
//
// 必要なスコープ: groups:write（作成・招待・アーカイブ）, groups:read（確認）

import (
	"fmt"
	"net/url"
	"strings"
)

func channelHint(err string) string {
	hints := map[string]string{
		"missing_scope": "  スコープが足りません。Slack App に groups:write と groups:read を\n  追加して Reinstall してください。",
		"name_taken": "  その名前のチャンネルはワークスペースにすでにあります。\n" +
			"  **他の人のものかもしれないので、勝手には使いません。**\n" +
			"  自分のものなら --existing <チャンネルID> で指定してください。\n" +
			"  そうでなければ別の名前にしてください。",
		"invalid_name":      "  この名前は使えません。日本語が弾かれた場合は英字の mietask-<名字> で作り直してください。",
		"restricted_action": "  ワークスペースの設定でアプリによる作成が止められています。手で作ってください。",
		"invalid_auth":      "  トークンが無効です。",
		"not_in_channel":    "  Botがそのチャンネルにいません。/invite してください。",
		"channel_not_found": "  そのチャンネルIDが見つかりません。Botが入っているか確認してください。",
		"user_not_found":    "  config.json の owner.slack_user_id が正しくありません。",
		"cant_invite_self":  "  Bot自身は招待できません。",
		"already_archived":  "  すでにアーカイブ済みです。",
	}
	if h, ok := hints[err]; ok {
		return h
	}
	return "  Slackのエラー: " + err
}

func formCall(token, method string, kv ...string) (map[string]any, error) {
	v := url.Values{}
	for i := 0; i+1 < len(kv); i += 2 {
		v.Set(kv[i], kv[i+1])
	}
	return slackCall(token, method, nil, v)
}

func nextCursor(p map[string]any) string {
	if m, ok := p["response_metadata"].(map[string]any); ok {
		if c, ok := m["next_cursor"].(string); ok {
			return c
		}
	}
	return ""
}

// channelMembers はチャンネルの参加者。確認できなければ nil（『いない』と区別する）。
func channelMembers(token, channel string) map[string]bool {
	out := map[string]bool{}
	cursor := ""
	for i := 0; i < 10; i++ {
		kv := []string{"channel", channel, "limit", "200"}
		if cursor != "" {
			kv = append(kv, "cursor", cursor)
		}
		p, err := formCall(token, "conversations.members", kv...)
		if err != nil || p["ok"] != true {
			return nil
		}
		if arr, ok := p["members"].([]any); ok {
			for _, m := range arr {
				if s, ok := m.(string); ok {
					out[s] = true
				}
			}
		}
		if cursor = nextCursor(p); cursor == "" {
			break
		}
	}
	return out
}

// ensureMemberIn は指定の人がチャンネルにいることを保証する。いなければ招待する。
func ensureMemberIn(token, channel, user string) (string, error) {
	if who := channelMembers(token, channel); who != nil && who[user] {
		return "すでに参加しています", nil
	}
	p, err := formCall(token, "conversations.invite", "channel", channel, "users", user)
	if err != nil {
		return "", err
	}
	if p["ok"] == true {
		return "招待しました", nil
	}
	e := errOf(p)
	if e == "already_in_channel" {
		return "すでに参加しています", nil
	}
	return "", &PostError{fmt.Sprintf("チャンネルに入れられませんでした（%s）\n%s", e, channelHint(e))}
}

// findPrivateChannel は Botが入っているプライベートチャンネルから、名前で探す。
func findPrivateChannel(token, name string) (string, error) {
	target := strings.TrimSpace(strings.TrimLeft(name, "#"))
	cursor := ""
	for {
		kv := []string{"types", "private_channel", "exclude_archived", "true", "limit", "200"}
		if cursor != "" {
			kv = append(kv, "cursor", cursor)
		}
		p, err := formCall(token, "conversations.list", kv...)
		if err != nil {
			return "", err
		}
		if p["ok"] != true {
			e := errOf(p)
			return "", &PostError{fmt.Sprintf("チャンネルの一覧を取れませんでした（%s）\n%s", e, channelHint(e))}
		}
		if arr, ok := p["channels"].([]any); ok {
			for _, c := range arr {
				if m, ok := c.(map[string]any); ok && m["name"] == target {
					if id, ok := m["id"].(string); ok {
						return id, nil
					}
				}
			}
		}
		if cursor = nextCursor(p); cursor == "" {
			break
		}
	}
	return "", &PostError{"#" + target + " が見つかりません。\n" +
		"  名前が違うか、Botがまだそのチャンネルに入っていません。管理者に確認してください。"}
}

// createPrivateChannel はプライベートチャンネルを作って ID と名前を返す。
func createPrivateChannel(token, name string) (string, string, error) {
	name = strings.TrimSpace(strings.TrimLeft(name, "#"))
	p, err := formCall(token, "conversations.create", "name", name, "is_private", "true")
	if err != nil {
		return "", "", err
	}
	if p["ok"] != true {
		e := errOf(p)
		return "", "", &PostError{fmt.Sprintf("チャンネルを作れませんでした（%s）\n%s", e, channelHint(e))}
	}
	ch, _ := p["channel"].(map[string]any)
	id, _ := ch["id"].(string)
	nm, _ := ch["name"].(string)
	return id, nm, nil
}

func archiveChannel(token, channel string) error {
	p, err := formCall(token, "conversations.archive", "channel", channel)
	if err != nil {
		return err
	}
	if p["ok"] != true {
		e := errOf(p)
		if e == "already_archived" {
			return nil
		}
		return &PostError{fmt.Sprintf("アーカイブできませんでした（%s）\n%s", e, channelHint(e))}
	}
	return nil
}

func cmdChannel(name, existing, owner, findTeam string, dryRun bool) error {
	if findTeam != "" {
		token, err := readToken("")
		if err != nil {
			return err
		}
		ch, err := findPrivateChannel(token, findTeam)
		if err != nil {
			return err
		}
		fmt.Printf("team_channel: %s\n", ch)
		return nil
	}
	if name == "" && existing == "" {
		return &PostError{"--name か --existing か --find-team のどれかが要ります。"}
	}
	if owner == "" {
		owner = ownerSlackID()
	}
	if owner == "" {
		return &PostError{"本人のSlackユーザーIDが分かりません。\n" +
			"  config.json の owner.slack_user_id を入れるか、--owner で渡してください。\n" +
			"  ここが空だと、本人がチャンネルに入れません。"}
	}
	if dryRun {
		where := "新規 #" + strings.TrimLeft(name, "#")
		if existing != "" {
			where = "既存 " + existing
		}
		fmt.Printf("[dry-run] %s に %s を入れます\n", where, owner)
		return nil
	}
	token, err := readToken("")
	if err != nil {
		return err
	}
	if existing != "" {
		// 既存を使う道。本人が入っているかを必ず確かめる。ここを飛ばすと、他人のチャンネルを投稿先にしてしまう。
		ch := strings.TrimSpace(existing)
		nm := "?"
		if p, err := formCall(token, "conversations.info", "channel", ch); err == nil && p["ok"] == true {
			if c, ok := p["channel"].(map[string]any); ok {
				if s, ok := c["name"].(string); ok {
					nm = s
				}
			}
		}
		fmt.Printf("既存を使います: #%s\n", nm)
		msg, err := ensureMemberIn(token, ch, owner)
		if err != nil {
			return err
		}
		fmt.Printf("  %s\n", msg)
		fmt.Printf("channel: %s\n", ch)
		return nil
	}
	id, nm, err := createPrivateChannel(token, name)
	if err != nil {
		return err
	}
	fmt.Printf("作りました: #%s\n", nm)
	msg, err := ensureMemberIn(token, id, owner)
	if err != nil {
		return err
	}
	fmt.Printf("  %s\n", msg)
	fmt.Printf("channel: %s\n", id)
	return nil
}
