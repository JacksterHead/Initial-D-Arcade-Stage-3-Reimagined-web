#!/bin/bash
# Assemble the static site for GitHub Pages (or any static host): the client, the data index and config.json.
#   Web/build/package_pages.sh <wasm-build dir> <out dir> [--data-url <url of the Native/ folder, ends in />]
#
# Default layout (this repository, deployed whole by .github/workflows/static.yml):
#   <site>/play/        <- this script's output (committed as play/)
#   <site>/Native/data  <- the game data, already in the repository
# so config.json says the data is at ../Native/ (resolved against the page, any sub-path works).
# For a host that cannot hold the 2.8 GB of data, pass --data-url (the host must send
# Access-Control-Allow-Origin; Range support is optional, see Web/README.md).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$here/../.."
build="${1:?wasm build dir}"; out="${2:?output dir}"; shift 2
data="../Native/"
while [ $# -gt 0 ]; do case "$1" in --data-url) data="${2:?}"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
case "$data" in */) ;; *) data="$data/";; esac
rm -rf "$out"; "$here/package_web.sh" "$build" "$out" >/dev/null
python3 -I "$here/../tools/make_manifest.py" "$repo/Native" \
  --set "boot=$here/../tools/prefetch/boot.txt" --set "menus=$here/../tools/prefetch/menus.txt" > "$out/manifest.json"
python3 -I - "$out" "$data" <<'PY'
import json, sys
out, data = sys.argv[1:3]
json.dump({"data": data, "manifest": "manifest.json"}, open(out + "/config.json", "w"), indent=2)
PY
: > "$out/.nojekyll"        # serve the files as they are (no Jekyll processing)
echo "site in $out: $(ls "$out" | wc -l) files, $(du -sh "$out" | cut -f1); game data from $data"
