#!/usr/bin/env bash
# mietask のスクリプトを、その環境にある Python で動かす入口（Mac / Windows の Git Bash 共通）。
#
#   bash run.sh <スクリプト名.py> [引数...]   例: bash run.sh task_sync.py thread
#   bash run.sh --check                       Python があるかを確かめる（セットアップ用）
#
# Python の呼び方は環境で違う（Mac は python3、Windows は py / python）。
# Windows の python3・python は、未インストールだと Microsoft Store を開くだけの偽物のことがあるので、
# 名前があるかではなく「実際に動くか」で選ぶ。

set -u
_src="${BASH_SOURCE[0]}"; case "$_src" in */*) HERE="$(cd "${_src%/*}" && pwd)" ;; *) HERE="$(pwd)" ;; esac

# Windows の既定の文字コード（cp932）では絵文字を出すところで落ちるため、常にUTF-8で動かす
export PYTHONUTF8=1
export PYTHONIOENCODING=utf-8

PY=()

os_kind() {
  case "$(uname -s 2>/dev/null)" in
    Darwin) echo mac ;;
    MINGW* | MSYS* | CYGWIN*) echo windows ;;
    *) echo other ;;
  esac
}

works() {
  "$@" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' >/dev/null 2>&1
}

# Mac で Command Line Tools が無いと、/usr/bin/python3 は呼んだだけでインストールのダイアログを出す。
# 本人に断る前にダイアログが出ないよう、その場合は呼ばずに飛ばす。
mac_stub_only() {
  [ "$(os_kind)" = mac ] && ! xcode-select -p >/dev/null 2>&1
}

find_python() {
  local c
  for c in python3 python; do
    local p
    p="$(command -v "$c" 2>/dev/null)" || continue
    if [ "$p" = /usr/bin/python3 ] && mac_stub_only; then continue; fi
    if works "$p"; then PY=("$p"); return 0; fi
  done
  if command -v py >/dev/null 2>&1 && works py -3; then PY=(py -3); return 0; fi

  # PATH に載っていない場所も見る。
  # Windows は winget で入れた直後、アプリを開き直すまで PATH に反映されない。
  local cands=(
    /opt/homebrew/bin/python3
    /usr/local/bin/python3
    /Library/Frameworks/Python.framework/Versions/Current/bin/python3
  )
  if [ "$(os_kind)" = windows ]; then
    local la="${LOCALAPPDATA:-}"
    command -v cygpath >/dev/null 2>&1 && [ -n "$la" ] && la="$(cygpath -u "$la")"
    for c in "$la"/Programs/Python/Python3*/python.exe "/c/Program Files/Python3"*/python.exe; do
      cands+=("$c")
    done
  fi
  for c in "${cands[@]}"; do
    if [ -x "$c" ] && works "$c"; then PY=("$c"); return 0; fi
  done
  return 1
}

if [ "${1:-}" = "--check" ]; then
  echo "os: $(os_kind)"
  if [ "$(os_kind)" = mac ]; then
    if xcode-select -p >/dev/null 2>&1; then echo "clt: yes"; else echo "clt: no"; fi
  fi
  if [ "$(os_kind)" = windows ]; then
    if command -v winget >/dev/null 2>&1; then echo "winget: yes"; else echo "winget: no"; fi
  fi
  if find_python; then
    echo "python: ${PY[*]} ($("${PY[@]}" -c 'import platform; print(platform.python_version())'))"
    exit 0
  fi
  echo "python: none"
  exit 1
fi

if [ $# -lt 1 ]; then
  echo "使い方: bash run.sh <スクリプト名.py> [引数...]" >&2
  exit 2
fi

if ! find_python; then
  echo "エラー: Python 3.8 以上が見つかりません。" >&2
  echo "  Claude Code で /mietask:setup と打つと、入れるところまで案内します。" >&2
  exit 127
fi

script="$1"
shift
case "$script" in
  */* | *\\*) target="$script" ;;
  *) target="$HERE/$script" ;;
esac
exec "${PY[@]}" "$target" "$@"
