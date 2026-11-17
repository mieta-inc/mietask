package main

// 持ち案件の台帳（$H/data/projects.json）。
//
// 管理者が知りたいのは「その日に拾われたタスク」ではなく「この人がいま、どの案件を持っているか」。
// そこで各自の手元に持ち案件の一覧を置き、毎朝その日に動きがあった案件だけを本人の Claude が更新する
// （一言と最後に動いた日）。動きの無い日が続いた案件は、ここで決まりどおりに扱う。
//   - 最後に動いてから 3週間（idleDays）: 「しばらく動きなし」にする
//   - 最後に動いてから 6週間（dropDays）: 一覧から外す
// 管理者に送るのはこの一覧そのもの（案件名・関わり方・状態・一言・最後に動いた日）。タスクの題名や件数は送らない。

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	idleDays       = 21
	dropDays       = 42
	stateIdle      = "しばらく動きなし"
	projectNameMax = 30
	projectRoleMax = 12
	projectDetail  = 300 // 詳細の上限（ページでは開いたときに数行）
)

// 本人の Claude が付けられる状態（「しばらく動きなし」は日付から決まるので付けられない）
var touchStates = []string{"動いている", "相手待ち", "期限が過ぎたものあり"}

// 案件の段階（どこまで進んでいるか）
var projectStages = []string{"準備", "進行中", "仕上げ", "運用中"}

const projectNextMax = 30 // 次の節目の上限

type project struct {
	Name     string `json:"name"`
	Role     string `json:"role,omitempty"`
	Note     string `json:"note,omitempty"`
	Detail   string `json:"detail,omitempty"`    // 詳細（数行。ページではトグルで開く）
	Stage    string `json:"stage,omitempty"`     // 段階（準備・進行中・仕上げ・運用中）
	Next     string `json:"next,omitempty"`      // 次の節目（何が起きるか）
	NextDate string `json:"next_date,omitempty"` // 次の節目の日付（分かるときだけ）
	State    string `json:"state"`
	Since    string `json:"since"`
	LastSeen string `json:"last_seen"`
}

type projectBook struct {
	Projects []project `json:"projects"`
}

// その日の更新（本人の Claude が書く）
type projectUpdate struct {
	Touched []project `json:"touched"`
	Remove  []string  `json:"remove"`
	Rename  []struct {
		From string `json:"from"`
		To   string `json:"to"`
	} `json:"rename"`
}

func projectsPath() string { return filepath.Join(dataDir(), "projects.json") }

// 全角・半角の空白と区切りの違いは同じ案件とみなす
func projectKey(s string) string {
	r := strings.NewReplacer(" ", "", "　", "", "・", "", "･", "", "-", "", "_", "")
	return strings.ToLower(r.Replace(strings.TrimSpace(s)))
}

func loadBook() (*projectBook, error) {
	raw, err := os.ReadFile(projectsPath())
	if errors.Is(err, os.ErrNotExist) {
		return &projectBook{Projects: []project{}}, nil
	}
	if err != nil {
		return nil, err
	}
	var b projectBook
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, fmt.Errorf("%s が壊れています（%v）。%s.bak_* から戻してください", projectsPath(), err, projectsPath())
	}
	if b.Projects == nil {
		b.Projects = []project{}
	}
	return &b, nil
}

func saveBook(b *projectBook) error {
	raw, err := json.MarshalIndent(b, "", "  ")
	if err != nil {
		return err
	}
	path := projectsPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if info, err := os.Stat(path); err == nil {
		bak := path + ".bak_" + nowJST().Format("0102-150405")
		if err := copyFile(path, bak, info.ModTime()); err != nil {
			return fmt.Errorf("持ち案件の台帳のバックアップを取れませんでした: %w", err)
		}
		pruneBackups(path)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(raw, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func ymd(t interface{ Format(string) string }) string { return t.Format("2006-01-02") }

// ageBook は6週間動きの無い案件を外し、外した名前を返す
func ageBook(b *projectBook) []string {
	cut := ymd(todayJST().AddDate(0, 0, -dropDays))
	var keep []project
	var dropped []string
	for _, p := range b.Projects {
		if p.LastSeen != "" && p.LastSeen < cut {
			dropped = append(dropped, p.Name)
			continue
		}
		keep = append(keep, p)
	}
	if keep == nil {
		keep = []project{}
	}
	b.Projects = keep
	return dropped
}

// effectiveState は日付から見た状態（3週間動きが無ければ「しばらく動きなし」）
func effectiveState(p project) string {
	if p.LastSeen != "" && p.LastSeen < ymd(todayJST().AddDate(0, 0, -idleDays)) {
		return stateIdle
	}
	return p.State
}

func checkProjectText(where, label, v string, max int) error {
	switch {
	case utf8.RuneCountInString(v) > max:
		return fmt.Errorf("%s の%sが長すぎます（%d文字まで）: %s", where, label, max, v)
	case reShareBad.MatchString(v):
		return fmt.Errorf("%s の%sに改行・リンク・メンション・メールアドレスは入れられません: %s", where, label, v)
	}
	return nil
}

func (b *projectBook) find(name string) int {
	k := projectKey(name)
	for i, p := range b.Projects {
		if projectKey(p.Name) == k {
			return i
		}
	}
	return -1
}

// applyUpdate はその日の更新を台帳に入れる。形が違えば何も変えずに止まる
func applyUpdate(b *projectBook, u projectUpdate) ([]string, error) {
	today := ymd(todayJST())
	for i, p := range u.Touched {
		where := fmt.Sprintf("touched[%d]", i)
		p.Name = strings.TrimSpace(p.Name)
		if p.Name == "" {
			return nil, fmt.Errorf("%s の案件名が空です", where)
		}
		if !contains(touchStates, p.State) {
			return nil, fmt.Errorf("%s の状態は %s のどれかです（%q になっています）", where, strings.Join(touchStates, "・"), p.State)
		}
		for _, c := range []struct {
			label, v string
			max      int
		}{{"案件名", p.Name, projectNameMax}, {"関わり方", p.Role, projectRoleMax}, {"一言", p.Note, shareNoteMax}, {"詳細", p.Detail, projectDetail}, {"次の節目", p.Next, projectNextMax}} {
			if err := checkProjectText(where, c.label, strings.TrimSpace(c.v), c.max); err != nil {
				return nil, err
			}
		}
		if p.Stage != "" && !contains(projectStages, p.Stage) {
			return nil, fmt.Errorf("%s の段階は %s のどれかです（%q になっています）", where, strings.Join(projectStages, "・"), p.Stage)
		}
		if p.NextDate != "" && !reYMD.MatchString(p.NextDate) {
			return nil, fmt.Errorf("%s の次の節目の日付は yyyy-mm-dd で書きます（%q になっています）", where, p.NextDate)
		}
		if p.NextDate != "" && strings.TrimSpace(p.Next) == "" {
			return nil, fmt.Errorf("%s は次の節目の日付だけがあります。何が起きるか（next）も書いてください", where)
		}
	}
	for i, r := range u.Rename {
		if strings.TrimSpace(r.From) == "" || strings.TrimSpace(r.To) == "" {
			return nil, fmt.Errorf("rename[%d] の from と to が要ります", i)
		}
		if err := checkProjectText(fmt.Sprintf("rename[%d]", i), "案件名", r.To, projectNameMax); err != nil {
			return nil, err
		}
	}
	var notes []string
	for _, r := range u.Rename {
		i := b.find(r.From)
		if i < 0 {
			notes = append(notes, "名前を変える案件が見つかりません: "+r.From)
			continue
		}
		if j := b.find(r.To); j >= 0 && j != i {
			// まとめ先がもうあれば1つにする（新しく動いたほうの日付を残す）
			if b.Projects[i].LastSeen > b.Projects[j].LastSeen {
				b.Projects[j].LastSeen = b.Projects[i].LastSeen
			}
			if b.Projects[i].Since < b.Projects[j].Since && b.Projects[i].Since != "" {
				b.Projects[j].Since = b.Projects[i].Since
			}
			b.Projects = append(b.Projects[:i], b.Projects[i+1:]...)
			notes = append(notes, fmt.Sprintf("まとめました: %s → %s", r.From, r.To))
			continue
		}
		b.Projects[i].Name = strings.TrimSpace(r.To)
		notes = append(notes, fmt.Sprintf("名前を変えました: %s → %s", r.From, r.To))
	}
	for _, name := range u.Remove {
		i := b.find(name)
		if i < 0 {
			notes = append(notes, "外す案件が見つかりません: "+name)
			continue
		}
		b.Projects = append(b.Projects[:i], b.Projects[i+1:]...)
		notes = append(notes, "外しました: "+name)
	}
	for _, t := range u.Touched {
		t.Name, t.Role, t.Note, t.Detail = strings.TrimSpace(t.Name), strings.TrimSpace(t.Role), strings.TrimSpace(t.Note), strings.TrimSpace(t.Detail)
		if i := b.find(t.Name); i >= 0 {
			p := &b.Projects[i]
			p.State, p.LastSeen = t.State, today
			if t.Role != "" {
				p.Role = t.Role
			}
			if t.Note != "" {
				p.Note = t.Note
			}
			if t.Detail != "" {
				p.Detail = t.Detail
			}
			if t.Stage != "" {
				p.Stage = t.Stage
			}
			// 次の節目は、書いた日に日付ごと入れ替える（節目が過ぎて次に移ったとき、古い日付が残らないように）
			if strings.TrimSpace(t.Next) != "" {
				p.Next, p.NextDate = strings.TrimSpace(t.Next), t.NextDate
			}
			continue
		}
		b.Projects = append(b.Projects, project{Name: t.Name, Role: t.Role, Note: t.Note, Detail: t.Detail, Stage: t.Stage,
			Next: strings.TrimSpace(t.Next), NextDate: t.NextDate, State: t.State, Since: today, LastSeen: today})
		notes = append(notes, "足しました: "+t.Name)
	}
	return notes, nil
}

func sortedProjects(b *projectBook) []project {
	rank := map[string]int{"期限が過ぎたものあり": 0, "相手待ち": 1, "動いている": 2, stateIdle: 3}
	out := append([]project{}, b.Projects...)
	sort.SliceStable(out, func(i, j int) bool {
		si, sj := rank[effectiveState(out[i])], rank[effectiveState(out[j])]
		if si != sj {
			return si < sj
		}
		return out[i].LastSeen > out[j].LastSeen
	})
	return out
}

// projectShareItems は管理者に送る形（持ち案件の一覧そのもの）
func projectShareItems(b *projectBook) []shareItem {
	var items []shareItem
	for _, p := range sortedProjects(b) {
		items = append(items, shareItem{Name: p.Name, State: effectiveState(p), Note: p.Note, Detail: p.Detail, Role: p.Role, LastSeen: p.LastSeen,
			Stage: p.Stage, Next: p.Next, NextDate: p.NextDate})
	}
	if items == nil {
		items = []shareItem{}
	}
	return items
}

func printBook(b *projectBook) {
	ps := sortedProjects(b)
	fmt.Printf("持っている案件 %d件（3週間動きが無ければ「しばらく動きなし」、6週間で外れます）\n", len(ps))
	for _, p := range ps {
		l := "• " + p.Name
		if p.Role != "" {
			l += "（" + p.Role + "）"
		}
		l += " — " + effectiveState(p)
		if p.Stage != "" {
			l += "・" + p.Stage
		}
		if p.Note != "" {
			l += "：" + p.Note
		}
		l += "　最後に動いた " + shortDate(p.LastSeen)
		fmt.Println(l)
		if p.Next != "" {
			fmt.Println("    次: " + nextLabel(p.NextDate, p.Next))
		}
		if p.Detail != "" {
			fmt.Println("    " + p.Detail)
		}

	}
}

// loadAgedBook は台帳を読み、6週間動きの無い案件を外して（外したら保存して）返す
func loadAgedBook() (*projectBook, error) {
	b, err := loadBook()
	if err != nil {
		return nil, err
	}
	if dropped := ageBook(b); len(dropped) > 0 {
		if err := saveBook(b); err != nil {
			return nil, err
		}
		fmt.Printf("6週間動きが無かったので外しました: %s\n", strings.Join(dropped, "、"))
	}
	return b, nil
}

func runProjects(rest []string) error {
	if len(rest) == 0 {
		return errors.New("projects list | projects update --file FILE | projects remove NAME のどれかです。")
	}
	switch rest[0] {
	case "list":
		b, err := loadAgedBook()
		if err != nil {
			return err
		}
		printBook(b)
		return nil
	case "update":
		a, err := parseArgs(rest[1:])
		if err != nil {
			return err
		}
		path := a.get("file")
		if path == "" {
			return errors.New("--file が要ります。")
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("更新のファイルが見つかりません: %s", path)
		}
		var u projectUpdate
		if err := json.Unmarshal(raw, &u); err != nil {
			return fmt.Errorf("%s のJSONが壊れています: %v", path, err)
		}
		b, err := loadAgedBook()
		if err != nil {
			return err
		}
		notes, err := applyUpdate(b, u)
		if err != nil {
			return err
		}
		if err := saveBook(b); err != nil {
			return err
		}
		for _, n := range notes {
			fmt.Println(n)
		}
		printBook(b)
		consumeInput(path)
		return nil
	case "remove":
		if len(rest) < 2 || strings.TrimSpace(rest[1]) == "" {
			return errors.New("外す案件の名前を渡してください。例: projects remove \"渋谷区WS\"")
		}
		b, err := loadAgedBook()
		if err != nil {
			return err
		}
		notes, err := applyUpdate(b, projectUpdate{Remove: []string{rest[1]}})
		if err != nil {
			return err
		}
		if err := saveBook(b); err != nil {
			return err
		}
		for _, n := range notes {
			fmt.Println(n)
		}
		printBook(b)
		return nil
	}
	return fmt.Errorf("projects の使い方が違います: %s", rest[0])
}

// nextLabel は「11/25 項目を固める打合せ」。日付が無ければ「日付未定」
func nextLabel(date, text string) string {
	if date == "" {
		return "日付未定　" + text
	}
	return shortDate(date) + " " + text
}
