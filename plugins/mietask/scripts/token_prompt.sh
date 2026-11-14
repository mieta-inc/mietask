#!/usr/bin/env bash
# ミエタスクの鍵を伏せ字の入力欄で受け取り、そのまま ~/.config/mietask/slack-token に保存する。
# 鍵はこのスクリプトの中だけを通り、画面にもClaudeの会話にも出ない。
#
#   bash token_prompt.sh
#
# 出力は「OK」か「保存されませんでした（…）」だけ。

set -u
_src="${BASH_SOURCE[0]}"; case "$_src" in */*) HERE="$(cd "${_src%/*}" && pwd)" ;; *) HERE="$(pwd)" ;; esac
MSG='ミエタスクの Bot から DM で届いた鍵を貼り付けて「保存」を押してください'

case "$(uname -s 2>/dev/null)" in
  Darwin)
    DIR="$HOME/.config/mietask"
    mkdir -p "$DIR" && chmod 700 "$DIR" || { echo "保存されませんでした（フォルダを作れません: $DIR）"; exit 1; }
    T=$(osascript -e "text returned of (display dialog \"$MSG\" default answer \"\" with hidden answer with title \"ミエタスク\" buttons {\"キャンセル\", \"保存\"} default button \"保存\" cancel button \"キャンセル\")" 2>/dev/null)
    T="$(printf '%s' "${T:-}" | tr -d '[:space:]')"
    if [ -z "$T" ]; then unset T; echo "保存されませんでした（キャンセルか空欄）"; exit 1; fi
    (umask 077; printf '%s' "$T" > "$DIR/slack-token")
    unset T
    echo OK
    ;;
  MINGW* | MSYS* | CYGWIN*)
    # Windows は PowerShell の入力欄を出す。保存も PowerShell 側で行い、トークンを bash に戻さない
    PS1_PATH="$HERE/token_prompt.ps1"
    command -v cygpath >/dev/null 2>&1 && PS1_PATH="$(cygpath -w "$PS1_PATH")"
    powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File "$PS1_PATH"
    ;;
  *)
    echo "保存されませんでした（この環境では入力欄を出せません。Mac か Windows で実行してください）"
    exit 1
    ;;
esac
