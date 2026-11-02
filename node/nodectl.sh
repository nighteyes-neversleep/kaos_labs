#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Node.js is required to control this node.' >&2
  exit 1
fi
exec node "$script_dir/discover.mjs" --control "$@"
