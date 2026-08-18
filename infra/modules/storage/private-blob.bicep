metadata description = '''
Generic private blob storage for a hosted agent tool server.

Only genuinely generic primitives live here: a private account with shared-key access disabled, a
private container, an optional expiry policy, and a data-plane role assignment for the workload
identity.

What is deliberately absent is every capability's idea of what it stores. Asset semantics, upload
policy, corpus layout, and deployment-record schemas belong to the capability that owns them.
'''

@description('Globally unique storage account name: 3-24 lower-case alphanumeric characters.')
@minLength(3)
@maxLength(24)
param name string

@description('Azure region for the account.')
param location string

@description('Private blob container created in the account.')
param containerName string

@description('Principal id granted data-plane access. Normally the workload managed identity.')
param dataPrincipalId string

@description('Data-plane role granted to the principal.')
@allowed([
  'reader'
  'contributor'
])
param dataAccess string = 'contributor'

@description('Days after creation when blobs are deleted. Zero disables the lifecycle policy.')
@minValue(0)
@maxValue(365)
param retentionDays int = 0

@description('Set false to keep the account off public networks; requires private endpoints.')
param allowPublicNetworkAccess bool = true

@description('Tags applied to the account.')
param tags object = {}

var blobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var blobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
var roleId = dataAccess == 'reader' ? blobDataReaderRoleId : blobDataContributorRoleId

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    // No anonymous access and no shared keys: the only way in is an Entra identity with an
    // explicit data-plane role, so there is no account key to leak or rotate.
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    networkAcls: {
      defaultAction: allowPublicNetworkAccess ? 'Allow' : 'Deny'
      bypass: 'AzureServices'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: false
    }
  }
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: {
    publicAccess: 'None'
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = if (retentionDays > 0) {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-blobs'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterCreationGreaterThan: retentionDays
                }
              }
            }
          }
        }
      ]
    }
  }
}

resource dataAccessRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storage.id, dataPrincipalId, dataAccess)
  scope: container
  properties: {
    principalId: dataPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleId)
  }
}

output accountName string = storage.name
output accountId string = storage.id
output containerName string = container.name
output blobEndpoint string = storage.properties.primaryEndpoints.blob
