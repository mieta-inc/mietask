package main

// 使い続けるうえでの点検（診断の最後に出す）。
//
// 毎朝の実行は、止まっても何も知らせてくれない（定期タスクの作業場所が消えたときは、黙って飛ばされる）。
// 投稿の日付から、平日の朝の投稿が抜けていないかを見る。あわせて、自動更新が入っているかを見る。

import (
	"fmt"
	"time"
)

// missedWeekdayRuns は、last のあと now までに抜けている平日の朝の投稿の数。
// 平日の朝の実行は7時台に動くので、今日の分は9時を過ぎてから数える。
// アプリが閉じていた日も数えてしまうが、警告（⚠）にとどめる。
func missedWeekdayRuns(last, now time.Time) int {
	day := func(t time.Time) time.Time { y, m, d := t.Date(); return time.Date(y, m, d, 0, 0, 0, 0, t.Location()) }
	weekday := func(t time.Time) bool { w := t.Weekday(); return w != time.Saturday && w != time.Sunday }
	l, today := day(last.In(now.Location())), day(now)
	missed := 0
	for d := l.AddDate(0, 0, 1); d.Before(today); d = d.AddDate(0, 0, 1) {
		if weekday(d) {
			missed++
		}
	}
	if l.Before(today) && weekday(today) && now.Hour() >= 9 {
		missed++
	}
	return missed
}

func doctorUpkeep(ok, warn func(string, string), now time.Time) {
	if s, _, err := readClaudeSettings(); err != nil {
		warn("自動更新", err.Error())
	} else if autoUpdateOn(s) {
		ok("自動更新", "入っています")
	} else {
		warn("自動更新", "入っていません。直した版が届きません。`mietask autoupdate` で入れられます")
	}

	st, err := loadLedger(statePath())
	if err != nil {
		return
	}
	posted := str(orObj(st.Val("slack_thread")).Val("posted_at"))
	if posted == "" {
		return // まだ一度も投稿していない
	}
	last, err := time.Parse(time.RFC3339, posted)
	if err != nil {
		return
	}
	when := last.In(now.Location()).Format("1/2 15:04")
	if n := missedWeekdayRuns(last, now); n > 0 {
		warn("毎朝の投稿", fmt.Sprintf("最後は %s。そのあと平日の朝の投稿が %d回ありません。"+
			"アプリが閉じていた日でなければ、毎朝の実行が止まっているかもしれません"+
			"（定期タスクの作業場所が消えた、など）。サイドバーの「ミエタスク（毎朝）」を確かめてください", when, n))
		return
	}
	ok("毎朝の投稿", "最後は "+when)
}
