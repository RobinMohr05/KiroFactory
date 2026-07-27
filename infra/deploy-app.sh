#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Vibecode Heaven — Deploy Container App (Orchestrator)
#
# Deploys the Vibecode Heaven backend as an always-on Container App.
# Requires:
#   - Infrastructure deployed (deploy.sh)
#   - Image pushed to ACR (build-and-push.sh)
#   - SQL Server credentials
#
# Usage:
#   ./deploy-app.sh                         # Deploy with defaults
#   ./deploy-app.sh --what-if               # Preview only
#   ./deploy-app.sh --tag v1.0.0            # Deploy specific image tag
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

RESOURCE_GROUP="${RESOURCE_GROUP:-SandboxForRM}"
ACR_NAME="${ACR_NAME:-kiroFactory}"
CONTAINERAPP_ENV="${CONTAINERAPP_ENV:-managedEnvironment-SandboxForRM-8f71}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
WORKER_IMAGE_TAG="${WORKER_IMAGE_TAG:-latest}"
PROXY_IMAGE_TAG="${PROXY_IMAGE_TAG:-latest}"
DEPLOYMENT_NAME="kirofactory-app-$(date +%Y%m%d-%H%M%S)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHAT_IF=false

# These should be set as environment variables or passed via --parameter flags
# DB_SERVER, DB_USER, DB_PASSWORD, JWT_SECRET, ENCRYPTION_KEY, ACA_WORKER_SECRET
# Optional: AZURE_DEVOPS_EXT_PAT (org-level git-clone fallback for workers)

# ─── Parse Arguments ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --what-if)
      WHAT_IF=true
      shift
      ;;
    --tag)
      IMAGE_TAG="$2"
      shift 2
      ;;
    --resource-group)
      RESOURCE_GROUP="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1"
      exit 1
      ;;
  esac
done

# ─── Functions ────────────────────────────────────────────────────────────────

log() {
  echo "[$(date '+%H:%M:%S')] $*"
}

# ─── Pre-flight Checks ───────────────────────────────────────────────────────

log "Checking Azure CLI..."
if ! command -v az &> /dev/null; then
  echo "ERROR: Azure CLI (az) is not installed."
  exit 1
fi

if ! az account show &> /dev/null; then
  echo "ERROR: Not logged in to Azure. Run 'az login' first."
  exit 1
fi

# Verify required secrets are set
if [ -z "${DB_SERVER:-}" ]; then
  echo "ERROR: DB_SERVER environment variable is required."
  echo "  export DB_SERVER=your-server.database.windows.net"
  exit 1
fi
if [ -z "${DB_USER:-}" ]; then
  echo "ERROR: DB_USER environment variable is required."
  exit 1
fi
if [ -z "${DB_PASSWORD:-}" ]; then
  echo "ERROR: DB_PASSWORD environment variable is required."
  exit 1
fi
if [ -z "${JWT_SECRET:-}" ]; then
  echo "ERROR: JWT_SECRET environment variable is required."
  echo "  export JWT_SECRET=\$(openssl rand -hex 32)"
  exit 1
fi
if [ -z "${ENCRYPTION_KEY:-}" ]; then
  echo "ERROR: ENCRYPTION_KEY environment variable is required."
  echo "  export ENCRYPTION_KEY=\$(openssl rand -hex 32)"
  exit 1
fi
if [ -z "${ACA_WORKER_SECRET:-}" ]; then
  echo "ERROR: ACA_WORKER_SECRET environment variable is required (worker ↔ orchestrator auth)."
  echo "  export ACA_WORKER_SECRET=\$(openssl rand -hex 32)"
  exit 1
fi

# ─── Resolve Infrastructure References ───────────────────────────────────────

log "Resolving Container Apps Environment ID ($CONTAINERAPP_ENV)..."
ENV_ID=$(az containerapp env show \
  --name "$CONTAINERAPP_ENV" \
  --resource-group "$RESOURCE_GROUP" \
  --query id \
  --output tsv 2>/dev/null || echo "")

if [ -z "$ENV_ID" ]; then
  echo "ERROR: Container Apps Environment '$CONTAINERAPP_ENV' not found in '$RESOURCE_GROUP'."
  echo "Run deploy.sh first to create the infrastructure, or set CONTAINERAPP_ENV to the correct name."
  exit 1
fi

log "Resolving Container Apps Environment default domain..."
ENV_DOMAIN=$(az containerapp env show \
  --name "$CONTAINERAPP_ENV" \
  --resource-group "$RESOURCE_GROUP" \
  --query properties.defaultDomain \
  --output tsv)

log "Resolving ACR login server..."
ACR_LOGIN_SERVER=$(az acr show \
  --name "$ACR_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query loginServer \
  --output tsv)

log "Environment: $ENV_ID"
log "Env domain:  $ENV_DOMAIN"
log "ACR: $ACR_LOGIN_SERVER"
log "Image tag: $IMAGE_TAG (worker: $WORKER_IMAGE_TAG, proxy: $PROXY_IMAGE_TAG)"

# ─── Deploy Container App ─────────────────────────────────────────────────────

if [ "$WHAT_IF" = true ]; then
  log "Running what-if analysis..."
  az deployment group what-if \
    --resource-group "$RESOURCE_GROUP" \
    --template-file "$SCRIPT_DIR/modules/container-app.bicep" \
    --parameters environmentId="$ENV_ID" \
                 envDefaultDomain="$ENV_DOMAIN" \
                 acrLoginServer="$ACR_LOGIN_SERVER" \
                 acrName="$ACR_NAME" \
                 imageTag="$IMAGE_TAG" \
                 workerImageTag="$WORKER_IMAGE_TAG" \
                 proxyImageTag="$PROXY_IMAGE_TAG" \
                 dbServer="$DB_SERVER" \
                 dbDatabase="${DB_DATABASE:-TecFactory}" \
                 dbUser="$DB_USER" \
                 dbPassword="$DB_PASSWORD" \
                 jwtSecret="$JWT_SECRET" \
                 encryptionKey="$ENCRYPTION_KEY" \
                 workerSecret="$ACA_WORKER_SECRET" \
                 azureDevOpsPat="${AZURE_DEVOPS_EXT_PAT:-}"
else
  log "Deploying Vibecode Heaven Orchestrator Container App..."
  
  RESULT=$(az deployment group create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$DEPLOYMENT_NAME" \
    --template-file "$SCRIPT_DIR/modules/container-app.bicep" \
    --parameters environmentId="$ENV_ID" \
                 envDefaultDomain="$ENV_DOMAIN" \
                 acrLoginServer="$ACR_LOGIN_SERVER" \
                 acrName="$ACR_NAME" \
                 imageTag="$IMAGE_TAG" \
                 workerImageTag="$WORKER_IMAGE_TAG" \
                 proxyImageTag="$PROXY_IMAGE_TAG" \
                 dbServer="$DB_SERVER" \
                 dbDatabase="${DB_DATABASE:-TecFactory}" \
                 dbUser="$DB_USER" \
                 dbPassword="$DB_PASSWORD" \
                 jwtSecret="$JWT_SECRET" \
                 encryptionKey="$ENCRYPTION_KEY" \
                 workerSecret="$ACA_WORKER_SECRET" \
                 azureDevOpsPat="${AZURE_DEVOPS_EXT_PAT:-}" \
    --output json)

  FQDN=$(echo "$RESULT" | jq -r '.properties.outputs.fqdn.value')
  APP_NAME=$(echo "$RESULT" | jq -r '.properties.outputs.appName.value')
  REVISION=$(echo "$RESULT" | jq -r '.properties.outputs.latestRevision.value')

  log "✅ Container App deployed successfully!"
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo " KiroFactory Orchestrator — Deployed"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
  echo "  App Name:  $APP_NAME"
  echo "  URL:       https://$FQDN"
  echo "  Revision:  $REVISION"
  echo "  Image:     $ACR_LOGIN_SERVER/kirofactory-api:$IMAGE_TAG"
  echo ""
  echo "  Health:    https://$FQDN/api/health"
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
fi
