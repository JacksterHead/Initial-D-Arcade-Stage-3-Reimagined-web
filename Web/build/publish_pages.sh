#!/bin/bash
# Publish a site folder (Web/build/package_pages.sh) to the `gh-pages` branch of a remote.
#   Web/build/publish_pages.sh <site dir> [remote url, default: origin of this checkout]
# The branch only ever holds build output, so it is replaced with a single fresh commit (force push).
# Then, once: repository Settings -> Pages -> Deploy from a branch -> gh-pages / (root).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
site="$(cd "${1:?site dir}" && pwd)"
remote="${2:-$(git -C "$here" remote get-url origin)}"
source_sha="$(git -C "$here" rev-parse --short HEAD 2>/dev/null || echo unknown)"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
cp -a "$site/." "$work/"
git -C "$work" init -q -b gh-pages
git -C "$work" add -A -f
git -C "$work" -c user.name="${GIT_AUTHOR_NAME:-Web build}" -c user.email="${GIT_AUTHOR_EMAIL:-noreply@users.noreply.github.com}" \
  commit -q -m "Deploy web client (source $source_sha)"
git -C "$work" push -f "$remote" gh-pages
echo "pushed gh-pages to $remote"
