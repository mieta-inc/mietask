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
