package main

// 窓口（管理台帳の Apps Script）を通して Slack を使う。
//
// メンバーが持つのは一人ずつ別の鍵（mietask2.…）だけで、Botトークンは持たない。
// 投稿・投稿先の用意・診断・管理者の画面のデータは、すべて窓口に頼む。窓口は鍵を確かめ、
// 本人の投稿先と所属チームのまとめチャンネルにしか投稿させない。台帳で停止にされた人や、
// 鍵を無効にされた人は、その時点から窓口を使えなくなる。

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

const relayKeyPrefix = "mietask2."

type relayKey struct {
	URL    string `json:"u"`
	ID     string `json:"i"`
	Secret string `json:"k"`
}

func decodeRelayKey(raw string) (*relayKey, error) {
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "\uFEFF"))
	if !strings.HasPrefix(raw, relayKeyPrefix) {
		return nil, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(strings.TrimPrefix(raw, relayKeyPrefix), "="))
	if err != nil {
		return nil, errors.New("ミエタスクの鍵が壊れています。DM で届いた鍵をコピーし直してください")
	}
	var k relayKey
	if err := json.Unmarshal(b, &k); err != nil || k.URL == "" || k.ID == "" || k.Secret == "" {
		return nil, errors.New("ミエタスクの鍵が読めません。DM で届いた鍵をコピーし直してください")
	}
	return &k, nil
}

// relayKeyFromFile は鍵ファイルが一人ずつの鍵なら返す。そうでなければ nil。
func relayKeyFromFile() *relayKey {
	b, err := os.ReadFile(tokenFile())
	if err != nil {
		return nil
	}
	k, err := decodeRelayKey(string(b))
	if err != nil {
		return nil
	}
	return k
}

type RelayError struct {
	Code    string
	Message string
}

func (e *RelayError) Error() string { return e.Message }

// 窓口は1回の投稿で親＋子スレッドを順に投げる（1通ごとに1秒ほど待つ）ので、長めに待つ
var relayClient = &http.Client{Timeout: 120 * time.Second}

// relayCall は窓口に頼む。Apps Script は POST のあと別の URL へ転送するが、http.Client がたどる。
func relayCall(k *relayKey, action string, params map[string]any) (map[string]any, error) {
	body := map[string]any{}
	for kk, v := range params {
		body[kk] = v
	}
	body["id"] = k.ID
	body["k"] = k.Secret
	body["action"] = action
	b, _ := json.Marshal(body)
	res, err := relayClient.Post(k.URL, "application/json", bytes.NewReader(b))
	if err != nil {
		return nil, fmt.Errorf("管理台帳の窓口に接続できません: %s", hideURL(err))
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("管理台帳の窓口がHTTP %dを返しました", res.StatusCode)
	}
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		// 窓口の公開範囲が「全員」でないと、ログイン画面の HTML が返ってくる
		return nil, errors.New("管理台帳の窓口の応答が読めません（管理者に、窓口の公開範囲が「全員」になっているか確認してもらってください）")
	}
	if out["ok"] != true {
		code, _ := out["error"].(string)
		msg, _ := out["message"].(string)
		if msg == "" {
			msg = "窓口に断られました（" + code + "）"
		}
		return nil, &RelayError{Code: code, Message: msg}
	}
	return out, nil
}

func relayVersionParams() map[string]any {
	return map[string]any{"version": version, "os": runtime.GOOS + "/" + runtime.GOARCH}
}

// relayPost は親＋子スレッドを窓口経由で投稿し、親の ts を返す。
func relayPost(k *relayKey, channel, parent string, replies []string) (string, error) {
	p := relayVersionParams()
	p["channel"] = channel
	p["parent"] = parent
	p["replies"] = replies
	out, err := relayCall(k, "post", p)
	if err != nil {
		return "", err
	}
	ts, _ := out["ts"].(string)
	if ts == "" {
		return "", errors.New("投稿は通ったのに ts が返りませんでした")
	}
	return ts, nil
}

// relayMe は自分の情報・所属チーム・（管理者なら）管理しているチームを返す。
type relayMeResult struct {
	Me struct {
		Name    string   `json:"name"`
		SlackID string   `json:"slack_id"`
		Teams   []string `json:"teams"`
		Status  string   `json:"status"`
		Channel string   `json:"channel"`
	} `json:"me"`
	Teams []struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Channel string `json:"channel"`
		Missing bool   `json:"missing"`
	} `json:"teams"`
	Managed *struct {
		Teams    []Team            `json:"teams"`
		Members  []Member          `json:"members"`
		Settings map[string]string `json:"settings"`
		Daily    []DailyStatus     `json:"daily"`
	} `json:"managed"`
	Settings map[string]string `json:"settings"`
}

var relayMeMemo *relayMeResult

func relayMe(k *relayKey) (*relayMeResult, error) {
	if relayMeMemo != nil {
		return relayMeMemo, nil
	}
	out, err := relayCall(k, "me", nil)
	if err != nil {
		return nil, err
	}
	b, _ := json.Marshal(out)
	var r relayMeResult
	if err := json.Unmarshal(b, &r); err != nil {
		return nil, fmt.Errorf("窓口の応答が読めません: %w", err)
	}
	relayMeMemo = &r
	return &r, nil
}

// relaySetup は投稿先を用意する（無ければ作り、本人を招待する）。
func relaySetup(k *relayKey, candidates []string) (id, name, msg string, err error) {
	p := relayVersionParams()
	p["candidates"] = candidates
	out, err := relayCall(k, "setup", p)
	if err != nil {
		return "", "", "", err
	}
	id, _ = out["channel"].(string)
	name, _ = out["name"].(string)
	msg, _ = out["message"].(string)
	return id, name, msg, nil
}

// relayDoctor は診断の窓口側の部分。
func relayDoctor(k *relayKey, ok, ng, warn func(string, string)) {
	out, err := relayCall(k, "check", nil)
	if err != nil {
		var re *RelayError
		if errors.As(err, &re) {
			ng("鍵", re.Message)
		} else {
			ng("管理台帳の窓口", err.Error())
		}
		return
	}
	b, _ := json.Marshal(out)
	var r struct {
		Bot string `json:"bot"`
		Me  struct {
			Name  string   `json:"name"`
			Teams []string `json:"teams"`
		} `json:"me"`
		Teams []struct {
			ID      string `json:"id"`
			Channel string `json:"channel"`
			Missing bool   `json:"missing"`
		} `json:"teams"`
		Channel *struct {
			ID       string `json:"id"`
			Name     string `json:"name"`
			Archived bool   `json:"archived"`
			Error    string `json:"error"`
		} `json:"channel"`
	}
	_ = json.Unmarshal(b, &r)
	ok("鍵", r.Me.Name+"（一人ずつの鍵・窓口経由）")
	if r.Bot != "ok" {
		ng("窓口のBot", "Slack に拒否されています（"+r.Bot+"）。管理者に連絡してください")
	}
	switch {
	case r.Channel == nil:
		ng("投稿先", "まだありません。/mietask:setup をやり直してください")
	case r.Channel.Error != "":
		ng("投稿先", r.Channel.ID+" に Bot が入れません（"+r.Channel.Error+"）")
	case r.Channel.Archived:
		ng("投稿先", "#"+r.Channel.Name+" はアーカイブされています。管理者に確認してください")
	default:
		ok("投稿先", "#"+r.Channel.Name+"（"+r.Channel.ID+"）")
	}
	var names []string
	for _, t := range r.Teams {
		switch {
		case t.Missing:
			names = append(names, t.ID+"（台帳にないチーム）")
		case t.Channel == "":
			names = append(names, t.ID+"（まとめチャンネル未設定）")
		default:
			names = append(names, t.ID)
		}
	}
	if len(names) == 0 {
		names = []string{"なし"}
	}
	ok("所属チーム", strings.Join(names, ", "))
}

// relayRegistry は管理者の画面用のデータ。--team を指定すれば、そのチームとその下のチームに絞る。
func relayRegistry(k *relayKey, teamID string) (*Registry, error) {
	me, err := relayMe(k)
	if err != nil {
		return nil, err
	}
	if me.Managed == nil {
		return nil, errors.New("管理しているチームがありません（管理台帳の「チーム」の管理者に入っていません）")
	}
	reg := &Registry{Teams: me.Managed.Teams, Members: me.Managed.Members, Settings: me.Managed.Settings, Daily: me.Managed.Daily}
	if teamID == "" {
		return reg, nil
	}
	ids := reg.subtree(teamID)
	if len(ids) == 0 {
		return nil, fmt.Errorf("チーム %s を管理していないか、台帳にありません", teamID)
	}
	return filterRegistry(reg, ids), nil
}
