metadata description = '''
User-assigned managed identity used by a hosted agent tool server.

Every capability deployment needs exactly this: one identity that pulls its image, reads its
secrets, and authenticates to any provider it calls. Nothing about it is capability-specific, so it
is shared verbatim rather than copied.

Role assignments live with the resource that grants them (the registry grants AcrPull, the vault
grants secret access) so a capability can compose only the grants it actually needs.
'''

@description('Azure region for the identity.')
param location string

@description('Name of the user-assigned managed identity.')
param name string

@description('Tags applied to the identity.')
param tags object = {}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: name
  location: location
  tags: tags
}

@description('Resource id, used for ACR pull, Key Vault references, and Container App identity.')
output id string = identity.id

@description('Client id, injected as AZURE_CLIENT_ID when a workload uses the identity directly.')
output clientId string = identity.properties.clientId

@description('Principal id, used as the target of role assignments.')
output principalId string = identity.properties.principalId

@description('Identity name, for composition into dependent resource names.')
output name string = identity.name
