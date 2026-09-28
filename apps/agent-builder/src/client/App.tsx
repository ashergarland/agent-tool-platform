import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { AgentDefinition, ReadinessRequirement } from '@agent-tool-platform/agent-kit';
import {
  buildAgent,
  BuilderApiError,
  BuilderUnavailableError,
  getCapabilityCatalog,
  getLocalAgentInstances,
  prepareAgent,
} from './api.js';
import type {
  BuildAgentResult,
  BuildCapabilityResult,
  CapabilityCatalogItem,
  CapabilityCatalogProfile,
  CapabilityCatalogResponse,
  GeneratedArtifact,
  LocalAgentInstance,
  LocalAgentInstanceDiscoveryResponse,
  PrepareActionResultPresentation,
  PrepareAgentResult,
  PreparedInstanceState,
  ReadinessState,
} from '../shared/contracts.js';
import { developerOptimizationPreset } from '../shared/developer-optimization-preset.js';
import {
  localProfileFor,
  planCapabilitySelections,
  selectableProfiles,
  type ExecutionPolicy,
} from './execution-policy.js';

type Page = 'builder' | 'capabilities';
type LoadState = 'error' | 'loading' | 'ready';

interface AgentDraft {
  readonly name: string;
  readonly id: string;
  readonly version: string;
  readonly instructions: string;
  readonly selectedCapabilityIds: readonly string[];
  readonly executionPolicy: ExecutionPolicy;
  readonly profileSelections: Readonly<Record<string, string>>;
}

interface UiError {
  readonly code?: string;
  readonly summary: string;
  readonly issues: readonly string[];
}

const emptyDraft: AgentDraft = {
  name: '',
  id: '',
  version: '1.0.0',
  instructions: '',
  selectedCapabilityIds: [],
  executionPolicy: 'automatic',
  profileSelections: {},
};

const readinessPresentation: Readonly<
  Record<ReadinessState, { readonly label: string; readonly tone: string }>
> = {
  'available-local': { label: 'Available locally', tone: 'positive' },
  ready: { label: 'Ready to prepare', tone: 'positive' },
  'local-setup-required': { label: 'Local setup required', tone: 'warning' },
  'remote-provider-setup-required': {
    label: 'Remote/provider setup required',
    tone: 'warning',
  },
  'missing-configuration': { label: 'Configuration required', tone: 'attention' },
  'incompatible-binding': { label: 'Incompatible binding', tone: 'danger' },
};

const instanceStatePresentation: Readonly<
  Record<PreparedInstanceState, { readonly label: string; readonly tone: string }>
> = {
  READY: { label: 'READY', tone: 'positive' },
  NEEDS_SETUP: { label: 'NEEDS SETUP', tone: 'warning' },
  UNAVAILABLE: { label: 'UNAVAILABLE', tone: 'danger' },
};

const discoveredStatePresentation: Readonly<
  Record<LocalAgentInstance['state'], { readonly label: string; readonly tone: string }>
> = {
  READY: { label: 'READY', tone: 'positive' },
  ACTIVE: { label: 'ACTIVE', tone: 'positive' },
  DEGRADED: { label: 'DEGRADED', tone: 'warning' },
  NEEDS_SETUP: { label: 'NEEDS SETUP', tone: 'warning' },
  UNAVAILABLE: { label: 'UNAVAILABLE', tone: 'danger' },
};

const preparationStatusPresentation: Readonly<
  Record<
    PrepareActionResultPresentation['status'],
    { readonly label: string; readonly tone: string }
  >
> = {
  success: { label: 'Completed', tone: 'positive' },
  'already-ready': { label: 'Already ready', tone: 'positive' },
  'setup-required': { label: 'Setup required', tone: 'warning' },
  unavailable: { label: 'Unavailable', tone: 'danger' },
};

const modePresentation = {
  local: { label: 'Local', icon: 'L' },
  remote: { label: 'Remote', icon: 'R' },
  hybrid: { label: 'Hybrid', icon: 'H' },
} as const;

const mutationPresentation = {
  'read-only': 'Read-only',
  mutating: 'Mutating',
} as const;

const executionPolicyPresentation: Readonly<
  Record<ExecutionPolicy, { readonly label: string; readonly description: string }>
> = {
  automatic: {
    label: 'Automatic',
    description: 'Agent Kit chooses the normal compatible default profile during Build.',
  },
  'local-only': {
    label: 'Local only',
    description:
      'Require Registry-declared local profiles and favor read-only when local alternatives exist.',
  },
  custom: {
    label: 'Custom',
    description:
      'Choose profiles for capabilities with meaningful alternatives; Auto remains valid.',
  },
};

const profileExecutionLabel = (profile: CapabilityCatalogProfile): string =>
  profile.bindingModes.length === 0
    ? 'Unavailable'
    : profile.bindingModes.map((mode) => modePresentation[mode].label).join(' / ');

const profilePostureLabel = (profile: CapabilityCatalogProfile): string =>
  `${profileExecutionLabel(profile)} · ${mutationPresentation[profile.dimensions.mutation]}`;

const executionShapeLabel = (result: BuildAgentResult): string => {
  const activeModes = (['local', 'remote', 'hybrid'] as const).filter(
    (mode) => result.execution[mode] > 0,
  );
  if (activeModes.length > 1) return 'Mixed capabilities';
  const mode = activeModes[0];
  return mode === undefined ? 'No capabilities' : `${modePresentation[mode].label} capabilities`;
};

export const deriveAgentId = (name: string): string => {
  const words = name.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  if (words.at(-1) === 'agent') words.pop();
  return words.join('-');
};

const uiError = (error: unknown, fallback: string): UiError => {
  if (error instanceof BuilderApiError) {
    return { code: error.code, summary: error.message, issues: error.issues };
  }
  if (error instanceof BuilderUnavailableError) {
    return { summary: error.message, issues: [] };
  }
  return { summary: fallback, issues: [] };
};

const Icon = ({
  name,
  size = 18,
}: {
  readonly name:
    | 'arrow'
    | 'bolt'
    | 'check'
    | 'chevron'
    | 'copy'
    | 'grid'
    | 'layers'
    | 'lock'
    | 'sparkles'
    | 'terminal';
  readonly size?: number;
}): ReactNode => {
  const paths = {
    arrow: <path d="m8 5 7 7-7 7M15 12H3" />,
    bolt: <path d="m13 2-9 11h7l-1 9 9-12h-7l1-8Z" />,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    copy: (
      <>
        <rect width="11" height="11" x="9" y="9" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </>
    ),
    grid: (
      <>
        <rect width="7" height="7" x="3" y="3" rx="1" />
        <rect width="7" height="7" x="14" y="3" rx="1" />
        <rect width="7" height="7" x="3" y="14" rx="1" />
        <rect width="7" height="7" x="14" y="14" rx="1" />
      </>
    ),
    layers: <path d="m12 2 9 5-9 5-9-5 9-5Zm-9 10 9 5 9-5M3 17l9 5 9-5" />,
    lock: (
      <>
        <rect width="16" height="11" x="4" y="11" rx="2" />
        <path d="M8 11V7a4 4 0 0 1 8 0v4" />
      </>
    ),
    sparkles: (
      <>
        <path d="m12 3-1.5 4.5L6 9l4.5 1.5L12 15l1.5-4.5L18 9l-4.5-1.5L12 3Z" />
        <path d="m5 3-.5 1.5L3 5l1.5.5L5 7l.5-1.5L7 5l-1.5-.5L5 3Zm14 12-1 3-3 1 3 1 1 3 1-3 3-1-3-1-1-3Z" />
      </>
    ),
    terminal: (
      <>
        <rect width="20" height="16" x="2" y="4" rx="2" />
        <path d="m6 9 3 3-3 3m5 0h5" />
      </>
    ),
  } as const;
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
    >
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
        {paths[name]}
      </g>
    </svg>
  );
};

const Brand = (): ReactNode => (
  <div className="brand">
    <div className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
    <div>
      <strong>Agent Tool Platform</strong>
      <span>Agent Builder</span>
    </div>
  </div>
);

const AppNavigation = ({
  page,
  onNavigate,
}: {
  readonly page: Page;
  readonly onNavigate: (page: Page) => void;
}): ReactNode => (
  <nav aria-label="Primary navigation" className="primary-nav">
    <button
      className={page === 'capabilities' ? 'active' : ''}
      onClick={() => onNavigate('capabilities')}
      type="button"
    >
      <Icon name="grid" size={16} />
      Capabilities
    </button>
    <button
      className={page === 'builder' ? 'active' : ''}
      onClick={() => onNavigate('builder')}
      type="button"
    >
      <Icon name="layers" size={16} />
      Build Agent
    </button>
  </nav>
);

const ProductShell = ({
  children,
  page,
  onNavigate,
}: {
  readonly children: ReactNode;
  readonly page: Page;
  readonly onNavigate: (page: Page) => void;
}): ReactNode => (
  <div className="app-shell">
    <header className="topbar">
      <Brand />
      <AppNavigation page={page} onNavigate={onNavigate} />
      <div className="host-pill">
        <span className="pulse-dot" />
        Local Builder
      </div>
    </header>
    <main>{children}</main>
    <footer>
      <span>Agent Tool Platform</span>
      <span>Build deterministic compositions. Prepare truthful Agent Instances.</span>
    </footer>
  </div>
);

const SkeletonCards = ({ count = 6 }: { readonly count?: number }): ReactNode => (
  <div aria-label="Loading capabilities" className="capability-grid" role="status">
    {Array.from({ length: count }, (_, index) => (
      <div className="capability-card skeleton-card" key={index}>
        <span className="skeleton skeleton-title" />
        <span className="skeleton skeleton-line" />
        <span className="skeleton skeleton-line short" />
        <span className="skeleton skeleton-chip" />
      </div>
    ))}
  </div>
);

const ErrorNotice = ({
  error,
  title = 'Something needs attention',
  onRetry,
}: {
  readonly error: UiError;
  readonly title?: string;
  readonly onRetry?: () => void;
}): ReactNode => (
  <section className="error-notice" role="alert">
    <div className="error-glyph">!</div>
    <div>
      <div className="error-heading">
        <h3>{title}</h3>
        {error.code === undefined ? null : <code>{error.code}</code>}
      </div>
      <p>{error.summary}</p>
      {error.issues.length === 0 ? null : (
        <ul>
          {error.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {onRetry === undefined ? null : (
        <button className="button secondary compact" onClick={onRetry} type="button">
          Try again
        </button>
      )}
    </div>
  </section>
);

const VersionBadge = ({
  status,
  version,
}: {
  readonly status: CapabilityCatalogItem['versionStatus'];
  readonly version: string;
}): ReactNode => (
  <span className={`version-badge ${status}`}>
    <span>{version}</span>
    <span>{status}</span>
  </span>
);

const ProfilePosture = ({ profile }: { readonly profile: CapabilityCatalogProfile }): ReactNode => (
  <span className={`profile-posture ${profile.dimensions.mutation}`}>
    {profilePostureLabel(profile)}
  </span>
);

const CapabilityExecutionControl = ({
  capability,
  policy,
  selectedProfileId,
  onProfileChange,
}: {
  readonly capability: CapabilityCatalogItem;
  readonly policy: ExecutionPolicy;
  readonly selectedProfileId: string | undefined;
  readonly onProfileChange: (capabilityId: string, profileId: string | undefined) => void;
}): ReactNode => {
  const profiles = selectableProfiles(capability);

  if (policy === 'automatic') {
    return (
      <div className="capability-execution-summary">
        <small>Execution</small>
        <strong>Auto</strong>
        <span>Profile and mutation posture resolve through Agent Kit during Build.</span>
      </div>
    );
  }

  if (policy === 'local-only') {
    const profile = localProfileFor(capability);
    if (profile === undefined) {
      return (
        <div className="capability-execution-summary incompatible">
          <small>Execution</small>
          <strong>Local only unavailable</strong>
          <span>No Registry profile for this capability can execute locally.</span>
        </div>
      );
    }
    return (
      <div className="capability-execution-summary">
        <small>Execution · Local only</small>
        <ProfilePosture profile={profile} />
        <span>{profile.description}</span>
      </div>
    );
  }

  if (profiles.length <= 1) {
    const profile = profiles[0];
    return (
      <div className="capability-execution-summary">
        <small>Execution</small>
        <strong>Auto · only Registry profile</strong>
        {profile === undefined ? null : <ProfilePosture profile={profile} />}
        <span>Agent Kit resolves this capability during Build; no extra choice is needed.</span>
      </div>
    );
  }

  return (
    <fieldset className="profile-picker">
      <legend>Execution profile</legend>
      <label className={selectedProfileId === undefined ? 'selected' : ''}>
        <input
          checked={selectedProfileId === undefined}
          name={`profile-${capability.id}`}
          onChange={() => onProfileChange(capability.id, undefined)}
          type="radio"
        />
        <span>
          <strong>Auto</strong>
          <small>Agent Kit chooses the normal compatible default.</small>
        </span>
      </label>
      {profiles.map((profile) => (
        <label className={selectedProfileId === profile.id ? 'selected' : ''} key={profile.id}>
          <input
            checked={selectedProfileId === profile.id}
            name={`profile-${capability.id}`}
            onChange={() => onProfileChange(capability.id, profile.id)}
            type="radio"
          />
          <span>
            <ProfilePosture profile={profile} />
            <small>{profile.description}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
};

const CapabilityCard = ({
  capability,
  selected,
  selectable = false,
  onToggle,
  executionPolicy,
  selectedProfileId,
  onProfileChange,
}: {
  readonly capability: CapabilityCatalogItem;
  readonly selected?: boolean;
  readonly selectable?: boolean;
  readonly onToggle?: (id: string) => void;
  readonly executionPolicy?: ExecutionPolicy;
  readonly selectedProfileId?: string | undefined;
  readonly onProfileChange?: (capabilityId: string, profileId: string | undefined) => void;
}): ReactNode => {
  const profilePostures = [
    ...new Set(selectableProfiles(capability).map((profile) => profilePostureLabel(profile))),
  ];
  const content = (
    <div className="capability-card-content">
      <div className="capability-card-topline">
        <div className="capability-symbol">{capability.displayName.slice(0, 2).toUpperCase()}</div>
        <VersionBadge status={capability.versionStatus} version={capability.version} />
      </div>
      <div className="capability-heading">
        <h3>{capability.displayName}</h3>
        <code>{capability.id}</code>
      </div>
      <p>{capability.description}</p>
      <div className="chip-row">
        {capability.bindingModes.map((mode) => (
          <span className={`mode-chip ${mode}`} key={mode}>
            {modePresentation[mode].label}
          </span>
        ))}
        {profilePostures.map((posture) => (
          <span className="profile-chip" key={posture}>
            {posture}
          </span>
        ))}
      </div>
      <div className="capability-meta">
        <span>{capability.category}</span>
        <span>{String(capability.toolCount)} tools</span>
        <span>{capability.stateChanging ? 'May create or change state' : 'Read-only'}</span>
      </div>
      {selectable ? (
        <div className="selection-indicator">
          <span className="selection-check">
            {selected ? <Icon name="check" size={14} /> : null}
          </span>
          {selected ? 'Selected' : 'Add capability'}
        </div>
      ) : null}
    </div>
  );

  if (!selectable) return <article className="capability-card">{content}</article>;
  return (
    <article className={`capability-card selectable ${selected ? 'selected' : ''}`}>
      <button
        aria-pressed={selected}
        className="capability-toggle"
        onClick={() => onToggle?.(capability.id)}
        type="button"
      >
        {content}
      </button>
      {selected && executionPolicy !== undefined && onProfileChange !== undefined ? (
        <CapabilityExecutionControl
          capability={capability}
          onProfileChange={onProfileChange}
          policy={executionPolicy}
          selectedProfileId={selectedProfileId}
        />
      ) : null}
    </article>
  );
};

const CatalogPage = ({
  catalog,
  state,
  error,
  onRetry,
  onUseBuilder,
}: {
  readonly catalog: CapabilityCatalogResponse | undefined;
  readonly state: LoadState;
  readonly error: UiError | undefined;
  readonly onRetry: () => void;
  readonly onUseBuilder: () => void;
}): ReactNode => (
  <div className="page catalog-page">
    <section className="page-hero catalog-hero">
      <div>
        <span className="eyebrow">First-party Registry</span>
        <h1>Capabilities built for focused work.</h1>
        <p>
          Explore the live Capability Registry, then compose the capabilities your agent needs.
          Versions, profiles, and execution bindings resolve during Build.
        </p>
      </div>
      <div className="hero-actions">
        <button className="button primary" onClick={onUseBuilder} type="button">
          Build an agent
          <Icon name="arrow" size={17} />
        </button>
        {catalog === undefined ? null : (
          <div className="registry-stat">
            <strong>{String(catalog.capabilities.length)}</strong>
            <span>registered capabilities</span>
            <code>registry {catalog.registryVersion}</code>
          </div>
        )}
      </div>
    </section>
    {state === 'loading' ? <SkeletonCards /> : null}
    {state === 'error' && error !== undefined ? (
      <ErrorNotice error={error} onRetry={onRetry} title="Capability Registry unavailable" />
    ) : null}
    {state === 'ready' && catalog?.capabilities.length === 0 ? (
      <section className="empty-state">
        <Icon name="grid" size={28} />
        <h2>No capabilities are registered</h2>
        <p>The Builder will show first-party capabilities here when the Registry contains them.</p>
      </section>
    ) : null}
    {state === 'ready' && catalog !== undefined && catalog.capabilities.length > 0 ? (
      <section aria-label="Capability catalog" className="capability-grid">
        {catalog.capabilities.map((capability) => (
          <CapabilityCard capability={capability} key={capability.id} />
        ))}
      </section>
    ) : null}
  </div>
);

const localInstanceName = (agentId: string): string => {
  const name = agentId
    .split('-')
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(' ');
  return name.endsWith(' Agent') ? name : `${name} Agent`;
};

const preparedTime = (value: string): string =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));

const LocalInstancesSection = ({
  discovery,
  error,
  onRetry,
  state,
}: {
  readonly discovery: LocalAgentInstanceDiscoveryResponse | undefined;
  readonly error: UiError | undefined;
  readonly onRetry: () => void;
  readonly state: LoadState;
}): ReactNode => (
  <section aria-labelledby="local-instances-heading" className="local-instances">
    <div className="local-instances-heading">
      <div>
        <span className="eyebrow">Persisted locally</span>
        <h2 id="local-instances-heading">Local Agent Instances</h2>
      </div>
      <p>
        Prepared instances are validated through Agent Kit and rediscovered when Builder restarts.
        Persistence does not mean the agent is running.
      </p>
    </div>
    {state === 'loading' ? (
      <div aria-label="Loading local Agent Instances" className="instance-loading">
        <span className="spinner" />
        Discovering prepared instances…
      </div>
    ) : null}
    {state === 'error' && error !== undefined ? (
      <ErrorNotice error={error} onRetry={onRetry} title="Local instances unavailable" />
    ) : null}
    {state === 'ready' && discovery?.instances.length === 0 ? (
      <div className="instance-empty">
        <Icon name="layers" size={20} />
        <div>
          <strong>No prepared instances yet</strong>
          <span>Build and Prepare an agent to persist its local Agent Instance.</span>
        </div>
      </div>
    ) : null}
    {state === 'ready' && discovery !== undefined && discovery.instances.length > 0 ? (
      <div className="local-instance-grid">
        {discovery.instances.map((instance) => {
          const presentation = discoveredStatePresentation[instance.state];
          return (
            <article className="local-instance-card" key={instance.instanceId}>
              <div className="local-instance-card-heading">
                <div>
                  <h3>{localInstanceName(instance.agent.id)}</h3>
                  <code>
                    {instance.agent.id} · v{instance.agent.version}
                  </code>
                </div>
                <span className={`status-chip ${presentation.tone}`}>{presentation.label}</span>
              </div>
              <div className="local-instance-context">
                <strong>{instance.environment.label}</strong>
                <span>
                  Prepared{' '}
                  <time dateTime={instance.preparedAt}>{preparedTime(instance.preparedAt)}</time>
                </span>
              </div>
              <div className="local-instance-summary">
                <span>
                  <strong>{String(instance.bindingSummary.local)}</strong> Local
                </span>
                <span>
                  <strong>{String(instance.bindingSummary.remote)}</strong> Remote
                </span>
                <span>
                  <strong>{String(instance.bindingSummary.hybrid)}</strong> Hybrid
                </span>
                <span>{String(instance.bindingSummary.total)} bindings</span>
              </div>
              <details className="local-instance-details">
                <summary>Binding readiness</summary>
                <div>
                  {instance.bindings.map((binding) => (
                    <div
                      className="local-instance-binding"
                      key={`${binding.capabilityId}-${binding.capabilityVersion}-${binding.profile}`}
                    >
                      <span>
                        <strong>{binding.capabilityId}</strong>
                        <code>
                          v{binding.capabilityVersion} · {binding.profile}
                        </code>
                      </span>
                      <span>
                        {modePresentation[binding.mode].label} ·{' '}
                        {discoveredStatePresentation[binding.state].label}
                      </span>
                      <small>{readinessPresentation[binding.readiness].label}</small>
                    </div>
                  ))}
                </div>
              </details>
              <code className="local-instance-id">{instance.instanceId}</code>
            </article>
          );
        })}
      </div>
    ) : null}
    {state === 'ready' && discovery !== undefined && discovery.diagnostics.warnings.length > 0 ? (
      <div className="instance-discovery-warning" role="status">
        {discovery.diagnostics.warnings.map((warning) => (
          <span key={warning}>{warning}</span>
        ))}
      </div>
    ) : null}
  </section>
);

const Lifecycle = ({
  built,
  prepared,
  preparing,
}: {
  readonly built: boolean;
  readonly prepared: boolean;
  readonly preparing: boolean;
}): ReactNode => {
  const steps: readonly {
    readonly number: number;
    readonly label: string;
    readonly state: 'active' | 'complete' | 'locked' | 'next';
    readonly detail: string | undefined;
  }[] = [
    { number: 1, label: 'Define', state: built ? 'complete' : 'active', detail: undefined },
    { number: 2, label: 'Build', state: built ? 'complete' : 'next', detail: undefined },
    {
      number: 3,
      label: 'Prepare',
      state: prepared ? 'complete' : built ? 'active' : 'locked',
      detail: preparing ? 'Preparing…' : built && !prepared ? 'Available' : undefined,
    },
    {
      number: 4,
      label: 'Agent Instance',
      state: prepared ? 'active' : 'locked',
      detail: prepared ? 'Realized' : undefined,
    },
  ] as const;
  return (
    <ol aria-label="Agent lifecycle" className="lifecycle">
      {steps.map((step, index) => (
        <li className={step.state} key={step.label}>
          <span className="step-node">
            {step.state === 'complete' ? <Icon name="check" size={15} /> : step.number}
          </span>
          <span className="step-copy">
            <strong>{step.label}</strong>
            {step.detail === undefined && step.state === 'locked' ? <small>Pending</small> : null}
            {step.detail === undefined ? null : <small>{step.detail}</small>}
          </span>
          {index === steps.length - 1 ? null : <span className="step-line" />}
        </li>
      ))}
    </ol>
  );
};

const DraftOverview = ({
  draft,
  catalog,
}: {
  readonly draft: AgentDraft;
  readonly catalog: CapabilityCatalogResponse | undefined;
}): ReactNode => {
  const selected = new Set(draft.selectedCapabilityIds);
  const selectedItems = catalog?.capabilities.filter((item) => selected.has(item.id)) ?? [];
  return (
    <aside className="draft-overview">
      <span className="eyebrow">Composition</span>
      <h2>{draft.name.trim() || 'Untitled agent'}</h2>
      <code>{draft.id || 'agent-id'}</code>
      <div className="overview-stat">
        <strong>{String(selectedItems.length)}</strong>
        <span>capabilities selected</span>
      </div>
      <div className="overview-execution">
        <small>Agent runtime</small>
        <strong>Local VS Code agent</strong>
        <span>{executionPolicyPresentation[draft.executionPolicy].label} capability execution</span>
      </div>
      <div className="overview-stack">
        {selectedItems.length === 0 ? (
          <p>Select capabilities to shape this composition.</p>
        ) : (
          selectedItems.map((item) => (
            <div key={item.id}>
              <span>{item.displayName}</span>
              <small>{item.id}</small>
            </div>
          ))
        )}
      </div>
      <div className="overview-boundary">
        <Icon name="lock" size={17} />
        <div>
          <strong>Build uses references only</strong>
          <span>No endpoints or secret values are requested or stored.</span>
        </div>
      </div>
    </aside>
  );
};

const AuthoringForm = ({
  draft,
  catalog,
  catalogState,
  building,
  formError,
  onChange,
  onToggleCapability,
  onProfileChange,
  onApplyPreset,
  onSubmit,
  policyIssues,
}: {
  readonly draft: AgentDraft;
  readonly catalog: CapabilityCatalogResponse | undefined;
  readonly catalogState: LoadState;
  readonly building: boolean;
  readonly formError: UiError | undefined;
  readonly onChange: (patch: Partial<AgentDraft>) => void;
  readonly onToggleCapability: (id: string) => void;
  readonly onProfileChange: (capabilityId: string, profileId: string | undefined) => void;
  readonly onApplyPreset: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly policyIssues: readonly string[];
}): ReactNode => (
  <form className="authoring-form" onSubmit={onSubmit}>
    <section className="form-section identity-section">
      <div className="section-heading">
        <div>
          <span className="section-number">01</span>
          <div>
            <h2>Define your agent</h2>
            <p>Give the composition a purpose and a durable identity.</p>
          </div>
        </div>
        <button className="preset-button" onClick={onApplyPreset} type="button">
          <Icon name="sparkles" size={17} />
          Developer Optimization preset
        </button>
      </div>
      <div className="field-grid">
        <label className="field">
          <span>Agent name</span>
          <input
            autoComplete="off"
            maxLength={200}
            name="agent-name"
            onChange={(event) => onChange({ name: event.target.value })}
            placeholder="Developer Optimization Agent"
            value={draft.name}
          />
        </label>
        <label className="field compact-field">
          <span>Initial version</span>
          <input aria-readonly="true" readOnly value={draft.version} />
        </label>
      </div>
      <details className="technical-id" open={draft.id.length > 0}>
        <summary>
          Technical identity
          <span>Derived from the name · editable</span>
        </summary>
        <label className="field">
          <span>Agent ID</span>
          <input
            autoComplete="off"
            maxLength={200}
            name="agent-id"
            onChange={(event) => onChange({ id: event.target.value })}
            placeholder="developer-optimization"
            spellCheck="false"
            value={draft.id}
          />
          <small>Stable Platform identifier used in locks and generated file names.</small>
        </label>
      </details>
      <label className="field instructions-field">
        <span>
          Instructions
          <small>{draft.instructions.length.toLocaleString()} / 16,000</small>
        </span>
        <textarea
          maxLength={16_000}
          name="instructions"
          onChange={(event) => onChange({ instructions: event.target.value })}
          placeholder="Describe how this agent should work, reason, and use its selected capabilities..."
          rows={12}
          value={draft.instructions}
        />
      </label>
    </section>

    <section className="form-section selection-section">
      <div className="section-heading">
        <div>
          <span className="section-number">02</span>
          <div>
            <h2>Select capabilities</h2>
            <p>Choose by role. Agent Kit resolves compatible versions, profiles, and bindings.</p>
          </div>
        </div>
        <span className="selected-count">
          {String(draft.selectedCapabilityIds.length)} selected
        </span>
      </div>
      {catalogState === 'loading' ? <SkeletonCards count={3} /> : null}
      {catalogState === 'error' ? (
        <p className="inline-empty">Capabilities are unavailable until the Registry reloads.</p>
      ) : null}
      {catalogState === 'ready' && catalog?.capabilities.length === 0 ? (
        <p className="inline-empty">The Registry does not currently contain capabilities.</p>
      ) : null}
      {catalogState === 'ready' && catalog !== undefined ? (
        <div className="capability-grid selection-grid">
          {catalog.capabilities.map((capability) => (
            <CapabilityCard
              capability={capability}
              key={capability.id}
              executionPolicy={draft.executionPolicy}
              onProfileChange={onProfileChange}
              onToggle={onToggleCapability}
              selectable
              selected={draft.selectedCapabilityIds.includes(capability.id)}
              selectedProfileId={draft.profileSelections[capability.id]}
            />
          ))}
        </div>
      ) : null}
    </section>

    <section className="form-section execution-policy-section">
      <div className="section-heading">
        <div>
          <span className="section-number">03</span>
          <div>
            <h2>Choose capability execution</h2>
            <p>The agent stays local. This policy controls where its capabilities execute.</p>
          </div>
        </div>
      </div>
      <div className="runtime-axis-note">
        <Icon name="terminal" size={18} />
        <div>
          <strong>Agent runtime · Local VS Code</strong>
          <span>Capabilities may independently resolve to local, remote, or hybrid execution.</span>
        </div>
      </div>
      <fieldset aria-label="Execution policy" className="execution-policy-grid">
        {(['automatic', 'local-only', 'custom'] as const).map((policy) => {
          const presentation = executionPolicyPresentation[policy];
          return (
            <label className={draft.executionPolicy === policy ? 'selected' : ''} key={policy}>
              <input
                checked={draft.executionPolicy === policy}
                name="execution-policy"
                onChange={() => onChange({ executionPolicy: policy })}
                type="radio"
              />
              <span>
                <strong>{presentation.label}</strong>
                <small>{presentation.description}</small>
              </span>
            </label>
          );
        })}
      </fieldset>
      <div className="policy-boundary">
        <strong>Execution and mutation stay separate.</strong>
        <span>
          Every explicit profile identifies both its Local, Remote, or Hybrid topology and its
          Read-only or Mutating posture.
        </span>
      </div>
      {policyIssues.length === 0 ? null : (
        <ErrorNotice
          error={{
            summary: 'The selected capabilities cannot satisfy Local only.',
            issues: policyIssues,
          }}
          title="Local only is incompatible"
        />
      )}
    </section>

    {formError === undefined ? null : (
      <ErrorNotice error={formError} title="Build could not complete" />
    )}

    <section className="build-action-bar">
      <div>
        <Icon name="bolt" size={20} />
        <div>
          <strong>Build a deterministic composition</strong>
          <span>
            {executionPolicyPresentation[draft.executionPolicy].label} · validate · resolve · bind ·
            generate
          </span>
        </div>
      </div>
      <button
        className="button primary build-button"
        disabled={building || policyIssues.length > 0}
        type="submit"
      >
        {building ? (
          <>
            <span className="spinner" />
            Building composition…
          </>
        ) : (
          <>
            Build agent
            <Icon name="arrow" size={18} />
          </>
        )}
      </button>
    </section>
  </form>
);

const ReadinessChip = ({ state }: { readonly state: ReadinessState }): ReactNode => {
  const presentation = readinessPresentation[state];
  return <span className={`status-chip ${presentation.tone}`}>{presentation.label}</span>;
};

const CapabilityResultRow = ({
  capability,
}: {
  readonly capability: BuildCapabilityResult;
}): ReactNode => {
  const mode = modePresentation[capability.binding.mode];
  return (
    <article className="result-capability">
      <div className="result-capability-main">
        <div className={`binding-icon ${capability.binding.mode}`}>{mode.icon}</div>
        <div>
          <strong>{capability.displayName}</strong>
          <code>
            {capability.id} · v{capability.resolvedVersion}
          </code>
          <span className="compatibility-label">
            <Icon name="check" size={11} />
            VS Code compatible
          </span>
        </div>
      </div>
      <div className="result-cell">
        <small>Execution</small>
        <strong className={`resolved-posture ${capability.profile.mutation}`}>
          {mode.label} · {mutationPresentation[capability.profile.mutation]}
        </strong>
      </div>
      <div className="result-cell">
        <small>Resolved profile</small>
        <code>{capability.profile.id}</code>
      </div>
      <div className="result-cell">
        <small>Resolved binding</small>
        <code>{capability.binding.id}</code>
        <span>{capability.binding.interface}</span>
      </div>
      <ReadinessChip state={capability.readiness.state} />
      <div className="readiness-summary">
        <span>
          <strong>Setup</strong>
          {capability.readiness.setupSummary}
        </span>
        <span>
          <strong>Ready when</strong>
          {capability.readiness.summary}
        </span>
      </div>
      {capability.configuration.endpointRequired ||
      capability.configuration.requiredNames.length > 0 ? (
        <div className="configuration-strip">
          {capability.configuration.endpointRequired ? <span>Endpoint required</span> : null}
          {capability.configuration.requiredNames.map((name) => (
            <span key={name}>{name} required</span>
          ))}
          {capability.configuration.headers.map((header) => (
            <span key={`${header.name}-${header.configurationName}`}>
              Header: {header.name} ← {header.configurationName}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
};

const ExecutionSummary = ({ result }: { readonly result: BuildAgentResult }): ReactNode => {
  const shape = executionShapeLabel(result);
  return (
    <section className="result-section">
      <div className="result-section-heading">
        <div>
          <span className="eyebrow">Execution</span>
          <h2>Local Agent · {shape}</h2>
        </div>
        <p>Agent runtime and capability execution are independent axes.</p>
      </div>
      <div className="runtime-summary">
        <div>
          <small>Agent runtime</small>
          <strong>Local · VS Code</strong>
        </div>
        <div>
          <small>Capability execution</small>
          <strong>{shape}</strong>
        </div>
        <span>One remote capability does not make the whole agent remote.</span>
      </div>
      <div className="execution-grid">
        {(['local', 'remote', 'hybrid'] as const).map((mode) => (
          <article className={`execution-card ${mode}`} key={mode}>
            <div className={`binding-icon ${mode}`}>{modePresentation[mode].icon}</div>
            <div>
              <strong>{String(result.execution[mode])}</strong>
              <span>{modePresentation[mode].label}</span>
            </div>
            <small>
              {mode === 'local'
                ? 'Runs on this environment'
                : mode === 'remote'
                  ? 'Connects to a provider endpoint'
                  : 'Local process with provider access'}
            </small>
          </article>
        ))}
      </div>
    </section>
  );
};

const ArtifactPreview = ({
  artifacts,
}: {
  readonly artifacts: readonly GeneratedArtifact[];
}): ReactNode => {
  const [activeKind, setActiveKind] = useState(artifacts[0]?.kind ?? 'lock');
  const [copyState, setCopyState] = useState<'copied' | 'error' | 'idle'>('idle');
  const active = artifacts.find((artifact) => artifact.kind === activeKind) ?? artifacts[0];

  useEffect(() => {
    setActiveKind(artifacts[0]?.kind ?? 'lock');
    setCopyState('idle');
  }, [artifacts]);

  if (active === undefined) return null;

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(active.content);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1_500);
    } catch {
      setCopyState('error');
    }
  };

  return (
    <section className="result-section artifact-section">
      <div className="result-section-heading">
        <div>
          <span className="eyebrow">Generated artifacts</span>
          <h2>Inspect the exact build output</h2>
        </div>
        <p>Previewed directly from Agent Kit. Nothing is written to your filesystem.</p>
      </div>
      <div className="artifact-shell">
        <div aria-label="Generated artifact previews" className="artifact-tabs" role="tablist">
          {artifacts.map((artifact) => (
            <button
              aria-selected={artifact.kind === active.kind}
              className={artifact.kind === active.kind ? 'active' : ''}
              key={artifact.kind}
              onClick={() => {
                setActiveKind(artifact.kind);
                setCopyState('idle');
              }}
              role="tab"
              type="button"
            >
              {artifact.label}
            </button>
          ))}
        </div>
        <div className="artifact-toolbar">
          <code>{active.path}</code>
          <button className="copy-button" onClick={() => void copy()} type="button">
            <Icon name={copyState === 'copied' ? 'check' : 'copy'} size={15} />
            {copyState === 'copied' ? 'Copied' : copyState === 'error' ? 'Copy failed' : 'Copy'}
          </button>
        </div>
        <pre>
          <code>{active.content}</code>
        </pre>
      </div>
    </section>
  );
};

const VsCodeSummary = ({ result }: { readonly result: BuildAgentResult }): ReactNode => {
  const configuration = result.capabilities.flatMap((capability) => [
    ...(capability.configuration.endpointRequired ? [`${capability.displayName} endpoint`] : []),
    ...capability.configuration.requiredNames.map((name) => `${capability.displayName}: ${name}`),
  ]);
  return (
    <section className="result-section vscode-section">
      <div className="vscode-mark">
        <Icon name="terminal" size={24} />
      </div>
      <div className="vscode-copy">
        <span className="eyebrow">VS Code integration generated</span>
        <h2>{String(result.vsCode.serverCount)} MCP servers configured</h2>
        <div className="generated-paths">
          <div>
            <small>Agent file</small>
            <code>{result.vsCode.agentPath}</code>
          </div>
          <div>
            <small>MCP configuration</small>
            <code>{result.vsCode.mcpPath}</code>
          </div>
        </div>
      </div>
      <div className="configuration-summary">
        <small>Configuration references</small>
        {configuration.length === 0 ? (
          <span>None required by this build</span>
        ) : (
          configuration.map((item) => <span key={item}>{item}</span>)
        )}
        <strong>Reference-based · no secret values</strong>
      </div>
    </section>
  );
};

const readinessRequirementText = (requirement: ReadinessRequirement): string => {
  switch (requirement.kind) {
    case 'host-compatibility':
      return requirement.state === 'compatible'
        ? 'VS Code host compatibility verified by Build'
        : `Host incompatible: ${requirement.reasons.join('; ')}`;
    case 'setup':
      return `Registry setup note: ${requirement.summary}`;
    case 'artifact-availability':
      return `Registry artifact metadata: ${requirement.state} (${requirement.artifactId}); this is not local availability evidence`;
    case 'configuration':
      return `${requirement.name}: ${requirement.state === 'available' ? 'configuration reference verified' : 'configuration reference missing'}`;
    case 'local-artifact':
      return `Local artifact: ${requirement.state === 'available' ? 'verified' : 'setup required'}`;
    case 'remote-connection':
      return `Remote connection: ${requirement.state === 'available' ? 'verified' : 'setup required'}`;
    case 'provider-prerequisite':
      return `${requirement.id}: ${requirement.state === 'available' ? 'verified' : 'setup required'} · ${requirement.description}`;
  }
};

const setupRequirementText = (result: PrepareActionResultPresentation): string => {
  const { action } = result;
  switch (action.concern) {
    case 'local-artifact':
      return action.artifact === undefined
        ? 'The locked local artifact has not been verified in this environment.'
        : `The locked ${action.artifact.kind} artifact ${action.artifact.identifier}@${action.artifact.version} has not been verified in this environment.`;
    case 'configuration':
      return `Provide the named configuration reference ${action.configurationName ?? 'required by this binding'} to VS Code. Builder does not collect or persist its value.`;
    case 'remote-connection':
      return 'Verify that the configured remote capability connection is reachable and authorized.';
    case 'provider-prerequisite':
      return `Verify provider prerequisite ${action.prerequisiteId ?? 'required by this binding'} without asking Builder to provision or mutate the provider.`;
    case 'host-integration':
      return 'Materialize the generated VS Code agent and MCP files through a future bounded workspace flow. Builder has not written them.';
  }
};

const PreparationStatusChip = ({
  status,
}: {
  readonly status: PrepareActionResultPresentation['status'];
}): ReactNode => {
  const presentation = preparationStatusPresentation[status];
  return <span className={`status-chip ${presentation.tone}`}>{presentation.label}</span>;
};

const AgentInstanceView = ({ result }: { readonly result: PrepareAgentResult }): ReactNode => {
  const state = instanceStatePresentation[result.instance.state];
  const actionStatus = new Map(
    result.preparation.actionResults.map(({ action, status }) => [action.actionId, status]),
  );
  return (
    <>
      <section className={`instance-hero ${state.tone}`}>
        <div>
          <span className="eyebrow">
            Agent Instance {result.preparation.disposition === 'created' ? 'created' : 'reconciled'}
          </span>
          <h2>{state.label}</h2>
          <p>
            Prepare realized the canonical Build for this environment. This is readiness state, not
            runtime activity or health.
          </p>
        </div>
        <div className="instance-facts">
          <div>
            <small>Environment</small>
            <strong>{result.environment.label}</strong>
            <code>{result.environment.id}</code>
          </div>
          <div>
            <small>Runnable</small>
            <strong>{result.preparation.runnable ? 'Yes' : 'No'}</strong>
          </div>
          <div>
            <small>Disposition</small>
            <strong>{result.preparation.disposition === 'created' ? 'Created' : 'Updated'}</strong>
          </div>
        </div>
        <div className="instance-id">
          <small>Deterministic instance ID</small>
          <code>{result.instance.instanceId}</code>
        </div>
      </section>

      <section className="result-section preparation-summary">
        <div className="result-section-heading">
          <div>
            <span className="eyebrow">Preparation</span>
            <h2>Environment readiness</h2>
          </div>
          <p>
            Positive states come only from supplied evidence or successful driver actions. Published
            metadata alone is not readiness.
          </p>
        </div>
        <div className="preparation-metrics">
          <div className="positive">
            <strong>{String(result.preparation.summary.ready)}</strong>
            <span>ready actions</span>
          </div>
          <div className="warning">
            <strong>{String(result.preparation.summary.setupRequired)}</strong>
            <span>setup required</span>
          </div>
          <div className="danger">
            <strong>{String(result.preparation.summary.unavailable)}</strong>
            <span>unavailable</span>
          </div>
          <div>
            <PreparationStatusChip status={result.preparation.hostIntegration.status} />
            <span>VS Code host integration</span>
          </div>
        </div>
      </section>

      <section className="result-section prepared-capabilities">
        <div className="result-section-heading">
          <div>
            <span className="eyebrow">Capabilities</span>
            <h2>Prepared binding readiness</h2>
          </div>
          <p>Prepare preserves the exact Local, Remote, and Hybrid bindings selected by Build.</p>
        </div>
        <div className="prepared-capability-list">
          {result.readiness.capabilities.map((capability) => (
            <article className="prepared-capability" key={`${capability.id}-${capability.profile}`}>
              <div className="prepared-capability-heading">
                <div className={`binding-icon ${capability.bindingMode}`}>
                  {modePresentation[capability.bindingMode].icon}
                </div>
                <div>
                  <strong>{capability.displayName}</strong>
                  <code>
                    {capability.id} · v{capability.version} · {capability.profile}
                  </code>
                </div>
              </div>
              <div className="prepared-capability-states">
                <ReadinessChip state={capability.state} />
                <span
                  className={`instance-binding-state ${capability.instanceState.toLowerCase()}`}
                >
                  {instanceStatePresentation[capability.instanceState].label}
                </span>
              </div>
              <ul>
                {capability.requirements.map((requirement, index) => (
                  <li key={`${requirement.kind}-${String(index)}`}>
                    {readinessRequirementText(requirement)}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="result-section setup-requirements">
        <div className="result-section-heading">
          <div>
            <span className="eyebrow">Required setup</span>
            <h2>
              {result.setupRequirements.length === 0
                ? 'No unresolved actions'
                : `${String(result.setupRequirements.length)} unresolved ${result.setupRequirements.length === 1 ? 'action' : 'actions'}`}
            </h2>
          </div>
          <p>
            Setup requirements are H7 action results. They do not contain credential values,
            commands, or arbitrary filesystem targets.
          </p>
        </div>
        {result.setupRequirements.length === 0 ? (
          <div className="setup-complete">
            <Icon name="check" size={18} />
            This environment satisfies the current preparation plan.
          </div>
        ) : (
          <div className="setup-list">
            {result.setupRequirements.map((requirement) => (
              <article key={requirement.action.actionId}>
                <div>
                  <strong>{requirement.action.title}</strong>
                  <p>{setupRequirementText(requirement)}</p>
                  <code>{requirement.action.actionId}</code>
                </div>
                <PreparationStatusChip status={requirement.status} />
              </article>
            ))}
          </div>
        )}
        <details className="preparation-plan">
          <summary>
            Preparation plan · {String(result.plan.actions.length)}{' '}
            {result.plan.actions.length === 1 ? 'action' : 'actions'}
          </summary>
          <div>
            {result.plan.actions.map((action) => {
              const status = actionStatus.get(action.actionId);
              return (
                <div key={action.actionId}>
                  <span>
                    <strong>{action.title}</strong>
                    <small>{action.concern.replaceAll('-', ' ')}</small>
                  </span>
                  {status === undefined ? null : <PreparationStatusChip status={status} />}
                </div>
              );
            })}
          </div>
        </details>
      </section>

      <section className="next-step run-boundary">
        <div>
          <span className="next-step-number">05</span>
          <div>
            <span className="eyebrow">Run remains future work</span>
            <h2>No execution has occurred.</h2>
            <p>
              This Prepared Agent Instance is persisted in Builder&apos;s bounded local state and
              can be rediscovered after restart. Persistence does not make it active or runnable.
            </p>
          </div>
        </div>
        <button className="button secondary" disabled type="button">
          <Icon name="lock" size={16} />
          Run · unavailable
        </button>
      </section>
    </>
  );
};

const BuildResultView = ({
  result,
  onEdit,
  onPrepare,
  prepareError,
  prepareResult,
  preparing,
}: {
  readonly result: BuildAgentResult;
  readonly onEdit: () => void;
  readonly onPrepare: () => void;
  readonly prepareError: UiError | undefined;
  readonly prepareResult: PrepareAgentResult | undefined;
  readonly preparing: boolean;
}): ReactNode => {
  const setupMessage =
    result.readiness.setupRequired === 0
      ? 'Build requirements resolved. Preparation is still environment-specific.'
      : `${String(result.readiness.setupRequired)} ${result.readiness.setupRequired === 1 ? 'capability requires' : 'capabilities require'} setup before this composition can run.`;
  return (
    <div className="build-result">
      <section className="build-success-hero">
        <div className="success-orbit">
          <Icon name="check" size={32} />
        </div>
        <div className="success-copy">
          <span className="eyebrow">Build complete</span>
          <h1>{result.agent.name}</h1>
          <div className="agent-identity">
            <code>{result.agent.id}</code>
            <span>v{result.agent.version}</span>
            <span>{String(result.capabilities.length)} capabilities</span>
            <span>Local Agent · {executionShapeLabel(result)}</span>
          </div>
          <p>{setupMessage}</p>
          <small>
            Lock digest <code>{result.lockDigest}</code>
          </small>
        </div>
        <div className="success-actions">
          <button className="button secondary" onClick={onEdit} type="button">
            Edit definition
          </button>
          <button className="button primary" disabled={preparing} onClick={onPrepare} type="button">
            {preparing ? <span className="spinner" /> : <Icon name="bolt" size={16} />}
            {preparing
              ? 'Preparing…'
              : prepareResult === undefined
                ? 'Prepare agent'
                : 'Prepare again'}
          </button>
        </div>
      </section>

      {prepareResult === undefined ? (
        <section className="truth-banner">
          <div>
            <Icon name="layers" size={20} />
            <div>
              <strong>{preparing ? 'Preparing this exact Build' : 'Built, not prepared'}</strong>
              <span>
                {preparing
                  ? 'Agent Kit is reconciling conservative environment evidence into an Agent Instance.'
                  : 'This validated composition describes what the environment must realize. Runtime health has not been evaluated.'}
              </span>
            </div>
          </div>
          <div className="readiness-totals">
            <span>
              <strong>{String(result.readiness.ready)}</strong> ready requirements
            </span>
            <span>
              <strong>{String(result.readiness.setupRequired)}</strong> need setup
            </span>
            <span>
              <strong>{String(result.readiness.configurationRequired)}</strong> need configuration
            </span>
          </div>
        </section>
      ) : null}

      {prepareError === undefined ? null : (
        <ErrorNotice error={prepareError} title="Prepare could not complete" />
      )}
      {prepareResult === undefined ? null : <AgentInstanceView result={prepareResult} />}

      <section className="result-section capability-results">
        <div className="result-section-heading">
          <div>
            <span className="eyebrow">Capabilities</span>
            <h2>Resolved composition</h2>
          </div>
          <p>Versions, profiles, bindings, and readiness returned by Agent Kit.</p>
        </div>
        <div className="result-capability-list">
          {result.capabilities.map((capability) => (
            <CapabilityResultRow capability={capability} key={capability.id} />
          ))}
        </div>
      </section>

      <ExecutionSummary result={result} />
      <VsCodeSummary result={result} />
      <ArtifactPreview artifacts={result.artifacts} />

      {prepareResult === undefined ? (
        <section className="next-step">
          <div>
            <span className="next-step-number">03</span>
            <div>
              <span className="eyebrow">Next: Prepare</span>
              <h2>Realize this build in the local VS Code environment.</h2>
              <p>
                Builder will reconstruct and verify this exact Build, then use Agent Kit H7 to
                create an Agent Instance. Unverified artifacts, connections, configuration, provider
                prerequisites, and host files remain truthful setup requirements.
              </p>
            </div>
          </div>
          <button
            className="button secondary"
            disabled={preparing}
            onClick={onPrepare}
            type="button"
          >
            {preparing ? 'Preparing…' : 'Prepare this Build'}
          </button>
        </section>
      ) : null}
    </div>
  );
};

const BuilderPage = ({
  catalog,
  catalogState,
  draft,
  onDraftChange,
  onToggleCapability,
  onProfileChange,
  onApplyPreset,
  onSubmit,
  policyIssues,
  building,
  buildError,
  buildResult,
  onEdit,
  onPrepare,
  prepareError,
  prepareResult,
  preparing,
  instanceDiscovery,
  instanceError,
  instanceState,
  onRetryInstances,
}: {
  readonly catalog: CapabilityCatalogResponse | undefined;
  readonly catalogState: LoadState;
  readonly draft: AgentDraft;
  readonly onDraftChange: (patch: Partial<AgentDraft>) => void;
  readonly onToggleCapability: (id: string) => void;
  readonly onProfileChange: (capabilityId: string, profileId: string | undefined) => void;
  readonly onApplyPreset: () => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly policyIssues: readonly string[];
  readonly building: boolean;
  readonly buildError: UiError | undefined;
  readonly buildResult: BuildAgentResult | undefined;
  readonly onEdit: () => void;
  readonly onPrepare: () => void;
  readonly prepareError: UiError | undefined;
  readonly prepareResult: PrepareAgentResult | undefined;
  readonly preparing: boolean;
  readonly instanceDiscovery: LocalAgentInstanceDiscoveryResponse | undefined;
  readonly instanceError: UiError | undefined;
  readonly instanceState: LoadState;
  readonly onRetryInstances: () => void;
}): ReactNode => (
  <div className="page builder-page">
    <section className="builder-heading">
      <div>
        <span className="eyebrow">Agent Builder</span>
        <h1>Compose an agent from real capabilities.</h1>
        <p>
          Define intent and select capabilities. The Platform resolves the infrastructure details.
        </p>
      </div>
      <Lifecycle
        built={buildResult !== undefined}
        prepared={prepareResult !== undefined}
        preparing={preparing}
      />
    </section>
    <LocalInstancesSection
      discovery={instanceDiscovery}
      error={instanceError}
      onRetry={onRetryInstances}
      state={instanceState}
    />
    {buildResult === undefined ? (
      <div className="authoring-layout">
        <AuthoringForm
          building={building}
          catalog={catalog}
          catalogState={catalogState}
          draft={draft}
          formError={buildError}
          onApplyPreset={onApplyPreset}
          onChange={onDraftChange}
          onProfileChange={onProfileChange}
          onSubmit={onSubmit}
          onToggleCapability={onToggleCapability}
          policyIssues={policyIssues}
        />
        <DraftOverview catalog={catalog} draft={draft} />
      </div>
    ) : (
      <BuildResultView
        onEdit={onEdit}
        onPrepare={onPrepare}
        prepareError={prepareError}
        prepareResult={prepareResult}
        preparing={preparing}
        result={buildResult}
      />
    )}
  </div>
);

export const App = (): ReactNode => {
  const [page, setPage] = useState<Page>('builder');
  const [catalogState, setCatalogState] = useState<LoadState>('loading');
  const [catalog, setCatalog] = useState<CapabilityCatalogResponse>();
  const [catalogError, setCatalogError] = useState<UiError>();
  const [instanceState, setInstanceState] = useState<LoadState>('loading');
  const [instanceDiscovery, setInstanceDiscovery] = useState<LocalAgentInstanceDiscoveryResponse>();
  const [instanceError, setInstanceError] = useState<UiError>();
  const [draft, setDraft] = useState<AgentDraft>(emptyDraft);
  const [idEdited, setIdEdited] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<UiError>();
  const [buildResult, setBuildResult] = useState<BuildAgentResult>();
  const [builtDefinition, setBuiltDefinition] = useState<AgentDefinition>();
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<UiError>();
  const [prepareResult, setPrepareResult] = useState<PrepareAgentResult>();
  const buildAbort = useRef<AbortController | undefined>(undefined);
  const prepareAbort = useRef<AbortController | undefined>(undefined);
  const instancesAbort = useRef<AbortController | undefined>(undefined);

  const loadCatalog = (): void => {
    const controller = new AbortController();
    setCatalogState('loading');
    setCatalogError(undefined);
    void getCapabilityCatalog(controller.signal)
      .then((response) => {
        setCatalog(response);
        setCatalogState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCatalogError(uiError(error, 'The Capability Registry could not be loaded.'));
        setCatalogState('error');
      });
  };

  const loadInstances = (): void => {
    instancesAbort.current?.abort();
    const controller = new AbortController();
    instancesAbort.current = controller;
    setInstanceState('loading');
    setInstanceError(undefined);
    void getLocalAgentInstances(controller.signal)
      .then((response) => {
        setInstanceDiscovery(response);
        setInstanceState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInstanceError(uiError(error, 'Local Agent Instances could not be discovered.'));
        setInstanceState('error');
      })
      .finally(() => {
        if (instancesAbort.current === controller) instancesAbort.current = undefined;
      });
  };

  useEffect(() => {
    const controller = new AbortController();
    void getCapabilityCatalog(controller.signal)
      .then((response) => {
        setCatalog(response);
        setCatalogState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setCatalogError(uiError(error, 'The Capability Registry could not be loaded.'));
        setCatalogState('error');
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    instancesAbort.current = controller;
    void getLocalAgentInstances(controller.signal)
      .then((response) => {
        setInstanceDiscovery(response);
        setInstanceState('ready');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInstanceError(uiError(error, 'Local Agent Instances could not be discovered.'));
        setInstanceState('error');
      })
      .finally(() => {
        if (instancesAbort.current === controller) instancesAbort.current = undefined;
      });
    return () => controller.abort();
  }, []);

  useEffect(
    () => () => {
      buildAbort.current?.abort();
      prepareAbort.current?.abort();
      instancesAbort.current?.abort();
    },
    [],
  );

  const selectedSet = useMemo(
    () => new Set(draft.selectedCapabilityIds),
    [draft.selectedCapabilityIds],
  );
  const selectionPlan = useMemo(
    () =>
      planCapabilitySelections(
        draft.selectedCapabilityIds,
        draft.executionPolicy,
        draft.profileSelections,
        catalog,
      ),
    [catalog, draft.executionPolicy, draft.profileSelections, draft.selectedCapabilityIds],
  );

  const changeDraft = (patch: Partial<AgentDraft>): void => {
    setBuildError(undefined);
    setBuildResult(undefined);
    setBuiltDefinition(undefined);
    setPrepareError(undefined);
    setPrepareResult(undefined);
    setDraft((current) => {
      if (patch.name !== undefined && !idEdited && patch.id === undefined) {
        return { ...current, ...patch, id: deriveAgentId(patch.name) };
      }
      return { ...current, ...patch };
    });
    if (patch.id !== undefined) setIdEdited(true);
  };

  const toggleCapability = (id: string): void => {
    const next = new Set(selectedSet);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const ordered = catalog?.capabilities
      .filter((capability) => next.has(capability.id))
      .map(({ id }) => id) ?? [...next];
    changeDraft({ selectedCapabilityIds: ordered });
  };

  const changeProfile = (capabilityId: string, profileId: string | undefined): void => {
    const profileSelections: Record<string, string> = { ...draft.profileSelections };
    if (profileId === undefined) delete profileSelections[capabilityId];
    else profileSelections[capabilityId] = profileId;
    changeDraft({ profileSelections });
  };

  const applyPreset = (): void => {
    const profileSelections: Record<string, string> = {};
    for (const selection of developerOptimizationPreset.capabilities) {
      if ('profile' in selection && selection.profile !== undefined) {
        profileSelections[selection.id] = selection.profile;
      }
    }
    setIdEdited(true);
    setBuildError(undefined);
    setBuildResult(undefined);
    setBuiltDefinition(undefined);
    setPrepareError(undefined);
    setPrepareResult(undefined);
    setDraft({
      name: developerOptimizationPreset.name,
      id: developerOptimizationPreset.id,
      version: developerOptimizationPreset.version,
      instructions: developerOptimizationPreset.instructions,
      selectedCapabilityIds: developerOptimizationPreset.capabilities.map(({ id }) => id),
      executionPolicy: 'custom',
      profileSelections,
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const missing: string[] = [];
    if (draft.name.trim().length === 0) missing.push('Enter an agent name.');
    if (draft.id.trim().length === 0) missing.push('Enter or derive an agent ID.');
    if (draft.instructions.trim().length === 0) missing.push('Add agent instructions.');
    if (draft.selectedCapabilityIds.length === 0) missing.push('Select at least one capability.');
    if (selectionPlan.issues.length > 0) {
      setBuildError({
        summary: 'The execution policy cannot be applied to this composition.',
        issues: selectionPlan.issues,
      });
      return;
    }
    if (missing.length > 0) {
      setBuildError({
        code: 'INVALID_AGENT_DEFINITION',
        summary: 'Complete the required agent fields before building.',
        issues: missing,
      });
      return;
    }

    const definition: AgentDefinition = {
      schemaVersion: 1,
      id: draft.id,
      name: draft.name,
      version: draft.version,
      instructions: draft.instructions,
      capabilities: [...selectionPlan.selections],
    };
    buildAbort.current?.abort();
    prepareAbort.current?.abort();
    const controller = new AbortController();
    buildAbort.current = controller;
    setBuilding(true);
    setBuildError(undefined);
    setPrepareError(undefined);
    setPrepareResult(undefined);
    void buildAgent(definition, controller.signal)
      .then((result) => {
        setBuiltDefinition(definition);
        setBuildResult(result);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setBuildError(uiError(error, 'The agent build failed.'));
      })
      .finally(() => {
        if (buildAbort.current === controller) {
          setBuilding(false);
          buildAbort.current = undefined;
        }
      });
  };

  const prepare = (): void => {
    if (buildResult === undefined || builtDefinition === undefined) return;
    prepareAbort.current?.abort();
    const controller = new AbortController();
    prepareAbort.current = controller;
    setPreparing(true);
    setPrepareError(undefined);
    setPrepareResult(undefined);
    void prepareAgent(builtDefinition, buildResult.lockDigest, controller.signal)
      .then((result) => {
        setPrepareResult(result);
        loadInstances();
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPrepareError(uiError(error, 'The agent preparation failed.'));
      })
      .finally(() => {
        if (prepareAbort.current === controller) {
          setPreparing(false);
          prepareAbort.current = undefined;
        }
      });
  };

  const editDefinition = (): void => {
    prepareAbort.current?.abort();
    setBuildResult(undefined);
    setBuiltDefinition(undefined);
    setPrepareError(undefined);
    setPrepareResult(undefined);
    setPreparing(false);
  };

  return (
    <ProductShell onNavigate={setPage} page={page}>
      {page === 'capabilities' ? (
        <CatalogPage
          catalog={catalog}
          error={catalogError}
          onRetry={loadCatalog}
          onUseBuilder={() => setPage('builder')}
          state={catalogState}
        />
      ) : (
        <BuilderPage
          buildError={buildError}
          buildResult={buildResult}
          building={building}
          catalog={catalog}
          catalogState={catalogState}
          draft={draft}
          instanceDiscovery={instanceDiscovery}
          instanceError={instanceError}
          instanceState={instanceState}
          onApplyPreset={applyPreset}
          onDraftChange={changeDraft}
          onEdit={editDefinition}
          onPrepare={prepare}
          onProfileChange={changeProfile}
          onRetryInstances={loadInstances}
          onSubmit={submit}
          onToggleCapability={toggleCapability}
          policyIssues={selectionPlan.issues}
          prepareError={prepareError}
          prepareResult={prepareResult}
          preparing={preparing}
        />
      )}
    </ProductShell>
  );
};
