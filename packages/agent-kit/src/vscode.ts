import { compareCodeUnits, serializeCanonicalJson } from './canonical-json.js';
import { AgentKitError } from './errors.js';
import type { HostAdapter, HostAdapterGenerationInput, HostCompatibility } from './host-adapter.js';
import type { ResolvedCapabilityArtifact } from './schemas.js';

export const VSCODE_ADAPTER_SCHEMA_VERSION = 1;

export interface VsCodeAdapterOutput {
  readonly hostId: 'vscode';
  readonly schemaVersion: typeof VSCODE_ADAPTER_SCHEMA_VERSION;
  readonly files: readonly [
    {
      readonly path: string;
      readonly mediaType: 'text/markdown';
      readonly content: string;
    },
    {
      readonly path: '.vscode/mcp.json';
      readonly mediaType: 'application/json';
      readonly content: string;
    },
  ];
}

const isIdentifierCharacter = (character: string): boolean =>
  (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9');

/**
 * Collapses runs of characters outside `[a-z0-9]` into a single hyphen with a single linear scan.
 * Registry-derived capability ids and configuration names are uncontrolled input, so this avoids
 * the regex-based collapse-then-trim pattern CodeQL flags as a polynomial ReDoS risk; unlike a
 * regex, this makes no backtracking decisions and always runs in time proportional to the input
 * length. `lowercase` is a caller choice rather than a default so ids already validated as
 * lowercase (capability/agent ids) are not silently rewritten, matching the prior regex behavior
 * where only the input-id helper folded case.
 *
 * Exported only for direct regression testing of this internal normalizer; it is intentionally
 * not part of the package's public barrel (`index.ts`).
 */
export const collapseToHyphens = (value: string, lowercase: boolean): string => {
  let result = '';
  let pendingHyphen = false;
  for (const rawCharacter of value) {
    const character = lowercase ? rawCharacter.toLowerCase() : rawCharacter;
    if (isIdentifierCharacter(character)) {
      if (pendingHyphen) {
        result += '-';
        pendingHyphen = false;
      }
      result += character;
    } else {
      pendingHyphen = true;
    }
  }
  return result;
};

/** Trims leading and/or trailing hyphens with a linear scan. Exported for the same reason as
 * {@link collapseToHyphens}. */
export const trimHyphens = (value: string, leading: boolean, trailing: boolean): string => {
  let start = 0;
  let end = value.length;
  if (leading) {
    while (start < end && value[start] === '-') start += 1;
  }
  if (trailing) {
    while (end > start && value[end - 1] === '-') end -= 1;
  }
  return value.slice(start, end);
};

export const hostId = (capabilityId: string): string =>
  trimHyphens(collapseToHyphens(capabilityId, false), true, true);

export const inputId = (serverId: string, value: string): string =>
  trimHyphens(`${serverId}-${collapseToHyphens(value, true)}`, false, true);

const packageCommand = (
  artifact: Pick<ResolvedCapabilityArtifact, 'availability' | 'identifier' | 'version'>,
): { readonly command: string; readonly args: readonly string[] } => ({
  command: 'npx',
  args: [
    artifact.availability === 'published' ? '-y' : '--offline',
    `${artifact.identifier}@${artifact.version}`,
  ],
});

const evaluateVsCode = ({
  profile,
  binding,
  artifact,
}: Parameters<HostAdapter['evaluate']>[0]): HostCompatibility => {
  const reasons: string[] = [];
  if (binding.availability === 'remote') {
    if (binding.interface !== 'http') {
      reasons.push('hosted profiles must expose an HTTP entrypoint for VS Code');
    }
    if (profile.prerequisites.requiredSecrets.length > 0) {
      reasons.push(
        'authenticated HTTP bindings require a registry-defined client header mapping that is not available',
      );
    }
  } else {
    if (binding.interface !== 'stdio') {
      reasons.push('local and hybrid profiles must expose a stdio entrypoint for VS Code');
    }
    if (artifact.kind === 'source') {
      reasons.push('VS Code requires an npm or OCI launch artifact');
    }
  }
  return reasons.length === 0
    ? { state: 'compatible', reasons: [] }
    : { state: 'incompatible', reasons };
};

interface VsCodeInput {
  readonly type: 'promptString';
  readonly id: string;
  readonly description: string;
  readonly password?: boolean;
}

type VsCodeServer =
  | {
      readonly type: 'stdio';
      readonly command: string;
      readonly args: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    }
  | {
      readonly type: 'http';
      readonly url: string;
    };

const localServer = (
  artifact: ResolvedCapabilityArtifact,
  environment: Readonly<Record<string, string>>,
): VsCodeServer => {
  if (artifact.kind === 'npm') {
    const command = packageCommand(artifact);
    return {
      type: 'stdio',
      ...command,
      ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
    };
  }
  if (artifact.kind === 'oci') {
    const forwardedEnvironment = Object.keys(environment)
      .sort()
      .flatMap((name) => ['--env', name]);
    return {
      type: 'stdio',
      command: 'docker',
      args: [
        'run',
        '--rm',
        '-i',
        artifact.availability === 'published' ? '--pull=missing' : '--pull=never',
        ...forwardedEnvironment,
        `${artifact.identifier}:${artifact.version}`,
      ],
      ...(Object.keys(environment).length === 0 ? {} : { env: environment }),
    };
  }
  throw new AgentKitError(
    'INCOMPATIBLE_BINDING',
    'VS Code cannot launch a source artifact without an environment-specific prepared path.',
  );
};

const generateVsCode = (input: HostAdapterGenerationInput): VsCodeAdapterOutput => {
  const inputs: VsCodeInput[] = [];
  const servers: Record<string, VsCodeServer> = {};
  const toolNames: string[] = [];
  const usedServerIds = new Set<string>();
  const usedInputIds = new Set<string>();

  for (const capability of input.capabilities) {
    const serverId = hostId(capability.capability.id);
    if (usedServerIds.has(serverId)) {
      throw new AgentKitError(
        'INVALID_REGISTRY_RECORD',
        `Capabilities map to duplicate VS Code server id ${serverId}.`,
      );
    }
    usedServerIds.add(serverId);
    toolNames.push(`${serverId}/*`);

    if (capability.binding.mode === 'remote') {
      const endpointInputId = `${serverId}-endpoint`;
      if (usedInputIds.has(endpointInputId)) {
        throw new AgentKitError(
          'INVALID_REGISTRY_RECORD',
          `Capabilities map to duplicate VS Code input id ${endpointInputId}.`,
        );
      }
      usedInputIds.add(endpointInputId);
      inputs.push({
        type: 'promptString',
        id: endpointInputId,
        description: `${capability.capability.displayName} MCP endpoint`,
      });
      servers[serverId] = {
        type: 'http',
        url: `\${input:${endpointInputId}}`,
      };
      continue;
    }

    const environment: Record<string, string> = {};
    for (const secretName of capability.binding.requiredSecretNames) {
      const secretInputId = inputId(serverId, secretName);
      if (usedInputIds.has(secretInputId)) {
        throw new AgentKitError(
          'INVALID_REGISTRY_RECORD',
          `Configuration names map to duplicate VS Code input id ${secretInputId}.`,
        );
      }
      usedInputIds.add(secretInputId);
      inputs.push({
        type: 'promptString',
        id: secretInputId,
        description: `${capability.capability.displayName}: ${secretName}`,
        password: true,
      });
      environment[secretName] = `\${input:${secretInputId}}`;
    }
    servers[serverId] = localServer(capability.binding.artifact, environment);
  }

  const frontmatter = [
    '---',
    `name: ${JSON.stringify(input.definition.name)}`,
    `description: ${JSON.stringify(`${input.definition.name}, composed by Agent Tool Platform.`)}`,
    `tools: ${JSON.stringify(toolNames.sort())}`,
    'target: vscode',
    '---',
  ].join('\n');
  const agentContent = `${frontmatter}\n\n<!-- agent.lock ${input.lockDigest} -->\n\n${input.instructions.rendered}\n`;
  const mcpContent = serializeCanonicalJson({
    ...(inputs.length === 0
      ? {}
      : {
          inputs: inputs.sort((left, right) => compareCodeUnits(left.id, right.id)),
        }),
    servers,
  });
  const agentPath = `.github/agents/${hostId(input.definition.id)}.agent.md`;

  return {
    hostId: 'vscode',
    schemaVersion: VSCODE_ADAPTER_SCHEMA_VERSION,
    files: [
      { path: agentPath, mediaType: 'text/markdown', content: agentContent },
      { path: '.vscode/mcp.json', mediaType: 'application/json', content: mcpContent },
    ],
  };
};

export const vscodeHostAdapter: HostAdapter<VsCodeAdapterOutput> = {
  id: 'vscode',
  schemaVersion: VSCODE_ADAPTER_SCHEMA_VERSION,
  evaluate: evaluateVsCode,
  generate: generateVsCode,
};
