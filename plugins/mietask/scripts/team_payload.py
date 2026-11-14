#!/usr/bin/env python3
"""自分用の投稿内容から、チームのまとめチャンネル向けの投稿内容を作る。

    python3 team_payload.py --payload /tmp/task-check-payload.json --name "三上 詩乃" \
        > /tmp/task-team-payload.json

変えるのは2点だけ:
  - 親の先頭に名前を付け、「詳細はスレッドに…」の案内行を落とす（返信するのは本人だけなので）
  - 返信案の子スレッドを落とす（本人用の下書きで、管理者に見せるものではない）

タスクの一覧・期限・次の一手・メモは自分用と同じものを出す。管理者が1on1で同じものを見るため。
LLMに組み立て直させないのは、自分用とまとめ用で中身がずれないようにするため。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

# 自分用の親にだけある、本人向けの案内
OWNER_ONLY_MARKERS = ("詳細はスレッドに",)
# 本人用の下書き。まとめには出さない
DRAFT_MARKERS = ("返信案",)


def build(own: Dict[str, Any], name: str) -> Dict[str, Any]:
    parent = own.get("parent")
    if not isinstance(parent, str) or not parent.strip():
        raise ValueError("payload に parent がありません。")
    replies = own.get("replies") or []
    if not isinstance(replies, list):
        raise ValueError("payload の replies はリストである必要があります。")

    lines = [ln for ln in parent.splitlines() if not any(m in ln for m in OWNER_ONLY_MARKERS)]
    while lines and not lines[-1].strip():
        lines.pop()
    team_parent = f":bust_in_silhouette: *{name}*\n" + "\n".join(lines)

    kept: List[str] = []
    for r in replies:
        head = (r or "").strip().splitlines()[0] if (r or "").strip() else ""
        if any(m in head for m in DRAFT_MARKERS):
            continue
        kept.append(r)
    return {"parent": team_parent, "replies": kept}


def main() -> int:
    ap = argparse.ArgumentParser(description="チームのまとめ用の投稿内容を作る")
    ap.add_argument("--payload", type=Path, required=True, help="自分用の投稿内容（post_slack.py に渡したもの）")
    ap.add_argument("--name", required=True, help="まとめに出す名前（例: 三上 詩乃）")
    args = ap.parse_args()
    try:
        own = json.loads(args.payload.read_text(encoding="utf-8"))
        out = build(own, args.name.strip())
    except (OSError, ValueError, json.JSONDecodeError) as e:
        print(f"エラー: {e}", file=sys.stderr)
        return 1
    json.dump(out, sys.stdout, ensure_ascii=False, indent=1)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
