// mietask は ミエタスク（Claude Code プラグイン）の処理の芯。
//
// 毎朝の巡回結果をタスク台帳に登録し、Slackに投稿し、翌朝に返信（完了・ステイ・メモ・追加）を読み戻す。
// 追加のインストールなしで Mac・Windows で動くように、1本の実行ファイルにしてある。
//
//	mietask sync thread|complete|upsert|status|record ...   台帳の更新（旧 task_sync.py）
//	mietask post ...                                          Slackへ投稿（旧 post_slack.py）
//	mietask channel ...                                       投稿先チャンネルの作成（旧 make_channel.py）
//	mietask team-payload ...                                  まとめチャンネル用の投稿内容（旧 team_payload.py）
//	mietask delete ...                                        Botの投稿を消す（旧 delete_slack.py）
//	mietask paths home|tmp                                    データの置き場所
//	mietask doctor                                            設定・トークン・接続を点検する
//	mietask version
package main

import (
	"errors"
	"fmt"
	"os"
	"strings"
)

// version はビルド時に -ldflags "-X main.version=..." で入れる。
var version = "dev"

// errSilent はメッセージを出し終えたうえで終了コード1にするための印。
var errSilent = errors.New("")

// args は「--name value」「--name=value」「--flag」と位置引数を受ける小さな解析器。
type args struct {
	vals  map[string][]string
	flags map[string]bool
	pos   []string
}

func parseArgs(in []string, boolFlags ...string) (*args, error) {
	isBool := map[string]bool{"dry-run": true, "help": true}
	for _, b := range boolFlags {
		isBool[b] = true
	}
	a := &args{vals: map[string][]string{}, flags: map[string]bool{}}
	for i := 0; i < len(in); i++ {
		s := in[i]
		if s == "-h" {
			a.flags["help"] = true
			continue
		}
		if !strings.HasPrefix(s, "--") || s == "--" {
			a.pos = append(a.pos, s)
			continue
		}
		name := s[2:]
		val := ""
		hasVal := false
		if eq := strings.IndexByte(name, '='); eq >= 0 {
			name, val, hasVal = name[:eq], name[eq+1:], true
		}
		if isBool[name] {
			a.flags[name] = true
			continue
		}
		if !hasVal {
			if i+1 >= len(in) {
				return nil, fmt.Errorf("--%s に値がありません", name)
			}
			i++
			val = in[i]
		}
		a.vals[name] = append(a.vals[name], val)
	}
	return a, nil
}

func (a *args) get(name string) string {
	if v := a.vals[name]; len(v) > 0 {
		return v[len(v)-1]
	}
	return ""
}

func (a *args) has(name string) bool { _, ok := a.vals[name]; return ok }

func usage() {
	fmt.Fprintln(os.Stderr, `使い方: mietask <コマンド> [引数]

  sync thread                         前回のスレッド情報を表示する
  sync complete --replies FILE        スレッド返信の「N完了」などを反映する
  sync upsert --findings FILE         巡回結果を台帳に登録する
  sync status ID... --status S        タスクの status を変える
  sync record --ts TS                 投稿したスレッドの ts を控える
  post --payload FILE                 Slackへ親＋子スレッドを投稿する
  channel --name NAME                 投稿先のプライベートチャンネルを作る
  post-team --payload FILE            所属チームのまとめチャンネルへ投稿する（返信案は除く）
  team-payload --payload FILE --name NAME   まとめチャンネル用の投稿内容を作る
  registry [--team ID]                管理台帳の中身を出す（管理者の画面用）
  delete --ts TS                      Botの投稿を消す
  paths home|tmp                      データの置き場所を出す
  setup --slack-id U --email E --name N   設定・台帳・投稿先チャンネルをまとめて用意する
  admin status|create-team|invite-managers|archive-member|make-key   管理者用
  doctor                              設定・トークン・接続を点検する
  version                             バージョンを出す

どのコマンドも --dry-run で、書き込み・投稿をせずにやることだけ表示する。`)
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(argv []string) int {
	if len(argv) == 0 {
		usage()
		return 2
	}
	cmd, rest := argv[0], argv[1:]
	var err error
	code := 0
	switch cmd {
	case "sync":
		code, err = runSync(rest)
	case "post":
		var a *args
		if a, err = parseArgs(rest); err == nil {
			err = cmdPost(a.get("payload"), a.get("channel"), a.get("token-file"), a.flags["dry-run"])
		}
	case "channel":
		var a *args
		if a, err = parseArgs(rest); err == nil {
			err = cmdChannel(a.get("name"), a.get("existing"), a.get("owner"), a.get("find-team"), a.flags["dry-run"])
		}
	case "team-payload":
		var a *args
		if a, err = parseArgs(rest); err == nil {
			if !a.has("payload") || !a.has("name") {
				err = errors.New("--payload と --name が要ります。")
			} else {
				err = cmdTeamPayload(a.get("payload"), a.get("name"))
			}
		}
	case "delete":
		var a *args
		if a, err = parseArgs(rest); err == nil {
			err = cmdDelete(a.vals["ts"], a.get("ts-file"), a.get("channel"), a.get("token-file"), a.flags["dry-run"])
		}
	case "paths":
		which := "home"
		if len(rest) > 0 {
			which = rest[0]
		}
		switch which {
		case "home":
			fmt.Println(toSlash(homeDir()))
		case "tmp":
			var d string
			if d, err = tmpDir(); err == nil {
				fmt.Println(toSlash(d))
			}
		default:
			fmt.Fprintf(os.Stderr, "不明な指定です: %s（home か tmp）\n", which)
			return 2
		}
	case "post-team":
		var a *args
		if a, err = parseArgs(rest); err == nil {
			if !a.has("payload") {
				err = errors.New("--payload が要ります。")
			} else {
				err = cmdPostTeam(a.get("payload"), a.get("name"), a.flags["dry-run"])
			}
		}
	case "registry":
		var a *args
		if a, err = parseArgs(rest); err == nil {
			err = cmdRegistry(a.get("team"))
		}
	case "setup":
		var a *args
		if a, err = parseArgs(rest); err == nil {
			err = cmdSetup(a)
		}
	case "admin":
		err = runAdmin(rest)
	case "doctor":
		code = cmdDoctor()
	case "_parse":
		err = cmdDebugParse()
	case "version", "--version":
		fmt.Println("mietask", version)
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "不明なコマンドです: %s\n\n", cmd)
		usage()
		return 2
	}
	if err != nil {
		if err != errSilent {
			fmt.Fprintf(os.Stderr, "エラー: %s\n", err)
		}
		return 1
	}
	return code
}

func runSync(rest []string) (int, error) {
	a, err := parseArgs(rest, "allow-no-mapping", "no-carry-over", "reopen")
	if err != nil {
		return 1, err
	}
	if len(a.pos) == 0 {
		return 2, errors.New("sync のあとに thread / complete / upsert / status / record のどれかが要ります。")
	}
	dry := a.flags["dry-run"]
	switch a.pos[0] {
	case "thread":
		return 0, cmdThread()
	case "complete":
		if !a.has("replies") {
			return 1, errors.New("--replies が要ります。")
		}
		only := ownerSlackID()
		if a.has("only-user") {
			only = a.get("only-user")
		}
		return 0, cmdComplete(a.get("replies"), a.flags["allow-no-mapping"], only, dry)
	case "upsert":
		if !a.has("findings") {
			return 1, errors.New("--findings が要ります。")
		}
		return 0, cmdUpsert(a.get("findings"), !a.flags["no-carry-over"], dry)
	case "status":
		ids := a.pos[1:]
		if len(ids) == 0 || !a.has("status") {
			return 1, errors.New("task.id と --status が要ります。")
		}
		ok, err := cmdStatus(ids, a.get("status"), a.get("note"), a.flags["reopen"], dry)
		if err != nil {
			return 1, err
		}
		if !ok {
			return 1, nil
		}
		return 0, nil
	case "record":
		if !a.has("ts") {
			return 1, errors.New("--ts が要ります。")
		}
		ch := postChannel()
		if a.has("channel") {
			ch = a.get("channel")
		}
		return 0, cmdRecord(a.get("ts"), ch, dry)
	}
	return 2, fmt.Errorf("不明な sync コマンドです: %s", a.pos[0])
}
