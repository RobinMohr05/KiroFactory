// KiroFactory — VNET Peering to Azure SQL Server VNET
// 
// This module creates a VNET peering between the KiroFactory ACA VNET
// and the existing Azure SQL Server's VNET, enabling private connectivity.
//
// PREREQUISITE: The Azure SQL Server (REDACTED_DB_SERVER) must
// be in a VNET with a private endpoint, OR you must add the ACA subnet's
// outbound IPs to the SQL Server's firewall rules.
//
// If Azure SQL uses public endpoint with firewall rules (most common for
// Azure SQL Database), you only need to whitelist the ACA environment's
// static outbound IP — no peering needed.

targetScope = 'resourceGroup'

@description('KiroFactory VNET resource ID')
param localVnetId string

@description('KiroFactory VNET name')
param localVnetName string

@description('Remote VNET resource ID (Azure SQL Server VNET)')
param remoteVnetId string

@description('Peering name')
param peeringName string = 'kirofactory-to-sql-vnet'

// ─── VNET Peering (local → remote) ──────────────────────────────────────────

resource peering 'Microsoft.Network/virtualNetworks/virtualNetworkPeerings@2023-11-01' = {
  name: '${localVnetName}/${peeringName}'
  properties: {
    remoteVirtualNetwork: {
      id: remoteVnetId
    }
    allowVirtualNetworkAccess: true
    allowForwardedTraffic: false
    allowGatewayTransit: false
    useRemoteGateways: false
  }
}

output peeringId string = peering.id
output peeringState string = peering.properties.peeringState
