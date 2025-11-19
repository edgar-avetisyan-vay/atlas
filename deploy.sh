#!/bin/bash
set -euo pipefail

echo "🔧 Atlas CI/CD Deployment Script"

### Sync docker group membership for current session (avoid infinite recursion)
# Resolve absolute path to this script for re-exec
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "$0")"
if [[ -z "${ATLAS_IN_SG:-}" ]]; then
  if command -v id >/dev/null 2>&1 && id -nG 2>/dev/null | grep -qw docker; then
    echo "✅ Docker group already present; continuing..."
  elif command -v sg >/dev/null 2>&1; then
    echo "🔄 Syncing docker group membership..."
    # Reconstruct quoted args safely
    QUOTED_ARGS=()
    for arg in "$@"; do
      QUOTED_ARGS+=("$(printf '%q' "$arg")")
    done
    CMD="ATLAS_IN_SG=1 \"$SCRIPT_PATH\" ${QUOTED_ARGS[*]}"
    exec sg docker -c "$CMD"
  else
    echo "⚠️ 'sg' command not available; proceeding without group switch"
  fi
else
  echo "✅ Running under docker group context"
fi

# Resolve repo root from this script's location
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HTML_DIR="${REPO_ROOT}/data/html"
BUILD_INFO_SCRIPT="${REPO_ROOT}/config/scripts/write_build_info.sh"
IMAGE="keinstien/atlas"
CONTAINER_NAME="atlas-dev"
if [[ -f "$HTML_DIR/build-info.json" ]]; then
  CURRENT_VERSION=$(awk -F'"' '{print $4}' "$HTML_DIR/build-info.json")
else
  CURRENT_VERSION="unknown"
fi

echo "📁 Repo root: $REPO_ROOT"
echo "🗂️  HTML dir:   $HTML_DIR"

# Prompt for version (allow env override)
if [[ -z "${VERSION:-}" ]]; then
  read -p "👉 Enter the version tag (current version: $CURRENT_VERSION): " VERSION
fi
if [[ -z "${VERSION:-}" ]]; then
  echo "❌ Version tag is required. Exiting..."
  exit 1
fi

# Ask whether to also tag this version as 'latest' (allow env override)
if [[ -z "${TAG_LATEST:-}" ]]; then
  read -p "👉 Tag this version as 'latest' as well? (y/N): " TAG_LATEST
fi
if [[ "${TAG_LATEST:-}" =~ ^([yY][eE][sS]|[yY])$ ]]; then
  DO_LATEST=true
else
  DO_LATEST=false
fi

# Ask whether to push this version to Docker Hub (allow env override via PUSH_D or DO_PUSH)
if [[ -z "${PUSH_D:-}" && -z "${DO_PUSH:-}" ]]; then
  read -p "👉 Push this version to Docker Hub? (y/N): " PUSH_D
fi
if [[ "${PUSH_D:-}" =~ ^([yY][eE][sS]|[yY])$ || "${DO_PUSH:-}" =~ ^([tT][rR][uU][eE]|[yY][eE][sS]|[yY])$ ]]; then
  DO_PUSH=true
else
  DO_PUSH=false
fi

# Sanity checks
command -v docker >/dev/null 2>&1 || { echo "❌ docker is not installed or not in PATH"; exit 1; }

echo "📦 Starting deployment for version: $VERSION"

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

# Step 4: (Optional) backup disabled by default. Enable by exporting RUN_BACKUP=1
if [[ "${RUN_BACKUP:-0}" == "1" && -x "/home/karam/atlas-repo-backup.sh" ]]; then
  echo "🗃️ Running backup script..."
  /home/karam/atlas-repo-backup.sh || echo "⚠️ Backup script returned non-zero exit; continuing..."
else
  echo "ℹ️ Skipping backup (set RUN_BACKUP=1 to enable and ensure script exists)"
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

if $DO_LATEST; then
  echo "✅ Deployment complete for version: $VERSION (also tagged as latest)"
else
  echo "✅ Deployment complete for version: $VERSION"
fi