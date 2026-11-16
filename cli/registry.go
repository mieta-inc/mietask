package main

// 管理台帳（スプレッドシート）との連携。
//
// チームの組み替え・管理者の交代・退職者の停止を、管理者がスプレッドシートを書き換えるだけで
// 済むようにするためのもの。メンバー側は何もしなくてよく、毎朝の実行が台帳を読み直す。
//
// スプレッドシートには Apps Script の窓口（admin/registry.gs）を付ける。鍵（ミエタスクの鍵）を
// 持っている人だけが読める。スプレッドシート自体は社内向けの共有のまま置いておける。
//
// 台帳が読めない日（通信断・Googleの障害）は、前回読んだ内容（~/.mietask/registry.json）で動く。
// 台帳を使っていない人（鍵が Botトークンだけ）は、これまでどおり slack-post.json の設定で動く。

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ミエタスクの鍵。Botトークン・台帳の窓口・窓口の合言葉を1つにまとめたもの。
// 1Password で配り、メンバーは入力欄に1回貼るだけにする。
const keyPrefix = "mietask1."

type mietaskKey struct {
	Slack       string `json:"s"`
	RegistryURL string `json:"r,omitempty"`
	RegistryKey string `json:"k,omitempty"`
}

// decodeKey はトークンファイルの中身を読む。生の Botトークン（xoxb-）でも鍵でもよい。
func decodeKey(raw string) (mietaskKey, error) {
	raw = strings.TrimSpace(strings.TrimPrefix(raw, "\uFEFF"))
	if !strings.HasPrefix(raw, keyPrefix) {
		return mietaskKey{Slack: raw}, nil
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(raw, keyPrefix))
	if err != nil {
		return mietaskKey{}, errors.New("ミエタスクの鍵が壊れています。1Password からコピーし直してください")
	}
	var k mietaskKey
	if err := json.Unmarshal(b, &k); err != nil {
		return mietaskKey{}, errors.New("ミエタスクの鍵が読めません。1Password からコピーし直してください")
	}
	return k, nil
}

func encodeKey(k mietaskKey) string {
	b, _ := json.Marshal(k)
	return keyPrefix + base64.RawURLEncoding.EncodeToString(b)
}

func readKeyFile() (mietaskKey, bool) {
	b, err := os.ReadFile(tokenFile())
	if err != nil {
		return mietaskKey{}, false
	}
	k, err := decodeKey(string(b))
	if err != nil {
		return mietaskKey{}, false
	}
	return k, true
}

// ---------------------------------------------------------------- 台帳の中身

type Team struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Parent   string   `json:"parent"`
	Channel  string   `json:"channel"`
	Managers []string `json:"managers"`
	Note     string   `json:"note,omitempty"`
}

type Member struct {
	Name    string   `json:"name"`
	SlackID string   `json:"slack_id"`
	Email   string   `json:"email"`
	Teams   []string `json:"teams"`
	Status  string   `json:"status"`
	// NotionUser は MTD の担当を引くための Notion ユーザーID（user://…）。空なら管理者の画面がメールで探す
	NotionUser string `json:"notion_user,omitempty"`
	Note       string `json:"note,omitempty"`
	// 以下は一人ずつの鍵（窓口経由）のときに窓口が返す
	Channel string `json:"channel,omitempty"`
	LastRun string `json:"last_run,omitempty"`
	Version string `json:"version,omitempty"`
}

type Activity struct {
	SlackID string `json:"slack_id"`
	Name    string `json:"name"`
	Channel string `json:"channel"`
	Version string `json:"version"`
	OS      string `json:"os"`
	At      string `json:"at"`
}

type Registry struct {
	Teams    []Team            `json:"teams"`
	Members  []Member          `json:"members"`
	Settings map[string]string `json:"settings"`
	Activity []Activity        `json:"activity"`
	// Daily は各自のミエタスクが毎朝送る件数（直近8日）。窓口が管理者にだけ返す
	Daily []DailyStatus `json:"daily,omitempty"`
}

// DailyStatus は1人1日分の件数。題名やメモは入らない（管理者に届くのは件数だけ）
type DailyStatus struct {
	Date    string `json:"date"`
	SlackID string `json:"slack_id"`
	Name    string `json:"name"`
	Overdue int    `json:"overdue"`
	Today   int    `json:"today"`
	Week    int    `json:"week"`
	At      string `json:"at"`
}

type registryCache struct {
	FetchedAt string   `json:"fetched_at"`
	Data      Registry `json:"data"`
}

const statusStopped = "停止"

func (r *Registry) member(slackID string) *Member {
	for i := range r.Members {
		if r.Members[i].SlackID == slackID {
			return &r.Members[i]
		}
	}
	return nil
}

func (r *Registry) team(id string) *Team {
	for i := range r.Teams {
		if strings.EqualFold(r.Teams[i].ID, id) {
			return &r.Teams[i]
		}
	}
	return nil
}

// subtree は指定チームと、その下にあるチーム（親チームをたどって）のIDを返す。PM を指せば PM1・PM2 も入る。
func (r *Registry) subtree(id string) []string {
	out := []string{}
	seen := map[string]bool{}
	var walk func(string)
	walk = func(cur string) {
		key := strings.ToLower(cur)
		if seen[key] {
			return // 親子の循環があっても止まるように
		}
		seen[key] = true
		out = append(out, cur)
		for _, t := range r.Teams {
			if strings.EqualFold(t.Parent, cur) {
				walk(t.ID)
			}
		}
	}
	if t := r.team(id); t != nil {
		walk(t.ID)
	}
	return out
}

func registryCachePath() string { return filepath.Join(homeDir(), "registry.json") }

var registryClient = &http.Client{Timeout: 20 * time.Second}

// fetchRegistry は台帳を読む。読めなければ前回の内容を返し、stale=true にする。
// 台帳を使っていない（鍵に窓口が無い）ときは nil を返す。
// 1回の実行の中では一度だけ読む（自分の投稿とまとめの投稿で何度も取りに行かない）
var registryMemo struct {
	done  bool
	reg   *Registry
	stale bool
	err   error
}

func fetchRegistry() (*Registry, bool, error) {
	if !registryMemo.done {
		registryMemo.reg, registryMemo.stale, registryMemo.err = fetchRegistryOnce()
		registryMemo.done = true
	}
	return registryMemo.reg, registryMemo.stale, registryMemo.err
}

func fetchRegistryOnce() (reg *Registry, stale bool, err error) {
	k, ok := readKeyFile()
	if !ok || k.RegistryURL == "" {
		return nil, false, nil
	}
	reg, ferr := fetchRegistryFrom(k)
	if ferr == nil {
		saveRegistryCache(reg)
		return reg, false, nil
	}
	if cached := loadRegistryCache(); cached != nil {
		return &cached.Data, true, ferr
	}
	return nil, true, ferr
}

func fetchRegistryFrom(k mietaskKey) (*Registry, error) {
	u := k.RegistryURL + "?" + url.Values{"action": {"get"}, "key": {k.RegistryKey}}.Encode()
	res, err := registryClient.Get(u)
	if err != nil {
		return nil, fmt.Errorf("管理台帳に接続できません: %s", hideURL(err))
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("管理台帳がHTTP %dを返しました", res.StatusCode)
	}
	var wrap struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
		Registry
	}
	if err := json.Unmarshal(body, &wrap); err != nil {
		// 窓口の公開範囲が「自分のみ」などだと、ログイン画面のHTMLが返ってくる
		return nil, errors.New("管理台帳の応答が読めません（Apps Script の公開範囲が「全員」になっているか確認してください）")
	}
	if !wrap.OK {
		return nil, fmt.Errorf("管理台帳に断られました: %s", wrap.Error)
	}
	return &wrap.Registry, nil
}

// hideURL は通信エラーから URL を外す。URL には台帳の合言葉が入っているので、画面やログに出さない。
func hideURL(err error) string {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err.Error()
	}
	return err.Error()
}

func saveRegistryCache(reg *Registry) {
	c := registryCache{FetchedAt: nowStamp(), Data: *reg}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return
	}
	_ = os.MkdirAll(homeDir(), 0o755)
	tmp := registryCachePath() + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		_ = os.Rename(tmp, registryCachePath())
	}
}

func loadRegistryCache() *registryCache {
	b, err := os.ReadFile(registryCachePath())
	if err != nil {
		return nil
	}
	var c registryCache
	if json.Unmarshal(b, &c) != nil {
		return nil
	}
	return &c
}

// checkActive は投稿の前に呼ぶ。台帳で「停止」になっている人は投稿しない（退職・異動時の止め方）。
// 台帳に載っていない人は、警告だけ出して続ける（登録より先に導入した人を止めないため）。
func checkActive() error {
	reg, stale, err := fetchRegistry()
	if reg == nil {
		if err != nil {
			fmt.Fprintf(os.Stderr, "警告: %s（前回の内容もないため、台帳の確認を飛ばします）\n", err)
		}
		return nil
	}
	if stale {
		fmt.Fprintf(os.Stderr, "警告: %s。前回読んだ内容で続けます\n", err)
	}
	me := ownerSlackID()
	m := reg.member(me)
	if m == nil {
		fmt.Fprintf(os.Stderr, "警告: 管理台帳に未登録です（Slack ID %s）。管理者に登録を頼んでください\n", me)
		return nil
	}
	if strings.TrimSpace(m.Status) == statusStopped {
		return &PostError{"ミエタスクの利用は管理台帳で停止されています。投稿しません。\n" +
			"  心当たりがなければ管理者に確認してください。"}
	}
	return nil
}

// teamChannels は本人が投稿するまとめチャンネル（チームID → チャンネルID）。
// 台帳があれば台帳の所属から、無ければ slack-post.json の team_channel から決める。
func teamChannels() ([][2]string, string, error) {
	reg, _, _ := fetchRegistry()
	if reg != nil {
		m := reg.member(ownerSlackID())
		if m == nil {
			return nil, "", nil
		}
		var out [][2]string
		for _, tid := range m.Teams {
			t := reg.team(strings.TrimSpace(tid))
			if t == nil {
				fmt.Fprintf(os.Stderr, "警告: 管理台帳のチーム %q が見つかりません\n", tid)
				continue
			}
			if t.Channel == "" {
				fmt.Fprintf(os.Stderr, "警告: チーム %s のまとめチャンネルが台帳に入っていません\n", t.ID)
				continue
			}
			out = append(out, [2]string{t.ID, t.Channel})
		}
		return out, m.Name, nil
	}
	conf, err := slackPostConf()
	if err != nil || conf == nil {
		return nil, "", err
	}
	if ch := pyStrIfTruthy(conf.Val("team_channel")); ch != "" {
		return [][2]string{{"team", ch}}, "", nil
	}
	return nil, "", nil
}

// cmdPostTeam は自分用の投稿内容から、所属する全チームのまとめチャンネルへ投稿する。
func cmdPostTeam(payloadPath, nameArg string, dryRun bool) error {
	relay := relayKeyFromFile()
	if !dryRun && relay == nil {
		if err := checkActive(); err != nil {
			return err
		}
	}
	var chans [][2]string
	var regName string
	var err error
	if relay != nil {
		// 一人ずつの鍵：所属チームは窓口に聞く（窓口が停止・鍵の無効も確かめる）
		me, rerr := relayMe(relay)
		if rerr != nil {
			return rerr
		}
		regName = me.Me.Name
		for _, t := range me.Teams {
			switch {
			case t.Missing:
				fmt.Fprintf(os.Stderr, "警告: 管理台帳のチーム %q が見つかりません\n", t.ID)
			case t.Channel == "":
				fmt.Fprintf(os.Stderr, "警告: チーム %s のまとめチャンネルが台帳に入っていません\n", t.ID)
			default:
				chans = append(chans, [2]string{t.ID, t.Channel})
			}
		}
	} else if chans, regName, err = teamChannels(); err != nil {
		return err
	}
	if len(chans) == 0 {
		fmt.Println("まとめチャンネルの設定がないので、まとめへの投稿はしません。")
		return nil
	}
	name := nameArg
	if name == "" {
		name = regName
	}
	if name == "" {
		if c, err := loadConfig(); err == nil {
			name = str(orObj(c.Val("owner")).Val("name"))
		}
	}
	if name == "" {
		return errors.New("まとめに出す名前が分かりません。--name で渡すか、config.json の owner.name を入れてください。")
	}
	raw, err := os.ReadFile(payloadPath)
	if err != nil {
		return err
	}
	v, err := ParseJSON(raw)
	if err != nil {
		return err
	}
	own, ok := v.(*Obj)
	if !ok {
		return errors.New("payload のトップレベルはオブジェクトである必要があります。")
	}
	tp, err := buildTeamPayload(own, pyStrip(name))
	if err != nil {
		return err
	}
	tmp, err := tmpDir()
	if err != nil {
		return err
	}
	tpPath := filepath.Join(tmp, "team-payload.json")
	if err := os.WriteFile(tpPath, []byte(DumpJSON(tp, 1)+"\n"), 0o644); err != nil {
		return err
	}
	var failed []string
	for _, c := range chans {
		fmt.Printf("== まとめ（%s）%s\n", c[0], c[1])
		if err := postPayloadFile(tpPath, c[1], "", dryRun, false); err != nil {
			// 1つのチームで失敗しても、他のチームには出す
			failed = append(failed, c[0]+": "+err.Error())
		}
	}
	if len(failed) > 0 {
		return errors.New(strings.Join(failed, "\n"))
	}
	return nil
}

// heartbeat は投稿のあとに台帳へ「動いている」ことを知らせる。管理者が導入状況を見るのに使う。
// 失敗しても投稿は済んでいるので、警告だけにする。
func heartbeat(channel string) {
	k, ok := readKeyFile()
	if !ok || k.RegistryURL == "" {
		return
	}
	name := ""
	if c, err := loadConfig(); err == nil {
		name = str(orObj(c.Val("owner")).Val("name"))
	}
	body, _ := json.Marshal(map[string]string{
		"action":   "heartbeat",
		"key":      k.RegistryKey,
		"slack_id": ownerSlackID(),
		"name":     name,
		"channel":  channel,
		"version":  version,
		"os":       runtime.GOOS + "/" + runtime.GOARCH,
	})
	res, err := registryClient.Post(k.RegistryURL, "application/json", bytes.NewReader(body))
	if err != nil {
		fmt.Fprintf(os.Stderr, "警告: 管理台帳に稼働を記録できませんでした: %s\n", hideURL(err))
		return
	}
	res.Body.Close()
}

func doctorRegistry(ok, ng, warn func(string, string)) {
	k, has := readKeyFile()
	if !has || k.RegistryURL == "" {
		warn("管理台帳", "使っていません（鍵が Botトークンだけ）。チームの設定は slack-post.json から読みます")
		return
	}
	reg, err := fetchRegistryFrom(k)
	if err != nil {
		if c := loadRegistryCache(); c != nil {
			warn("管理台帳", err.Error()+"。前回（"+c.FetchedAt+"）の内容で動きます")
			reg = &c.Data
		} else {
			ng("管理台帳", err.Error())
			return
		}
	}
	m := reg.member(ownerSlackID())
	switch {
	case m == nil:
		warn("管理台帳", "未登録です。管理者に登録を頼んでください")
	case strings.TrimSpace(m.Status) == statusStopped:
		ng("管理台帳", "利用が停止されています。管理者に確認してください")
	default:
		var names []string
		for _, tid := range m.Teams {
			if t := reg.team(strings.TrimSpace(tid)); t != nil {
				label := t.ID
				if t.Channel == "" {
					label += "（まとめチャンネル未設定）"
				}
				names = append(names, label)
			} else {
				names = append(names, tid+"（台帳にないチーム）")
			}
		}
		if len(names) == 0 {
			names = []string{"なし"}
		}
		ok("管理台帳", fmt.Sprintf("%s / 所属: %s", m.Name, strings.Join(names, ", ")))
	}
}

// cmdRegistry は台帳の中身を出す。管理者の画面（team-sheet）が、チームとメンバーを知るのに使う。
//
//	mietask registry              全体
//	mietask registry --team pm    PM と、その下のチーム（PM1・PM2…）に属する人だけ
func cmdRegistry(teamID string) error {
	if k := relayKeyFromFile(); k != nil {
		reg, err := relayRegistry(k, teamID)
		if err != nil {
			return err
		}
		b, _ := json.MarshalIndent(reg, "", "  ")
		fmt.Println(string(b))
		return nil
	}
	reg, stale, err := fetchRegistry()
	if reg == nil {
		if err != nil {
			return err
		}
		return errors.New("管理台帳を使っていません（鍵に台帳の窓口が入っていません）。")
	}
	if stale {
		fmt.Fprintf(os.Stderr, "警告: %s。前回読んだ内容を出します\n", err)
	}
	out := reg
	if teamID != "" {
		ids := reg.subtree(teamID)
		if len(ids) == 0 {
			return fmt.Errorf("チーム %s が台帳にありません", teamID)
		}
		out = filterRegistry(reg, ids)
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	fmt.Println(string(b))
	return nil
}

// filterRegistry は指定したチーム（ID の一覧）と、そこに属するメンバーだけを残す。
func filterRegistry(reg *Registry, ids []string) *Registry {
	in := map[string]bool{}
	for _, id := range ids {
		in[strings.ToLower(id)] = true
	}
	out := &Registry{Settings: reg.Settings, Activity: reg.Activity}
	for _, t := range reg.Teams {
		if in[strings.ToLower(t.ID)] {
			out.Teams = append(out.Teams, t)
		}
	}
	for _, m := range reg.Members {
		for _, tid := range m.Teams {
			if in[strings.ToLower(strings.TrimSpace(tid))] {
				out.Members = append(out.Members, m)
				break
			}
		}
	}
	who := map[string]bool{}
	for _, m := range out.Members {
		who[m.SlackID] = true
	}
	for _, d := range reg.Daily {
		if who[d.SlackID] {
			out.Daily = append(out.Daily, d)
		}
	}
	return out
}
