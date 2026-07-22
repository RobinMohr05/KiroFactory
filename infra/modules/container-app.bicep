// KiroFactory — Container App: Orchestrator (Backend)
// Always-on Container App with min 1 replica for the Express + WebSocket server.

targetScope = 'resourceGroup'

// ─── Parameters ──────────────────────────────────────────────────────────────

@description('Container Apps Environment ID')
param environmentId string

@description('ACR login server (e.g., kirofactoryacr.azurecr.io)')
param acrLoginServer string

@description('ACR name for credential reference')
param acrName string

@description('Container image tag (e.g., latest, v1.0.0)')
param imageTag string = 'latest'

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

@description('Name of the ACA worker Job the orchestrator starts/stops (used for the RBAC role assignment). Must match ACA_JOB_NAME.')
param workerJobName string = 'kirofactory-worker'

@description('Tags applied to resources')
param tags object = {
  project: 'KiroFactory'
  environment: 'production'
  managedBy: 'bicep'
}

// ─── Variables ───────────────────────────────────────────────────────────────

var appName = 'kirofactory-orchestrator'
var imageName = '${acrLoginServer}/kirofactory:${imageTag}'

// Built-in role "Container Apps Jobs Operator" — grants read/start/stop on ACA jobs
// (Microsoft.App/jobs/*/read + Microsoft.App/jobs/*/action, which covers start/action and stop/action).
// https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/containers
var jobsOperatorRoleId = 'b9a307c4-5aa3-4b52-ba60-2b17c136cd7b'

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
        allowInsecure: false // Redirect HTTP → HTTPS
        clientCertificateMode: 'ignore'
        // Sticky sessions ensure WebSocket connections stay on the same replica
        // (required for real-time task updates via ws://)
        stickySessions: {
          affinity: 'sticky'
        }
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
      secrets: [
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
      ]
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
          env: [
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
          ]
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

// ─── RBAC: orchestrator → worker Job ─────────────────────────────────────────
// The orchestrator calls Microsoft.App/jobs/{job}/start (and stop/read) via the
// REST API using its managed identity. Without this assignment the call fails
// with 403 AuthorizationFailed on 'Microsoft.App/jobs/start/action'.
// The Job is expected to already exist (created outside this module).

resource workerJob 'Microsoft.App/jobs@2024-03-01' existing = {
  name: workerJobName
}

resource jobsOperatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(workerJob.id, containerApp.id, jobsOperatorRoleId)
  scope: workerJob
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', jobsOperatorRoleId)
    principalId: containerApp.identity.principalId
    principalType: 'ServicePrincipal'
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
