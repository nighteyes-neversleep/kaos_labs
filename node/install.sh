#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js is required. Install an official Node 24 LTS package, then rerun this installer. No changes were made.' >&2
  exit 1
fi
exec node "$script_dir/discover.mjs" --install "$@"
