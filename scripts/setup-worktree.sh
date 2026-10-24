#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if command -v direnv >/dev/null 2>&1; then
  direnv allow "$repo_root"
fi

exec nix develop "$repo_root" --command pnpm --dir "$repo_root" install --frozen-lockfile --prefer-offline --config.package-import-method=hardlink --config.confirmModulesPurge=false
