metadata description = '''
Key Vault holding the secrets a hosted agent tool server needs at runtime.

RBAC authorization is used rather than access policies, soft delete and purge protection are on,
and the workload is granted only Key Vault Secrets User. A separate bootstrap principal may be
granted Secrets Officer so an operator or deployment pipeline can write the initial secret values
without the workload ever holding write access.

Secret *values* are deliberately not parameters of this module. A capability supplies them out of
band so no secret is ever written into a deployment history.
'''

@description('Azure region for the vault.')
param location string

@description('Globally unique vault name: 3-24 alphanumeric characters and hyphens.')
@minLength(3)
@maxLength(24)
param name string

@description('Principal id granted read access to secrets. Normally the workload managed identity.')
param readerPrincipalId string

@description('Principal type of the reader; user-assigned identities are ServicePrincipal.')
@allowed([
  'ServicePrincipal'
  'User'
  'Group'
])
param readerPrincipalType string = 'ServicePrincipal'

@description('Optional principal id granted write access so initial secrets can be seeded.')
param writerPrincipalId string = ''

@description('Principal type of the optional seeding principal.')
@allowed([
  'ServicePrincipal'
  'User'
  'Group'
])
param writerPrincipalType string = 'User'

@description('Days a soft-deleted vault is recoverable.')
@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int = 7

@description('Set false to require private endpoints for vault access.')
param allowPublicNetworkAccess bool = true

@description('Tags applied to the vault.')
param tags object = {}

var secretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var secretsOfficerRoleId = 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    // Purge protection makes an accidental or malicious delete recoverable rather than terminal.
    enablePurgeProtection: true
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
    networkAcls: {
      defaultAction: allowPublicNetworkAccess ? 'Allow' : 'Deny'
      bypass: 'AzureServices'
    }
    sku: {
      family: 'A'
      name: 'standard'
    }
  }
}

resource secretsReaderRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, readerPrincipalId, 'key-vault-secrets-user')
  scope: vault
  properties: {
    principalId: readerPrincipalId
    principalType: readerPrincipalType
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      secretsUserRoleId
    )
  }
}

resource secretsOfficerRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(writerPrincipalId)) {
  name: guid(vault.id, writerPrincipalId, 'key-vault-secrets-officer')
  scope: vault
  properties: {
    principalId: writerPrincipalId
    principalType: writerPrincipalType
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      secretsOfficerRoleId
    )
  }
}

output name string = vault.name
output id string = vault.id
output vaultUri string = vault.properties.vaultUri
