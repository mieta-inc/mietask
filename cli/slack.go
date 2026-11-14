package main

// Slack への投稿・チャンネル作成・削除。
//
// Botトークンは ~/.config/mietask/slack-token から読む（環境変数で上書き可）。
// リポジトリ内にトークンを置かないこと。トークンの中身はログにもエラーにも出さない。

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

type PostError struct{ msg string }

func (e *PostError) Error() string { return e.msg }

const slackAPI = "https://slack.com/api"

// 投稿の間隔。chat.postMessage は同一チャンネルあたり毎秒1通が目安。
const postInterval = 1200 * time.Millisecond

// Slackのテキスト上限は4000文字。超えると末尾が黙って切られるので事前に弾く。
const maxTextLen = 3900

// レート制限（429 / ratelimited）のときだけ待ってやり直す回数。
// 投稿が通ったか分からない失敗（通信断など）ではやり直さない。二重投稿になるため。
const rateLimitRetries = 3

var httpClient = &http.Client{Timeout: 30 * time.Second}

// readToken は Botトークンを取り出す。中身はログにも例外にも出さない。
func readToken(path string) (string, error) {
	if env := os.Getenv("SLACK_BOT_TOKEN"); env != "" {
		return strings.TrimSpace(env), nil
	}
	if path == "" {
		path = tokenFile()
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", &PostError{"Botトークンが見つかりません: " + path + "\n" +
			"  Claude Code で /mietask:setup と打つと、置くところまでやります。"}
	}
	// Windows は権限の仕組みが違い、常に「他から読める」と出てしまうので見ない
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		fmt.Fprintf(os.Stderr, "警告: %s が他ユーザーから読めます。chmod 600 を推奨します。\n", path)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	// 中身は生の Botトークンでも、ミエタスクの鍵（Botトークンと台帳の窓口をまとめたもの）でもよい
	k, err := decodeKey(string(b))
	if err != nil {
		return "", &PostError{err.Error() + ": " + path}
	}
	token := strings.TrimSpace(k.Slack)
	if token == "" {
		return "", &PostError{"トークンファイルが空です: " + path}
	}
	if !strings.HasPrefix(token, "xoxb-") {
		return "", &PostError{"Botトークンの形式ではありません（xoxb- で始まるはず）: " + path + "\n" +
			"  User Token（xoxp-）ではなく Bot User OAuth Token を保存してください。"}
	}
	return token, nil
}

// slackCall は Slack API を呼ぶ。form が nil なら JSON で送る。
func slackCall(token, method string, jsonBody map[string]any, form url.Values) (map[string]any, error) {
	for attempt := 0; ; attempt++ {
		var req *http.Request
		var err error
		if form != nil {
			req, err = http.NewRequest("POST", slackAPI+"/"+method, strings.NewReader(form.Encode()))
			if err == nil {
				req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=utf-8")
			}
		} else {
			b, _ := json.Marshal(jsonBody)
			req, err = http.NewRequest("POST", slackAPI+"/"+method, bytes.NewReader(b))
			if err == nil {
				req.Header.Set("Content-Type", "application/json; charset=utf-8")
			}
		}
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := httpClient.Do(req)
		if err != nil {
			return nil, &PostError{"Slack APIに到達できません: " + err.Error()}
		}
		body, _ := io.ReadAll(res.Body)
		res.Body.Close()

		if res.StatusCode == 429 && attempt < rateLimitRetries {
			time.Sleep(retryAfter(res))
			continue
		}
		if res.StatusCode >= 400 {
			return nil, &PostError{fmt.Sprintf("Slack APIがHTTP %dを返しました: %s", res.StatusCode, http.StatusText(res.StatusCode))}
		}
		var payload map[string]any
		if err := json.Unmarshal(body, &payload); err != nil {
			return nil, &PostError{"Slack APIの応答が読めません: " + err.Error()}
		}
		if payload["ok"] != true && payload["error"] == "ratelimited" && attempt < rateLimitRetries {
			time.Sleep(retryAfter(res))
			continue
		}
		return payload, nil
	}
}

func retryAfter(res *http.Response) time.Duration {
	if s := res.Header.Get("Retry-After"); s != "" {
		if n, err := strconv.Atoi(s); err == nil && n > 0 && n < 120 {
			return time.Duration(n) * time.Second
		}
	}
	return 5 * time.Second
}

func errOf(p map[string]any) string {
	if e, ok := p["error"].(string); ok && e != "" {
		return e
	}
	return "unknown_error"
}

// ---------------------------------------------------------------- 投稿

func slackPostConf() (*Obj, error) {
	o, exists, err := readJSONObj(slackPostPath())
	if err != nil {
		return nil, &PostError{slackPostPath() + " が壊れています: " + err.Error()}
	}
	if !exists {
		return nil, nil
	}
	return o, nil
}

// readDefaultChannel は投稿先チャンネルIDを読む。slack-post.json が正、config.json が予備。
func readDefaultChannel() (string, error) {
	conf, err := slackPostConf()
	if err != nil {
		return "", err
	}
	if conf != nil {
		if ch := pyStrIfTruthy(conf.Val("channel")); ch != "" {
			return ch, nil
		}
	}
	return postChannel(), nil
}

// displayFields は投稿時の表示名とアイコン。slack-post.json から読む。
//
// App Home の Display Name を変えても、投稿の表示名は変わらないことがある。
// Slackは投稿した時点の名前をメッセージに焼き付けるため、確実なのは投稿ごとに username を渡すこと。
// これには chat:write.customize が要る。無ければ既定の名前で投げ直す。
func displayFields() map[string]string {
	out := map[string]string{}
	conf, err := slackPostConf()
	if err != nil || conf == nil {
		return out
	}
	for _, k := range []string{"username", "icon_url", "icon_emoji"} {
		if v := conf.Val(k); truthy(v) {
			out[k] = pyStr(v)
		}
	}
	return out
}

func postHint(err, channel string) string {
	hints := map[string]string{
		"channel_not_found": "  チャンネルID " + channel + " が見つかりません。チャンネル名ではなくID（Cで始まる）を指定してください。",
		"not_in_channel":    "  Botが " + channel + " に入っていません。チャンネルで /invite @アプリ名 を実行してください。",
		"invalid_auth":      "  トークンが無効です。再発行してファイルを置き換えてください。",
		"missing_scope":     "  スコープが足りません。chat:write を付けて再インストールしてください。",
		"token_revoked":     "  トークンが失効しています。再発行してください。",
		"ratelimited":       "  レート制限です。しばらく置いて再実行してください。",
		"msg_too_long":      "  本文が長すぎます。区分を分けてください。",
		"is_archived":       "  投稿先のチャンネルがアーカイブされています。管理者に確認するか、/mietask:setup で投稿先を作り直してください。",
	}
	if h, ok := hints[err]; ok {
		return h
	}
	return "  https://api.slack.com/methods/chat.postMessage#errors を参照"
}

func sendMessage(token string, body map[string]any, channel string) (string, error) {
	p, err := slackCall(token, "chat.postMessage", body, nil)
	if err != nil {
		return "", err
	}
	if p["ok"] != true {
		e := errOf(p)
		return "", &PostError{"Slackが投稿を拒否しました: " + e + "\n" + postHint(e, channel)}
	}
	ts, _ := p["ts"].(string)
	if ts == "" {
		return "", &PostError{"投稿は通ったのに ts が返りませんでした"}
	}
	return ts, nil
}

// postOne は1通投げて ts を返す。
func postOne(token, channel, text, threadTS string) (string, error) {
	custom := displayFields()
	body := map[string]any{
		"channel": channel,
		"text":    text,
		// 子スレッドをチャンネル本流に流さない
		"reply_broadcast": false,
		// URLの自動展開を抑える。朝の一覧が縦に伸びないように
		"unfurl_links": false,
		"unfurl_media": false,
	}
	if threadTS != "" {
		body["thread_ts"] = threadTS
	}
	for k, v := range custom {
		body[k] = v
	}
	ts, err := sendMessage(token, body, channel)
	if err == nil || len(custom) == 0 {
		return ts, err
	}
	// 表示名の指定だけが原因なら、名前を諦めて投稿は通す。朝の一覧が名前のせいで届かないほうが困る。
	msg := err.Error()
	if !strings.Contains(msg, "missing_scope") && !strings.Contains(msg, "not_allowed_token_type") && !strings.Contains(msg, "invalid_arguments") {
		return "", err
	}
	fmt.Fprintln(os.Stderr, "警告: 表示名を指定できませんでした。既定の名前で投稿します。\n"+
		"  直すには Slack App に chat:write.customize を足して Reinstall してください。")
	for k := range custom {
		delete(body, k)
	}
	return sendMessage(token, body, channel)
}

func workspaceName() string {
	if conf, _ := slackPostConf(); conf != nil {
		if ws := conf.Val("workspace"); truthy(ws) {
			return strings.TrimSpace(strings.ReplaceAll(pyStr(ws), ".slack.com", ""))
		}
	}
	if c, err := loadConfig(); err == nil {
		if ws := orObj(c.Val("owner")).Val("slack_workspace"); truthy(ws) {
			return strings.TrimSpace(strings.ReplaceAll(pyStr(ws), ".slack.com", ""))
		}
	}
	return ""
}

// permalink はスレッドのpermalinkを組み立てる。ワークスペース名が分からなければ空。でっち上げたURLは返さない。
func permalink(channel, ts string) string {
	ws := workspaceName()
	if ws == "" {
		return ""
	}
	return "https://" + ws + ".slack.com/archives/" + channel + "/p" + strings.ReplaceAll(ts, ".", "")
}

var reMdLink = regexp.MustCompile(`\[[^\]]+\]\(https?://`)

func cmdPost(payloadPath, channelArg, tokenPath string, dryRun bool) error {
	return postPayloadFile(payloadPath, channelArg, tokenPath, dryRun, true)
}

// postPayloadFile は投稿の本体。beat=true なら投稿のあと管理台帳に稼働を記録する（自分のチャンネルへの投稿のとき）。
func postPayloadFile(payloadPath, channelArg, tokenPath string, dryRun, beat bool) error {
	var raw []byte
	var err error
	where := payloadPath
	if payloadPath != "" {
		raw, err = os.ReadFile(payloadPath)
		if err != nil {
			return &PostError{"payloadが見つかりません: " + payloadPath}
		}
	} else {
		if fi, _ := os.Stdin.Stat(); fi != nil && fi.Mode()&os.ModeCharDevice != 0 {
			return &PostError{"payloadがありません。--payload を指定するか標準入力で渡してください。"}
		}
		raw, _ = io.ReadAll(os.Stdin)
		where = "標準入力"
	}
	v, err := ParseJSON(raw)
	if err != nil {
		return &PostError{where + " のJSONが壊れています: " + err.Error()}
	}
	data, ok := v.(*Obj)
	if !ok {
		return &PostError{where + " のトップレベルはオブジェクトである必要があります。"}
	}
	parent := pyStr(getDefault(data, "parent", ""))
	rawReplies, _ := getDefault(data, "replies", []any{}).([]any)

	// 投げる前に落とす。Slackは長すぎる本文を黙って切るので、ここで止める。
	if pyStrip(parent) == "" {
		return &PostError{"parent が空です。"}
	}
	labels := []string{"parent"}
	texts := []string{parent}
	for i, r := range rawReplies {
		s, ok := r.(string)
		if !ok {
			return &PostError{fmt.Sprintf("replies[%d] が文字列ではありません。", i)}
		}
		labels = append(labels, fmt.Sprintf("replies[%d]", i))
		texts = append(texts, s)
	}
	for i, t := range texts {
		if n := utf8.RuneCountInString(t); n > maxTextLen {
			return &PostError{fmt.Sprintf("%s が%d文字で、上限%d文字を超えています。区分を分けるか、件数を絞ってください。", labels[i], n, maxTextLen)}
		}
	}
	// Slackはmrkdwn。GitHub記法で書かれていたら知らせる（自動変換はしない）
	for i, t := range texts {
		if strings.Contains(t, "**") {
			fmt.Fprintf(os.Stderr, "警告: %s に ** があります。Slackの太字は *1つ* です。\n", labels[i])
		}
		if reMdLink.MatchString(t) {
			fmt.Fprintf(os.Stderr, "警告: %s に [text](url) 形式のリンクがあります。Slackでは <url|text> です。\n", labels[i])
		}
	}
	replies := texts[1:]

	channel := channelArg
	if channel == "" {
		channel = pyStrIfTruthy(data.Val("channel"))
	}
	if channel == "" {
		if channel, err = readDefaultChannel(); err != nil {
			return err
		}
	}

	// dry-run は本文を見るためのものなので、チャンネルもトークンも要求しない。
	if dryRun {
		shown := channel
		if shown == "" {
			shown = "(未設定)"
		}
		fmt.Printf("[dry-run] channel=%s\n", shown)
		fmt.Println("--- parent ---")
		fmt.Println(parent)
		for i, r := range replies {
			fmt.Printf("--- reply %d ---\n", i+1)
			fmt.Println(r)
		}
		return nil
	}
	if channel == "" {
		return &PostError{fmt.Sprintf("投稿先チャンネルが決まりません。--channel で渡すか、%s に {\"channel\": \"C...\"} を置いてください。", slackPostPath())}
	}
	token, err := readToken(tokenPath)
	if err != nil {
		return err
	}
	if err := checkActive(); err != nil {
		return err
	}
	rootTS, err := postOne(token, channel, parent, "")
	if err != nil {
		return err
	}
	// ts は sync record に渡す。翌朝この ts のスレッドを読んで完了を拾う。
	fmt.Printf("ts: %s\n", rootTS)
	if link := permalink(channel, rootTS); link != "" {
		fmt.Printf("親メッセージ: %s\n", link)
	}
	for i, r := range replies {
		time.Sleep(postInterval)
		if _, err := postOne(token, channel, r, rootTS); err != nil {
			return err
		}
		fmt.Printf("  子スレッド %d/%d 投稿\n", i+1, len(replies))
	}
	if beat {
		heartbeat(channel)
	}
	return nil
}

// ---------------------------------------------------------------- 削除

func deleteHint(err string) string {
	hints := map[string]string{
		"message_not_found":   "  すでに消えているか、ts が違います。",
		"cant_delete_message": "  Botが投げたものではありません。本人や他の人の発言はBotトークンでは消せないので、Slackの画面から消してください。",
		"channel_not_found":   "  チャンネルIDが違います。",
		"missing_scope":       "  スコープが足りません。chat:write を付けて再インストールしてください。",
		"invalid_auth":        "  トークンが無効です。",
		"ratelimited":         "  レート制限です。しばらく置いて再実行してください。",
	}
	if h, ok := hints[err]; ok {
		return h
	}
	return "  https://api.slack.com/methods/chat.delete#errors を参照"
}

func cmdDelete(tsList []string, tsFile, channel, tokenPath string, dryRun bool) error {
	targets := append([]string(nil), tsList...)
	if tsFile != "" {
		b, err := os.ReadFile(tsFile)
		if err != nil {
			return &PostError{"ts一覧が見つかりません: " + tsFile}
		}
		for _, line := range pySplitlines(string(b)) {
			line = pyStrip(strings.SplitN(line, "#", 2)[0])
			if line != "" {
				targets = append(targets, line)
			}
		}
	}
	if len(targets) == 0 {
		return &PostError{"消す対象がありません。--ts か --ts-file を指定してください。"}
	}
	var uniq []string
	for _, t := range targets {
		uniq = appendUnique(uniq, t)
	}
	if channel == "" {
		var err error
		if channel, err = readDefaultChannel(); err != nil {
			return err
		}
	}
	if channel == "" {
		return &PostError{"チャンネルが決まりません。--channel で渡してください。"}
	}
	if dryRun {
		fmt.Printf("[dry-run] channel=%s / %d件\n", channel, len(uniq))
		for _, t := range uniq {
			fmt.Printf("  %s\n", t)
		}
		return nil
	}
	token, err := readToken(tokenPath)
	if err != nil {
		return err
	}
	ok := 0
	var failed []string
	for i, ts := range uniq {
		if i > 0 {
			time.Sleep(1100 * time.Millisecond)
		}
		p, err := slackCall(token, "chat.delete", map[string]any{"channel": channel, "ts": ts}, nil)
		if err == nil && p["ok"] != true {
			e := errOf(p)
			err = &PostError{ts + " を消せませんでした: " + e + "\n" + deleteHint(e)}
		}
		if err != nil {
			// 1件の失敗で全部止めない。残りを消して、最後にまとめて報告する。
			failed = append(failed, err.Error())
			fmt.Fprintf(os.Stderr, "  %d/%d 失敗 %s\n", i+1, len(uniq), ts)
			continue
		}
		ok++
		fmt.Printf("  %d/%d 削除 %s\n", i+1, len(uniq), ts)
	}
	fmt.Printf("\n削除 %d件 / 失敗 %d件\n", ok, len(failed))
	if len(failed) > 0 {
		fmt.Fprintln(os.Stderr, "\n--- 失敗した分 ---")
		for _, f := range failed {
			fmt.Fprintln(os.Stderr, f)
		}
		return errSilent
	}
	return nil
}
