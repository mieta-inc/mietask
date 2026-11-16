package main

// 管理者向けの、案件ごとの要約。
//
// MTD はプログラム（授業）の案件のタスク管理で、社内の案件やリードしている仕事は出てこない。
// それを管理者が知れるように、各自のミエタスクが毎朝、その日の一覧を「案件ごとの状態」にまとめて窓口に送る。
// 送るのは 案件名・状態・次の期限 だけ。タスクの題名、メールや DM の文面、社外の人の名前は入れない
// （作るのは本人の手元の Claude。ここでは形と、リンク・メンション・メールアドレスが無いことを確かめる）。
// 管理者に届くのと同じものを、本人のチャンネルにも出す（何が上に見えているかを本人が知っているように）。

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

type shareItem struct {
	Name  string `json:"name"`
	State string `json:"state"`
	Due   string `json:"due,omitempty"`
}

var shareStates = []string{"動いている", "相手待ち", "期限が過ぎたものあり"}

const (
	shareMax     = 12
	shareNameMax = 40
)

var (
	reShareBad = regexp.MustCompile(`(?i)[\r\n<>@]|https?:`)
	reYMD      = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// loadShare は要約のファイル（{"items":[{"name","state","due"}]}）を読み、形を確かめる。
// 決まった項目のほかは読み捨てる（送らない）。
func loadShare(path string) ([]shareItem, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("要約のファイルが見つかりません: %s", path)
	}
	var doc struct {
		Items *[]map[string]any `json:"items"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("%s のJSONが壊れています: %v", path, err)
	}
	if doc.Items == nil {
		return nil, fmt.Errorf("%s に items がありません（MTD のほかの案件が無ければ空の配列にする）", path)
	}
	if len(*doc.Items) > shareMax {
		return nil, fmt.Errorf("要約は%d件までです（%d件あります）。案件をまとめてください", shareMax, len(*doc.Items))
	}
	out := make([]shareItem, 0, len(*doc.Items))
	for i, it := range *doc.Items {
		where := fmt.Sprintf("items[%d]", i)
		name, _ := it["name"].(string)
		name = strings.TrimSpace(name)
		state, _ := it["state"].(string)
		due, _ := it["due"].(string)
		switch {
		case name == "":
			return nil, fmt.Errorf("%s の案件名が空です", where)
		case utf8.RuneCountInString(name) > shareNameMax:
			return nil, fmt.Errorf("%s の案件名が長すぎます（%d文字まで）: %s", where, shareNameMax, name)
		case reShareBad.MatchString(name):
			return nil, fmt.Errorf("%s の案件名に改行・リンク・メンション・メールアドレスは入れられません: %s", where, name)
		case !contains(shareStates, state):
			return nil, fmt.Errorf("%s の状態は %s のどれかです（%q になっています）", where, strings.Join(shareStates, "・"), state)
		case due != "" && !reYMD.MatchString(due):
			return nil, fmt.Errorf("%s の期限は yyyy-mm-dd で書きます（%q になっています）", where, due)
		}
		out = append(out, shareItem{Name: name, State: state, Due: due})
	}
	return out, nil
}

func contains(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}

func shortDate(ymd string) string {
	p := strings.Split(ymd, "-")
	if len(p) != 3 {
		return ymd
	}
	m, _ := strconv.Atoi(p[1])
	d, _ := strconv.Atoi(p[2])
	return fmt.Sprintf("%d/%d", m, d)
}

// sharePreview は本人のチャンネルに出す「管理者に届く内容」。
func sharePreview(items []shareItem) string {
	lines := []string{":eyes: *管理者に届く内容*（チームのまとめに、案件ごとの状態だけが出ます。タスクの題名・メールやDMの中身は届きません）"}
	if len(items) == 0 {
		lines = append(lines, "• MTDのほかの案件なし")
	}
	for _, it := range items {
		l := "• " + it.Name + " — " + it.State
		if it.Due != "" {
			l += "（次の期限 " + shortDate(it.Due) + "）"
		}
		lines = append(lines, l)
	}
	return strings.Join(lines, "\n")
}

// sendShare は要約を窓口に送る。管理台帳を使っていなければ何もしない。
func sendShare(items []shareItem, dryRun bool) error {
	if dryRun {
		fmt.Printf("[dry-run] 管理者向けの要約（%d件）は送りません\n", len(items))
		return nil
	}
	k := relayKeyFromFile()
	if k == nil {
		fmt.Println("管理台帳を使っていないので、管理者向けの要約は送りません。")
		return nil
	}
	p := relayVersionParams()
	p["items"] = items
	if _, err := relayCall(k, "share", p); err != nil {
		return err
	}
	fmt.Printf("管理者向けの要約を送りました（%d件）\n", len(items))
	return nil
}

func cmdShare(path string, dryRun bool) error {
	if path == "" {
		return errors.New("--file が要ります。")
	}
	items, err := loadShare(path)
	if err != nil {
		return err
	}
	if dryRun {
		fmt.Println(sharePreview(items))
	}
	if err := sendShare(items, dryRun); err != nil {
		return err
	}
	if !dryRun {
		consumeInput(path)
	}
	return nil
}

// withSharePreview は投稿内容の子スレッドの最後に「管理者に届く内容」を足した一時ファイルを作り、そのパスを返す。
// 元のファイルは書き換えない。
func withSharePreview(payloadPath string, items []shareItem) (string, error) {
	if payloadPath == "" {
		return "", errors.New("--share は --payload と一緒に使ってください。")
	}
	raw, err := os.ReadFile(payloadPath)
	if err != nil {
		return "", &PostError{"payloadが見つかりません: " + payloadPath}
	}
	v, err := ParseJSON(raw)
	if err != nil {
		return "", &PostError{payloadPath + " のJSONが壊れています: " + err.Error()}
	}
	data, ok := v.(*Obj)
	if !ok {
		return "", &PostError{payloadPath + " のトップレベルはオブジェクトである必要があります。"}
	}
	replies, _ := getDefault(data, "replies", []any{}).([]any)
	data.Set("replies", append(append([]any{}, replies...), sharePreview(items)))
	dir, err := tmpDir()
	if err != nil {
		return "", err
	}
	out := filepath.Join(dir, fmt.Sprintf("post-with-share-%d.json", os.Getpid()))
	if err := os.WriteFile(out, []byte(DumpJSON(data, 0)), 0o600); err != nil {
		return "", err
	}
	return out, nil
}
