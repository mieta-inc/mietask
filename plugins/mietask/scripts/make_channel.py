#!/usr/bin/env python3
"""投稿先のプライベートチャンネルを作り、本人を招待して、IDを返す。

**なぜBotに作らせるか。** 手で作らせると、作る→Botを/inviteする→チャンネルIDを
コピーして貼る、の3手が要る。ここが一番つまずく。

**必ず本人を招待する。** Botが作ったプライベートチャンネルには最初Botしかいない。
招待を忘れると、本人が自分のチャンネルを見られない。

**同名チャンネルを黙って使い回さない。** ワークスペースでチャンネル名は一意なので、
別の人が同じ名前を入れると衝突する。Botは複数人のチャンネルに入っているため、
名前だけで突き合わせると **他人のチャンネルに投稿先を向けてしまう**。
既存を使うのは「本人がすでにそこに入っている」と確認できたときだけにする。

必要なスコープ: groups:write（作成・招待）, groups:read（確認）
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import paths  # noqa: E402
from post_slack import PostError, read_token  # noqa: E402

API = "https://slack.com/api"


def call(token: str, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
    data = urllib.parse.urlencode(params).encode("utf-8")
    req = urllib.request.Request(
        f"{API}/{method}",
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise PostError(f"Slackに繋がりません: {e}") from e


def hint(err: str) -> str:
    return {
        "missing_scope": (
            "  スコープが足りません。Slack App に groups:write と groups:read を\n"
            "  追加して Reinstall してください。"
        ),
        "name_taken": (
            "  その名前のチャンネルはワークスペースにすでにあります。\n"
            "  **他の人のものかもしれないので、勝手には使いません。**\n"
            "  自分のものなら --existing <チャンネルID> で指定してください。\n"
            "  そうでなければ別の名前にしてください。"
        ),
        "invalid_name": "  使えるのは小文字・数字・ハイフン・アンダースコアだけです。",
        "restricted_action": "  ワークスペースの設定でアプリによる作成が止められています。手で作ってください。",
        "invalid_auth": "  トークンが無効です。",
        "not_in_channel": "  Botがそのチャンネルにいません。/invite してください。",
        "channel_not_found": "  そのチャンネルIDが見つかりません。Botが入っているか確認してください。",
        "user_not_found": "  config.json の owner.slack_user_id が正しくありません。",
        "cant_invite_self": "  Bot自身は招待できません。",
    }.get(err, f"  Slackのエラー: {err}")


def members(token: str, channel: str) -> Optional[set]:
    """チャンネルの参加者。確認できなければ None（『いない』と区別する）。"""
    out, cursor = set(), ""
    for _ in range(10):
        p = {"channel": channel, "limit": 200}
        if cursor:
            p["cursor"] = cursor
        r = call(token, "conversations.members", p)
        if not r.get("ok"):
            return None
        out.update(r.get("members", []))
        cursor = (r.get("response_metadata") or {}).get("next_cursor") or ""
        if not cursor:
            break
    return out


def ensure_owner_in(token: str, channel: str, owner: str) -> str:
    """本人がチャンネルにいることを保証する。いなければ招待する。"""
    who = members(token, channel)
    if who is not None and owner in who:
        return "すでに参加しています"

    r = call(token, "conversations.invite", {"channel": channel, "users": owner})
    if r.get("ok"):
        return "招待しました"
    err = r.get("error", "unknown")
    if err == "already_in_channel":
        return "すでに参加しています"
    raise PostError(f"本人をチャンネルに入れられませんでした（{err}）\n{hint(err)}")


def main() -> int:
    ap = argparse.ArgumentParser(description="投稿先のプライベートチャンネルを作る")
    ap.add_argument("--name", help="チャンネル名（#は不要）")
    ap.add_argument(
        "--existing",
        help="既にあるチャンネルを使う場合のID。**本人が入っているか必ず確認する**",
    )
    ap.add_argument("--owner", help="本人のSlackユーザーID（既定: config.json）")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.name and not args.existing:
        print("エラー: --name か --existing のどちらかが要ります。", file=sys.stderr)
        return 1

    owner = args.owner or paths.owner_slack_id()
    if not owner:
        print(
            "エラー: 本人のSlackユーザーIDが分かりません。\n"
            "  config.json の owner.slack_user_id を入れるか、--owner で渡してください。\n"
            "  ここが空だと、本人がチャンネルに入れません。",
            file=sys.stderr,
        )
        return 1

    if args.dry_run:
        where = f"既存 {args.existing}" if args.existing else f"新規 #{(args.name or '').lstrip('#')}"
        print(f"[dry-run] {where} に {owner} を入れます")
        return 0

    try:
        token = read_token(None)

        if args.existing:
            # 既存を使う道。**本人が入っているかを必ず確かめる。**
            # ここを飛ばすと、他人のチャンネルを投稿先にしてしまう。
            ch = args.existing.strip()
            info = call(token, "conversations.info", {"channel": ch})
            name = (info.get("channel") or {}).get("name", "?") if info.get("ok") else "?"
            print(f"既存を使います: #{name}")
            print(f"  {ensure_owner_in(token, ch, owner)}")
            print(f"channel: {ch}")
            return 0

        name = args.name.lstrip("#").strip()
        r = call(token, "conversations.create", {"name": name, "is_private": "true"})
        if not r.get("ok"):
            err = r.get("error", "unknown")
            raise PostError(f"チャンネルを作れませんでした（{err}）\n{hint(err)}")

        ch = r["channel"]
        print(f"作りました: #{ch['name']}")
        print(f"  {ensure_owner_in(token, ch['id'], owner)}")
        print(f"channel: {ch['id']}")
        return 0

    except PostError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
