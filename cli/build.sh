#!/usr/bin/env bash
# mietask の実行ファイルを、Mac（Apple製チップ・Intel）・Windows 向けにまとめて作る。
# できたものは plugins/mietask/bin/ に置く（プラグインと一緒に配る）。
#
#   bash cli/build.sh            plugin.json の version を埋め込んで作る
#   bash cli/build.sh --check    作らずに、置いてある実行ファイルがソースと一致するか確かめる（CI 用）
#
# -trimpath・-buildvcs=false と固定のフラグで作るので、同じソース・同じ Go のバージョンなら
# 同じファイルになる（コミットSHAは埋めない）。

set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$ROOT/plugins/mietask/bin"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/plugins/mietask/.claude-plugin/plugin.json" | head -1)"
TARGETS="darwin/arm64 darwin/amd64 windows/amd64"

cd "$ROOT/cli"
go vet ./...
go test ./...

build_to() {
  local dir="$1"
  for t in $TARGETS; do
    local os="${t%/*}" arch="${t#*/}" name="mietask-${t%/*}-${t#*/}"
    [ "$os" = windows ] && name="$name.exe"
    # -buildvcs=false が要る。付けないと Go がコミットSHAを埋めるので、
    # 「作ってコミット → そのコミットから作り直す」と中身が変わり、--check が必ず落ちる。
    CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath -buildvcs=false \
      -ldflags "-s -w -buildid= -X main.version=$VERSION" -o "$dir/$name" .
  done
}

if [ "${1:-}" = "--check" ]; then
  tmp="$(mktemp -d)"
  build_to "$tmp"
  status=0
  for f in "$tmp"/*; do
    if ! cmp -s "$f" "$OUT/$(basename "$f")"; then
      echo "ソースと一致しません: $(basename "$f")（cli/build.sh で作り直してコミットしてください）" >&2
      status=1
    fi
  done
  rm -rf "$tmp"
  exit $status
fi

mkdir -p "$OUT"
build_to "$OUT"
chmod +x "$OUT"/mietask-*
echo "version $VERSION"
ls -l "$OUT"
