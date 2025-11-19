#!/bin/bash
set -euo pipefail

OUTPUT_PATH="${1:-${BUILD_INFO_OUTPUT:-/usr/share/nginx/html/build-info.json}}"
VERSION="${ATLAS_UI_VERSION:-${UI_VERSION:-dev}}"
COMMIT="${ATLAS_UI_COMMIT:-${UI_COMMIT:-unknown}}"
BUILT_AT="${ATLAS_UI_BUILT_AT:-${UI_BUILT_AT:-$(date -u +'%Y-%m-%dT%H:%M:%SZ')}}"

mkdir -p "$(dirname "$OUTPUT_PATH")"
cat >"$OUTPUT_PATH" <<JSON
{ "version": "${VERSION}", "commit": "${COMMIT}", "builtAt": "${BUILT_AT}" }
JSON
