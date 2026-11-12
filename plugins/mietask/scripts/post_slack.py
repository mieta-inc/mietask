#!/usr/bin/env python3
"""Slackへ親メッセージ＋子スレッドを投稿する。

task-check の結果を #マイ-タスク に流すために使う。
親を1本投げて、返ってきた ts にぶら下げる形で返信をN本投げる。

    python3 scripts/post_slack.py --payload /path/to/payload.json
    cat payload.json | python3 scripts/post_slack.py
    python3 scripts/post_slack.py --payload payload.json --dry-run

payload.json の形:

    {
      "channel": "C0XXXXXXXXX",     # 省略時は data/slack-post.json の channel
      "parent": "親メッセージの本文",
      "replies": ["子スレッド1", "子スレッド2"]
    }

Botトークンは ~/.config/mieta/slack-token から読む（環境変数で上書き可）。
**リポジトリ内にトークンを置かないこと。** このディレクトリはGoogleドライブ同期下。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paths  # noqa: E402

API = "https://slack.com/api/chat.postMessage"
DEFAULT_TOKEN_FILE = paths.token_file()
CONFIG_FILE = paths.slack_post_path()

# 投稿の間隔。chat.postMessage は同一チャンネルあたり毎秒1通が目安。
POST_INTERVAL_SEC = 1.2

# Slackのテキスト上限は4000文字。超えると末尾が黙って切られるので事前に弾く。
MAX_TEXT_LEN = 3900


class PostError(RuntimeError):
    """投稿が成立しなかったときに投げる。原因をメッセージに必ず含める。"""


def read_token(token_file: Optional[Path]) -> str:
    """Botトークンを取り出す。中身はログにも例外にも出さない。"""
    env = os.environ.get("SLACK_BOT_TOKEN")
    if env:
        return env.strip()

    path = token_file or paths.token_file()

    if not path.exists():
        raise PostError(
            f"Botトークンが見つかりません: {path}\n"
            "  Claude Code で /mietask:setup と打つと、置くところまでやります。\n"
            "  手で置く場合:\n"
            f"    mkdir -p {path.parent} && chmod 700 {path.parent}\n"
            f"    （トークンを {path} に保存）\n"
            f"    chmod 600 {path}"
        )

    mode = path.stat().st_mode & 0o077
    if mode:
        print(
            f"警告: {path} が他ユーザーから読めます。chmod 600 を推奨します。",
            file=sys.stderr,
        )

    token = path.read_text(encoding="utf-8").strip()
    if not token:
        raise PostError(f"トークンファイルが空です: {path}")
    if not token.startswith("xoxb-"):
        raise PostError(
            f"Botトークンの形式ではありません（xoxb- で始まるはず）: {path}\n"
            "  User Token（xoxp-）ではなく Bot User OAuth Token を保存してください。"
        )
    return token


def read_default_channel() -> Optional[str]:
    """投稿先チャンネルIDを読む。slack-post.json が正、config.json が予備。

    セットアップは両方に書くが、片方だけ直した人でも動くようにしてある。
    """
    if CONFIG_FILE.exists():
        try:
            conf = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise PostError(f"{CONFIG_FILE} が壊れています: {e}") from e
        channel = conf.get("channel")
        if channel:
            return str(channel)
    return paths.post_channel() or None


def load_payload(payload_path: Optional[Path]) -> Dict[str, Any]:
    """投稿内容を読む。--payload が無ければ標準入力から。"""
    if payload_path:
        if not payload_path.exists():
            raise PostError(f"payloadが見つかりません: {payload_path}")
        raw = payload_path.read_text(encoding="utf-8")
        where = str(payload_path)
    else:
        if sys.stdin.isatty():
            raise PostError("payloadがありません。--payload を指定するか標準入力で渡してください。")
        raw = sys.stdin.read()
        where = "標準入力"

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise PostError(f"{where} のJSONが壊れています: {e}") from e

    if not isinstance(data, dict):
        raise PostError(f"{where} のトップレベルはオブジェクトである必要があります。")
    return data


def validate(parent: str, replies: List[str]) -> None:
    """投げる前に落とす。Slackは長すぎる本文を黙って切るので、ここで止める。"""
    if not parent.strip():
        raise PostError("parent が空です。")

    for label, text in [("parent", parent)] + [
        (f"replies[{i}]", r) for i, r in enumerate(replies)
    ]:
        if not isinstance(text, str):
            raise PostError(f"{label} が文字列ではありません。")
        if len(text) > MAX_TEXT_LEN:
            raise PostError(
                f"{label} が{len(text)}文字で、上限{MAX_TEXT_LEN}文字を超えています。"
                "区分を分けるか、件数を絞ってください。"
            )


def warn_markdown(parent: str, replies: List[str]) -> None:
    """Slackはmrkdwn。GitHub記法で書かれていたら知らせる（自動変換はしない）。"""
    blocks: List[Tuple[str, str]] = [("parent", parent)] + [
        (f"replies[{i}]", r) for i, r in enumerate(replies)
    ]
    for label, text in blocks:
        if "**" in text:
            print(
                f"警告: {label} に ** があります。Slackの太字は *1つ* です。",
                file=sys.stderr,
            )
        if re.search(r"\[[^\]]+\]\(https?://", text):
            print(
                f"警告: {label} に [text](url) 形式のリンクがあります。"
                "Slackでは <url|text> です。",
                file=sys.stderr,
            )


def display() -> Dict[str, str]:
    """投稿時の表示名とアイコン。slack-post.json から読む。

    **App Home の Display Name を変えても、投稿の表示名は変わらないことがある。**
    Slackは投稿した時点の名前をメッセージに焼き付けるため、確実なのは投稿ごとに
    username を渡すこと（2026-11-04 に別のBotで同じ問題に当たり、この方法で解決した）。
    これには chat:write.customize が要る。無ければ黙って既定の名前で投げる。
    """
    out: Dict[str, str] = {}
    if not CONFIG_FILE.exists():
        return out
    try:
        conf = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return out
    for k in ("username", "icon_url", "icon_emoji"):
        v = conf.get(k)
        if v:
            out[k] = str(v)
    return out


def _send(token: str, body: Dict[str, Any], channel: str) -> str:
    """実際に投げる。HTTPと ok:false をここで throw にそろえる。"""
    req = urllib.request.Request(
        API,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            payload = json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise PostError(f"Slack APIがHTTP {e.code}を返しました: {e.reason}") from e
    except urllib.error.URLError as e:
        raise PostError(f"Slack APIに到達できません: {e.reason}") from e

    if not payload.get("ok"):
        err = payload.get("error", "unknown_error")
        raise PostError(f"Slackが投稿を拒否しました: {err}\n{_hint(err, channel)}")

    ts = payload.get("ts")
    if not ts:
        raise PostError(f"投稿は通ったのに ts が返りませんでした: {payload}")
    return str(ts)


def post(token: str, channel: str, text: str, thread_ts: Optional[str] = None) -> str:
    """1通投げて ts を返す。失敗はすべて PostError にして上げる。"""
    custom = display()
    body: Dict[str, Any] = {
        "channel": channel,
        "text": text,
        # 子スレッドをチャンネル本流に流さない
        "reply_broadcast": False,
        # URLの自動展開を抑える。朝の一覧が縦に伸びないように
        "unfurl_links": False,
        "unfurl_media": False,
    }
    if thread_ts:
        body["thread_ts"] = thread_ts
    body.update(custom)

    if not custom:
        return _send(token, body, channel)

    try:
        return _send(token, body, channel)
    except PostError as e:
        # 表示名の指定だけが原因なら、名前を諦めて投稿は通す。
        # 朝の一覧が名前のせいで届かないほうが困る。
        if not any(k in str(e) for k in
                   ("missing_scope", "not_allowed_token_type", "invalid_arguments")):
            raise
        print(
            "警告: 表示名を指定できませんでした。既定の名前で投稿します。\n"
            "  直すには Slack App に chat:write.customize を足して Reinstall してください。",
            file=sys.stderr,
        )
        for k in ("username", "icon_url", "icon_emoji"):
            body.pop(k, None)
        return _send(token, body, channel)


def _hint(err: str, channel: str) -> str:
    """よくあるエラーに、次に何をすればいいかを添える。"""
    hints = {
        "channel_not_found": (
            f"  チャンネルID {channel} が見つかりません。"
            "チャンネル名ではなくID（Cで始まる）を指定してください。"
        ),
        "not_in_channel": (
            f"  Botが {channel} に入っていません。"
            "チャンネルで /invite @アプリ名 を実行してください。"
        ),
        "invalid_auth": "  トークンが無効です。再発行してファイルを置き換えてください。",
        "missing_scope": "  スコープが足りません。chat:write を付けて再インストールしてください。",
        "token_revoked": "  トークンが失効しています。再発行してください。",
        "ratelimited": "  レート制限です。しばらく置いて再実行してください。",
        "msg_too_long": "  本文が長すぎます。区分を分けてください。",
    }
    return hints.get(err, "  https://api.slack.com/methods/chat.postMessage#errors を参照")


def workspace_name() -> str:
    """permalink用のワークスペース名。slack-post.json か config.json から読む。"""
    for src, key in ((CONFIG_FILE, "workspace"), (paths.config_path(), None)):
        if not src.exists():
            continue
        try:
            conf = json.loads(src.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        ws = conf.get("workspace") if key else (conf.get("owner") or {}).get("slack_workspace")
        if ws:
            return str(ws).replace(".slack.com", "").strip()
    return ""


def permalink(channel: str, ts: str) -> str:
    """スレッドのpermalinkを組み立てる（APIを1回節約する）。

    ワークスペース名が分からなければ空文字を返す。**でっち上げたURLは返さない。**
    """
    ws = workspace_name()
    if not ws:
        return ""
    return f"https://{ws}.slack.com/archives/{channel}/p{ts.replace('.', '')}"


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Slackへ親メッセージ＋子スレッドを投稿する"
    )
    parser.add_argument("--payload", type=Path, help="投稿内容のJSON。省略時は標準入力")
    parser.add_argument("--channel", help="投稿先チャンネルID。payloadと設定より優先")
    parser.add_argument("--token-file", type=Path, help="Botトークンのパス")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="投稿せず、投げる内容をそのまま表示する",
    )
    args = parser.parse_args()

    try:
        data = load_payload(args.payload)
        parent = str(data.get("parent", ""))
        replies = list(data.get("replies", []))

        validate(parent, replies)
        warn_markdown(parent, replies)

        channel = args.channel or data.get("channel") or read_default_channel()

        # dry-run は本文を見るためのものなので、チャンネルもトークンも要求しない。
        if args.dry_run:
            print(f"[dry-run] channel={channel or '(未設定)'}")
            print("--- parent ---")
            print(parent)
            for i, r in enumerate(replies, 1):
                print(f"--- reply {i} ---")
                print(r)
            return 0

        if not channel:
            raise PostError(
                "投稿先チャンネルが決まりません。--channel で渡すか、"
                f"{CONFIG_FILE} に {{\"channel\": \"C...\"}} を置いてください。"
            )

        token = read_token(args.token_file)

        root_ts = post(token, channel, parent)
        # ts は task_sync.py record に渡す。翌朝この ts のスレッドを読んで完了を拾う。
        print(f"ts: {root_ts}")
        link = permalink(channel, root_ts)
        if link:
            print(f"親メッセージ: {link}")

        for i, reply in enumerate(replies, 1):
            time.sleep(POST_INTERVAL_SEC)
            post(token, channel, reply, thread_ts=root_ts)
            print(f"  子スレッド {i}/{len(replies)} 投稿")

        return 0

    except PostError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
