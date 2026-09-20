import type { RegistryCapability, RegistryCapabilityProfile } from '@agent-tool-platform/agent-kit';

type LocalFixture = {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly status: RegistryCapability['version']['status'];
  readonly artifact: string;
  readonly artifactAvailability: RegistryCapability['artifacts'][number]['availability'];
  readonly profileId: string;
  readonly profileSource: RegistryCapabilityProfile['source'];
  readonly profileDescription: string;
  readonly permissions: RegistryCapabilityProfile['permissions'];
  readonly prerequisiteSummary: string;
  readonly readinessSummary: string;
  readonly routing: string;
  readonly revision: string;
  readonly metadataVersion: string;
  readonly releaseTag?: string;
};

const source = (
  id: string,
  revision: string,
  metadataVersion: string,
  hasProfiles: boolean,
  releaseTag?: string,
): RegistryCapability['source'] => ({
  capabilityId: `io.github.ashergarland/agent-tool-server-${id}`,
  repository: `https://github.com/ashergarland/agent-tool-server-${id}`,
  revision,
  metadataVersion,
  ...(releaseTag === undefined ? {} : { releaseTag }),
  metadata: {
    server: 'server.json',
    package: 'package.json',
    ...(hasProfiles ? { profiles: 'capability-profiles.json' } : {}),
  },
});

const localCapability = (fixture: LocalFixture): RegistryCapability => ({
  schemaVersion: '1.0.0',
  kind: 'capability',
  id: fixture.id,
  displayName: fixture.displayName,
  description: fixture.description,
  version: { value: fixture.version, status: fixture.status },
  artifacts: [
    {
      id: 'npm-package',
      kind: 'npm',
      identifier: fixture.artifact,
      version: fixture.version,
      availability: fixture.artifactAvailability,
      reference: fixture.status === 'released' ? `v${fixture.version}` : 'server.json#/packages/0',
    },
  ],
  profiles: [
    {
      id: fixture.profileId,
      description: fixture.profileDescription,
      source: fixture.profileSource,
      dimensions: {
        execution: 'local',
        delivery: 'package',
        access: 'local-process',
        workload: 'filesystem',
        provider: 'none',
        mutation: 'read-only',
      },
      permissions: fixture.permissions,
      prerequisites: {
        setupRequired: true,
        summary: fixture.prerequisiteSummary,
        requiredSecrets: [],
        provider: [],
      },
      readiness: {
        signals: ['process', 'workload'],
        summary: fixture.readinessSummary,
      },
      stateEffects: [],
    },
  ],
  bindings: [
    {
      id: 'local-stdio',
      profileId: fixture.profileId,
      artifactId: 'npm-package',
      interface: 'stdio',
      availability: 'local',
    },
  ],
  stateChanging: false,
  routing: { summary: fixture.routing },
  source: source(
    fixture.id,
    fixture.revision,
    fixture.metadataVersion,
    fixture.profileSource === 'capability-profile-declaration',
    fixture.releaseTag,
  ),
});

const astSummarizer = localCapability({
  id: 'ast-summarizer',
  displayName: 'AST Summarizer',
  description:
    'Read-only TypeScript and JavaScript declaration skeletons and local dependency graphs for one workspace.',
  version: '0.1.1',
  status: 'released',
  artifact: '@agent-tool-platform/ast-summarizer',
  artifactAvailability: 'published',
  profileId: 'local-package',
  profileSource: 'registry-curated',
  profileDescription:
    'Read-only local package execution over stdio against one TypeScript or JavaScript workspace.',
  permissions: {
    summary: 'Read files beneath the configured workspace root.',
    scopes: ['workspace-read'],
  },
  prerequisiteSummary:
    'Requires a local TypeScript or JavaScript workspace; no provider or secret setup is required.',
  readinessSummary: 'Ready when the local process can read the configured workspace.',
  routing:
    'Use for TypeScript or JavaScript declarations, signatures, file skeletons, dependency structure, and codebase orientation.',
  revision: '93bffa78d3fbbb4d835a8da55f33af68e48ec8cd',
  metadataVersion: '0.0.0-development',
  releaseTag: 'v0.1.1',
});

const gitOptimizer = localCapability({
  id: 'git-optimizer',
  displayName: 'Git Optimizer',
  description: 'Read-only summaries of local Git commit and branch diffs.',
  version: '0.1.0',
  status: 'declared',
  artifact: 'agent-tool-server-git-optimizer',
  artifactAvailability: 'declared',
  profileId: 'local-package',
  profileSource: 'capability-profile-declaration',
  profileDescription:
    'Read-only local Git change analysis over repositories already accessible to the invoking user.',
  permissions: {
    summary: 'Run read-only Git operations within explicitly allowed local repository roots.',
    scopes: ['process-execute', 'repository-read'],
  },
  prerequisiteSummary:
    'Requires Git and at least one readable local repository root; no provider or secret setup is required.',
  readinessSummary: 'Ready when Git is available and a configured repository root is readable.',
  routing:
    'Use for bounded summaries of changed files, symbols, configuration keys, and routes between two local Git commits.',
  revision: '6fe83371af641fdbaea1e22c0c8bf981caa882ab',
  metadataVersion: '0.1.0',
});

const dataCruncher = localCapability({
  id: 'data-cruncher',
  displayName: 'Data Cruncher',
  description: 'Query large local JSON, JSONL, log, and text files with bounded tools.',
  version: '0.0.0-development',
  status: 'development',
  artifact: 'agent-tool-server-data-cruncher',
  artifactAvailability: 'declared',
  profileId: 'local-package',
  profileSource: 'capability-profile-declaration',
  profileDescription:
    'Read-only local package execution over stdio against one explicitly selected filesystem root.',
  permissions: {
    summary: 'Read one selected local data file and execute bounded jq or ripgrep subprocesses.',
    scopes: ['filesystem-read', 'process-execute'],
  },
  prerequisiteSummary:
    'Requires a configured data root plus supported jq and ripgrep executables; no provider or secret setup is required.',
  readinessSummary: 'Ready when the data root, jq, and ripgrep are usable.',
  routing:
    'Use for bounded jq reduction and ripgrep search over large local JSON, JSONL, log, or text files.',
  revision: '67bc95dd4ba9d2b8ae829650d470a055819121f1',
  metadataVersion: '0.0.0-development',
});

const docRag = localCapability({
  id: 'doc-rag',
  displayName: 'Doc RAG',
  description: 'Bounded evidence retrieval from one configured documentation corpus.',
  version: '0.0.0-development',
  status: 'development',
  artifact: 'agent-tool-server-doc-rag',
  artifactAvailability: 'declared',
  profileId: 'local-filesystem-package',
  profileSource: 'capability-profile-declaration',
  profileDescription: 'Read-only local package execution over stdio against one filesystem corpus.',
  permissions: {
    summary: 'Read documents beneath the configured documentation root.',
    scopes: ['filesystem-read'],
  },
  prerequisiteSummary:
    'Requires a configured local documentation corpus; no provider or secret setup is required.',
  readinessSummary:
    'Ready after the configured documentation root yields a validated non-empty index.',
  routing: 'Use for bounded, provenance-rich retrieval from one configured documentation corpus.',
  revision: 'b4ead6e48d00c14b59089e7169cb03ac6f57b181',
  metadataVersion: '0.0.0-development',
});

const documentOptimizer = localCapability({
  id: 'document-optimizer',
  displayName: 'Document Optimizer',
  description: 'Deterministic, provenance-aware optimization of PDF and DOCX documents.',
  version: '0.0.0-development',
  status: 'development',
  artifact: 'agent-tool-server-document-optimizer',
  artifactAvailability: 'declared',
  profileId: 'local-filesystem-package',
  profileSource: 'capability-profile-declaration',
  profileDescription:
    'Read-only local PDF and DOCX optimization beneath one configured document root.',
  permissions: {
    summary: 'Read PDF and DOCX files beneath the configured document root.',
    scopes: ['filesystem-read'],
  },
  prerequisiteSummary:
    'Requires a configured local document root; no provider or secret setup is required.',
  readinessSummary: 'Ready when the configured document root is present and usable.',
  routing:
    'Use for deterministic, provenance-aware PDF and DOCX representations with progressive access to outlines, sections, tables, and figures.',
  revision: '35223be62972093a1b5180b3b0672654f90fb5ad',
  metadataVersion: '0.0.0-development',
});

const vision: RegistryCapability = {
  schemaVersion: '1.0.0',
  kind: 'capability',
  id: 'vision',
  displayName: 'Vision',
  description: 'Bounded image analysis, OCR, comparison, and optimized image-region artifacts.',
  version: { value: '0.0.0-development', status: 'development' },
  artifacts: [
    {
      id: 'npm-package',
      kind: 'npm',
      identifier: 'agent-tool-server-vision',
      version: '0.0.0-development',
      availability: 'declared',
      reference: 'server.json#/packages/0',
    },
  ],
  profiles: [
    {
      id: 'hybrid-azure-package',
      description:
        'Local stdio execution with bounded filesystem images and explicitly configured Azure Content Understanding OCR.',
      source: 'capability-profile-declaration',
      dimensions: {
        execution: 'local',
        delivery: 'package',
        access: 'local-process',
        workload: 'filesystem',
        provider: 'external',
        mutation: 'mutating',
      },
      permissions: {
        summary:
          'Read allowed local images, execute the capability-owned worker, call Azure OCR, and create principal-scoped artifacts.',
        scopes: [
          'artifact-write',
          'filesystem-read',
          'network-access',
          'process-execute',
          'provider-read',
        ],
      },
      prerequisites: {
        setupRequired: true,
        summary:
          'Requires allowed image roots, the Python image worker, and an explicitly configured Azure Content Understanding identity.',
        requiredSecrets: ['AZURE_CLIENT_SECRET'],
        provider: [
          {
            id: 'azure-content-understanding',
            description:
              'An HTTPS Azure AI Content Understanding endpoint and an Entra application authorized only for analysis.',
          },
        ],
      },
      readiness: {
        signals: ['process', 'provider', 'workload'],
        summary:
          'Ready when local roots and worker dependencies are usable and provider authentication succeeds.',
      },
      stateEffects: ['artifact-create'],
    },
    {
      id: 'local-package',
      description:
        'Local stdio execution over explicitly allowed image roots with deterministic image operations and local OCR.',
      source: 'capability-profile-declaration',
      dimensions: {
        execution: 'local',
        delivery: 'package',
        access: 'local-process',
        workload: 'filesystem',
        provider: 'none',
        mutation: 'mutating',
      },
      permissions: {
        summary:
          'Read allowed local images, execute the capability-owned worker, and create principal-scoped artifacts.',
        scopes: ['artifact-write', 'filesystem-read', 'process-execute'],
      },
      prerequisites: {
        setupRequired: true,
        summary:
          'Requires allowed image roots and the local Python image worker; no provider or secret setup is required.',
        requiredSecrets: [],
        provider: [],
      },
      readiness: {
        signals: ['process', 'workload'],
        summary:
          'Ready when an allowed image root and the required Python image dependencies are available.',
      },
      stateEffects: ['artifact-create'],
    },
  ],
  bindings: [
    {
      id: 'hybrid-azure-stdio',
      profileId: 'hybrid-azure-package',
      artifactId: 'npm-package',
      interface: 'stdio',
      availability: 'hybrid',
    },
    {
      id: 'local-stdio',
      profileId: 'local-package',
      artifactId: 'npm-package',
      interface: 'stdio',
      availability: 'local',
    },
  ],
  stateChanging: true,
  routing: {
    summary:
      'Use for bounded image analysis, OCR and layout extraction, image comparison, and optimized image-region artifacts.',
  },
  source: source('vision', '833d97c76d92ca833650d826fb1348090df1d5a8', '0.0.0-development', true),
};

const azureProfiles: readonly RegistryCapabilityProfile[] = [
  {
    id: 'hosted-mutating',
    description:
      'Authenticated hosted Azure operations with separately enabled mutations, previews, confirmation, scoped RBAC, and provider verification.',
    source: 'capability-profile-declaration',
    dimensions: {
      execution: 'hosted',
      delivery: 'container',
      access: 'authenticated-service',
      workload: 'provider',
      provider: 'external',
      mutation: 'mutating',
    },
    permissions: {
      summary:
        'Read Azure state and perform only separately enabled, allow-listed operations within operator-scoped RBAC.',
      scopes: ['network-access', 'provider-read', 'provider-write'],
    },
    prerequisites: {
      setupRequired: true,
      summary:
        'Requires an authenticated hosted service, operator-scoped Azure identities, provider registrations, and separately enabled mutation policy.',
      requiredSecrets: ['connector-api-key'],
      provider: [
        {
          id: 'azure-provider-registrations',
          description:
            'Every resource provider required by an authorized operation or Bicep template is registered by the operator.',
        },
        {
          id: 'azure-resource-manager',
          description:
            'Azure Resource Manager and Resource Graph are available to the selected managed identity.',
        },
      ],
    },
    readiness: {
      signals: ['process', 'provider', 'workload'],
      summary:
        'Ready when hosted access, provider authentication, selected mutation RBAC, and deployment prerequisites are usable.',
    },
    stateEffects: ['provider-mutation'],
  },
  {
    id: 'hosted-read-only',
    description:
      'Authenticated hosted inspection and diagnosis through an operator-scoped Azure identity.',
    source: 'capability-profile-declaration',
    dimensions: {
      execution: 'hosted',
      delivery: 'container',
      access: 'authenticated-service',
      workload: 'provider',
      provider: 'external',
      mutation: 'read-only',
    },
    permissions: {
      summary:
        "Read Azure state within operator-selected scopes and the managed identity's effective RBAC.",
      scopes: ['network-access', 'provider-read'],
    },
    prerequisites: {
      setupRequired: true,
      summary:
        'Requires an authenticated hosted service, an operator-scoped Azure identity, and required provider registrations.',
      requiredSecrets: ['connector-api-key'],
      provider: [
        {
          id: 'azure-provider-registrations',
          description:
            'Resource providers needed by the resources being inspected are registered by the operator.',
        },
        {
          id: 'azure-resource-manager',
          description:
            'Azure Resource Manager and Resource Graph are available to the selected managed identity.',
        },
      ],
    },
    readiness: {
      signals: ['process', 'provider', 'workload'],
      summary:
        'Ready when hosted access, Azure authentication, a read-only provider query, and configured RBAC checks succeed.',
    },
    stateEffects: [],
  },
];

const azure: RegistryCapability = {
  schemaVersion: '1.0.0',
  kind: 'capability',
  id: 'azure',
  displayName: 'Azure Agent Tool Server',
  description: 'Inspect, diagnose, operate and deploy Azure through a guard-railed control plane',
  version: { value: '0.2.0', status: 'declared' },
  artifacts: [
    {
      id: 'oci-container',
      kind: 'oci',
      identifier: 'ghcr.io/ashergarland/agent-tool-server-azure',
      version: '0.2.0',
      availability: 'declared',
      reference: 'server.json#/packages/0',
    },
  ],
  profiles: [...azureProfiles],
  bindings: [
    {
      id: 'hosted-mutating-http',
      profileId: 'hosted-mutating',
      artifactId: 'oci-container',
      interface: 'http',
      availability: 'remote',
    },
    {
      id: 'hosted-read-only-http',
      profileId: 'hosted-read-only',
      artifactId: 'oci-container',
      interface: 'http',
      availability: 'remote',
    },
  ],
  stateChanging: true,
  routing: {
    summary:
      'Use for Azure inventory, Resource Graph queries, diagnostics, guarded operations, Bicep validation and what-if, deployments, status, and rollback.',
  },
  source: source('azure', 'a2ea5bac9162159b4b0b04ce12e80d46a1b9a79c', '0.2.0', true),
};

/**
 * Temporary M5 fixture projected from capability-registry commit
 * 44f0a525a48843d4ae994b9f56b8d704c4f01283. Replace this with the package reader when H1/H2 lands
 * on the shared branch.
 */
export const firstPartyCapabilityFixtures: readonly RegistryCapability[] = [
  astSummarizer,
  azure,
  dataCruncher,
  docRag,
  documentOptimizer,
  gitOptimizer,
  vision,
];

export const createFirstPartyRegistryFixture = (): {
  readonly getCapability: (capabilityId: string) => RegistryCapability | undefined;
} => {
  const byId = new Map(
    firstPartyCapabilityFixtures.map((capability) => [capability.id, capability]),
  );
  return { getCapability: (capabilityId) => byId.get(capabilityId) };
};
