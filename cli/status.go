package main

// 動作の点検用の件数。
//
// チームのまとめには、各自の一覧（題名・メモ・出どころ）を出さない。タスクの題名には
// DM・非公開チャンネル・メールの内容が入るため。窓口に送るのは毎朝の件数（超過・今日・今週）だけで、
// 見るのはシステム管理者（急に0件になった人がいれば、巡回が壊れているかもしれない）。
// チームの管理者の状態把握には使わない。案件ごとに重さが違い、件数では忙しさが分からないため。
// 件数は本人の投稿の1行目から取るので、本人が見た数と同じになる。

import (
	"fmt"
	"os"
	"regexp"
	"strconv"
)

type teamCounts struct {
	Overdue, Today, Week int
}

var (
	reOverdue = regexp.MustCompile(`超過\s*(\d+)`)
	reToday   = regexp.MustCompile(`今日\s*(\d+)`)
	reWeek    = regexp.MustCompile(`今週\s*(\d+)`)
)

// parseTeamCounts は親メッセージの1行目（:date: … 超過N / 今日N / 今週N）から件数を取る。
// 2行目より下はタスクの見出しで「今日17:00」のような語が入るので見ない。
// 該当0件の区分は1行目から落ちるので、無ければ0。
func parseTeamCounts(parent string) teamCounts {
	lines := pySplitlines(parent)
	first := ""
	if len(lines) > 0 {
		first = lines[0]
	}
	pick := func(re *regexp.Regexp) int {
		m := re.FindStringSubmatch(first)
		if m == nil {
			return 0
		}
		n, _ := strconv.Atoi(m[1])
		return n
	}
	return teamCounts{Overdue: pick(reOverdue), Today: pick(reToday), Week: pick(reWeek)}
}

// sendTeamStatus は投稿内容から件数だけを取り出して窓口に送る。
// 自分のチャンネルへの投稿は済んでいるので、ここで失敗しても止めない（警告だけ）。
func sendTeamStatus(payloadPath string, dryRun bool) {
	raw, err := os.ReadFile(payloadPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "警告: 点検用の件数を作れませんでした: %v\n", err)
		return
	}
	v, err := ParseJSON(raw)
	if err != nil {
		return
	}
	own, ok := v.(*Obj)
	if !ok {
		return
	}
	c := parseTeamCounts(str(own.Val("parent")))
	summary := fmt.Sprintf("超過%d・今日%d・今週%d", c.Overdue, c.Today, c.Week)
	if dryRun {
		fmt.Printf("[dry-run] 動作の点検用に送るのは件数だけ: %s（題名・メモ・出どころは送らない）\n", summary)
		return
	}
	k := relayKeyFromFile()
	if k == nil {
		return // 管理台帳を使っていない
	}
	p := relayVersionParams()
	p["counts"] = map[string]any{"overdue": c.Overdue, "today": c.Today, "week": c.Week}
	if _, err := relayCall(k, "status", p); err != nil {
		// 窓口がまだ古く、件数の受け取りを知らないときもここに来る
		fmt.Fprintf(os.Stderr, "警告: 点検用の件数を送れませんでした。自分のチャンネルへの投稿は済んでいるので、やり直さないでください: %v\n", err)
		return
	}
	fmt.Printf("点検用の件数を送りました: %s\n", summary)
}
