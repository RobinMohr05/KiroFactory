// Vibecode Heaven — Azure Container Apps Infrastructure
// This Bicep template creates the foundational ACA environment.
//
// ⚠ DRIFT NOTE: The live environment in resource group "SandboxForRM" was partly created ad hoc
// (portal / az CLI), so some live resource names differ from this template's defaults — notably
// the Container Apps Environment is "managedEnvironment-SandboxForRM-8f71" and the Log Analytics
// workspace is "workspacesandboxforrm86f0". This template is the greenfield definition; for the
// existing environment, deploy-app.sh resolves resources by name (see CONTAINERAPP_ENV) rather
// than recreating them. The app + worker layer (modules/container-app.bicep, modules/worker-job.bicep)
// IS reconciled to the live environment and is safe to deploy against it.

targetScope = 'resourceGroup'

// ─── Parameters ──────────────────────────────────────────────────────────────

@description('Base name for all resources')
param baseName string = 'kirofactory'

@description('Azure region for all resources')
param location string = resourceGroup().location

@description('Container Apps Environment name')
param environmentName string = '${baseName}-env'

@description('Azure Container Registry name (must be globally unique, alphanumeric only). Defaults to the live registry "kiroFactory" (login server kirofactory.azurecr.io).')
param acrName string = 'kiroFactory'

@description('ACR SKU tier')
@allowed(['Basic', 'Standard', 'Premium'])
param acrSku string = 'Basic'

@description('Log Analytics workspace name')
param logAnalyticsName string = '${baseName}-logs'

@description('Tags applied to all resources')
param tags object = {
  project: 'VibecodeHeaven'
  environment: 'production'
  managedBy: 'bicep'
}

// ─── Log Analytics Workspace ─────────────────────────────────────────────────
// Required by Container Apps Environment for logging and monitoring.

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

// ─── Container Apps Environment ──────────────────────────────────────────────
// The managed environment that hosts all Container Apps.
// Uses the free *.azurecontainerapps.io subdomain for ingress.

resource containerAppsEnvironment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalytics.properties.customerId
        sharedKey: logAnalytics.listKeys().primarySharedKey
      }
    }
    // No VNET integration — Neo4j AuraDB Free is reached over the public internet
    // (neo4j+s://) and needs no private networking. See git history if VNET
    // integration is ever needed again for a different dependency.
    zoneRedundant: false // Not needed for initial testing, saves cost
  }
}

// ─── Azure Container Registry ────────────────────────────────────────────────
// Stores Docker images for KiroFactory. Basic tier (~5 EUR/mo).

resource acr 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: acrName
  location: location
  tags: tags
  sku: {
    name: acrSku
  }
  properties: {
    adminUserEnabled: true // Enables username/password auth for simplicity
    publicNetworkAccess: 'Enabled'
  }
}

// ─── Outputs ─────────────────────────────────────────────────────────────────

@description('Container Apps Environment ID')
output environmentId string = containerAppsEnvironment.id

@description('Container Apps Environment default domain')
output defaultDomain string = containerAppsEnvironment.properties.defaultDomain

@description('Container Apps Environment static IP')
output staticIp string = containerAppsEnvironment.properties.staticIp

@description('ACR login server')
output acrLoginServer string = acr.properties.loginServer

@description('ACR name')
output acrNameOutput string = acr.name

@description('Log Analytics workspace ID')
output logAnalyticsWorkspaceId string = logAnalytics.id
