package main

// doctor は導入や毎朝の実行で詰まったときに、どこが悪いかを一度に点検する。
// 「ミエタスクを診断して」と言われたら Claude がこれを実行し、結果を本人に伝える。
// トークンの中身は出さない。

import (
	"fmt"
	"os"
	"runtime"
	"time"
)

func cmdDoctor() int {
	bad := 0
	ok := func(label, detail string) { fmt.Printf("✅ %s: %s\n", label, detail) }
	ng := func(label, detail string) {
		bad++
		fmt.Printf("❌ %s: %s\n", label, detail)
	}
	warns := 0
	warn := func(label, detail string) {
		warns++
		fmt.Printf("⚠️ %s: %s\n", label, detail)
	}

	fmt.Printf("mietask %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
	fmt.Printf("データ: %s\n\n", toSlash(homeDir()))

	// 設定
	if _, err := os.Stat(configPath()); os.IsNotExist(err) {
		// 初回。台帳や投稿先の ❌ を並べても意味がないので、ここで止める
		ng("設定", "設定がありません（まだセットアップしていません）。/mietask:setup と打ってください")
		fmt.Println()
		fmt.Println("まだセットアップしていません。")
		return 1
	}
	cfg, err := loadConfig()
	if err != nil {
		ng("設定", err.Error())
	} else {
		owner := orObj(cfg.Val("owner"))
		uid := str(owner.Val("slack_user_id"))
		if uid == "" {
			ng("設定", "owner.slack_user_id が空です。返信を本人のものと判定できません")
		} else {
			ok("設定", fmt.Sprintf("%s（%s）", pyStrIfTruthy(owner.Val("name")), uid))
		}
	}

	// 台帳
	for _, p := range []string{tasksPath(), statePath()} {
		if _, err := loadLedger(p); err != nil {
			ng("台帳", err.Error())
		}
	}
	if data, err := loadLedger(tasksPath()); err == nil {
		if tasks, err := tasksList(data); err == nil {
			open := 0
			for _, t := range tasks {
				if !isClosed(t) {
					open++
				}
			}
			ok("台帳", fmt.Sprintf("タスク %d件（未完了 %d件）", len(tasks), open))
		}
	}

	// 一人ずつの鍵（窓口経由）なら、鍵・Bot・投稿先・所属は窓口に確かめてもらう
	if relay := relayKeyFromFile(); relay != nil {
		relayDoctor(relay, ok, ng, warn)
		if st, err := loadLedger(statePath()); err == nil {
			if last := str(st.Val("last_sweep_at")); last != "" {
				ok("前回の巡回", last)
			} else {
				warn("前回の巡回", "まだ一度も巡回していません")
			}
		}
		doctorUpkeep(ok, warn, time.Now())
		return doctorSummary(bad, warns)
	}

	// 投稿先
	ch, err := readDefaultChannel()
	if err != nil {
		ng("投稿先", err.Error())
	} else if ch == "" {
		ng("投稿先", "チャンネルが決まっていません。/mietask:setup の「チャンネルを作る」をやり直してください")
	}

	// トークンと接続
	token, terr := readToken("")
	if terr != nil {
		ng("トークン", terr.Error())
	} else {
		p, err := slackCall(token, "auth.test", map[string]any{}, nil)
		switch {
		case err != nil:
			ng("Slackへの接続", err.Error()+"（ネットワークかプロキシを確認）")
		case p["ok"] != true:
			ng("トークン", "Slackに拒否されました: "+errOf(p)+"。1Passwordから貼り直してください")
		default:
			ok("トークン", fmt.Sprintf("有効（%v / %v）", p["team"], p["user"]))
			if ch != "" {
				info, err := formCall(token, "conversations.info", "channel", ch)
				if err == nil && info["ok"] == true {
					name := "?"
					if c, ok := info["channel"].(map[string]any); ok {
						name = fmt.Sprint(c["name"])
					}
					ok("投稿先", "#"+name+"（"+ch+"）")
				} else {
					e := "接続エラー"
					if info != nil {
						e = errOf(info)
					}
					ng("投稿先", ch+" に Bot が入れません: "+e)
				}
			}
		}
	}

	// 前回の実行
	if st, err := loadLedger(statePath()); err == nil {
		if last := str(st.Val("last_sweep_at")); last != "" {
			ok("前回の巡回", last)
		} else {
			warn("前回の巡回", "まだ一度も巡回していません")
		}
	}

	// 管理台帳（使っている場合）
	doctorRegistry(ok, ng, warn)
	doctorUpkeep(ok, warn, time.Now())

	return doctorSummary(bad, warns)
}

func doctorSummary(bad, warns int) int {
	fmt.Println()
	if bad == 0 && warns > 0 {
		// 毎朝の実行が黙って止まっているときは ⚠ になる。「問題なし」で終えると見落とす
		fmt.Printf("止まるほどの問題はありませんが、⚠️ が%d件あります。⚠️ の行を読んで確かめてください。\n", warns)
		return 0
	}
	if bad == 0 {
		fmt.Println("問題は見つかりませんでした。")
		return 0
	}
	fmt.Printf("%d件の問題があります。❌ の行を上から直してください。\n", bad)
	_ = os.Stdout.Sync()
	return 1
}
