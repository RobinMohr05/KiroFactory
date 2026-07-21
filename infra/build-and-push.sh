#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# KiroFactory — Build and Push Docker Image to ACR
#
# Prerequisites:
#   - Azure CLI installed and logged in (az login)
#   - Docker installed and running
#   - ACR already deployed (run deploy.sh first)
#
# Usage:
#   ./build-and-push.sh                    # Build and push with 'latest' tag
#   ./build-and-push.sh --tag v1.0.0       # Build and push with specific tag
#   ./build-and-push.sh --acr-name myacr   # Override ACR name
#   ./build-and-push.sh --build-only       # Only build, don't push
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

ACR_NAME="${ACR_NAME:-kirofactoryacr}"
IMAGE_NAME="kirofactory"
IMAGE_TAG="latest"
RESOURCE_GROUP="${RESOURCE_GROUP:-kirofactory-rg}"
BUILD_ONLY=false

# Project root (one level up from infra/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ─── Parse Arguments ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    --acr-name)
      ACR_NAME="$2"
      shift 2
      ;;
    --resource-group)
      RESOURCE_GROUP="$2"
      shift 2
      ;;
    --build-only)
      BUILD_ONLY=true
      shift
      ;;
    *)
      echo "Unknown argument: $1"
      echo "Usage: $0 [--tag <tag>] [--acr-name <name>] [--resource-group <rg>] [--build-only]"
      exit 1
      ;;
  esac
done

# ─── Functions ────────────────────────────────────────────────────────────────

log() {
  echo "[$(date '+%H:%M:%S')] $*"
}

# ─── Pre-flight Checks ───────────────────────────────────────────────────────

log "Checking Docker..."
if ! command -v docker &> /dev/null; then
  echo "ERROR: Docker is not installed."
  exit 1
fi

if ! docker info &> /dev/null; then
  echo "ERROR: Docker daemon is not running."
  exit 1
fi

# ─── Get ACR Login Server ─────────────────────────────────────────────────────

if [ "$BUILD_ONLY" = false ]; then
  log "Checking Azure CLI..."
  if ! command -v az &> /dev/null; then
    echo "ERROR: Azure CLI (az) is not installed."
    exit 1
  fi

  log "Getting ACR login server for '$ACR_NAME'..."
  ACR_LOGIN_SERVER=$(az acr show \
    --name "$ACR_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --query loginServer \
    --output tsv 2>/dev/null || echo "")

  if [ -z "$ACR_LOGIN_SERVER" ]; then
    echo "ERROR: Could not find ACR '$ACR_NAME' in resource group '$RESOURCE_GROUP'."
    echo "Make sure the infrastructure is deployed (run deploy.sh first)."
    exit 1
  fi

  log "ACR login server: $ACR_LOGIN_SERVER"
fi

# ─── Build Docker Image ──────────────────────────────────────────────────────

FULL_IMAGE="${ACR_LOGIN_SERVER:-local}/${IMAGE_NAME}:${IMAGE_TAG}"

log "Building Docker image..."
log "  Context: $PROJECT_ROOT"
log "  Tag: $FULL_IMAGE"

docker build \
  --platform linux/amd64 \
  --tag "$FULL_IMAGE" \
  --tag "${ACR_LOGIN_SERVER:-local}/${IMAGE_NAME}:latest" \
  "$PROJECT_ROOT"

log "✅ Build completed: $FULL_IMAGE"

if [ "$BUILD_ONLY" = true ]; then
  log "Build-only mode — skipping push."
  exit 0
fi

# ─── Login to ACR ─────────────────────────────────────────────────────────────

log "Logging in to ACR '$ACR_NAME'..."
az acr login --name "$ACR_NAME"

# ─── Push Image ───────────────────────────────────────────────────────────────

log "Pushing image to ACR..."
docker push "$FULL_IMAGE"

# Also push 'latest' tag if the specified tag is different
if [ "$IMAGE_TAG" != "latest" ]; then
  docker push "${ACR_LOGIN_SERVER}/${IMAGE_NAME}:latest"
fi

log "✅ Push completed!"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Image pushed successfully"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  Image: $FULL_IMAGE"
echo "  ACR:   $ACR_LOGIN_SERVER"
echo ""
echo "Next steps:"
echo "  Deploy the Container App:"
echo "    az deployment group create \\"
echo "      --resource-group $RESOURCE_GROUP \\"
echo "      --template-file infra/modules/container-app.bicep \\"
echo "      --parameters environmentId=<env-id> \\"
echo "                   acrLoginServer=$ACR_LOGIN_SERVER \\"
echo "                   acrName=$ACR_NAME \\"
echo "                   imageTag=$IMAGE_TAG \\"
echo "                   dbServer=<server> \\"
echo "                   dbUser=<user> \\"
echo "                   dbPassword=<password> \\"
echo "                   jwtSecret=<secret> \\"
echo "                   encryptionKey=<key>"
echo ""
