#!/usr/bin/env python3
"""Slackに投げたメッセージを消す。

task-check の過去の投稿を片付けるために使う。
**消せるのは mietask Bot 自身が投げたものだけ。** 本人や他の人の発言は
Botトークンでは消せない（`cant_delete_message` が返る）。

    python3 scripts/delete_slack.py --ts 1794446558.963629 --ts 1794446560.451299
    python3 scripts/delete_slack.py --ts-file /path/to/ts.txt --dry-run

Slackは親を消しても子スレッドは残す。**親と子をすべて列挙して渡すこと。**
ts は新しい順に渡しても古い順でもよいが、親を先に消すと子が迷子に見えるので、
このスクリプトは渡された順に消す。子→親の順で渡すのが無難。

削除は取り消せない。--dry-run で対象を確認してから実行すること。
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
from post_slack import (  # noqa: E402
    PostError,
    read_default_channel,
    read_token,
)

API = "https://slack.com/api/chat.delete"

# chat.delete も chat.postMessage と同じくレート制限がある（Tier 3）。
DELETE_INTERVAL_SEC = 1.1


def delete(token: str, channel: str, ts: str) -> None:
    """1通消す。失敗はすべて PostError にして上げる。"""
    body: Dict[str, Any] = {"channel": channel, "ts": ts}
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
        raise PostError(f"{ts} を消せませんでした: {err}\n{_hint(err)}")


def _hint(err: str) -> str:
    hints = {
        "message_not_found": "  すでに消えているか、ts が違います。",
        "cant_delete_message": (
            "  Botが投げたものではありません。本人や他の人の発言は"
            "Botトークンでは消せないので、Slackの画面から消してください。"
        ),
        "channel_not_found": "  チャンネルIDが違います。",
        "missing_scope": "  スコープが足りません。chat:write を付けて再インストールしてください。",
        "invalid_auth": "  トークンが無効です。",
        "ratelimited": "  レート制限です。しばらく置いて再実行してください。",
    }
    return hints.get(err, "  https://api.slack.com/methods/chat.delete#errors を参照")


def load_ts(args: argparse.Namespace) -> List[str]:
    out: List[str] = list(args.ts or [])
    if args.ts_file:
        path = Path(args.ts_file)
        if not path.exists():
            raise PostError(f"ts一覧が見つかりません: {path}")
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.split("#", 1)[0].strip()
            if line:
                out.append(line)
    if not out:
        raise PostError("消す対象がありません。--ts か --ts-file を指定してください。")

    seen = set()
    uniq = []
    for t in out:
        if t not in seen:
            seen.add(t)
            uniq.append(t)
    return uniq


def main() -> int:
    parser = argparse.ArgumentParser(description="Slackのメッセージを消す")
    parser.add_argument("--ts", action="append", help="消すメッセージのts（複数可）")
    parser.add_argument("--ts-file", help="tsを1行ずつ並べたファイル")
    parser.add_argument("--channel", help="チャンネルID。省略時は data/slack-post.json")
    parser.add_argument("--token-file", type=Path, help="Botトークンのパス")
    parser.add_argument("--dry-run", action="store_true", help="消さずに対象だけ出す")
    args = parser.parse_args()

    try:
        targets = load_ts(args)
        channel: Optional[str] = args.channel or read_default_channel()
        if not channel:
            raise PostError("チャンネルが決まりません。--channel で渡してください。")

        if args.dry_run:
            print(f"[dry-run] channel={channel} / {len(targets)}件")
            for t in targets:
                print(f"  {t}")
            return 0

        token = read_token(args.token_file)

        ok = 0
        failed: List[str] = []
        for i, ts in enumerate(targets, 1):
            if i > 1:
                time.sleep(DELETE_INTERVAL_SEC)
            try:
                delete(token, channel, ts)
                ok += 1
                print(f"  {i}/{len(targets)} 削除 {ts}")
            except PostError as e:
                # 1件の失敗で全部止めない。残りを消して、最後にまとめて報告する。
                failed.append(str(e))
                print(f"  {i}/{len(targets)} 失敗 {ts}", file=sys.stderr)

        print(f"\n削除 {ok}件 / 失敗 {len(failed)}件")
        if failed:
            print("\n--- 失敗した分 ---", file=sys.stderr)
            for f in failed:
                print(f, file=sys.stderr)
            return 1
        return 0

    except PostError as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
