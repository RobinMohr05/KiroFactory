#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Vibecode Heaven — Deploy Azure Container Apps Environment
#
# Prerequisites:
#   - Azure CLI installed and logged in (az login)
#   - Subscription selected (az account set --subscription <id>)
#
# Usage:
#   ./deploy.sh                    # Deploy with defaults
#   ./deploy.sh --what-if          # Preview changes without deploying
#   ./deploy.sh --resource-group my-rg  # Use a specific resource group name
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

RESOURCE_GROUP="${RESOURCE_GROUP:-kirofactory-rg}"
LOCATION="${LOCATION:-germanywestcentral}"
DEPLOYMENT_NAME="kirofactory-infra-$(date +%Y%m%d-%H%M%S)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHAT_IF=false

# ─── Parse Arguments ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --what-if)
      WHAT_IF=true
      shift
      ;;
    --resource-group)
      RESOURCE_GROUP="$2"
      shift 2
      ;;
    --location)
      LOCATION="$2"
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
  echo "ERROR: Azure CLI (az) is not installed. Install from https://aka.ms/installazurecli"
  exit 1
fi

log "Checking Azure login status..."
if ! az account show &> /dev/null; then
  echo "ERROR: Not logged in to Azure. Run 'az login' first."
  exit 1
fi

SUBSCRIPTION=$(az account show --query name -o tsv)
log "Active subscription: $SUBSCRIPTION"

# ─── Create Resource Group ────────────────────────────────────────────────────

log "Ensuring resource group '$RESOURCE_GROUP' exists in '$LOCATION'..."
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --tags project=VibecodeHeaven environment=production managedBy=bicep \
  --output none

log "Resource group ready."

# ─── Deploy Bicep Template ────────────────────────────────────────────────────

if [ "$WHAT_IF" = true ]; then
  log "Running what-if analysis (no changes will be made)..."
  az deployment group what-if \
    --resource-group "$RESOURCE_GROUP" \
    --template-file "$SCRIPT_DIR/main.bicep" \
    --parameters "$SCRIPT_DIR/main.parameters.json" \
    --parameters location="$LOCATION"
else
  log "Deploying Vibecode Heaven infrastructure..."
  log "Deployment name: $DEPLOYMENT_NAME"
  
  RESULT=$(az deployment group create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$DEPLOYMENT_NAME" \
    --template-file "$SCRIPT_DIR/main.bicep" \
    --parameters "$SCRIPT_DIR/main.parameters.json" \
    --parameters location="$LOCATION" \
    --output json)

  # ─── Print Outputs ────────────────────────────────────────────────────────

  log "✅ Deployment completed successfully!"
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo " KiroFactory Infrastructure Outputs"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
  echo "  Default Domain:  $(echo "$RESULT" | jq -r '.properties.outputs.defaultDomain.value')"
  echo "  Static IP:       $(echo "$RESULT" | jq -r '.properties.outputs.staticIp.value')"
  echo "  ACR Login:       $(echo "$RESULT" | jq -r '.properties.outputs.acrLoginServer.value')"
  echo "  Environment ID:  $(echo "$RESULT" | jq -r '.properties.outputs.environmentId.value')"
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
  echo "Next steps:"
  echo "  1. Build and push your container image to ACR:"
  echo "     cd infra && ./build-and-push.sh --tag latest"
  echo ""
  echo "  2. Deploy the Container App (orchestrator):"
  echo "     export NEO4J_URI=neo4j+s://xxxxx.databases.neo4j.io NEO4J_PASSWORD=<pw>"
  echo "     export JWT_SECRET=\$(openssl rand -hex 32)"
  echo "     export ENCRYPTION_KEY=\$(openssl rand -hex 32)"
  echo "     cd infra && ./deploy-app.sh"
  echo ""
fi
