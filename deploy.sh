#!/bin/bash
set -euo pipefail

echo "🔧 Atlas CI/CD Deployment Script"

### Sync docker group membership for current session (avoid infinite recursion)
# Resolve absolute path to this script for re-exec
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "$0")"
if [[ -z "${ATLAS_IN_SG:-}" ]]; then
  if command -v id >/dev/null 2>&1 && id -nG 2>/dev/null | grep -qw docker; then
    echo "✅ Docker group already present; continuing..."
  elif command -v sg >/dev/null 2>&1 && getent group docker >/dev/null 2>&1; then
    echo "🔄 Syncing docker group membership..."
    # Reconstruct quoted args safely
    QUOTED_ARGS=()
    for arg in "$@"; do
      QUOTED_ARGS+=("$(printf '%q' "$arg")")
    done
    CMD="ATLAS_IN_SG=1 \"$SCRIPT_PATH\" ${QUOTED_ARGS[*]}"
    exec sg docker -c "$CMD"
  else
    echo "⚠️ 'docker' group not available; proceeding without group switch"
  fi
else
  echo "✅ Running under docker group context"
fi

# Resolve repo root from this script's location
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTML_DIR="${REPO_ROOT}/data/html"

BUILD_INFO_SCRIPT="${REPO_ROOT}/config/scripts/write_build_info.sh"
IMAGE_DEFAULT="atlas-local"
IMAGE="${IMAGE:-$IMAGE_DEFAULT}"
CONTAINER_NAME="${CONTAINER_NAME:-atlas-dev}"

usage() {
  cat <<EOF
Usage: ./deploy.sh [options]

Options:
  --image <name>       Override the container image (default: ${IMAGE_DEFAULT})
  --version <tag>      Override the version tag (default: local-YYYYMMDDHHMMSS)
  --tag-latest         Also tag the image as :latest
  --push               Push the built image to the configured registry (disabled by default)
  --skip-run           Build/tag only; skip starting the container
  -h, --help           Show this help message

Environment overrides:
  IMAGE                Same as --image
  VERSION              Same as --version
  CONTAINER_NAME       Name for the runtime container (default: atlas-dev)
  RUN_BACKUP=1         Enable backup hook
  BACKUP_SCRIPT        Executable script to run when RUN_BACKUP=1
EOF
}

VERSION_DEFAULT="local-$(date +%Y%m%d%H%M%S)"
VERSION="${VERSION:-$VERSION_DEFAULT}"
DO_LATEST=false
DO_PUSH=false
RUN_CONTAINER=true

PARSED_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -i|--image)
      if [[ -z "${2:-}" ]]; then
        echo "❌ --image requires a value"
        exit 1
      fi
      IMAGE="$2"
      shift 2
      ;;
    --version)
      if [[ -z "${2:-}" ]]; then
        echo "❌ --version requires a value"
        exit 1
      fi
      VERSION="$2"
      shift 2
      ;;
    --tag-latest)
      DO_LATEST=true
      shift
      ;;
    --push)
      DO_PUSH=true
      shift
      ;;
    --skip-run)
      RUN_CONTAINER=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      PARSED_ARGS+=("$1")
      shift
      ;;
  esac
done
set -- "${PARSED_ARGS[@]}"

echo "📁 Repo root: $REPO_ROOT"
echo "🗂️  HTML dir:   $HTML_DIR"
echo "🏷️  Version:    $VERSION"
echo "🐳 Image:      $IMAGE"
if $DO_LATEST; then
  echo "🔁 Will also tag :latest"
fi
if $DO_PUSH; then
  echo "📤 Push enabled (requires registry access)"
else
  echo "📥 Push disabled — build remains local to this repo"
fi

# Sanity checks
command -v docker >/dev/null 2>&1 || { echo "❌ docker is not installed or not in PATH"; exit 1; }

echo "📦 Starting deployment for version: $VERSION (image: $IMAGE)"

# Step 1: Write build-info.json for local dev fallbacks
echo "📝 Writing build-info.json..."
COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo 'dirty')"
BUILD_TIME="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
if [[ -x "$BUILD_INFO_SCRIPT" ]]; then
  ATLAS_UI_VERSION="$VERSION" ATLAS_UI_COMMIT="$COMMIT_SHA" ATLAS_UI_BUILT_AT="$BUILD_TIME" \
    "$BUILD_INFO_SCRIPT" "$HTML_DIR/build-info.json"
else
  echo "⚠️ $BUILD_INFO_SCRIPT missing; skipping build-info write"
fi

# Step 3: Stop and remove existing container if present
echo "🧹 Removing existing '$CONTAINER_NAME' container if running..."
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

# Step 4: Optional backup hook controlled via RUN_BACKUP=1 BACKUP_SCRIPT=/path/to/script.sh
if [[ "${RUN_BACKUP:-0}" == "1" ]]; then
  if [[ -n "${BACKUP_SCRIPT:-}" ]]; then
    if [[ -x "$BACKUP_SCRIPT" ]]; then
      echo "🗃️ Running backup script: $BACKUP_SCRIPT"
      "$BACKUP_SCRIPT" || echo "⚠️ Backup script returned non-zero exit; continuing..."
    else
      echo "⚠️ Backup script '$BACKUP_SCRIPT' is not executable; skipping"
    fi
  else
    echo "⚠️ RUN_BACKUP=1 set but BACKUP_SCRIPT is empty; skipping backup"
  fi
else
  echo "ℹ️ Skipping backup (set RUN_BACKUP=1 and BACKUP_SCRIPT=/path/to/script.sh)"
fi

# Step 5: Build Docker image from repo root
echo "🐳 Building Docker image: $IMAGE:$VERSION"
DOCKER_BUILDKIT=1 docker build \
  --build-arg UI_VERSION="$VERSION" \
  --build-arg UI_COMMIT="$COMMIT_SHA" \
  --build-arg UI_BUILD_TIME="$BUILD_TIME" \
  -t "$IMAGE:$VERSION" "$REPO_ROOT"

# Step 5b: Optionally tag as latest
if $DO_LATEST; then
  echo "🔄 Tagging Docker image as latest"
  docker tag "$IMAGE:$VERSION" "$IMAGE:latest"
else
  echo "⏭️ Skipping 'latest' tag per selection"
fi

# Step 6: Push image(s) to Docker Hub
if ! $DO_PUSH; then
  echo "⏭️ Skipping Docker push as requested"
  # exit 0
else
  echo "📤 Pushing Docker image(s) to Docker Hub..."
  docker push "$IMAGE:$VERSION"
  if $DO_LATEST; then
    docker push "$IMAGE:latest"
  fi
fi

if $RUN_CONTAINER; then
  # Step 7: Run new container
  echo "🚀 Deploying container..."
  docker run -d \
    --name "$CONTAINER_NAME" \
    --network=host \
    --cap-add=NET_RAW \
    --cap-add=NET_ADMIN \
    -e ATLAS_UI_PORT=8884 \
    -e ATLAS_API_PORT=8885 \
    -v /var/run/docker.sock:/var/run/docker.sock \
    "$IMAGE:$VERSION"
else
  echo "⏭️ Skipping container run (per --skip-run)"
fi

if $DO_LATEST; then
  echo "✅ Deployment complete for version: $VERSION (also tagged as latest)"
else
  echo "✅ Deployment complete for version: $VERSION"
fi