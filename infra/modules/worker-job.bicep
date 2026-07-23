// KiroFactory — Container Apps Job: Worker
// The event-driven (manual trigger, scale-to-zero) Job that runs one Kiro session per
// execution. The orchestrator starts executions via the Azure REST API and overrides the
// container template on every start (image, env, resources) — see backend/src/aca-worker-spawner.ts.
// This module therefore only needs to establish the Job's *base* configuration: environment,
// trigger type, registry credentials, and a placeholder worker container.
//
// It also (optionally) grants the orchestrator's managed identity the least-privilege
// "Container Apps Jobs Operator" role scoped to THIS job, so the RBAC that lets the
// orchestrator start/stop the job lives next to the job definition and can't drift.

targetScope = 'resourceGroup'

// ─── Parameters ──────────────────────────────────────────────────────────────

@description('Container Apps Environment ID that hosts the job')
param environmentId string

@description('ACR login server (e.g., kirofactory.azurecr.io)')
param acrLoginServer string

@description('ACR name for credential reference')
param acrName string

@description('Worker image tag (e.g., latest, v1.0.0)')
param workerImageTag string = 'latest'

@description('Azure region')
param location string = resourceGroup().location

@description('Job name. Must match the orchestrator ACA_JOB_NAME env var.')
param jobName string = 'kirofactory-worker'

@description('Max seconds a single worker execution may run before ACA terminates it')
@minValue(60)
param replicaTimeout int = 3600

@description('''
Object (principal) ID of the orchestrator's system-assigned managed identity. When provided,
this module grants that identity the "Container Apps Jobs Operator" role scoped to this job.
Leave empty to deploy the job without touching RBAC (e.g. when deploying the job standalone).
''')
param orchestratorPrincipalId string = ''

@description('Tags applied to resources')
param tags object = {
  project: 'KiroFactory'
  environment: 'production'
  managedBy: 'bicep'
}

// ─── Variables ───────────────────────────────────────────────────────────────

var workerImage = '${acrLoginServer}/kirofactory-worker:${workerImageTag}'

// Built-in role "Container Apps Jobs Operator" — read + start/stop on ACA jobs
// (Microsoft.App/jobs/read + Microsoft.App/jobs/*/action). Least privilege for the
// orchestrator; do NOT use Contributor.
var jobsOperatorRoleId = 'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b'

// ─── ACR Credential Reference ────────────────────────────────────────────────

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: acrName
}

// ─── Container Apps Job ───────────────────────────────────────────────────────

resource workerJob 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  tags: tags
  properties: {
    environmentId: environmentId
    configuration: {
      // Manual trigger: the orchestrator starts each execution explicitly via the REST API.
      triggerType: 'Manual'
      replicaTimeout: replicaTimeout
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: acrLoginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      secrets: [
        {
          name: 'acr-password'
          value: acr.listCredentials().passwords[0].value
        }
      ]
    }
    template: {
      // Placeholder container. The orchestrator overrides image/env/resources on every
      // start; this base definition just needs to be valid and pullable. CPU/memory are
      // kept in sync with the spawner's per-start override (1 vCPU / 2Gi).
      containers: [
        {
          name: 'worker'
          image: workerImage
          resources: {
            cpu: json('1.0')
            memory: '2Gi'
          }
        }
      ]
    }
  }
}

// ─── RBAC: orchestrator → this Job (optional) ────────────────────────────────
// Grants the orchestrator identity permission to start/stop this job. Scoped to the job
// (least privilege). Created here — alongside the job — so ordering is guaranteed and the
// grant can never point at a non-existent job.

resource jobsOperatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(orchestratorPrincipalId)) {
  name: guid(workerJob.id, orchestratorPrincipalId, jobsOperatorRoleId)
  scope: workerJob
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', jobsOperatorRoleId)
    principalId: orchestratorPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

@description('Worker Job name')
output jobName string = workerJob.name

@description('Worker Job resource ID')
output jobId string = workerJob.id
