// Vibecode Heaven — Container App: Orchestrator (Backend)
// Always-on Container App with min 1 replica for the Express + WebSocket server.
//
// This module also deploys the worker Job (via worker-job.bicep) and, through that module,
// the least-privilege RBAC that lets this app's managed identity start/stop the job. Deploying
// app + job + role assignment together keeps them consistent and prevents the drift that occurs
// when the app is updated with `az containerapp update` (image-only) and the RBAC is never applied.

targetScope = 'resourceGroup'

// ─── Parameters ──────────────────────────────────────────────────────────────

@description('Container Apps Environment ID')
param environmentId string

@description('Container Apps Environment default domain (e.g., orangeriver-26cd2328.germanywestcentral.azurecontainerapps.io). Used to build the worker-to-orchestrator WebSocket URL.')
param envDefaultDomain string

@description('ACR login server (e.g., kirofactory.azurecr.io)')
param acrLoginServer string

@description('ACR name for credential reference')
param acrName string

@description('Orchestrator (backend) container image tag (e.g., latest, v1.0.0)')
param imageTag string = 'latest'

@description('Worker container image tag')
param workerImageTag string = 'latest'

@description('MCP proxy sidecar image tag')
param proxyImageTag string = 'latest'

@description('Whether to configure the per-session MCP proxy sidecar (sets ACA_PROXY_IMAGE)')
param enableMcpProxy bool = true

@description('Azure region')
param location string = resourceGroup().location

@description('SQL Server hostname')
@secure()
param dbServer string

@description('SQL Server database name')
param dbDatabase string = 'TecFactory'

@description('SQL Server username')
@secure()
param dbUser string

@description('SQL Server password')
@secure()
param dbPassword string

@description('SQL Server port')
param dbPort string = '1433'

@description('Use encrypted SQL connection')
param dbEncrypt string = 'true'

@description('Trust server certificate (false for Azure SQL)')
param dbTrustServerCertificate string = 'false'

@description('JWT secret for authentication tokens')
@secure()
param jwtSecret string

@description('AES-256 encryption key (64-char hex) for API key storage')
@secure()
param encryptionKey string

@description('Shared secret for worker/orchestrator authentication (ACA_WORKER_SECRET)')
@secure()
param workerSecret string

@description('Optional org-level Azure DevOps PAT for worker git clone fallback (AZURE_DEVOPS_EXT_PAT). Leave empty to omit.')
@secure()
param azureDevOpsPat string = ''

@description('Git user name for worker commits')
param gitUserName string = 'Vibecode Heaven Agent'

@description('Git user email for worker commits')
param gitUserEmail string = 'agent@vibecode-heaven.dev'

@description('Minimum number of replicas (always-on)')
@minValue(1)
param minReplicas int = 1

@description('Maximum number of replicas for scaling')
@minValue(1)
param maxReplicas int = 3

@description('CPU cores allocated per replica')
param cpu string = '0.5'

@description('Memory allocated per replica (in Gi)')
param memory string = '1Gi'

@description('Name of the ACA worker Job. Must match the orchestrator ACA_JOB_NAME.')
param workerJobName string = 'kirofactory-worker'

@description('Max seconds a single worker execution may run')
param workerReplicaTimeout int = 3600

@description('Tags applied to resources')
param tags object = {
  project: 'KiroFactory'
  environment: 'production'
  managedBy: 'bicep'
}

// ─── Variables ───────────────────────────────────────────────────────────────

var appName = 'kirofactory-api'
var imageName = '${acrLoginServer}/kirofactory-api:${imageTag}'
var workerImage = '${acrLoginServer}/kirofactory-worker:${workerImageTag}'
var proxyImage = '${acrLoginServer}/kirofactory-mcp-proxy:${proxyImageTag}'

// Worker → orchestrator WebSocket. Derived from the env default domain (not the app's own
// FQDN, which would be a self-reference) so it can be computed at deploy time.
var orchestratorWsUrl = 'wss://${appName}.${envDefaultDomain}/internal/worker'

// Base secrets always present. The ADO PAT secret is appended only when supplied so we never
// create an empty-valued secret.
var baseSecrets = [
  {
    name: 'acr-password'
    value: acr.listCredentials().passwords[0].value
  }
  {
    name: 'db-server'
    value: dbServer
  }
  {
    name: 'db-user'
    value: dbUser
  }
  {
    name: 'db-password'
    value: dbPassword
  }
  {
    name: 'jwt-secret'
    value: jwtSecret
  }
  {
    name: 'encryption-key'
    value: encryptionKey
  }
  {
    name: 'aca-worker-secret'
    value: workerSecret
  }
]
var patSecret = empty(azureDevOpsPat) ? [] : [
  {
    name: 'azure-devops-pat'
    value: azureDevOpsPat
  }
]

// Base env always present. ADO PAT env is appended only when the secret exists.
var baseEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'PORT', value: '3500' }
  { name: 'DB_SERVER', secretRef: 'db-server' }
  { name: 'DB_DATABASE', value: dbDatabase }
  { name: 'DB_USER', secretRef: 'db-user' }
  { name: 'DB_PASSWORD', secretRef: 'db-password' }
  { name: 'DB_PORT', value: dbPort }
  { name: 'DB_ENCRYPT', value: dbEncrypt }
  { name: 'DB_TRUST_SERVER_CERTIFICATE', value: dbTrustServerCertificate }
  { name: 'JWT_SECRET', secretRef: 'jwt-secret' }
  { name: 'ENCRYPTION_KEY', secretRef: 'encryption-key' }
  // ── ACA worker (remote) mode ──
  { name: 'WORKER_MODE', value: 'remote' }
  { name: 'ACA_SUBSCRIPTION_ID', value: subscription().subscriptionId }
  { name: 'ACA_RESOURCE_GROUP', value: resourceGroup().name }
  { name: 'ACA_JOB_NAME', value: workerJobName }
  { name: 'ACA_WORKER_IMAGE', value: workerImage }
  { name: 'ACA_PROXY_IMAGE', value: enableMcpProxy ? proxyImage : '' }
  { name: 'ACA_ORCHESTRATOR_URL', value: orchestratorWsUrl }
  { name: 'ACA_WORKER_SECRET', secretRef: 'aca-worker-secret' }
  { name: 'GIT_USER_NAME', value: gitUserName }
  { name: 'GIT_USER_EMAIL', value: gitUserEmail }
]
var patEnv = empty(azureDevOpsPat) ? [] : [
  { name: 'AZURE_DEVOPS_EXT_PAT', secretRef: 'azure-devops-pat' }
]

// ─── ACR Credential Reference ────────────────────────────────────────────────

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: acrName
}

// ─── Container App ───────────────────────────────────────────────────────────

resource containerApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  // System-assigned managed identity — this is the identity DefaultAzureCredential
  // uses at runtime to call the Azure management API and start/stop the worker Job.
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      // External ingress: internet-facing on port 3500
      // Frontend (static) and API are served from the same origin — no CORS issues.
      // WebSocket upgrade is natively supported by ACA's HTTP transport.
      ingress: {
        external: true
        targetPort: 3500
        transport: 'http'
        allowInsecure: false // Redirect HTTP -> HTTPS
        clientCertificateMode: 'ignore'
        // NOTE: Sticky sessions (affinity) require 'Multiple' revision mode and are omitted
        // here — the orchestrator runs in Single revision mode. WebSocket clients reconnect,
        // and at minReplicas=1 all connections land on the same replica anyway. If you later
        // scale out and need WS affinity, switch activeRevisionsMode to 'Multiple' and re-add
        // stickySessions.
      }
      // ACR registry credentials (admin user)
      registries: [
        {
          server: acrLoginServer
          username: acr.listCredentials().username
          passwordSecretRef: 'acr-password'
        }
      ]
      // Secrets (referenced by env vars)
      secrets: concat(baseSecrets, patSecret)
    }
    template: {
      containers: [
        {
          name: 'orchestrator'
          image: imageName
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: concat(baseEnv, patEnv)
          // Probes aligned with the Dockerfile HEALTHCHECK
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                port: 3500
                path: '/api/health'
              }
              initialDelaySeconds: 10
              periodSeconds: 30
              timeoutSeconds: 5
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                port: 3500
                path: '/api/health'
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              timeoutSeconds: 3
              failureThreshold: 3
            }
            {
              type: 'Startup'
              httpGet: {
                port: 3500
                path: '/api/health'
              }
              initialDelaySeconds: 3
              periodSeconds: 5
              timeoutSeconds: 5
              failureThreshold: 10
            }
          ]
        }
      ]
      // Scaling: always-on with min 1 replica
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-scaling'
            http: {
              metadata: {
                concurrentRequests: '50'
              }
            }
          }
        ]
      }
    }
  }
}

// ─── Worker Job + RBAC ────────────────────────────────────────────────────────
// Deploy the worker Job as code and grant this app's managed identity the least-privilege
// "Container Apps Jobs Operator" role scoped to it. The role assignment lives inside the
// worker-job module (scoped to the job), so ordering is guaranteed: job first, then grant.

module workerJob 'worker-job.bicep' = {
  name: 'kirofactory-worker-job'
  params: {
    environmentId: environmentId
    acrLoginServer: acrLoginServer
    acrName: acrName
    workerImageTag: workerImageTag
    location: location
    jobName: workerJobName
    replicaTimeout: workerReplicaTimeout
    orchestratorPrincipalId: containerApp.identity.principalId
    tags: tags
  }
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

@description('Container App FQDN (URL)')
output fqdn string = containerApp.properties.configuration.ingress.fqdn

@description('Orchestrator system-assigned managed identity principal (object) ID')
output principalId string = containerApp.identity.principalId

@description('Container App name')
output appName string = containerApp.name

@description('Container App latest revision name')
output latestRevision string = containerApp.properties.latestRevisionName

@description('Worker Job name')
output workerJobName string = workerJob.outputs.jobName
