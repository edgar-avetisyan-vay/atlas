#!/bin/bash
set -euo pipefail

MODE_ARG="${1:-}"
DEFAULT_MODE="server"
if [[ -n "$MODE_ARG" && "$MODE_ARG" != "server" && "$MODE_ARG" != "agent" ]]; then
  echo "Usage: ./local-run.sh [server|agent]"
  exit 1
fi
MODE="${MODE_ARG:-${ATLAS_MODE:-$DEFAULT_MODE}}"
MODE="${MODE,,}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTML_DIR="${REPO_ROOT}/data/html"
BUILD_INFO_SCRIPT="${REPO_ROOT}/config/scripts/write_build_info.sh"
UI_PORT="${ATLAS_UI_PORT:-8884}"
API_PORT="${ATLAS_API_PORT:-8885}"

if [[ "$MODE" == "agent" ]]; then
  IMAGE_NAME="${IMAGE_NAME:-atlas-agent-local}"
  CONTAINER_NAME="${CONTAINER_NAME:-atlas-agent-local}"
else
  MODE="server"
  IMAGE_NAME="${IMAGE_NAME:-atlas-local}"
  CONTAINER_NAME="${CONTAINER_NAME:-atlas-local}"
fi

log() {
  echo -e "[local-run] $1"
}

command -v docker >/dev/null 2>&1 || { echo "❌ docker is not installed or not in PATH"; exit 1; }

if [[ "$MODE" == "server" ]]; then
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
  server_args=(
    docker run -d
    --name "$CONTAINER_NAME"
    --network host
    -e ATLAS_MODE=server
    -e ATLAS_UI_PORT="$UI_PORT"
    -e ATLAS_API_PORT="$API_PORT"
  )
  if [[ -n "${ATLAS_ENABLE_SCHEDULER:-}" ]]; then
    server_args+=( -e "ATLAS_ENABLE_SCHEDULER=$ATLAS_ENABLE_SCHEDULER" )
  fi
  for var in FASTSCAN_INTERVAL DOCKERSCAN_INTERVAL DEEPSCAN_INTERVAL SCAN_SUBNETS; do
    if [[ -n "${!var:-}" ]]; then
      server_args+=( -e "$var=${!var}" )
    fi
  done
  server_args+=( "$IMAGE_NAME" )

  "${server_args[@]}"

  log "Atlas UI should now be reachable at http://localhost:${UI_PORT}/"
  log "FastAPI docs are proxied at http://localhost:${UI_PORT}/api/docs"
else
  log "Preparing lightweight agent image..."
  REQUIRED_ENV=(ATLAS_CONTROLLER_URL ATLAS_SITE_ID ATLAS_AGENT_ID ATLAS_AGENT_TOKEN)
  for var in "${REQUIRED_ENV[@]}"; do
    if [[ -z "${!var:-}" ]]; then
      echo "❌ $var must be set in the environment for agent mode"
      exit 1
    fi
  done

  log "Stopping any running container named $CONTAINER_NAME..."
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

  log "Building $IMAGE_NAME (agent) from the current repo..."
  DOCKER_BUILDKIT=1 docker build -f Dockerfile.agent -t "$IMAGE_NAME" "$REPO_ROOT"

  log "Starting deep-scan agent on host network..."
  run_args=(
    docker run -d
    --name "$CONTAINER_NAME"
    --network host
    --cap-add NET_RAW
    --cap-add NET_ADMIN
    -e ATLAS_MODE=agent
    -e ATLAS_CONTROLLER_URL="$ATLAS_CONTROLLER_URL"
    -e ATLAS_SITE_ID="$ATLAS_SITE_ID"
    -e ATLAS_AGENT_ID="$ATLAS_AGENT_ID"
    -e ATLAS_AGENT_TOKEN="$ATLAS_AGENT_TOKEN"
    "$IMAGE_NAME"
  )

  if [[ -n "${ATLAS_SITE_NAME:-}" ]]; then
    run_args+=( -e "ATLAS_SITE_NAME=$ATLAS_SITE_NAME" )
  fi
  if [[ -n "${SCAN_SUBNETS:-}" ]]; then
    run_args+=( -e "SCAN_SUBNETS=$SCAN_SUBNETS" )
  fi
  if [[ -n "${ATLAS_AGENT_INTERVAL:-}" ]]; then
    run_args+=( -e "ATLAS_AGENT_INTERVAL=$ATLAS_AGENT_INTERVAL" )
  fi
  if [[ -n "${ATLAS_AGENT_ONCE:-}" ]]; then
    run_args+=( -e "ATLAS_AGENT_ONCE=$ATLAS_AGENT_ONCE" )
  fi

  "${run_args[@]}"

  log "Agent started. Logs: docker logs -f $CONTAINER_NAME"
fi
