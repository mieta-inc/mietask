---
description: mietask の初回セットアップ。設定ファイル・Slackチャンネル・Botトークン・定期実行をまとめて用意する
allowed-tools: Read, Write, Edit, Bash, AskUserQuestion, ToolSearch
---

mietask を使える状態にする。**本人と対話しながら進める。** 黙って進めない。

所要10〜15分。途中で止まっても、もう一度 `/mietask:setup` と打てば続きからやり直せる。

以下 `$P` = `${CLAUDE_PLUGIN_ROOT}`、`$H` = データの置き場所（ふつうは `~/.mietask`）とする。

**Mac でも Windows でも同じ手順で進める。** そのために次の2つを守る。

- スクリプトは Python で直接呼ばず、必ず `bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" <スクリプト名> [引数]` で呼ぶ。
  環境ごとの Python の呼び方の違いと文字コードはこれが吸収する
- Writeツールに渡すパスに `~` を使わない。1.5 で `bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" paths.py home` を実行し、
  出てきた絶対パスを `$H` として使う

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

## 1.5 Pythonを確かめる

毎朝の台帳の更新とSlackへの投稿は Python のスクリプトが受け持つ。この端末で動くかを先に確かめる。

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" --check
```

`python: …（3.x.x）` が出れば次へ。`python: none` なら、**本人に説明して了承をとってから入れる。黙って入れない。**

> 毎朝の処理に「Python」という無料のソフトが要ります。この端末にはまだ入っていないので、いまから入れてもよいですか？
> 数分〜15分ほどかかり、途中で1回ボタンを押してもらいます。

### Mac（`os: mac`）

Apple の「コマンドライン・デベロッパ・ツール」に Python が含まれている。了承をとってから:

```bash
xcode-select --install
```

- 「インストールしますか？」のダイアログが出るので「インストール」を押してもらう。
  利用許諾が出たら**本人が**「同意する」を押す（こちらでは押さない）
- 5〜15分かかる。終わったと言われたら `--check` をやり直す
- ダイアログが出ない・失敗した場合は、https://www.python.org/downloads/ から macOS 用のインストーラを入れてもらう

### Windows（`os: windows`）

`winget: yes` なら、了承をとってからこちらで実行する（管理者権限は要らない）:

```bash
winget install -e --id Python.Python.3.12 --scope user --accept-source-agreements --accept-package-agreements
```

- `--accept-…` は Python とインストール元の利用条件への同意。**了承をとる時点で、そのことも伝える**
- 「このアプリがデバイスに変更を加えることを許可しますか？」が出たら「はい」を押してもらう
- 終わったら `--check` をやり直す。入れた直後でも見つかるようにしてある

`winget: no` なら、https://www.python.org/downloads/ から Windows 用のインストーラを入れてもらう。
最初の画面で **「Add python.exe to PATH」にチェック**を入れてから「Install Now」。

どちらでも、入れたあとに `python: none` のままなら、Claudeアプリを一度閉じて開き直し、
`/mietask:setup` をやり直してもらう（途中から続く）。

ここまで通ったら、データの置き場所を確かめておく:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" paths.py home
```

出てきた絶対パスを以下 `$H` とする。

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

社内で使う場合は、**1Passwordの共有ボールトにある「ミエタスク Bot Token」**を取ってもらう。
見つからなければ管理者に聞く。
自分のワークスペースで使う場合は `$P/../../README.md` の「Slack Appを作る」を見る。

**入力欄のポップアップを出して、そこに貼ってもらう。** ターミナルは使わせない。
Mac でも Windows でも同じコマンドで、伏せ字の入力欄が出る。先に本人へこう伝えてから実行する:

> いまから入力欄が出ます。1Passwordの「ミエタスク Bot Token」をコピーして貼り付け、「保存」を押してください。

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/token_prompt.sh"
```

- トークンはこのスクリプトの中でファイルに保存されるだけで、**この会話にも出力にも出ない**。出力は `OK` か「保存されませんでした（…）」だけ
- スクリプトを書き換えたり、中身を表示するコマンドを足したりしない
- 「保存されませんでした」なら、もう一度実行してよいか本人に聞いてから出し直す
- 入力欄が見当たらないと言われたら、ほかのウィンドウの裏に隠れていないか見てもらう

置けたら、**中身を見ずに**置けたことだけ確かめる:

```bash
head -c 5 ~/.config/mietask/slack-token && echo "... (xoxb- で始まっていればOK)"
```

`xoxb-` が出れば正しい。違えば置き直してもらう。

## 4. 投稿先のチャンネルを作る

**Botに作らせる。** 手で作らせると、作る→`/invite`する→IDをコピーして貼る、の
3手が要る。ここが一番つまずく。

### 名前は必ず本人固有にする

**チャンネル名はワークスペース全体で一意。** 複数人が同じ名前を入れると衝突する。

既定は **`ミエタスク-<名字>`**。名字はメールの@より前を `.` で区切った最後の部分。
`.` が無ければ@より前をそのまま使う。小文字にし、`_` はハイフンに直す。

| メール | 既定の名前 |
|---|---|
| `yasuhiko.kawamura@…` | `ミエタスク-kawamura` |
| `shino.yamada@…` | `ミエタスク-yamada` |
| `kaizuka@…` | `ミエタスク-kaizuka` |

本人に「`#ミエタスク-kawamura` で作ります。よいですか」と確認してから作る。
別名を希望したら従うが、**`ミエタスク` のような共通の名前は止める。** 必ず誰のものか分かる名前にする。

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" make_channel.py --name ミエタスク-kawamura
```

`invalid_name` で弾かれたら、英字の `mietask-<名字>` で作り直す（日本語のチャンネル名を
受け付けないワークスペース設定があるため）。

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
> - **心当たりがない** → 名前も付けた形にします（例: `ミエタスク-shino-yamada`）

自分のものだと確認できた場合だけ、IDを渡して使う:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" make_channel.py --existing C0XXXXXXXXX
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

> 1. Slackで**プライベートチャンネル**を作る（名前は `ミエタスク-<自分の名字>`）
> 2. **自分だけを入れる。** 顧客名や依頼内容が流れるので、他の人がいる場所は使わない
> 3. そのチャンネルで `/invite @ミエタスク` と打つ
> 4. チャンネル名を右クリック→リンクをコピー→末尾の `C0XXXXXXXXX` を教えてもらう

**できたチャンネルには本人とBotしかいない。** 他の人を入れないよう一言添える。

## 4.5 チームのまとめチャンネル（チームで使う場合）

本人に聞く:

> チームの管理者が見るまとめチャンネルにも、毎朝の一覧を出しますか？
> 出す場合、**返信案を除いた一覧**（期限・次の一手・メモを含む）が管理者に見えます。
> 他のメンバーからは見えません。

出すなら、チャンネル名を聞く（PDは `ミエタスク-pd`）。名前でIDを探す:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" make_channel.py --find-team ミエタスク-pd
```

`team_channel: C0XXXXXXXXX` が出たら、`$H/slack-post.json` に `"team_channel"` として足す
（**Writeツールで**、既存の項目は消さない）。

- **本人をまとめチャンネルに招待しない。** メンバー同士がお互いの一覧を見られないようにするため。
  投稿はBotが行うので、本人が入っている必要はない
- 見つからなければ管理者に確認してもらう。勝手に作らない（管理者が作って、Botを入れておく場所）
- 出さないと言われたら、何も足さずに次へ進む
- `config.json` の `owner.name` が空なら、まとめに出す名前（例: `三上 詩乃`）を聞いて入れる

## 5. 通し見する

本物の巡回をせず、投稿の経路だけを確かめる。

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" post_slack.py --payload "$H/tmp/mietask-hello.json" --dry-run
```

payloadは**Writeツールで** `$H/tmp/mietask-hello.json` に書く（`$H` は絶対パスに置き換える。フォルダが無ければ `bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" paths.py tmp` で作られる）:

```json
{"parent": ":wave: mietask のセットアップが終わりました。明日の朝から毎日ここに届きます。", "replies": []}
```

dry-run が通ったら、**本人に聞いてから**実際に投げる:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/run.sh" post_slack.py --payload "$H/tmp/mietask-hello.json"
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

> **最初の1週間で、自分用に育てていくものです。**
> はじめは何も覚えていない状態なので、通知メールを拾ったり、対応済みのものを出したりします。
> 要らないものが出たら、Claudeに「これは要らない」「〇〇からのメールは出さなくていい」と言ってください。
> 次から出なくなり、だんだん自分に合った一覧になっていきます。

あわせて使い方を伝える:

> その日の投稿に返信すると、翌朝の一覧に反映されます。
> - `1完了` → もう出ません
> - `2ステイ` → 明日もそのまま出します
> - `3 山田さんに電話済み` → メモ。翌朝「前回のメモ」として出ます
> - `2ステイ 来週の会議で決める` → ステイとメモを同時に
> - `追加 見積書を作る 11/20まで` → 新しいタスクとして足します。Slackや議事録に出てこない仕事（口頭で頼まれたこと、自分で決めたこと）はここから入れてください
>
> 番号はその日限りです。`t091完了` のようにIDで返してもかまいません。
> 今すぐ見たいときは「タスク確認」と打ってください。

## やらないこと

- **トークンの中身を表示・復唱・ログ出力しない**
- 既存の `config.json` / `tasks.json` / `state.json` を**上書きしない**
- 本人をチームのまとめチャンネルに招待しない
- 本人の承認なしにSlackへ投稿しない（5と7は事前に聞く）
- コネクタの接続を代わりにやろうとしない。できない
- 繋がらなかったものを黙って飛ばさない。**何が繋がっていないか必ず言う**
