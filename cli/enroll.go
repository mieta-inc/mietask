package main

// 確認コードで使い始める（鍵をまだ持っていない人）。
//
//	mietask enroll start --slack-id U… --name "山田 太郎" [--email …] [--pc "山田のMac"]
//	mietask enroll finish --code 123456
//
// start は手元で合札（乱数）を作り、その sha256 だけを窓口に送る。窓口は本人の Slack の DM に6桁の確認コードを送る。
// finish は確認コードと合札を窓口に出し、受け取った鍵を鍵ファイルに保存する。鍵は画面にも会話にも出さない。
// コードは本人の DM にしか届かず、鍵を受け取れるのは合札を持つこの PC だけ。

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// 管理台帳の窓口。鍵を持つ前の申し込みはここに送る（鍵を持ってからは鍵の中の URL を使う）
const defaultRelayURL = "https://script.google.com/macros/s/AKfycbyvA4fVkvauGBfRcdJjlREEbafCbAidTohxlH9Dc7skgDazsSe4tQUdpCIJcpgnZC3x/exec"

func enrollRelayURL() string {
	if env := strings.TrimSpace(os.Getenv("MIETASK_RELAY_URL")); env != "" {
		return env
	}
	return defaultRelayURL
}

type enrollState struct {
	URL      string `json:"url"`
	SlackID  string `json:"slack_id"`
	EnrollID string `json:"enroll_id"`
	Secret   string `json:"secret"`
	Expires  int64  `json:"expires"`
}

func enrollStatePath() string { return filepath.Join(dataDir(), "enroll.json") }

func runEnroll(rest []string) error {
	if len(rest) == 0 {
		return errors.New("enroll start か enroll finish です")
	}
	a, err := parseArgs(rest[1:])
	if err != nil {
		return err
	}
	switch rest[0] {
	case "start":
		return cmdEnrollStart(strings.TrimSpace(a.get("slack-id")), strings.TrimSpace(a.get("name")), strings.TrimSpace(a.get("email")), strings.TrimSpace(a.get("pc")))
	case "finish":
		return cmdEnrollFinish(a.get("code"))
	}
	return fmt.Errorf("不明な指定です: enroll %s（start か finish）", rest[0])
}

// defaultPCName は確認コードの DM に出す PC の呼び名（例: 山田のMac）。本人が自分の PC だと分かればよい
func defaultPCName(name string) string {
	family := strings.Fields(strings.ReplaceAll(name, "　", " "))
	who := ""
	if len(family) > 0 {
		who = family[0] + "の"
	}
	switch runtime.GOOS {
	case "darwin":
		return who + "Mac"
	case "windows":
		return who + "Windows の PC"
	}
	return who + "PC"
}

func cmdEnrollStart(slackID, name, email, pc string) error {
	if slackID == "" || name == "" {
		return errors.New("--slack-id と --name が要ります（コネクタから取った本人の情報を渡す）")
	}
	slackID = strings.ToUpper(slackID)
	if k := relayKeyFromFile(); k != nil && k.ID == slackID {
		fmt.Println("鍵: すでに入っています（確認コードは要りません）")
		return nil
	}
	if pc == "" {
		pc = defaultPCName(name)
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return fmt.Errorf("合札を作れませんでした: %w", err)
	}
	secret := hex.EncodeToString(raw)
	sum := sha256.Sum256([]byte(secret))
	url := enrollRelayURL()
	p := relayVersionParams()
	for k, v := range map[string]any{"action": "enroll_start", "slack_id": slackID, "name": name, "email": email, "pc": pc, "verifier": hex.EncodeToString(sum[:])} {
		p[k] = v
	}
	out, err := relayCallURL(url, p)
	if err != nil {
		return err
	}
	id, _ := out["enroll_id"].(string)
	if id == "" {
		return errors.New("窓口が申し込みの番号を返しませんでした")
	}
	ttl, _ := out["expires_in"].(float64)
	if ttl <= 0 {
		ttl = 600
	}
	st := enrollState{URL: url, SlackID: slackID, EnrollID: id, Secret: secret, Expires: time.Now().Add(time.Duration(ttl) * time.Second).Unix()}
	if err := saveEnrollState(st); err != nil {
		return err
	}
	fmt.Printf("確認コード: %s の Slack の DM に送りました（%d分のあいだ有効）\n", pc, int(ttl)/60)
	fmt.Println("本人に、DM に届いた6桁の番号を入力してもらってください")
	return nil
}

func saveEnrollState(st enrollState) error {
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(st)
	return os.WriteFile(enrollStatePath(), b, 0o600)
}

func cmdEnrollFinish(code string) error {
	code = strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		if r >= '０' && r <= '９' {
			return '0' + (r - '０')
		}
		return -1
	}, code)
	if len(code) != 6 {
		return errors.New("確認コードは6桁の数字です。DM に届いた番号をそのまま入れてください")
	}
	b, err := os.ReadFile(enrollStatePath())
	if err != nil {
		return errors.New("申し込みが見つかりません。もう一度 /mietask:setup を打ってください")
	}
	var st enrollState
	if err := json.Unmarshal(b, &st); err != nil || st.EnrollID == "" || st.Secret == "" {
		_ = os.Remove(enrollStatePath())
		return errors.New("申し込みの控えが壊れています。もう一度 /mietask:setup を打ってください")
	}
	if time.Now().Unix() > st.Expires {
		_ = os.Remove(enrollStatePath())
		return errors.New("確認コードの期限（10分）が切れました。もう一度 /mietask:setup を打ってください")
	}
	out, err := relayCallURL(st.URL, map[string]any{"action": "enroll_claim", "slack_id": st.SlackID, "enroll_id": st.EnrollID, "secret": st.Secret, "code": code})
	if err != nil {
		var re *RelayError
		if errors.As(err, &re) && re.Code != "bad_code" {
			_ = os.Remove(enrollStatePath()) // やり直すしかないもの（期限切れ・回数切れ・別の PC）は控えを消す
		}
		return err
	}
	key, _ := out["key"].(string)
	k, err := decodeRelayKey(key)
	if err != nil || k == nil || k.ID != st.SlackID {
		return errors.New("窓口から受け取った鍵が読めません。もう一度 /mietask:setup を打ってください")
	}
	if err := os.MkdirAll(filepath.Dir(tokenFile()), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(tokenFile(), []byte(key), 0o600); err != nil {
		return fmt.Errorf("鍵を保存できませんでした: %w", err)
	}
	_ = os.Remove(enrollStatePath())
	name, _ := out["name"].(string)
	fmt.Printf("鍵: 保存しました（%s さん専用。中身は表示しません）\n", name)
	if reg, _ := out["registered"].(bool); reg {
		fmt.Println("管理台帳: 新しく登録しました（チームはこのあと選びます）")
	}
	return nil
}

type relayTeam struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

func cmdTeams() error {
	k := relayKeyFromFile()
	if k == nil {
		return errors.New("鍵がまだありません。先に確認コードで鍵を受け取ってください")
	}
	out, err := relayCall(k, "teams", nil)
	if err != nil {
		return err
	}
	var r struct {
		Teams []relayTeam `json:"teams"`
		Mine  []string    `json:"mine"`
	}
	b, _ := json.Marshal(out)
	if err := json.Unmarshal(b, &r); err != nil {
		return fmt.Errorf("窓口の応答が読めません: %w", err)
	}
	if len(r.Mine) > 0 {
		fmt.Printf("所属: %s（すでに入っています。選び直しはシステム管理者に頼みます）\n", strings.Join(r.Mine, ", "))
		return nil
	}
	for i, t := range r.Teams {
		fmt.Printf("%d. %s\t%s\n", i+1, t.Path, t.ID)
	}
	fmt.Printf("%d. わからない\tnone\n", len(r.Teams)+1)
	return nil
}

func cmdJoinTeam(id string) error {
	id = strings.TrimSpace(id)
	if id == "none" || id == "わからない" {
		fmt.Println("チーム: 選ばずに始めます（システム管理者があとで決めます）")
		return nil
	}
	k := relayKeyFromFile()
	if k == nil {
		return errors.New("鍵がまだありません。先に確認コードで鍵を受け取ってください")
	}
	out, err := relayCall(k, "join_team", map[string]any{"team": id})
	if err != nil {
		return err
	}
	name, _ := out["name"].(string)
	fmt.Printf("チーム: %s に入りました\n", name)
	if told, _ := out["notified"].([]any); len(told) > 0 {
		var names []string
		for _, n := range told {
			names = append(names, fmt.Sprint(n))
		}
		fmt.Printf("知らせた管理者: %s\n", strings.Join(names, "、"))
	}
	return nil
}
