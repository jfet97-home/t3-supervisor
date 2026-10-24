#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if command -v direnv >/dev/null 2>&1; then
  direnv allow "$repo_root"
fi

exec nix develop "$repo_root" --command npm --prefix "$repo_root" ci
