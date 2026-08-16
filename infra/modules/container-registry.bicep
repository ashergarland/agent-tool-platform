metadata description = '''
Container registry for hosted agent tool server images.

Admin credentials are disabled and pull access is granted through a managed identity role
assignment, so no registry password exists to leak, rotate, or accidentally commit.

The SKU is a parameter because a single-capability deployment is well served by Basic while a
shared registry fronting several capabilities may need Premium features; nothing else about the
registry differs between capabilities.
'''

@description('Azure region for the registry.')
param location string

@description('Globally unique registry name: 5-50 alphanumeric characters, lower case.')
@minLength(5)
@maxLength(50)
param name string

@description('Principal id granted AcrPull. Normally the workload managed identity.')
param pullPrincipalId string
@description('Registry SKU.')
@allowed([
  'Basic'
  'Standard'
  'Premium'
])
param sku string = 'Basic'

@description('Set false to require private endpoints for registry access.')
param allowPublicNetworkAccess bool = true

@description('Tags applied to the registry.')
param tags object = {}

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
  }
  properties: {
    // No admin user: image pulls authenticate as the managed identity, so there is no shared
    // registry credential anywhere in the system.
    adminUserEnabled: false
    publicNetworkAccess: allowPublicNetworkAccess ? 'Enabled' : 'Disabled'
  }
}

resource pullRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullPrincipalId, 'acr-pull')
  scope: registry
  properties: {
    principalId: pullPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      acrPullRoleId
    )
  }
}

output name string = registry.name
output id string = registry.id
output loginServer string = registry.properties.loginServer
