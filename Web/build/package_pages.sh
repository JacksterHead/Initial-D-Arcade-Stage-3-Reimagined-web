#!/bin/bash
# Assemble a static site for GitHub Pages (or any static host).
#   Web/build/package_pages.sh <wasm-build dir> <out dir> --data-url <url of the Native/ folder, ending in />
#
# GitHub Pages sites are limited to 1 GB and the game data is ~2.8 GB, so the site holds only the client
# and the data index (manifest.json). config.json tells the client where the data itself lives; the
# usual choice is this repository's own files on raw.githubusercontent.com, pinned to a pushed commit:
#   https://raw.githubusercontent.com/<user>/<repo>/<commit sha>/Native/
# The host of the data must send Access-Control-Allow-Origin (raw.githubusercontent.com does).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$here/../.."
build="${1:?wasm build dir}"; out="${2:?output dir}"; shift 2
data=""
while [ $# -gt 0 ]; do case "$1" in --data-url) data="${2:?}"; shift 2;; *) echo "unknown option $1" >&2; exit 2;; esac; done
[ -n "$data" ] || { echo "--data-url is required" >&2; exit 2; }
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
