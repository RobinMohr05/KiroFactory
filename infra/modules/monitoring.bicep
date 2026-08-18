// KiroFactory — Azure Monitor: Alerts & Workbook
// Configures alert rules and an Azure Monitor Workbook for observability.
//
// Prerequisites:
//   - Log Analytics workspace (created in main.bicep)
//   - Container App deployed (container-app.bicep)
//
// What ACA provides automatically:
//   - Container stdout/stderr → Log Analytics (ContainerAppConsoleLogs_CL)
//   - System logs → ContainerAppSystemLogs_CL
//   - HTTP metrics → requests, latency, response codes

targetScope = 'resourceGroup'

// ─── Parameters ──────────────────────────────────────────────────────────────

@description('Log Analytics workspace resource ID')
param logAnalyticsWorkspaceId string

@description('Container App name (for scoping alerts)')
param containerAppName string = 'kirofactory-orchestrator'

@description('Azure region')
param location string = resourceGroup().location

@description('Email address for alert notifications')
param alertEmail string = ''

@description('Worker crash rate threshold (crashes per 5-minute window)')
param workerCrashRateThreshold int = 3

@description('API error rate threshold (5xx responses per 5-minute window)')
param apiErrorRateThreshold int = 10

@description('Health check failure threshold (consecutive failures before alert)')
param healthCheckFailureThreshold int = 3

@description('Tags applied to all resources')
param tags object = {
  project: 'KiroFactory'
  environment: 'production'
  managedBy: 'bicep'
}

// ─── Variables ───────────────────────────────────────────────────────────────

var workbookId = guid(resourceGroup().id, 'kirofactory-workbook')

// ─── Action Group (notification target for alerts) ───────────────────────────

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'kirofactory-alerts-ag'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'KiroAlerts'
    enabled: true
    emailReceivers: alertEmail != '' ? [
      {
        name: 'admin-email'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ] : []
  }
}

// ─── Alert Rule: Worker Crash Rate ───────────────────────────────────────────
// Fires when worker containers crash more than N times in a 5-minute window.
// Detects kiro-cli process crashes, OOM kills, and unexpected exits.

resource workerCrashAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'kirofactory-worker-crash-rate'
  location: location
  tags: tags
  properties: {
    displayName: 'KiroFactory: Worker Crash Rate Exceeded'
    description: 'Worker containers are crashing at a rate above ${workerCrashRateThreshold} per 5 minutes. Check container logs for root cause.'
    severity: 1 // Critical
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    scopes: [
      logAnalyticsWorkspaceId
    ]
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == "${containerAppName}" or ContainerGroupName_s contains "worker"
            | where Log_s has_any ("worker-exited", "worker crashed", "SIGKILL", "OOMKilled", "exit code")
              or (Log_s has "exitCode" and Log_s !has "exitCode\":0" and Log_s !has "exitCode: 0")
            | summarize CrashCount = count() by bin(TimeGenerated, 5m)
          '''
          timeAggregation: 'Total'
          metricMeasureColumn: 'CrashCount'
          operator: 'GreaterThan'
          threshold: workerCrashRateThreshold
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

// ─── Alert Rule: Orchestrator Health Check Failures ──────────────────────────
// Fires when the /api/health endpoint fails repeatedly (detected via ACA system logs).
// ACA performs liveness/readiness probes — failures appear in system logs.

resource healthCheckAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'kirofactory-health-check-failures'
  location: location
  tags: tags
  properties: {
    displayName: 'KiroFactory: Orchestrator Health Check Failing'
    description: 'The orchestrator health check (/api/health) has failed ${healthCheckFailureThreshold}+ times in 5 minutes. The service may be unhealthy or unresponsive.'
    severity: 1 // Critical
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    scopes: [
      logAnalyticsWorkspaceId
    ]
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppSystemLogs_CL
            | where ContainerAppName_s == "${containerAppName}"
            | where Reason_s has_any ("FailedHealthProbe", "Unhealthy", "BackOff", "ContainerCrashLoopBackOff")
              or (Log_s has "probe" and Log_s has "failed")
            | summarize FailureCount = count() by bin(TimeGenerated, 5m)
          '''
          timeAggregation: 'Total'
          metricMeasureColumn: 'FailureCount'
          operator: 'GreaterThan'
          threshold: healthCheckFailureThreshold
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

// ─── Alert Rule: High API Error Rate ─────────────────────────────────────────
// Fires when the API returns too many 5xx responses in a 5-minute window.
// Uses container console logs since ACA doesn't expose HTTP status codes as metrics
// for custom Container Apps (only for Dapr-enabled apps).

resource apiErrorRateAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'kirofactory-api-error-rate'
  location: location
  tags: tags
  properties: {
    displayName: 'KiroFactory: High API Error Rate (5xx)'
    description: 'The API is returning 5xx errors at a rate above ${apiErrorRateThreshold} per 5 minutes. Investigate application logs for root cause.'
    severity: 2 // Warning
    enabled: true
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    scopes: [
      logAnalyticsWorkspaceId
    ]
    criteria: {
      allOf: [
        {
          query: '''
            ContainerAppConsoleLogs_CL
            | where ContainerAppName_s == "${containerAppName}"
            | where Log_s has_any ("500", "502", "503", "\"status\":5", "Internal Server Error", "Service Unavailable")
              and Log_s has_any ("/api/", "HTTP")
            | summarize ErrorCount = count() by bin(TimeGenerated, 5m)
          '''
          timeAggregation: 'Total'
          metricMeasureColumn: 'ErrorCount'
          operator: 'GreaterThan'
          threshold: apiErrorRateThreshold
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

// ─── Azure Monitor Workbook (Dashboard) ──────────────────────────────────────
// Free with Log Analytics workspace. Provides:
//   - Active sessions count
//   - Worker spawn rate
//   - Average session duration
//   - Error/crash rate
//   - Recent database connection issues (inferred from app logs; there is no
//     Neo4j-driver connection-pool introspection API equivalent to mssql's
//     pool stats, so no pool-usage panel is included — see
//     backend/src/db/connection.ts and design.md's "known gap" note)

resource workbook 'Microsoft.Insights/workbooks@2023-06-01' = {
  name: workbookId
  location: location
  tags: union(tags, { 'hidden-title': 'KiroFactory Dashboard' })
  kind: 'shared'
  properties: {
    displayName: 'KiroFactory Dashboard'
    category: 'workbook'
    sourceId: logAnalyticsWorkspaceId
    serializedData: loadTextContent('../workbook/kirofactory-dashboard.json')
  }
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

@description('Action Group ID')
output actionGroupId string = actionGroup.id

@description('Workbook resource ID')
output workbookId string = workbook.id
