#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Vibecode Heaven — Deploy Monitoring (Alerts + Dashboard Workbook)
#
# Deploys Azure Monitor alert rules and an Azure Monitor Workbook.
# Requires:
#   - Infrastructure deployed (deploy.sh) — Log Analytics workspace must exist
#   - Container App deployed (deploy-app.sh) — for alert scoping
#
# Usage:
#   ./deploy-monitoring.sh                              # Deploy with defaults
#   ./deploy-monitoring.sh --what-if                    # Preview only
#   ./deploy-monitoring.sh --email admin@example.com    # Set alert email
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ─── Configuration ────────────────────────────────────────────────────────────

RESOURCE_GROUP="${RESOURCE_GROUP:-kirofactory-rg}"
DEPLOYMENT_NAME="kirofactory-monitoring-$(date +%Y%m%d-%H%M%S)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WHAT_IF=false
ALERT_EMAIL="${ALERT_EMAIL:-}"
LOG_ANALYTICS_NAME="${LOG_ANALYTICS_NAME:-kirofactory-logs}"
CONTAINER_APP_NAME="${CONTAINER_APP_NAME:-kirofactory-orchestrator}"

# Alert thresholds (can be overridden via env vars)
WORKER_CRASH_THRESHOLD="${WORKER_CRASH_THRESHOLD:-3}"
API_ERROR_THRESHOLD="${API_ERROR_THRESHOLD:-10}"
HEALTH_CHECK_THRESHOLD="${HEALTH_CHECK_THRESHOLD:-3}"

# ─── Parse Arguments ──────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case $1 in
    --what-if)
      WHAT_IF=true
      shift
      ;;
    --email)
      ALERT_EMAIL="$2"
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

SUBSCRIPTION=$(az account show --query name -o tsv)
log "Active subscription: $SUBSCRIPTION"

# ─── Resolve Log Analytics Workspace ID ───────────────────────────────────────

log "Resolving Log Analytics workspace ID..."
LOG_ANALYTICS_ID=$(az monitor log-analytics workspace show \
  --workspace-name "$LOG_ANALYTICS_NAME" \
  --resource-group "$RESOURCE_GROUP" \
  --query id \
  --output tsv 2>/dev/null || echo "")

if [ -z "$LOG_ANALYTICS_ID" ]; then
  echo "ERROR: Log Analytics workspace '$LOG_ANALYTICS_NAME' not found in resource group '$RESOURCE_GROUP'."
  echo "Run deploy.sh first to create the infrastructure."
  exit 1
fi

log "Log Analytics workspace: $LOG_ANALYTICS_ID"

# ─── Deploy Monitoring Module ─────────────────────────────────────────────────

if [ "$WHAT_IF" = true ]; then
  log "Running what-if analysis..."
  az deployment group what-if \
    --resource-group "$RESOURCE_GROUP" \
    --template-file "$SCRIPT_DIR/modules/monitoring.bicep" \
    --parameters logAnalyticsWorkspaceId="$LOG_ANALYTICS_ID" \
                 containerAppName="$CONTAINER_APP_NAME" \
                 alertEmail="$ALERT_EMAIL" \
                 workerCrashRateThreshold="$WORKER_CRASH_THRESHOLD" \
                 apiErrorRateThreshold="$API_ERROR_THRESHOLD" \
                 healthCheckFailureThreshold="$HEALTH_CHECK_THRESHOLD"
else
  log "Deploying KiroFactory monitoring (alerts + workbook)..."
  log "Deployment name: $DEPLOYMENT_NAME"

  if [ -n "$ALERT_EMAIL" ]; then
    log "Alert notifications will be sent to: $ALERT_EMAIL"
  else
    log "⚠ No alert email configured (use --email to set one)"
  fi

  RESULT=$(az deployment group create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$DEPLOYMENT_NAME" \
    --template-file "$SCRIPT_DIR/modules/monitoring.bicep" \
    --parameters logAnalyticsWorkspaceId="$LOG_ANALYTICS_ID" \
                 containerAppName="$CONTAINER_APP_NAME" \
                 alertEmail="$ALERT_EMAIL" \
                 workerCrashRateThreshold="$WORKER_CRASH_THRESHOLD" \
                 apiErrorRateThreshold="$API_ERROR_THRESHOLD" \
                 healthCheckFailureThreshold="$HEALTH_CHECK_THRESHOLD" \
    --output json)

  ACTION_GROUP_ID=$(echo "$RESULT" | jq -r '.properties.outputs.actionGroupId.value')
  WORKBOOK_ID=$(echo "$RESULT" | jq -r '.properties.outputs.workbookId.value')

  log "✅ Monitoring deployed successfully!"
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo " KiroFactory Monitoring — Deployed"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
  echo "  Action Group:  $ACTION_GROUP_ID"
  echo "  Workbook:      $WORKBOOK_ID"
  echo ""
  echo "  Alert Rules:"
  echo "    • Worker crash rate > $WORKER_CRASH_THRESHOLD / 5min"
  echo "    • Health check failures > $HEALTH_CHECK_THRESHOLD / 5min"
  echo "    • API error rate (5xx) > $API_ERROR_THRESHOLD / 5min"
  echo ""
  echo "  Dashboard:"
  echo "    Open Azure Portal → Monitor → Workbooks → KiroFactory Dashboard"
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
fi
