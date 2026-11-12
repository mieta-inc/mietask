---
description: mietask の初回セットアップ。設定ファイル・Slackチャンネル・Botトークン・定期実行をまとめて用意する
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion, ToolSearch
---

mietask を使える状態にする。**本人と対話しながら進める。** 黙って進めない。

所要10〜15分。途中で止まっても、もう一度 `/mietask:setup` と打てば続きからやり直せる。

以下 `$P` = `${CLAUDE_PLUGIN_ROOT}`、`$H` = `~/.mietask` とする。

---

## 0. もう入っているか見る

```bash
ls ~/.mietask/config.json 2>/dev/null && echo "設定あり" || echo "未設定"
```

**設定があれば上書きしない。** 「すでにセットアップ済みです。やり直しますか、
一部だけ直しますか」と聞く。直す場合は該当する節だけを実行する。

## 1. コネクタの接続を確かめる

巡回はSlack・Gmail・Googleカレンダーを**本人のアカウントで**読む。
ここが繋がっていないと何も始まらない。

```
ToolSearch("slack search read thread")
ToolSearch("gmail search threads")
ToolSearch("calendar list events")
```

**実際に1回ずつ呼んで確かめる。** 説明文を見るだけでは繋がっているか分からない。
Slackの検索ツールの説明文に `Current logged in user's user_id is U0XXXXXXX` が
出るので、**ここで本人のSlackユーザーIDが取れる。** 後で使う。

繋がっていないものがあれば、**それが何で、どう繋ぐか**を伝えて止まる。
接続は本人が画面でやる操作なので、こちらからはできない。

## 2. 本人の情報を埋める

1で取れた値をそのまま使い、**取れなかったものだけ聞く。**
すでに分かっていることを聞き直さない。

| | 取り方 |
|---|---|
| Slackユーザー ID | 1の説明文から。取れなければプロフィール→その他→メンバーIDをコピーしてもらう |
| メール | Gmailの `to:me` 検索結果、またはこのセッションのアカウント情報 |
| 名前 | メールの署名、またはSlackのプロフィール |
| カレンダー ID | ふつうはメールと同じ |

`$P/templates/config.json` を読み、`owner` の5項目と `calendar.primary`、
`slack.reply_needed.check_user_id` を埋めて `$H/config.json` に**Writeツールで書く。**

```bash
mkdir -p ~/.mietask/data
```

台帳の初期ファイルも置く:

```bash
cp "${CLAUDE_PLUGIN_ROOT}/templates/tasks.json" ~/.mietask/data/tasks.json
cp "${CLAUDE_PLUGIN_ROOT}/templates/state.json" ~/.mietask/data/state.json
```

**すでにあるファイルは絶対に上書きしない。** `cp -n` を使うか、先に存在を確かめる。
ここを間違えると本人のタスクが全部消える。

## 3. Botトークンを置く

先にトークンを置く。**4でチャンネルを作るのにこれが要る。**

**トークンの中身は画面に出さない。読み上げない。復唱しない。**

すでに管理者がアプリを用意しているなら、その Bot Token をもらう。
自分のワークスペースで使う場合は `$P/../../README.md` の「Slack Appを作る」を見る。

受け取ったら、本人に**ターミナルで**次を実行してもらう。
**こちらが代わりに打たない。** トークンがこの会話に残らないようにするため。

```bash
mkdir -p ~/.config/mietask && chmod 700 ~/.config/mietask
read -rs TOKEN && printf '%s' "$TOKEN" > ~/.config/mietask/slack-token && chmod 600 ~/.config/mietask/slack-token && unset TOKEN && echo OK
```

実行したら、**中身を見ずに**置けたことだけ確かめる:

```bash
ls -l ~/.config/mietask/slack-token && head -c 5 ~/.config/mietask/slack-token && echo "... (xoxb- で始まっていればOK)"
```

`-rw-------` と `xoxb-` が出れば正しい。違えば置き直してもらう。

## 4. 投稿先のチャンネルを作る

**Botに作らせる。** 手で作らせると、作る→`/invite`する→IDをコピーして貼る、の
3手が要る。ここが一番つまずく。

### 名前は必ず本人固有にする

**チャンネル名はワークスペース全体で一意。** 複数人が同じ名前を入れると衝突する。

既定は `mietask-<メールの@より前>`。社内で重複しないので、これを勧める。

| メール | 既定の名前 |
|---|---|
| `shino.yamada@…` | `mietask-shino-yamada` |
| `kaizuka@…` | `mietask-kaizuka` |

`.` と `_` はハイフンに直し、小文字にする。本人が別名を希望したら従うが、
**`mietask` のような共通の名前は止める。** 必ず誰のものか分かる名前にする。

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/make_channel.py" --name mietask-shino-yamada
```

出力はこうなる。**`招待しました` が出ていることを必ず確かめる。**

```
作りました: #mietask-shino-yamada
  招待しました
channel: C0XXXXXXXXX
```

Botが作ったプライベートチャンネルには**最初Botしかいない。**
招待が効いていないと、本人は自分のチャンネルを見られない。

### `name_taken` が出たとき

**勝手に別名を作らない。黙って既存を使わない。** 他人のチャンネルかもしれない。

本人に聞く:

> `#<名前>` はすでにあります。これはご自身で作ったものですか？
> - **自分のもの** → チャンネル名を右クリック→リンクをコピーして、末尾の `C0...` を教えてください
> - **心当たりがない** → 別の名前にします（例: `mietask-<名字>-2`）

自分のものだと確認できた場合だけ、IDを渡して使う:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/make_channel.py" --existing C0XXXXXXXXX
```

これは**本人がそのチャンネルに入っているかを確かめてから**使う。
入っていなければ招待する。入れられなければ止まる。

### 設定に書く

`channel: C0XXXXXXXXX` の値で `$H/slack-post.json` を**Writeツールで書く。**

```json
{
  "_comment": "ミエタスク の投稿先と見た目。チャンネルIDは秘密ではないのでここでよい",
  "channel": "C0XXXXXXXXX",
  "channel_name": "#mietask-shino-yamada",
  "workspace": "your-workspace",
  "username": "ミエタスク",
  "icon_url": "https://raw.githubusercontent.com/mieta-inc/mietask/main/assets/icon-512.png"
}
```

`username` と `icon_url` は**投稿ごとにSlackへ渡す**。App Home の設定では
反映されないことがあるため（2026-11-04 と 2026-11-13 に2回同じ問題に当たった）。
`chat:write.customize` が要る。無ければ警告を出して既定の見た目で投稿する。

`$H/config.json` の `slack.channel` にも同じIDを入れる。

### 作れなかったとき

`missing_scope` や `restricted_action` なら、無理に回避しない。次を案内して、
IDをもらってから `--existing` で通す。

> 1. Slackで**プライベートチャンネル**を作る（名前は `mietask-<自分の名前>`）
> 2. **自分だけを入れる。** 顧客名や依頼内容が流れるので、他の人がいる場所は使わない
> 3. そのチャンネルで `/invite @ミエタスク` と打つ
> 4. チャンネル名を右クリック→リンクをコピー→末尾の `C0XXXXXXXXX` を教えてもらう

**できたチャンネルには本人とBotしかいない。** 他の人を入れないよう一言添える。

## 5. 通し見する

本物の巡回をせず、投稿の経路だけを確かめる。

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/post_slack.py" --payload /tmp/mietask-hello.json --dry-run
```

payloadは**Writeツールで** `/tmp/mietask-hello.json` に書く:

```json
{"parent": ":wave: mietask のセットアップが終わりました。明日の朝から毎日ここに届きます。", "replies": []}
```

dry-run が通ったら、**本人に聞いてから**実際に投げる:

```bash
python3 "${CLAUDE_PLUGIN_ROOT}/scripts/post_slack.py" --payload /tmp/mietask-hello.json
```

Slackに届いたか本人に見てもらう。**届かなければここで止まる。**
よくある原因は、Botをチャンネルに `/invite` していない（`not_in_channel`）。

## 6. 毎朝動くようにする

`scheduled-tasks` のツールで定期タスクを作る。

```
ToolSearch("create scheduled task")
```

- 名前: `mietask-daily`
- cron: `0 7 * * 1-5`（平日7時。**本人に希望を聞く**）
- 中身: 「`task-daily` スキルを使って、巡回して投稿する」

**本人に伝えておくこと:**

> 定期タスクは**Claude Codeが開いているあいだに動きます。**
> 7時に閉じていれば、次に開いた時刻に実行されて届きます。
> 「朝イチで開いたら届いている」形になります。

## 7. 最初の1回を回す

その場で `task-daily` スキルを使い、**実際に巡回して投稿する。**
明日まで待たせない。ここで本人が中身を見て、精度を判断できる。

## 8. 最後に伝えること

**これは必ず言う。黙ってはいけない。**

> **最初の1週間は外れが出ます。**
> 除外ルールが空の状態から始まるので、通知メールを拾ったり、
> 対応済みのものを出したりします。
>
> 気づいたら次のどちらかで直してください。だんだん当たるようになります。
> - 「これは要らない」と言う → 次から出なくなります
> - `~/.mietask/config.json` の `exclude_senders` に送信元を足す

あわせて使い方を3行で:

> - 終わったら、その日のスレッドに「3完了」と返信する（翌朝に反映されます）
> - 番号はその日限り。`t091完了` とIDで返してもOK
> - 今すぐ見たいときは「タスク確認」と打つ

## やらないこと

- **トークンの中身を表示・復唱・ログ出力しない**
- 既存の `config.json` / `tasks.json` / `state.json` を**上書きしない**
- 本人の承認なしにSlackへ投稿しない（5と7は事前に聞く）
- コネクタの接続を代わりにやろうとしない。できない
- 繋がらなかったものを黙って飛ばさない。**何が繋がっていないか必ず言う**
