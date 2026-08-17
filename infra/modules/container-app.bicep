metadata description = '''
Generic Container Apps hosting for a hosted agent tool server.

This module owns hosting *mechanics* only: the environment, ingress, probes against the platform's
own /health and /ready endpoints, scale bounds, managed identity, registry pull, Key Vault secret
references, and environment-variable injection.

It deliberately does not know any capability's environment variables. A capability passes its own
settings through `additionalEnv` and `secretRefs` rather than adding a parameter here, because a
shared module that accumulates AST limits, Azure deployment settings, Doc RAG corpus policy, Vision
provider configuration, and Data jq/ripgrep ceilings is no longer shared: it is every capability's
module wearing a trench coat.

The environment variables set below are exactly the ones the platform runtime itself reads.
'''

@description('Azure region for the environment and app.')
param location string

@description('Container Apps managed environment name.')
param environmentName string

@description('Container app name.')
param appName string

@description('Fully qualified container image reference.')
param containerImage string

@description('Login server of the registry holding the image. Empty for a public image.')
param registryServer string = ''

@description('Resource id of the user-assigned managed identity.')
param identityId string

@description('Client id of the managed identity, injected as AZURE_CLIENT_ID.')
param identityClientId string = ''

@description('Log Analytics workspace customer id. Empty disables the log sink.')
param logAnalyticsCustomerId string = ''

@secure()
@description('Log Analytics shared key. Required when a customer id is supplied.')
param logAnalyticsSharedKey string = ''

@secure()
@description('Application Insights connection string. Empty omits the variable entirely.')
param applicationInsightsConnectionString string = ''

@description('Expose the app on the public internet. False keeps ingress inside the environment.')
param externalIngress bool = true

@description('Container port the platform HTTP server listens on.')
param targetPort int = 8080

@description('Minimum replicas. Zero enables scale to zero, which is the cheap default.')
@minValue(0)
param minReplicas int = 0

@description('Maximum replicas.')
@minValue(1)
param maxReplicas int = 2

@description('Concurrent HTTP requests per replica before scaling out.')
@minValue(1)
param httpConcurrency int = 10

@description('vCPU per replica, as a string, for example 0.5.')
param cpu string = '0.5'

@description('Memory per replica, for example 1Gi.')
param memory string = '1Gi'

@description('Authentication mode the runtime should use.')
@allowed([
  'api-key'
  'entra-jwt'
  'disabled'
])
param authMode string = 'api-key'

@description('Runtime log level.')
@allowed([
  'fatal'
  'error'
  'warn'
  'info'
  'debug'
  'trace'
  'silent'
])
param logLevel string = 'info'

@description('Public base URL advertised in the generated OpenAPI document. Empty omits it.')
param publicBaseUrl string = ''

@description('Service version reported by /version. Usually the released package version.')
param serviceVersion string = ''

@description('Git commit reported by /version.')
param gitSha string = ''

@description('Enable state-changing tools. Off by default; a capability opts in deliberately.')
param mutationsEnabled bool = false

@description('Require explicit confirmation before a state-changing tool executes.')
param mutationConfirmationRequired bool = true

@description('Requests per principal per window before the fair-use budget rejects.')
@minValue(0)
param rateLimitMax int = 120

@description('Rate-limit window in milliseconds.')
@minValue(1000)
param rateLimitWindowMs int = 60000

@description('Requests per address per window charged to the pre-auth abuse budget.')
@minValue(0)
param preAuthRateLimitMax int = 30

@description('''
Trusted proxy hops in front of the container. Container Apps ingress is one hop, so the default of
1 makes the runtime take the right-most X-Forwarded-For entry, which is the one ingress added.
Raise this only to match additional trusted proxies; never trust the whole chain, or a caller can
choose its own rate-limit bucket by sending the header itself.
''')
@minValue(0)
@maxValue(8)
param trustedProxyHops int = 1

@description('Key Vault secret URIs mounted as container secrets: [{ name, keyVaultUrl }].')
param secretRefs array = []

@description('Capability environment variables: [{ name, value }] or [{ name, secretRef }].')
param additionalEnv array = []

@description('Volume definitions passed through verbatim to the container template.')
param volumes array = []

@description('Volume mounts passed through verbatim to the container.')
param volumeMounts array = []

@description('Tags applied to every resource.')
param tags object = {}

var logsConfigured = !empty(logAnalyticsCustomerId)

var baseEnv = concat(
  [
    {
      name: 'NODE_ENV'
      value: 'production'
    }
    {
      name: 'PORT'
      value: string(targetPort)
    }
    {
      name: 'HOST'
      value: '0.0.0.0'
    }
    {
      name: 'LOG_LEVEL'
      value: logLevel
    }
    {
      name: 'AUTH_MODE'
      value: authMode
    }
    {
      // Container Apps ingress always fronts the app, so X-Forwarded-For is the only way to tell
      // callers apart for the pre-auth abuse budget.
      //
      // The value is a bounded hop count, never `true`. Ingress *appends* to X-Forwarded-For
      // rather than replacing it, so a caller can send its own header and have the real address
      // appended after it. Trusting the whole chain would let that caller name any address it
      // likes and choose its own abuse-budget bucket. Trusting exactly one hop takes the
      // right-most entry — the one ingress itself added — which is the only trustworthy value.
      //
      // A deployment behind an additional proxy in front of Container Apps must raise this to
      // match the real number of trusted hops.
      name: 'TRUST_PROXY'
      value: string(trustedProxyHops)
    }
    {
      name: 'RATE_LIMIT_MAX'
      value: string(rateLimitMax)
    }
    {
      name: 'RATE_LIMIT_WINDOW_MS'
      value: string(rateLimitWindowMs)
    }
    {
      name: 'PRE_AUTH_RATE_LIMIT_MAX'
      value: string(preAuthRateLimitMax)
    }
    {
      name: 'MUTATIONS_ENABLED'
      value: string(mutationsEnabled)
    }
    {
      name: 'MUTATION_CONFIRMATION_REQUIRED'
      value: string(mutationConfirmationRequired)
    }
  ],
  empty(identityClientId)
    ? []
    : [
        {
          name: 'AZURE_CLIENT_ID'
          value: identityClientId
        }
      ],
  empty(publicBaseUrl)
    ? []
    : [
        {
          name: 'PUBLIC_BASE_URL'
          value: publicBaseUrl
        }
      ],
  empty(serviceVersion)
    ? []
    : [
        {
          name: 'SERVICE_VERSION'
          value: serviceVersion
        }
      ],
  empty(gitSha)
    ? []
    : [
        {
          name: 'GIT_SHA'
          value: gitSha
        }
      ],
  empty(applicationInsightsConnectionString)
    ? []
    : [
        {
          name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
          value: applicationInsightsConnectionString
        }
      ]
)

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: logsConfigured
    ? {
        appLogsConfiguration: {
          destination: 'log-analytics'
          logAnalyticsConfiguration: {
            customerId: logAnalyticsCustomerId
            sharedKey: logAnalyticsSharedKey
          }
        }
      }
    : {}
}

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: externalIngress
        allowInsecure: false
        targetPort: targetPort
        transport: 'auto'
      }
      registries: empty(registryServer)
        ? []
        : [
            {
              server: registryServer
              identity: identityId
            }
          ]
      secrets: [
        for secret in secretRefs: {
          name: secret.name
          keyVaultUrl: secret.keyVaultUrl
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'tool-server'
          image: containerImage
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: concat(baseEnv, additionalEnv)
          volumeMounts: volumeMounts
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health'
                port: targetPort
              }
              initialDelaySeconds: 3
              periodSeconds: 3
              failureThreshold: 20
            }
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: targetPort
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              // Readiness probes /ready, which the platform answers from the capability's own
              // readiness contributors, so a replica that cannot do its job leaves rotation.
              type: 'Readiness'
              httpGet: {
                path: '/ready'
                port: targetPort
              }
              initialDelaySeconds: 5
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      volumes: volumes
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: {
              metadata: {
                concurrentRequests: string(httpConcurrency)
              }
            }
          }
        ]
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output appId string = app.id
output environmentId string = environment.id
