metadata description = '''
Example composition of the shared modules.

This exists so CI can prove the modules compose and validate, not so anyone deploys it. It is
account-neutral: no tenant id, no subscription id, no resource-group name, no credential, and no
domain appears anywhere in this repository.

A capability repository will not deploy this file. It will compose the same modules with its own
naming, its own secrets, and its own capability-specific environment variables — see
`infra/README.md` for how those modules will eventually be consumed.
'''

targetScope = 'resourceGroup'

@description('Short name used to derive resource names.')
@minLength(3)
@maxLength(16)
param name string = 'atpsample'

@description('Azure region for every resource.')
param location string = resourceGroup().location

@description('Container image the sample would run.')
param containerImage string = 'mcr.microsoft.com/azuredocs/containerapps-helloworld:latest'

@description('Tags applied to every resource.')
param tags object = {
  workload: 'agent-tool-platform-example'
}

var suffix = uniqueString(resourceGroup().id, name)

module identity '../modules/identity.bicep' = {
  name: 'identity'
  params: {
    location: location
    name: 'id-${name}'
    tags: tags
  }
}

module registry '../modules/container-registry.bicep' = {
  name: 'registry'
  params: {
    location: location
    name: 'cr${name}${suffix}'
    pullPrincipalId: identity.outputs.principalId
    tags: tags
  }
}

module vault '../modules/key-vault.bicep' = {
  name: 'vault'
  params: {
    location: location
    name: 'kv-${take(suffix, 16)}'
    readerPrincipalId: identity.outputs.principalId
    tags: tags
  }
}

module observability '../modules/observability.bicep' = {
  name: 'observability'
  params: {
    location: location
    workspaceName: 'log-${name}'
    insightsName: 'appi-${name}'
    tags: tags
  }
}

module assets '../modules/storage/private-blob.bicep' = {
  name: 'assets'
  params: {
    location: location
    name: 'st${take(suffix, 20)}'
    containerName: 'assets'
    dataPrincipalId: identity.outputs.principalId
    retentionDays: 7
    tags: tags
  }
}

module app '../modules/container-app.bicep' = {
  name: 'app'
  params: {
    location: location
    environmentName: 'cae-${name}'
    appName: 'ca-${name}'
    containerImage: containerImage
    registryServer: registry.outputs.loginServer
    identityId: identity.outputs.id
    identityClientId: identity.outputs.clientId
    logAnalyticsCustomerId: observability.outputs.workspaceCustomerId
    logAnalyticsSharedKey: observability.outputs.workspaceSharedKey
    applicationInsightsConnectionString: observability.outputs.applicationInsightsConnectionString
    // A capability supplies its own domain settings here rather than adding parameters to the
    // shared module.
    additionalEnv: [
      {
        name: 'EXAMPLE_ASSET_ACCOUNT'
        value: assets.outputs.accountName
      }
      {
        name: 'EXAMPLE_ASSET_CONTAINER'
        value: assets.outputs.containerName
      }
    ]
    secretRefs: [
      {
        name: 'api-key'
        keyVaultUrl: '${vault.outputs.vaultUri}secrets/api-key'
      }
    ]
    tags: tags
  }
}

output fqdn string = app.outputs.fqdn
output registryLoginServer string = registry.outputs.loginServer
output vaultUri string = vault.outputs.vaultUri
