package main

// 巡回結果を tasks.json に登録し、Slackスレッドへの返信を反映する。
//
// 毎朝の流れ:
//
//	1. sync complete  前日のスレッド返信を読んで、完了・ステイ・メモ・追加を反映する
//	2. sync upsert    今日の巡回結果を tasks.json に登録し、表示番号 → task.id を記録する
//	3. post           自分のチャンネルに投げる
//	4. sync record    投稿したスレッドの ts を控える（翌朝これを読む）
//
// tasks.json は唯一の正。壊さないために:
//   - 書き込み前に必ずバックアップを取る（直近 keepBackups 件だけ残す）
//   - 一時ファイルに書いてから置き換える（途中で死んでも元が残る）
//   - done / dropped のタスクを open に戻すことは絶対にしない
//   - 解決できなかった返信は黙って捨てず、必ず報告する

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type SyncError struct{ msg string }

func (e *SyncError) Error() string { return e.msg }

// 完了として扱う status。ここに入っているものは巡回で復活させない。
var closedStatus = map[string]bool{"done": true, "dropped": true}

// 「本人が動かすと決めたもの」。巡回で再発見されなくても毎朝出し直す。
// later（今週はやらない）と blocked（相手待ち）は、巡回が拾ったときだけ出す。
var actionable = map[string]bool{"next": true, "open": true, "doing": true}

// 区分 → 新規タスクの初期 status
var sectionStatus = map[string]string{
	"overdue": "next",
	"today":   "next",
	"week":    "next",
	"watch":   "later",
	"waiting": "blocked",
}

// 本人が手で動かしてよい status。done はここに無い。
// 完了は「N完了」の返信から complete で入れる道だけにしてある
// （完了の記録が「いつ・どの返信で」に紐づかなくなるのを防ぐため）。
var settable = []string{"blocked", "doing", "dropped", "later", "next", "open"}

// 台帳のバックアップを残す数。以前は無限に溜まっていた。
const keepBackups = 30

var jst = time.FixedZone("JST", 9*60*60)

// nowJST は現在時刻。MIETASK_FAKE_NOW（RFC3339）があればそれを使う（テストで時刻を固定するため）。
func nowJST() time.Time {
	if s := os.Getenv("MIETASK_FAKE_NOW"); s != "" {
		if t, err := time.Parse(time.RFC3339, s); err == nil {
			return t.In(jst)
		}
	}
	return time.Now().In(jst)
}

func nowStamp() string { return nowJST().Format("2006-01-02T15:04:05-07:00") }

func todayJST() time.Time {
	n := nowJST()
	return time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, time.UTC)
}

func status(t *Obj) string { return str(t.Val("status")) }

func isClosed(t *Obj) bool { return closedStatus[status(t)] }

func loadLedger(path string) (*Obj, error) {
	o, exists, err := readJSONObj(path)
	if !exists && err == nil {
		// 初回に素の「見つかりません」を出すと何をすればいいか分からない。
		return nil, &SyncError{"見つかりません: " + path + "\n" +
			"  まだセットアップが済んでいないかもしれません。\n" +
			"  Claude Code で /mietask:setup と打ってください。"}
	}
	if err != nil {
		return nil, &SyncError{path + " のJSONが壊れています: " + err.Error()}
	}
	return o, nil
}

// saveLedger はバックアップしてから、一時ファイル経由で置き換える。
func saveLedger(path string, data *Obj, dryRun bool) error {
	if dryRun {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if info, err := os.Stat(path); err == nil {
		bak := path + ".bak_" + nowJST().Format("0102-150405")
		if err := copyFile(path, bak, info.ModTime()); err != nil {
			return fmt.Errorf("バックアップを取れませんでした: %w", err)
		}
		pruneBackups(path)
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(DumpJSON(data, 2)+"\n"), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func copyFile(src, dst string, mtime time.Time) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Chtimes(dst, mtime, mtime)
}

// 自動で取ったバックアップ（.bak_MMDD-HHMMSS）だけを対象にする。手で取った .bak_xxx は消さない。
var reAutoBackup = regexp.MustCompile(`\.bak_\d{4}-\d{6}$`)

func pruneBackups(path string) {
	matches, err := filepath.Glob(path + ".bak_*")
	if err != nil {
		return
	}
	type f struct {
		p string
		t time.Time
	}
	var files []f
	for _, m := range matches {
		if !reAutoBackup.MatchString(m) {
			continue
		}
		if info, err := os.Stat(m); err == nil {
			files = append(files, f{m, info.ModTime()})
		}
	}
	if len(files) <= keepBackups {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].t.After(files[j].t) })
	for _, x := range files[keepBackups:] {
		_ = os.Remove(x.p)
	}
}

func tasksList(data *Obj) ([]*Obj, error) {
	arr, ok := data.Val("tasks").([]any)
	if !ok {
		return nil, &SyncError{"tasks.json に tasks の一覧がありません"}
	}
	out := make([]*Obj, 0, len(arr))
	for _, v := range arr {
		t, ok := v.(*Obj)
		if !ok {
			return nil, &SyncError{"tasks.json の tasks にオブジェクトでない要素があります"}
		}
		out = append(out, t)
	}
	return out, nil
}

func taskID(t *Obj) string { return pyStr(t.Val("id")) }

// nextTaskID は既存の最大IDの次を返す。tasks.json の next_id は古いことがあるので信用しない。
func nextTaskID(tasks []*Obj) int {
	maxN, any := 0, false
	for _, t := range tasks {
		n := 0
		for _, r := range taskID(t) {
			if v := digitValue(r); v >= 0 {
				n = n*10 + v
			}
		}
		if !any || n > maxN {
			maxN, any = n, true
		}
	}
	if !any {
		return 1
	}
	return maxN + 1
}

func refKey(v any) string {
	if !truthy(v) {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return DumpJSON(v, 0)
}

func byRef(tasks []*Obj) map[string]*Obj {
	out := map[string]*Obj{}
	for _, t := range tasks {
		ref := refKey(orObj(t.Val("source")).Val("ref"))
		if ref != "" {
			if _, ok := out[ref]; !ok {
				out[ref] = t
			}
		}
	}
	return out
}

func getThread(state *Obj) *Obj { return state.SetDefaultObj("slack_thread") }

// dismissedRefs は却下済みrefを集める。
// state.json は {"ref":…, "reason":…, "at":…} の辞書、tasks.json は文字列と形が違う。どちらも受ける。
func dismissedRefs(sources ...*Obj) map[string]bool {
	out := map[string]bool{}
	for _, src := range sources {
		arr, _ := src.Val("dismissed_refs").([]any)
		for _, item := range arr {
			switch x := item.(type) {
			case string:
				out[x] = true
			case *Obj:
				if r := refKey(x.Val("ref")); r != "" {
					out[r] = true
				}
			}
		}
	}
	return out
}

func memoDate(at any) string {
	s, ok := at.(string)
	if !ok {
		return ""
	}
	for _, layout := range []string{
		"2006-01-02T15:04:05.999999-07:00", "2006-01-02T15:04:05-07:00", "2006-01-02T15:04-07:00",
		"2006-01-02T15:04:05.999999", "2006-01-02T15:04:05", "2006-01-02T15:04", "2006-01-02",
	} {
		if d, err := time.Parse(layout, s); err == nil {
			return fmt.Sprintf("%d/%d", int(d.Month()), d.Day())
		}
	}
	return ""
}

// ---------------------------------------------------------------- upsert

func cmdUpsert(findingsPath string, carryOver, dryRun bool) error {
	raw, err := os.ReadFile(findingsPath)
	if err != nil {
		return err
	}
	fv, err := ParseJSON(raw)
	if err != nil {
		return &SyncError{findingsPath + " のJSONが壊れています: " + err.Error()}
	}
	findings, ok := fv.([]any)
	if !ok {
		return &SyncError{"findings はタスクのリストである必要があります。"}
	}

	data, err := loadLedger(tasksPath())
	if err != nil {
		return err
	}
	state, err := loadLedger(statePath())
	if err != nil {
		return err
	}
	tasks, err := tasksList(data)
	if err != nil {
		return err
	}
	index := byRef(tasks)
	dismissed := dismissedRefs(data, state)

	nid := nextTaskID(tasks)
	stamp := nowStamp()
	mapping := NewObj()
	var created, updated, skipped []string
	number := 0

	for _, fvItem := range findings {
		f, ok := fvItem.(*Obj)
		if !ok {
			return &SyncError{"findings の要素がオブジェクトではありません"}
		}
		src := orObj(f.Val("source"))
		ref := refKey(src.Val("ref"))
		if ref == "" {
			return &SyncError{"source.ref がありません: " + pyRepr(f.Val("title"))}
		}
		if dismissed[ref] {
			skipped = append(skipped, pyStr(f.Val("title"))+" ← 対応不要として却下済み")
			continue
		}
		hit := index[ref]
		if hit != nil && isClosed(hit) {
			skipped = append(skipped, fmt.Sprintf("%s ← %s は %s 済み", pyStr(f.Val("title")), taskID(hit), pyStr(hit.Val("status"))))
			continue
		}

		number++
		if hit != nil {
			// 既存。status は触らない（本人が決めたものを巡回で戻さない）。
			hit.Set("last_seen_at", stamp)
			for _, k := range []string{"due", "due_confidence", "priority", "next_action"} {
				v := f.Val(k)
				if v != nil && !pyEqual(v, "") {
					hit.Set(k, v)
				}
			}
			mapping.Set(fmt.Sprint(number), taskID(hit))
			updated = append(updated, taskID(hit))
		} else {
			tid := fmt.Sprintf("t%03d", nid)
			nid++
			st := "next"
			if s, ok := getDefault(f, "section", "").(string); ok {
				if v, ok := sectionStatus[s]; ok {
					st = v
				}
			}
			t := NewObj()
			t.Set("id", tid)
			t.Set("title", getDefault(f, "title", ""))
			t.Set("due", f.Val("due"))
			t.Set("due_confidence", getDefault(f, "due_confidence", "inferred"))
			t.Set("status", st)
			t.Set("priority", getDefault(f, "priority", "P3"))
			t.Set("source", src)
			t.Set("notes", getDefault(f, "notes", ""))
			t.Set("next_action", getDefault(f, "next_action", ""))
			t.Set("project", f.Val("project"))
			t.Set("detected_at", stamp)
			t.Set("last_seen_at", stamp)
			tasks = append(tasks, t)
			mapping.Set(fmt.Sprint(number), tid)
			created = append(created, tid)
		}
	}

	// 巡回で再発見されなかった既存タスクを拾い直す。
	// これが無いと「tasks.json にあるが今日は誰も触れていない」タスクが永久に沈む。
	type carriedT struct {
		t       *Obj
		section string
		number  int
	}
	var carried []carriedT
	if carryOver {
		today := todayJST().Format("2006-01-02")
		mapped := map[string]bool{}
		for _, k := range mapping.Keys() {
			mapped[pyStr(mapping.Val(k))] = true
		}
		for _, t := range tasks {
			if mapped[taskID(t)] || isClosed(t) {
				continue
			}
			// ステイ指定は相手待ち・保留中でも翌朝は必ず出す（そのまま出す、の約束）
			if !actionable[status(t)] && !truthy(t.Val("stay_pending")) {
				continue
			}
			due := t.Val("due")
			var section string
			switch {
			case status(t) == "blocked":
				section = "waiting"
			case truthy(due) && str(due) < today:
				section = "overdue"
			case str(due) == today && due != nil:
				section = "today"
			default:
				section = "week"
			}
			number++
			mapping.Set(fmt.Sprint(number), taskID(t))
			carried = append(carried, carriedT{t, section, number})
		}
	}

	// ステイの約束は「翌朝1回出す」まで。出したら外す。
	shown := map[string]bool{}
	for _, k := range mapping.Keys() {
		shown[pyStr(mapping.Val(k))] = true
	}
	for _, t := range tasks {
		if shown[taskID(t)] {
			t.Delete("stay_pending")
		}
	}

	arr := make([]any, len(tasks))
	for i, t := range tasks {
		arr[i] = t
	}
	data.Set("tasks", arr)
	data.Set("next_id", nid)
	data.Set("updated_at", stamp)

	thread := getThread(state)
	thread.Set("mapping", mapping)
	thread.Set("mapped_at", stamp)
	// 新しい投稿の ts はまだ無い。record で入るまで前日のものを残さない。
	thread.Delete("ts")
	state.Set("last_sweep_at", stamp)

	if err := saveLedger(tasksPath(), data, dryRun); err != nil {
		return err
	}
	if err := saveLedger(statePath(), state, dryRun); err != nil {
		return err
	}

	tag := ""
	if dryRun {
		tag = "[dry-run] "
	}
	fmt.Printf("%s新規 %d件 / 既存更新 %d件 / 繰り越し %d件 / 除外 %d件\n", tag, len(created), len(updated), len(carried), len(skipped))
	if len(created) > 0 {
		fmt.Println("  新規:", strings.Join(created, ", "))
	}
	for _, s := range skipped {
		fmt.Println("  除外:", s)
	}

	if len(carried) > 0 {
		// 繰り越し分は findings に無いので、投稿に載せるための情報をここで出す。
		fmt.Println("\n巡回では拾われなかったが、未完了なので一覧に載せるもの:")
		for _, c := range carried {
			due := "期限なし"
			if truthy(c.t.Val("due")) {
				due = pyStr(c.t.Val("due"))
			}
			fmt.Printf("  %d. [%s] %s %s %s  期限 %s\n", c.number, c.section, taskID(c.t),
				pyStr(getDefault(c.t, "priority", "")), pyStr(getDefault(c.t, "title", "")), due)
			if truthy(c.t.Val("next_action")) {
				fmt.Printf("      → 次の一手: %s\n", pyStr(c.t.Val("next_action")))
			}
		}
	}

	// 前回のメモとステイ回数。投稿のタスク行の下に添える。
	byID := map[string]*Obj{}
	for _, t := range tasks {
		byID[taskID(t)] = t
	}
	var noteLines []string
	for _, n := range mapping.Keys() {
		tid := pyStr(mapping.Val(n))
		t := byID[tid]
		if t == nil {
			t = NewObj()
		}
		memo := orObj(t.Val("last_memo"))
		stays := t.Val("stay_count")
		if truthy(memo.Val("text")) || truthy(stays) {
			var parts []string
			if truthy(memo.Val("text")) {
				parts = append(parts, fmt.Sprintf("📝 %sのメモ: %s", memoDate(memo.Val("at")), pyStr(memo.Val("text"))))
			}
			if truthy(stays) {
				parts = append(parts, fmt.Sprintf("↻ ステイ%s回", pyStr(stays)))
			}
			noteLines = append(noteLines, fmt.Sprintf("  %s → %s  %s", n, tid, strings.Join(parts, "  ")))
		}
	}
	if len(noteLines) > 0 {
		fmt.Println("\n前回のメモ・ステイ（タスク行の下に添える）:")
		for _, l := range noteLines {
			fmt.Println(l)
		}
	}

	fmt.Println("\n表示番号 → task.id")
	for _, n := range mapping.Keys() {
		fmt.Printf("  %s → %s\n", n, pyStr(mapping.Val(n)))
	}
	return nil
}

// ---------------------------------------------------------------- complete

func cmdComplete(repliesPath string, allowNoMapping bool, onlyUser string, dryRun bool) error {
	raw, err := os.ReadFile(repliesPath)
	if err != nil {
		return err
	}
	rv, err := ParseJSON(raw)
	if err != nil {
		return &SyncError{repliesPath + " のJSONが壊れています: " + err.Error()}
	}
	var replies []any
	switch x := rv.(type) {
	case []any:
		replies = x
	case *Obj:
		replies, _ = getDefault(x, "replies", []any{}).([]any)
	}

	// Botが投げた子スレッド自身を読み返して誤爆しないよう、本人の発言だけに絞る。
	var texts []string
	droppedOthers := 0
	for _, r := range replies {
		switch x := r.(type) {
		case string:
			texts = append(texts, x)
		case *Obj:
			user := ""
			if truthy(x.Val("user")) {
				user = pyStr(x.Val("user"))
			}
			if truthy(x.Val("bot_id")) || (onlyUser != "" && user != "" && user != onlyUser) {
				droppedOthers++
				continue
			}
			texts = append(texts, str(getDefault(x, "text", "")))
		}
	}
	if droppedOthers > 0 {
		fmt.Printf("（本人以外の発言 %d件は読み飛ばしました）\n", droppedOthers)
	}

	state, err := loadLedger(statePath())
	if err != nil {
		return err
	}
	mapping := orObj(getThread(state).Val("mapping"))
	if len(mapping.Keys()) == 0 && !allowNoMapping {
		return &SyncError{"番号 → task.id の対応がありません。前回の upsert が走っていない可能性があります。\n" +
			"  番号指定を無視してIDだけ拾うなら --allow-no-mapping を付けてください。"}
	}

	texts, adds := splitAdds(texts)
	ids, stayIDs, memos, unresolved := parseReplies(texts, mapping)
	if len(ids)+len(stayIDs)+len(memos)+len(unresolved)+len(adds) == 0 {
		fmt.Println("完了・ステイ・メモ・追加の返信はありませんでした。")
		return nil
	}
	threadTS := ""
	if v := getThread(state).Val("ts"); truthy(v) {
		threadTS = pyStr(v)
	}

	data, err := loadLedger(tasksPath())
	if err != nil {
		return err
	}
	tasks, err := tasksList(data)
	if err != nil {
		return err
	}
	index := map[string]*Obj{}
	for _, t := range tasks {
		index[taskID(t)] = t
	}
	stamp := nowStamp()
	var done, already, missing []string
	doneIDs := map[string]bool{}

	for _, tid := range ids {
		t := index[tid]
		if t == nil {
			missing = append(missing, tid)
			continue
		}
		if isClosed(t) {
			already = append(already, fmt.Sprintf("%s（すでに %s）", tid, pyStr(t.Val("status"))))
			continue
		}
		t.Set("status", "done")
		t.Set("completed_at", stamp)
		done = append(done, tid+" "+pyStr(getDefault(t, "title", "")))
		doneIDs[pySplitFirst(tid+" x")] = true
	}

	// ステイ: status は変えない。翌朝必ず出す印を付け、回数を数える。
	// 同じスレッドを二度読んでも回数が増えないよう、スレッドの ts で重複を弾く。
	var stayed []string
	for _, tid := range stayIDs {
		t := index[tid]
		if t == nil {
			missing = append(missing, tid)
			continue
		}
		if isClosed(t) {
			already = append(already, fmt.Sprintf("%s（すでに %s。ステイは効きません）", tid, pyStr(t.Val("status"))))
			continue
		}
		if doneIDs[tid] {
			continue // 同じ返信で完了とステイが両方あれば完了を優先
		}
		t.Set("stay_pending", true)
		if threadTS == "" || !pyEqual(t.Val("last_stay_ts"), threadTS) {
			t.Set("stay_count", pyInt(t.Val("stay_count"))+1)
			t.Set("last_stay_ts", threadTS)
		}
		t.Set("last_stay_at", stamp)
		stayed = append(stayed, fmt.Sprintf("%s %s（%s回目）", tid, pyStr(getDefault(t, "title", "")), pyStr(t.Val("stay_count"))))
	}

	// メモ: 同じスレッドの同じ文は二度足さない。
	var noted []string
	for _, mm := range memos {
		tid, memo := mm[0], mm[1]
		t := index[tid]
		if t == nil {
			missing = append(missing, tid)
			continue
		}
		history, isList := t.Val("memos").([]any)
		if !t.Has("memos") {
			history, isList = []any{}, true
			t.Set("memos", history)
		}
		dup := false
		for _, h := range history {
			if ho, ok := h.(*Obj); ok && pyEqual(ho.Val("text"), memo) && pyEqual(ho.Val("thread_ts"), threadTS) {
				dup = true
				break
			}
		}
		if dup {
			continue
		}
		entry := NewObj()
		entry.Set("at", stamp)
		entry.Set("text", memo)
		entry.Set("thread_ts", threadTS)
		if isList {
			t.Set("memos", append(history, entry))
		}
		t.Set("last_memo", entry)
		noted = append(noted, tid+" 📝 "+memo)
	}

	// 追加: 新しいタスクとして足す。ref はスレッドと本文から作るので、同じスレッドを二度読んでも二重にならない。
	var added []string
	if len(adds) > 0 {
		refs := byRef(tasks)
		nid := nextTaskID(tasks)
		today := todayJST()
		for _, body := range adds {
			sum := sha1.Sum([]byte(body))
			h := hex.EncodeToString(sum[:])[:10]
			thr := threadTS
			if thr == "" {
				thr = "nothread"
			}
			ref := "manual:" + thr + ":" + h
			if refs[ref] != nil {
				continue
			}
			title, due := parseAdd(body, today)
			tid := fmt.Sprintf("t%03d", nid)
			nid++
			srcObj := NewObj()
			srcObj.Set("app", "manual")
			srcObj.Set("ref", ref)
			srcObj.Set("url", "")
			srcObj.Set("from", "本人が追加")
			t := NewObj()
			t.Set("id", tid)
			t.Set("title", title)
			if due != "" {
				t.Set("due", due)
				t.Set("due_confidence", "explicit")
			} else {
				t.Set("due", nil)
				t.Set("due_confidence", nil)
			}
			t.Set("status", "next")
			if due != "" {
				t.Set("priority", "P2")
			} else {
				t.Set("priority", "P3")
			}
			t.Set("source", srcObj)
			t.Set("notes", "")
			t.Set("next_action", "")
			t.Set("project", nil)
			t.Set("detected_at", stamp)
			t.Set("last_seen_at", stamp)
			tasks = append(tasks, t)
			refs[ref] = t
			if due != "" {
				added = append(added, fmt.Sprintf("%s %s（期限 %s）", tid, title, due))
			} else {
				added = append(added, fmt.Sprintf("%s %s（期限なし）", tid, title))
			}
		}
		arr := make([]any, len(tasks))
		for i, t := range tasks {
			arr[i] = t
		}
		data.Set("tasks", arr)
		data.Set("next_id", nid)
	}

	if len(done)+len(stayed)+len(noted)+len(added) > 0 {
		data.Set("updated_at", stamp)
		if err := saveLedger(tasksPath(), data, dryRun); err != nil {
			return err
		}
	}

	tag := ""
	if dryRun {
		tag = "[dry-run] "
	}
	fmt.Printf("%s完了 %d件 / ステイ %d件 / メモ %d件 / 追加 %d件\n", tag, len(done), len(stayed), len(noted), len(added))
	for _, d := range done {
		fmt.Println("  done:", d)
	}
	for _, s := range stayed {
		fmt.Println("  ステイ:", s)
	}
	for _, n := range noted {
		fmt.Println("  メモ:", n)
	}
	for _, a := range added {
		fmt.Println("  追加:", a)
	}
	// 握りつぶさない。拾えなかったものは必ず出す。
	for _, a := range already {
		fmt.Println("  変更なし:", a)
	}
	for _, m := range missing {
		fmt.Println("  ⚠ 該当なし:", m, "← tasks.json にこのIDがありません")
	}
	for _, u := range unresolved {
		fmt.Println("  ⚠ 解決できず:", u, "← 番号が前回の一覧にありません")
	}
	return nil
}

// ---------------------------------------------------------------- status

// cmdStatus は変更できなかったものがあれば changedAll=false を返す（終了コード1にする）。
func cmdStatus(ids []string, newStatus, note string, reopen, dryRun bool) (bool, error) {
	ok := false
	for _, s := range settable {
		if s == newStatus {
			ok = true
		}
	}
	if !ok {
		return false, &SyncError{newStatus + " には変えられません。指定できるのは: " + strings.Join(settable, " / ") +
			"\n  完了は complete（スレッドの「N完了」）から入れてください。"}
	}

	data, err := loadLedger(tasksPath())
	if err != nil {
		return false, err
	}
	tasks, err := tasksList(data)
	if err != nil {
		return false, err
	}
	index := map[string]*Obj{}
	for _, t := range tasks {
		index[taskID(t)] = t
	}
	stamp := nowStamp()
	var changed, missing, blocked []string
	anyChange := false

	for _, tid := range ids {
		t := index[tid]
		if t == nil {
			missing = append(missing, tid)
			continue
		}
		old := t.Val("status")
		if closedStatus[str(old)] && !reopen {
			// done / dropped を黙って開け直さない。戻すなら意思表示を要求する。
			blocked = append(blocked, fmt.Sprintf("%s（%s のまま。戻すなら --reopen）", tid, pyStr(old)))
			continue
		}
		if pyEqual(old, newStatus) {
			changed = append(changed, fmt.Sprintf("%s 変更なし（すでに %s）", tid, pyStr(old)))
			continue
		}
		t.Set("status", newStatus)
		t.Set("status_changed_at", stamp)
		if note != "" {
			notes := pyRstrip(str(t.Val("notes")))
			if !truthy(t.Val("notes")) {
				notes = ""
			}
			t.Set("notes", pyStrip(notes+"\n"+stamp[:10]+" "+note))
		}
		changed = append(changed, fmt.Sprintf("%s %s → %s  %s", tid, pyStr(old), newStatus, pyStr(getDefault(t, "title", ""))))
		anyChange = true
	}

	if anyChange {
		data.Set("updated_at", stamp)
		if err := saveLedger(tasksPath(), data, dryRun); err != nil {
			return false, err
		}
	}

	tag := ""
	if dryRun {
		tag = "[dry-run] "
	}
	fmt.Printf("%s%d件を処理\n", tag, len(ids))
	for _, c := range changed {
		fmt.Println("   " + c)
	}
	for _, b := range blocked {
		fmt.Println("  ⚠ 変更せず:", b)
	}
	for _, m := range missing {
		fmt.Println("  ⚠ 該当なし:", m, "← tasks.json にこのIDがありません")
	}
	return len(missing) == 0 && len(blocked) == 0, nil
}

// ---------------------------------------------------------------- record / thread

func cmdRecord(ts, channel string, dryRun bool) error {
	state, err := loadLedger(statePath())
	if err != nil {
		return err
	}
	thread := getThread(state)
	thread.Set("ts", ts)
	thread.Set("channel", channel)
	thread.Set("posted_at", nowStamp())
	if err := saveLedger(statePath(), state, dryRun); err != nil {
		return err
	}
	tag := ""
	if dryRun {
		tag = "[dry-run] "
	}
	fmt.Printf("%sスレッドを記録: %s / %s\n", tag, channel, ts)
	return nil
}

func cmdThread() error {
	state, err := loadLedger(statePath())
	if err != nil {
		return err
	}
	thread := getThread(state)
	if !truthy(thread.Val("ts")) {
		fmt.Println("前回のスレッドは記録されていません（初回、または record が走っていない）。")
		return nil
	}
	fmt.Println(DumpJSON(thread, 2))
	return nil
}
