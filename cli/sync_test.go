package main

// 毎朝の流れ（登録 → 投稿の記録 → 翌朝の返信反映 → 状態変更）を一時フォルダで通す回帰テスト。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func setupHome(t *testing.T) string {
	t.Helper()
	h := t.TempDir()
	t.Setenv("MIETASK_HOME", h)
	t.Setenv("MIETASK_FAKE_NOW", "2026-11-16T07:00:00+09:00")
	must(t, os.MkdirAll(filepath.Join(h, "data"), 0o755))
	write(t, filepath.Join(h, "config.json"), `{"owner": {"slack_user_id": "U1", "name": "テスト"}}`)
	write(t, filepath.Join(h, "slack-post.json"), `{"channel": "C1"}`)
	write(t, filepath.Join(h, "data", "tasks.json"), `{"version": 1, "tasks": [
	  {"id": "t001", "title": "見積書", "due": "2026-11-10", "status": "next", "source": {"ref": "slack:a"}},
	  {"id": "t002", "title": "相手待ち", "status": "blocked", "source": {"ref": "slack:b"}},
	  {"id": "t003", "title": "済んだもの", "status": "done", "source": {"ref": "slack:c"}}
	], "dismissed_refs": ["slack:x"]}`)
	write(t, filepath.Join(h, "data", "state.json"), `{}`)
	return h
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, p, s string) { t.Helper(); must(t, os.WriteFile(p, []byte(s), 0o644)) }

func loadTask(t *testing.T, id string) *Obj {
	t.Helper()
	data, err := loadLedger(tasksPath())
	must(t, err)
	tasks, err := tasksList(data)
	must(t, err)
	for _, x := range tasks {
		if taskID(x) == id {
			return x
		}
	}
	return nil
}

func TestDailyFlow(t *testing.T) {
	h := setupHome(t)
	f := filepath.Join(h, "f.json")
	write(t, f, `[
	  {"title": "見積書", "source": {"ref": "slack:a"}, "priority": "P1"},
	  {"title": "済んだもの", "source": {"ref": "slack:c"}},
	  {"title": "却下済み", "source": {"ref": "slack:x"}},
	  {"title": "新しい依頼", "source": {"ref": "slack:new"}, "section": "today"}
	]`)
	must(t, cmdUpsert(f, true, false))

	// 済んだもの・却下済みは出さない。既存の t001 は1番、新規は t004 で2番
	st, _ := loadLedger(statePath())
	mapping := orObj(getThread(st).Val("mapping"))
	if got := DumpJSON(mapping, 0); got != "{\n\"1\": \"t001\",\n\"2\": \"t004\"\n}" {
		t.Fatalf("mapping = %s", got)
	}
	if p := loadTask(t, "t001").Val("priority"); p != "P1" {
		t.Errorf("既存タスクの優先度が更新されていない: %v", p)
	}

	must(t, cmdRecord("1794800000.000100", "C1", false))

	r := filepath.Join(h, "r.json")
	write(t, r, `[
	  {"user": "U1", "text": "1完了\n2ステイ 来週決める\n追加 資料を作る 11/20まで"},
	  {"user": "U2", "text": "2完了"},
	  {"bot_id": "B1", "text": "2完了"}
	]`)
	must(t, cmdComplete(r, false, "U1", false))

	if s := status(loadTask(t, "t001")); s != "done" {
		t.Errorf("t001 が done になっていない: %s", s)
	}
	t4 := loadTask(t, "t004")
	if status(t4) != "next" || !truthy(t4.Val("stay_pending")) || pyInt(t4.Val("stay_count")) != 1 {
		t.Errorf("ステイが反映されていない: %s", DumpJSON(t4, 0))
	}
	if memo := orObj(t4.Val("last_memo")).Val("text"); memo != "来週決める" {
		t.Errorf("メモが残っていない: %v", memo)
	}
	t5 := loadTask(t, "t005")
	if t5 == nil || t5.Val("title") != "資料を作る" || t5.Val("due") != "2026-11-20" || t5.Val("priority") != "P2" {
		t.Errorf("追加が反映されていない: %v", t5)
	}

	// 同じスレッドをもう一度読んでも、ステイ回数・メモ・追加は増えない
	must(t, cmdComplete(r, false, "U1", false))
	if n := pyInt(loadTask(t, "t004").Val("stay_count")); n != 1 {
		t.Errorf("二度読みでステイ回数が増えた: %d", n)
	}
	if loadTask(t, "t006") != nil {
		t.Error("二度読みで追加が二重になった")
	}

	// done は黙って開け直さない
	ok, err := cmdStatus([]string{"t001"}, "next", "", false, false)
	must(t, err)
	if ok || status(loadTask(t, "t001")) != "done" {
		t.Error("done のタスクが --reopen なしで開け直された")
	}
	// done には status から変えられない
	if _, err := cmdStatus([]string{"t002"}, "done", "", false, false); err == nil {
		t.Error("status で done にできてしまった")
	}
	ok, err = cmdStatus([]string{"t002"}, "dropped", "本人: 対応不要", false, false)
	must(t, err)
	if !ok || !strings.Contains(str(loadTask(t, "t002").Val("notes")), "2026-11-16 本人: 対応不要") {
		t.Error("対応不要の記録が残っていない")
	}
}

func TestBackupsArePruned(t *testing.T) {
	setupHome(t)
	data, _ := loadLedger(tasksPath())
	for i := 0; i < keepBackups+5; i++ {
		t.Setenv("MIETASK_FAKE_NOW", "2026-11-16T07:00:"+twoDigits(i)+"+09:00")
		must(t, saveLedger(tasksPath(), data, false))
	}
	// 手で取ったバックアップは消さない
	write(t, tasksPath()+".bak_manual", "{}")
	must(t, saveLedger(tasksPath(), data, false))
	m, _ := filepath.Glob(tasksPath() + ".bak_*")
	if len(m) != keepBackups+1 {
		t.Errorf("バックアップの数 = %d（自動 %d ＋ 手動 1 のはず）", len(m), keepBackups)
	}
}

func twoDigits(i int) string {
	s := "0" + string(rune('0'+i%10))
	if i >= 10 {
		s = string(rune('0'+i/10)) + string(rune('0'+i%10))
	}
	return s
}

// 完了したタスクのスレッドに、完了のあとで本人以外の動きがあれば、続きのタスクとして起こし直す。
// 却下したもの・動きの無いもの・完了より前の動きは起こさない
func TestReopenAfterDone(t *testing.T) {
	h := setupHome(t)
	write(t, filepath.Join(h, "data", "tasks.json"), `{"version": 1, "tasks": [
	  {"id": "t001", "title": "資料を出す", "status": "done", "completed_at": "2026-11-15T09:00:00+09:00", "source": {"ref": "slack:a"}},
	  {"id": "t002", "title": "要らないもの", "status": "dropped", "source": {"ref": "slack:b"}},
	  {"id": "t003", "title": "前に済んだもの", "status": "done", "completed_at": "2026-11-15T09:00:00+09:00", "source": {"ref": "gmail:c"}}
	]}`)
	f := filepath.Join(h, "f.json")
	write(t, f, `[
	  {"title": "資料の修正", "source": {"ref": "slack:a", "activity_at": "2026-11-15T18:20:00+09:00"}, "section": "today"},
	  {"title": "要らないもの", "source": {"ref": "slack:b", "activity_at": "2026-11-15T18:20:00+09:00"}},
	  {"title": "前に済んだもの", "source": {"ref": "gmail:c", "activity_at": "2026-11-14T10:00:00+09:00"}}
	]`)
	out, err := captureStdout(t, func() error { return cmdUpsert(f, true, false) })
	must(t, err)
	if !strings.Contains(out, "起こし直し: t004 ← t001 の続き") || !strings.Contains(out, "新規 1件") {
		t.Fatalf("起こし直していない:\n%s", out)
	}
	t4 := loadTask(t, "t004")
	if status(t4) != "today" && status(t4) != "next" || t4.Val("follows") != "t001" || !strings.HasPrefix(str(t4.Val("notes")), "t001 の続き") {
		t.Fatalf("続きのタスク: %s", DumpJSON(t4, 0))
	}
	if status(loadTask(t, "t001")) != "done" {
		t.Error("前のタスクが開け直された")
	}

	// 翌日：同じスレッドは続きのタスク（t004）に当たる。二重に起こさない
	t.Setenv("MIETASK_FAKE_NOW", "2026-11-17T07:00:00+09:00")
	out, err = captureStdout(t, func() error { return cmdUpsert(f, true, false) })
	must(t, err)
	if !strings.Contains(out, "新規 0件") || loadTask(t, "t005") != nil {
		t.Fatalf("二重に起こし直した:\n%s", out)
	}

	// 時刻の形が違えば起こさずに知らせる
	write(t, f, `[{"title": "前に済んだもの", "source": {"ref": "gmail:c", "activity_at": "11/16 10:00"}}]`)
	out, err = captureStdout(t, func() error { return cmdUpsert(f, true, false) })
	must(t, err)
	if !strings.Contains(out, "activity_at の形が違う") || !strings.Contains(out, "新規 0件") {
		t.Fatalf("形の違う時刻を通した:\n%s", out)
	}
}

// 完了・ステイ・メモ・追加に当たらない本人の書き込みは捨てずに Claude に渡し、
// その書き込みを引用したときだけ done にできる
func TestOtherLinesAndDoneByQuote(t *testing.T) {
	h := setupHome(t)
	f := filepath.Join(h, "f.json")
	write(t, f, `[{"title": "見積書", "source": {"ref": "slack:a"}}]`)
	must(t, cmdUpsert(f, true, false))
	must(t, cmdRecord("1794800000.000100", "C1", false))

	r := filepath.Join(h, "r.json")
	write(t, r, `[
	  {"user": "U1", "text": "1ステイ\n見積書、出しました\n〇〇社からのメールは要らない"},
	  {"user": "U2", "text": "ほかの人の書き込み"},
	  {"bot_id": "B1", "text": ":speech_balloon: 返信案"}
	]`)
	out, err := captureStdout(t, func() error { return cmdComplete(r, false, "U1", false) })
	must(t, err)
	if !strings.Contains(out, "そのほかの書き込み 2件") || !strings.Contains(out, "✎ 見積書、出しました") || !strings.Contains(out, "✎ 〇〇社からのメールは要らない") {
		t.Fatalf("書き込みを渡していない:\n%s", out)
	}
	if strings.Contains(out, "ほかの人の書き込み") || strings.Contains(out, "返信案") || strings.Contains(out, "✎ 1ステイ") {
		t.Fatalf("本人以外・指定の行まで渡した:\n%s", out)
	}

	// 書き込みに無い文では done にできない
	if err := cmdDoneByQuote("t001", "見積書、出した", false); err == nil {
		t.Fatal("書き込みに無い文で done にできた")
	}
	out, err = captureStdout(t, func() error { return cmdDoneByQuote("t001", "見積書、出しました", false) })
	must(t, err)
	if !strings.Contains(out, "done: t001") || status(loadTask(t, "t001")) != "done" || loadTask(t, "t001").Val("done_by") != "見積書、出しました" {
		t.Fatalf("done になっていない:\n%s", out)
	}

	// 次の投稿を控えたら、前のスレッドの書き込みは使えない
	must(t, cmdRecord("1794900000.000100", "C1", false))
	if err := cmdDoneByQuote("t002", "見積書、出しました", false); err == nil {
		t.Fatal("前のスレッドの書き込みで done にできた")
	}
}
