#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build and push the KiroFactory Worker container image to ACR
#
# Usage:
#   ./build.sh                          # Build only (local)
#   ./build.sh --push                   # Build and push to ACR
#   ./build.sh --acr kirofactoryacr     # Specify ACR name
#   ./build.sh --tag v1.2.3             # Specify tag (default: latest)
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

ACR_NAME="${ACR_NAME:-kirofactoryacr}"
IMAGE_NAME="kirofactory-worker"
TAG="latest"
PUSH=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ─── Parse Arguments ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --push)
      PUSH=true
      shift
      ;;
    --acr)
      ACR_NAME="$2"
      shift 2
      ;;
    --tag)
      TAG="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

ACR_LOGIN_SERVER="${ACR_NAME}.azurecr.io"
FULL_IMAGE="${ACR_LOGIN_SERVER}/${IMAGE_NAME}:${TAG}"

# ─── Build ────────────────────────────────────────────────────────────────────

echo "════════════════════════════════════════════════════════"
echo " Building ${IMAGE_NAME}:${TAG}"
echo "════════════════════════════════════════════════════════"
echo ""

docker build \
  --tag "${IMAGE_NAME}:${TAG}" \
  --tag "${FULL_IMAGE}" \
  --label "build.date=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --label "build.tag=${TAG}" \
  "${SCRIPT_DIR}"

echo ""
echo "✅ Build successful: ${IMAGE_NAME}:${TAG}"

# Print image size
SIZE=$(docker image inspect "${IMAGE_NAME}:${TAG}" --format='{{.Size}}' 2>/dev/null || echo "0")
SIZE_MB=$((SIZE / 1024 / 1024))
echo "   Image size: ${SIZE_MB}MB"

if [ "$SIZE_MB" -gt 300 ]; then
  echo "   ⚠️  WARNING: Image exceeds 300MB target!"
fi

# ─── Push ─────────────────────────────────────────────────────────────────────

if [ "$PUSH" = true ]; then
  echo ""
  echo "════════════════════════════════════════════════════════"
  echo " Pushing to ${ACR_LOGIN_SERVER}"
  echo "════════════════════════════════════════════════════════"
  echo ""

  # Login to ACR
  az acr login --name "${ACR_NAME}"

  # Push
  docker push "${FULL_IMAGE}"

  echo ""
  echo "✅ Pushed: ${FULL_IMAGE}"

  # Also push as latest if tag != latest
  if [ "${TAG}" != "latest" ]; then
    docker tag "${IMAGE_NAME}:${TAG}" "${ACR_LOGIN_SERVER}/${IMAGE_NAME}:latest"
    docker push "${ACR_LOGIN_SERVER}/${IMAGE_NAME}:latest"
    echo "✅ Pushed: ${ACR_LOGIN_SERVER}/${IMAGE_NAME}:latest"
  fi
fi

echo ""
echo "Done."
