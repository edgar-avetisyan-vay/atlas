#!/bin/bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-atlas-local}"
CONTAINER_NAME="${CONTAINER_NAME:-atlas-local}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTML_DIR="${REPO_ROOT}/data/html"
BUILD_INFO_SCRIPT="${REPO_ROOT}/config/scripts/write_build_info.sh"
UI_PORT="${ATLAS_UI_PORT:-8884}"
API_PORT="${ATLAS_API_PORT:-8885}"

log() {
  echo -e "[local-run] $1"
}

command -v docker >/dev/null 2>&1 || { echo "❌ docker is not installed or not in PATH"; exit 1; }

log "Preparing static build metadata..."
if [[ -x "$BUILD_INFO_SCRIPT" ]]; then
  ATLAS_UI_VERSION="local-dev" ATLAS_UI_COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo 'dirty')" \
  ATLAS_UI_BUILT_AT="$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  "$BUILD_INFO_SCRIPT" "$HTML_DIR/build-info.json"
else
  log "Skipping build-info (script missing at $BUILD_INFO_SCRIPT)"
fi

log "Stopping any running container named $CONTAINER_NAME..."
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

log "Building $IMAGE_NAME from the current repo..."
DOCKER_BUILDKIT=1 docker build -t "$IMAGE_NAME" "$REPO_ROOT"

log "Starting container on host network..."
docker run -d \
  --name "$CONTAINER_NAME" \
  --network host \
  --cap-add NET_RAW \
  --cap-add NET_ADMIN \
  -e ATLAS_UI_PORT="$UI_PORT" \
  -e ATLAS_API_PORT="$API_PORT" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  "$IMAGE_NAME"

log "Atlas UI should now be reachable at http://localhost:${UI_PORT}/"
log "FastAPI docs are proxied at http://localhost:${UI_PORT}/api/docs"
