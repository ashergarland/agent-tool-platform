metadata description = '''
Observability for a hosted agent tool server: a Log Analytics workspace, an Application Insights
component backed by it, and an optional failed-request alert.

Merged from the strongest variants across the capability repositories. Two decisions are worth
stating:

- Application Insights ingests through Log Analytics rather than the classic pipeline, so there is
  one store, one retention setting, and one bill.
- Alerting is on *failed requests*, not on replica count. A capability that scales to zero has no
  replicas when idle, which is the normal, healthy, cheap state; alerting on it would page
  constantly for a service that is working perfectly.

Deploying this module is optional and is not part of the platform v0 scope. It exists so a
capability can compose observability without reinventing it.
'''

@description('Azure region for the workspace and component.')
param location string

@description('Log Analytics workspace name.')
param workspaceName string

@description('Application Insights component name.')
param insightsName string

@description('Days of log retention.')
@minValue(30)
@maxValue(730)
param retentionInDays int = 30

@description('Daily ingestion cap in GB. -1 leaves the workspace uncapped.')
param dailyQuotaGb int = -1

@description('Email address that receives operational alerts. Empty disables alerting entirely.')
param alertEmailAddress string = ''

@description('Failed requests within five minutes before the alert fires.')
@minValue(1)
param failedRequestAlertThreshold int = 20

@description('Tags applied to every resource.')
param tags object = {}

var alertsEnabled = !empty(alertEmailAddress)

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    retentionInDays: retentionInDays
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    workspaceCapping: {
      dailyQuotaGb: dailyQuotaGb
    }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: insightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource alertGroup 'Microsoft.Insights/actionGroups@2023-01-01' = if (alertsEnabled) {
  name: '${insightsName}-alerts'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'atsalerts'
    enabled: true
    emailReceivers: [
      {
        name: 'operations'
        emailAddress: alertEmailAddress
        useCommonAlertSchema: true
      }
    ]
  }
}

resource failedRequests 'Microsoft.Insights/metricAlerts@2018-03-01' = if (alertsEnabled) {
  name: '${insightsName}-failed-requests'
  location: 'global'
  tags: tags
  properties: {
    description: 'Server responses that failed in the last five minutes.'
    severity: 2
    enabled: true
    scopes: [
      insights.id
    ]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT5M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'failed-requests'
          metricNamespace: 'microsoft.insights/components'
          metricName: 'requests/failed'
          operator: 'GreaterThan'
          threshold: failedRequestAlertThreshold
          timeAggregation: 'Count'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: alertsEnabled ? alertGroup!.id : ''
      }
    ]
  }
}

output workspaceId string = workspace.id
output workspaceCustomerId string = workspace.properties.customerId

@secure()
output workspaceSharedKey string = workspace.listKeys().primarySharedKey

output applicationInsightsId string = insights.id

@secure()
output applicationInsightsConnectionString string = insights.properties.ConnectionString
