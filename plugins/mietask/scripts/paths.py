#!/usr/bin/env python3
"""データの置き場所と、本人の識別子を一箇所で決める。

プラグインは再インストールで中身が入れ替わる。だから **データをプラグインの中に
置いてはいけない。** タスクも設定もトークンもユーザーのホーム配下に置く。

| | 既定 | 上書き |
|---|---|---|
| データ | `~/.mietask/` | 環境変数 `MIETASK_HOME` |
| トークン | `~/.config/mietask/slack-token` | 環境変数 `MIETASK_TOKEN_FILE` |

トークンだけデータと別にしてあるのは、データ側を Google ドライブや iCloud に
置く人がいるため。**同期フォルダにトークンを置かせない。**
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict

DEFAULT_HOME = Path.home() / ".mietask"
DEFAULT_TOKEN_FILE = Path.home() / ".config" / "mietask" / "slack-token"


class ConfigError(RuntimeError):
    """設定が無い・壊れている。続けると壊れるので必ず止める。"""


def home() -> Path:
    env = os.environ.get("MIETASK_HOME")
    return Path(env).expanduser() if env else DEFAULT_HOME


def token_file() -> Path:
    env = os.environ.get("MIETASK_TOKEN_FILE")
    return Path(env).expanduser() if env else DEFAULT_TOKEN_FILE


def data_dir() -> Path:
    return home() / "data"


def config_path() -> Path:
    return home() / "config.json"


def tasks_path() -> Path:
    return data_dir() / "tasks.json"


def state_path() -> Path:
    return data_dir() / "state.json"


def slack_post_path() -> Path:
    return home() / "slack-post.json"


def load_config() -> Dict[str, Any]:
    """config.json を読む。無ければセットアップへ誘導する。"""
    p = config_path()
    if not p.exists():
        raise ConfigError(
            f"設定がありません: {p}\n"
            "  Claude Code で /mietask:setup と打ってセットアップしてください。"
        )
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ConfigError(f"{p} のJSONが壊れています: {e}") from e


def owner_slack_id(default: str = "") -> str:
    """本人のSlackユーザーID。「N完了」を本人の発言だけから拾うのに使う。"""
    try:
        return (load_config().get("owner") or {}).get("slack_user_id") or default
    except ConfigError:
        return default


def post_channel(default: str = "") -> str:
    """投稿先チャンネルID。slack-post.json を正とし、config は予備。"""
    p = slack_post_path()
    if p.exists():
        try:
            ch = json.loads(p.read_text(encoding="utf-8")).get("channel")
            if ch:
                return ch
        except json.JSONDecodeError:
            pass  # 壊れていても post_slack.py 側が詳しく報告する
    try:
        return (load_config().get("slack") or {}).get("channel") or default
    except ConfigError:
        return default


def tmp_dir() -> Path:
    """巡回の途中で書く一時ファイルの置き場所。/tmp は Windows に無いのでホーム配下にそろえる。"""
    d = home() / "tmp"
    d.mkdir(parents=True, exist_ok=True)
    return d


if __name__ == "__main__":
    # スキルから絶対パスを得るために使う。Write ツールは ~ を展開しないため。
    # Windows でも / 区切りで出す（C:/Users/...）。bash に渡したとき \ が消えないように
    #   bash run.sh paths.py home   → データの置き場所
    #   bash run.sh paths.py tmp    → 一時ファイルの置き場所（無ければ作る）
    import sys

    which = sys.argv[1] if len(sys.argv) > 1 else "home"
    if which == "home":
        print(home().as_posix())
    elif which == "tmp":
        print(tmp_dir().as_posix())
    else:
        print(f"不明な指定です: {which}（home か tmp）", file=sys.stderr)
        sys.exit(2)
