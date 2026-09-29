import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runtime from '@agent-tool-platform/runtime';
import {
  capabilityEntrySchemaId,
  capabilityRegistrySchemaVersion,
  type CapabilityEntry,
  type CapabilityRegistryReader,
} from '@agent-tool-platform/capability-registry';
import {
  buildVsCodeAgent,
  createNpmLocalArtifactPreparationDriver,
  createPreparedArtifactRealization,
  isMaterializableResolvedNpmArtifact,
  prepareAgent,
  preparedArtifactRealizationSchema,
  type PreparationAction,
  type PreparationDriver,
  type PreparationDriverRequest,
  type PreparationDriverResult,
  type PreparedArtifactRealization,
} from '@agent-tool-platform/agent-kit';
import {
  buildChildEnvironment,
  materializeNpmLocalArtifact,
  npmArtifactLayoutIdentity,
  runBoundedProcess,
  type NpmArtifactMaterializationOptions,
  type NpmLocalArtifactSpec,
} from '@agent-tool-platform/runtime';
import { runNpmLocalArtifactConformance } from '@agent-tool-platform/testkit';

const fixtureRoot = fileURLToPath(new URL('./fixtures/local-artifact-package', import.meta.url));
const gitRevision = 'a'.repeat(40);
const sha256 = `sha256:${'a'.repeat(64)}` as const;
const canonicalFixtureIntegrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`;
const temporaryRoots: string[] = [];

const temporaryRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const npmCliPath = (): string => {
  const path = process.env['npm_execpath'];
  if (path === undefined) throw new Error('npm_execpath is required for materializer tests');
  return path;
};

interface PackedFixture {
  readonly archivePath: string;
  readonly integrity: string;
}

const packFixture = async (
  packageRoot: string = fixtureRoot,
  base?: string,
): Promise<PackedFixture> => {
  const root = base ?? (await temporaryRoot('atp-artifact-pack-'));
  const destination = join(root, 'archive');
  await mkdir(destination, { recursive: true });
  execFileSync(
    process.execPath,
    [
      npmCliPath(),
      'pack',
      packageRoot,
      '--ignore-scripts',
      `--pack-destination=${destination}`,
      '--loglevel=error',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'));
  expect(archives).toHaveLength(1);
  const archivePath = join(destination, archives[0]!);
  const integrity = `sha512-${createHash('sha512')
    .update(await readFile(archivePath))
    .digest('base64')}`;
  return { archivePath, integrity };
};

const specFor = (integrity: string): NpmLocalArtifactSpec => ({
  packageName: '@agent-tool-platform/local-artifact-fixture',
  version: '1.2.3',
  binName: 'agent-tool-local-artifact-fixture',
  integrity,
  lifecycleScripts: 'forbidden',
});

interface FixtureIdentity {
  readonly id: string;
  readonly displayName: string;
  readonly packageName: string;
  readonly binName: string;
  readonly sourceCapabilityId: string;
}

const defaultFixtureIdentity: FixtureIdentity = {
  id: 'local-artifact-fixture',
  displayName: 'Local Artifact Fixture',
  packageName: '@agent-tool-platform/local-artifact-fixture',
  binName: 'agent-tool-local-artifact-fixture',
  sourceCapabilityId: 'io.github.ashergarland/local-artifact-fixture',
};

const entryFor = (
  integrity: string,
  identity: FixtureIdentity = defaultFixtureIdentity,
): CapabilityEntry => ({
  $schema: capabilityEntrySchemaId,
  schemaVersion: capabilityRegistrySchemaVersion,
  kind: 'capability',
  id: identity.id,
  displayName: identity.displayName,
  description: 'Immutable npm local artifact fixture.',
  publisher: {
    id: 'agent-tool-platform',
    displayName: 'Agent Tool Platform',
    url: 'https://github.com/ashergarland',
  },
  version: { value: '1.2.3', status: 'released' },
  artifacts: [
    {
      id: 'npm-package',
      kind: 'npm',
      identifier: identity.packageName,
      version: '1.2.3',
      availability: 'published',
      reference: 'v1.2.3',
      localExecution: {
        schemaVersion: 1,
        kind: 'node-package-bin',
        bin: identity.binName,
        integrity,
        lifecycleScripts: 'forbidden',
      },
    },
  ],
  links: {
    repository: 'https://github.com/ashergarland/agent-tool-platform',
    documentation: 'https://github.com/ashergarland/agent-tool-platform#readme',
  },
  category: { id: 'test-fixture', displayName: 'Test Fixture' },
  tags: ['test-fixture'],
  toolCount: 1,
  profiles: [
    {
      id: 'local-package',
      description: 'Local package execution over stdio.',
      source: 'registry-curated',
      dimensions: {
        execution: 'local',
        delivery: 'package',
        access: 'local-process',
        workload: 'none',
        provider: 'none',
        mutation: 'read-only',
      },
      permissions: {
        summary: 'Execute the immutable local fixture.',
        scopes: ['process-execute'],
      },
      prerequisites: {
        setupRequired: false,
        summary: 'Requires only the exact materialized npm artifact.',
        requiredSecrets: [],
        provider: [],
      },
      readiness: {
        signals: ['process'],
        summary: 'Ready after exact artifact verification.',
      },
      stateEffects: [],
    },
  ],
  bindings: [
    {
      id: 'local-stdio',
      profileId: 'local-package',
      artifactId: 'npm-package',
      interface: 'stdio',
      availability: 'local',
    },
  ],
  stateChanging: false,
  routing: { summary: 'Use only for local artifact contract tests.' },
  conformance: {
    status: 'verified',
    checks: ['mcp-metadata', 'routing-metadata', 'runtime-contract'],
  },
  source: {
    capabilityId: identity.sourceCapabilityId,
    repository: 'https://github.com/ashergarland/agent-tool-platform',
    revision: gitRevision,
    metadataVersion: '1.2.3',
    releaseTag: 'v1.2.3',
    metadata: {
      server: 'server.json',
      package: 'package.json',
    },
  },
});

const readerFor = (...entries: readonly CapabilityEntry[]): CapabilityRegistryReader => ({
  listCapabilities: () => entries,
  getCapability: (id) => entries.find((entry) => entry.id === id),
  listProfiles: (id) => entries.find((entry) => entry.id === id)?.profiles,
  listBindings: (id) => entries.find((entry) => entry.id === id)?.bindings,
});

const definition = {
  schemaVersion: 1,
  id: 'local-artifact-agent',
  name: 'Local Artifact Agent',
  version: '1.0.0',
  instructions: 'Use the exact prepared local capability.',
  capabilities: [{ id: 'local-artifact-fixture', version: '1.2.3' }],
} as const;

const secondaryFixtureIdentity: FixtureIdentity = {
  id: 'local-artifact-fixture-secondary',
  displayName: 'Secondary Local Artifact Fixture',
  packageName: '@agent-tool-platform/local-artifact-fixture-secondary',
  binName: 'agent-tool-local-artifact-fixture-secondary',
  sourceCapabilityId: 'io.github.ashergarland/local-artifact-fixture-secondary',
};

const buildFixtureAgent = async (
  integrity: string,
  identities: readonly FixtureIdentity[] = [defaultFixtureIdentity],
) => {
  const entries = identities.map((identity) => entryFor(integrity, identity));
  return buildVsCodeAgent(
    {
      ...definition,
      capabilities: identities.map((identity) => ({
        id: identity.id,
        version: '1.2.3' as const,
      })),
    },
    { registry: readerFor(...entries) },
  );
};

const materializationOptions = (
  root: string,
  archivePath: string,
): NpmArtifactMaterializationOptions => ({
  root,
  npmCliPath: npmCliPath(),
  source: { kind: 'archive', path: archivePath },
});

const executePreparedLaunch = async (
  realization: ReturnType<typeof createPreparedArtifactRealization>,
): Promise<string> => {
  const result = await runBoundedProcess({
    executablePath: realization.launch.executablePath,
    label: 'prepared local artifact',
    args: [realization.launch.entrypointPath],
    cwd: dirname(realization.launch.entrypointPath),
    env: buildChildEnvironment({
      pathEntries: [dirname(realization.launch.executablePath)],
      tempDir: dirname(realization.launch.entrypointPath),
    }),
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
    maxStderrBytes: 8 * 1024,
  });
  expect(result.code).toBe(0);
  return result.stdout;
};

type LocalArtifactPreparationAction = Extract<
  PreparationAction,
  { readonly kind: 'verify-local-artifact' | 'make-local-artifact-available' }
>;

interface MutableLocalArtifactAction {
  binding: { key: string };
  artifact: {
    identifier: string;
    version: string;
    localExecution?: {
      bin: string;
      integrity?: string;
      lifecycleScripts: string;
    };
  };
}

const fakeRealizationFor = (
  action: LocalArtifactPreparationAction,
): PreparedArtifactRealization => {
  if (!isMaterializableResolvedNpmArtifact(action.artifact)) {
    throw new Error('expected a materializable npm artifact action');
  }
  return createPreparedArtifactRealization({
    binding: action.binding,
    artifact: action.artifact,
    disposition: 'newly-materialized',
    materialization: {
      kind: 'npm',
      layout: npmArtifactLayoutIdentity({
        packageName: action.artifact.identifier,
        version: action.artifact.version,
        binName: action.artifact.localExecution.bin,
        integrity: action.artifact.localExecution.integrity,
        lifecycleScripts: action.artifact.localExecution.lifecycleScripts,
      }),
    },
    launch: {
      kind: 'node',
      executablePath: process.execPath,
      entrypointPath: join(
        parse(process.execPath).root,
        'agent-tool-platform-artifacts',
        `${action.binding.capabilityId}.mjs`,
      ),
    },
    verification: {
      status: 'verified',
      integrity: action.artifact.localExecution.integrity,
      installationDigest: `sha256:${createHash('sha256').update(action.actionId).digest('hex')}`,
      fileCount: 1,
      totalBytes: 1,
    },
  });
};

type HostPreparationRequest = Extract<
  PreparationDriverRequest,
  { readonly action: { readonly kind: 'prepare-host-integration' } }
>;

const driverWithFakeRealizations = (
  prepareHost: (request: HostPreparationRequest) => PreparationDriverResult,
): PreparationDriver => ({
  execute: async (request) => {
    if (
      request.action.kind === 'verify-local-artifact' ||
      request.action.kind === 'make-local-artifact-available'
    ) {
      return {
        status: 'success',
        artifactRealization: fakeRealizationFor(request.action),
      };
    }
    if ('artifactRealizations' in request) {
      return prepareHost(request);
    }
    return { status: 'setup-required' };
  },
});

describe('npm local artifact materializer', () => {
  it('passes reusable idempotence, launch, lifecycle, confinement, and corruption conformance', async () => {
    const packed = await packFixture();
    const root = await temporaryRoot('atp-artifact-conformance-');
    const expectedOutput = JSON.stringify({
      name: '@agent-tool-platform/local-artifact-fixture',
      version: '1.2.3',
    });

    const result = await runNpmLocalArtifactConformance({
      spec: specFor(packed.integrity),
      materialization: materializationOptions(root, packed.archivePath),
      expectedOutput,
      lifecycleMarkerName: 'install-ran.txt',
    });

    expect(result.failures).toEqual([]);
  }, 30_000);

  it('stops conformance before executing or corrupting an escaped entrypoint', async () => {
    const packed = await packFixture();
    const root = await temporaryRoot('atp-artifact-conformance-escape-');
    const outsideRoot = await temporaryRoot('atp-artifact-conformance-outside-');
    const outsideEntrypoint = join(outsideRoot, 'outside.mjs');
    const outsideContents = 'throw new Error("escaped entrypoint must not execute");\n';
    await writeFile(outsideEntrypoint, outsideContents, 'utf8');
    const actualVerify = runtime.verifyNpmLocalArtifact;
    vi.spyOn(runtime, 'verifyNpmLocalArtifact').mockImplementation(async (...args) => {
      const verified = await actualVerify(...args);
      return {
        ...verified,
        launch: { ...verified.launch, entrypointPath: outsideEntrypoint },
      };
    });
    const execution = vi
      .spyOn(runtime, 'runBoundedProcess')
      .mockRejectedValue(new Error('escaped entrypoint execution was not gated'));

    const result = await runNpmLocalArtifactConformance({
      spec: specFor(packed.integrity),
      materialization: materializationOptions(root, packed.archivePath),
      throwOnFailure: false,
    });

    expect(result.failures.map((failure) => failure.name)).toEqual([
      'the verified entrypoint stays beneath the consumer root',
    ]);
    expect(execution).not.toHaveBeenCalled();
    expect(await readFile(outsideEntrypoint, 'utf8')).toBe(outsideContents);
  }, 30_000);

  it('converges concurrent same-identity materialization on one verified layout', async () => {
    const packed = await packFixture();
    const root = await temporaryRoot('atp-artifact-concurrent-');
    const options = materializationOptions(root, packed.archivePath);
    const results = await Promise.all([
      materializeNpmLocalArtifact(specFor(packed.integrity), options),
      materializeNpmLocalArtifact(specFor(packed.integrity), options),
    ]);

    expect(results.map((result) => result.disposition).sort()).toEqual([
      'already-materialized',
      'materialized',
    ]);
    expect(results[0]?.layout).toBe(results[1]?.layout);
    expect(results[0]?.verification.installationDigest).toBe(
      results[1]?.verification.installationDigest,
    );
  }, 30_000);

  it('rejects integrity mismatches and unsafe package bin targets without committing a layout', async () => {
    const packed = await packFixture();
    const mismatchRoot = await temporaryRoot('atp-artifact-mismatch-');
    await expect(
      materializeNpmLocalArtifact(
        specFor(`sha512-${'A'.repeat(86)}==`),
        materializationOptions(mismatchRoot, packed.archivePath),
      ),
    ).rejects.toMatchObject({
      name: 'NpmArtifactMaterializationError',
      code: 'integrity-mismatch',
    });
    const boundedRoot = await temporaryRoot('atp-artifact-bounded-');
    await expect(
      materializeNpmLocalArtifact(specFor(packed.integrity), {
        ...materializationOptions(boundedRoot, packed.archivePath),
        limits: { maxArchiveBytes: 1 },
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });

    const badFixtureRoot = await temporaryRoot('atp-artifact-bad-bin-');
    const badPackage = join(badFixtureRoot, 'package');
    await cp(fixtureRoot, badPackage, { recursive: true });
    const packageDocument = JSON.parse(
      await readFile(join(badPackage, 'package.json'), 'utf8'),
    ) as Record<string, unknown>;
    packageDocument.bin = {
      'agent-tool-local-artifact-fixture': '../outside.mjs',
    };
    await writeFile(
      join(badPackage, 'package.json'),
      `${JSON.stringify(packageDocument, null, 2)}\n`,
      'utf8',
    );
    const badPacked = await packFixture(badPackage, badFixtureRoot);
    const confinedRoot = await temporaryRoot('atp-artifact-confined-');
    await expect(
      materializeNpmLocalArtifact(
        specFor(badPacked.integrity),
        materializationOptions(confinedRoot, badPacked.archivePath),
      ),
    ).rejects.toMatchObject({
      name: 'NpmArtifactMaterializationError',
      code: 'corrupt-installation',
    });
    await expect(access(join(confinedRoot, 'outside.mjs'))).rejects.toBeDefined();
    await expect(
      access(
        join(confinedRoot, ...npmArtifactLayoutIdentity(specFor(badPacked.integrity)).split('/')),
      ),
    ).rejects.toBeDefined();
  });

  it('derives one portable layout identity and refuses a filesystem root', async () => {
    const packed = await packFixture();
    const spec = specFor(packed.integrity);
    expect(npmArtifactLayoutIdentity(spec)).toBe(npmArtifactLayoutIdentity({ ...spec }));
    expect(
      npmArtifactLayoutIdentity({
        ...spec,
        integrity: `sha512-${'A'.repeat(86)}==`,
      }),
    ).not.toBe(npmArtifactLayoutIdentity(spec));

    await expect(
      materializeNpmLocalArtifact(spec, {
        ...materializationOptions(parse(process.cwd()).root, packed.archivePath),
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });

    const privateRegistryRoot = await temporaryRoot('atp-artifact-private-registry-');
    await expect(
      materializeNpmLocalArtifact(spec, {
        root: privateRegistryRoot,
        npmCliPath: npmCliPath(),
        source: { kind: 'registry', registryUrl: 'http://localhost:4873/' },
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('rejects malformed, wrong-length, and noncanonical SHA-512 SRI', () => {
    const canonical =
      'sha512-KLP86c/Ylp+oqCTVHuZdHwql2GX4Xfai59UEXUjWrFpzq/l1vMlMPWz44jFgXNaavAmiVl07y73oplVwnKXRxw==';
    const noncanonicalAlias =
      'sha512-KLP86c/Ylp+oqCTVHuZdHwql2GX4Xfai59UEXUjWrFpzq/l1vMlMPWz44jFgXNaavAmiVl07y73oplVwnKXRxx==';
    expect(Buffer.from(canonical.slice(7), 'base64')).toEqual(
      Buffer.from(noncanonicalAlias.slice(7), 'base64'),
    );
    expect(() => npmArtifactLayoutIdentity(specFor(canonical))).not.toThrow();
    expect(() => npmArtifactLayoutIdentity(specFor('sha512-not-base64'))).toThrow(/integrity/iu);
    expect(() => npmArtifactLayoutIdentity(specFor(`sha512-${'A'.repeat(84)}`))).toThrow(
      /integrity/iu,
    );
    expect(() => npmArtifactLayoutIdentity(specFor(noncanonicalAlias))).toThrow(/integrity/iu);
  });

  it.runIf(process.platform === 'win32')(
    'rejects current-drive-rooted Windows materialization roots',
    async () => {
      const packed = await packFixture();
      await expect(
        materializeNpmLocalArtifact(specFor(packed.integrity), {
          ...materializationOptions('\\atp-root', packed.archivePath),
        }),
      ).rejects.toMatchObject({ code: 'invalid-input' });
    },
  );

  it('bounds HTTPS registry redirects and archive bytes through an injectable network seam', async () => {
    const packed = await packFixture();
    const archive = await readFile(packed.archivePath);
    const metadata = JSON.stringify({
      name: '@agent-tool-platform/local-artifact-fixture',
      version: '1.2.3',
      dist: {
        integrity: packed.integrity,
        tarball: 'https://registry.example/local-artifact-fixture.tgz',
        unpackedSize: 1_024,
        fileCount: 3,
      },
    });
    const requests: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      requests.push(url);
      return url.endsWith('.tgz')
        ? new Response(archive, {
            status: 200,
            headers: { 'content-length': String(archive.byteLength) },
          })
        : new Response(metadata, {
            status: 200,
            headers: { 'content-length': String(Buffer.byteLength(metadata)) },
          });
    };
    const root = await temporaryRoot('atp-artifact-fetched-');
    const result = await materializeNpmLocalArtifact(specFor(packed.integrity), {
      root,
      npmCliPath: npmCliPath(),
      source: { kind: 'registry', registryUrl: 'https://registry.example/' },
      fetch,
    });

    expect(result.disposition).toBe('materialized');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain('%40agent-tool-platform%2Flocal-artifact-fixture');
    expect(requests[1]).toBe('https://registry.example/local-artifact-fixture.tgz');

    const redirectRoot = await temporaryRoot('atp-artifact-redirect-');
    let redirectCount = 0;
    const redirectingFetch: typeof globalThis.fetch = async () => {
      redirectCount += 1;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://registry.example/redirect' },
      });
    };
    await expect(
      materializeNpmLocalArtifact(specFor(packed.integrity), {
        root: redirectRoot,
        npmCliPath: npmCliPath(),
        source: { kind: 'registry', registryUrl: 'https://registry.example/' },
        fetch: redirectingFetch,
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
    expect(redirectCount).toBe(6);

    const privateRoot = await temporaryRoot('atp-artifact-private-registry-');
    await expect(
      materializeNpmLocalArtifact(specFor(packed.integrity), {
        root: privateRoot,
        npmCliPath: npmCliPath(),
        source: { kind: 'registry', registryUrl: 'https://127.0.0.1/' },
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(requests).toHaveLength(2);
    await expect(
      materializeNpmLocalArtifact(specFor(packed.integrity), {
        root: privateRoot,
        npmCliPath: npmCliPath(),
        source: { kind: 'registry', registryUrl: 'https://[::ffff:127.0.0.1]/' },
        fetch,
      }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(requests).toHaveLength(2);

    const oversizedRoot = await temporaryRoot('atp-artifact-oversized-');
    const oversizedFetch: typeof globalThis.fetch = async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      return url.endsWith('.tgz')
        ? new Response(archive, {
            status: 200,
            headers: { 'content-length': String(archive.byteLength) },
          })
        : new Response(metadata, { status: 200 });
    };
    await expect(
      materializeNpmLocalArtifact(specFor(packed.integrity), {
        root: oversizedRoot,
        npmCliPath: npmCliPath(),
        source: { kind: 'registry', registryUrl: 'https://registry.example/' },
        fetch: oversizedFetch,
        limits: { maxArchiveBytes: archive.byteLength - 1 },
      }),
    ).rejects.toMatchObject({ code: 'limit-exceeded' });
  }, 30_000);
});

describe('Agent Kit prepared artifact realization', () => {
  it('materializes once, verifies on repeat, supplies the host seam, and makes H7 READY', async () => {
    const packed = await packFixture();
    const root = await temporaryRoot('atp-artifact-h7-');
    const entry = entryFor(packed.integrity);
    const build = await buildVsCodeAgent(definition, { registry: readerFor(entry) });
    const repeatedBuild = await buildVsCodeAgent(definition, { registry: readerFor(entry) });
    const localDriver = createNpmLocalArtifactPreparationDriver(
      materializationOptions(root, packed.archivePath),
    );
    let preparedMcp: unknown;
    const execute = vi.fn<PreparationDriver['execute']>(async (request) => {
      if (
        request.action.kind === 'verify-local-artifact' ||
        request.action.kind === 'make-local-artifact-available'
      ) {
        return localDriver.execute(request);
      }
      if (request.action.kind === 'prepare-host-integration') {
        if (!('generatedHostFiles' in request)) {
          throw new Error('missing host integration request payload');
        }
        const mcpFile = request.generatedHostFiles.find((file) => file.path === '.vscode/mcp.json');
        if (mcpFile === undefined) throw new Error('missing VS Code MCP output');
        const document = JSON.parse(mcpFile.content) as {
          servers: Record<string, { command: string; args: string[]; type: 'stdio' }>;
        };
        expect(document.servers['local-artifact-fixture']).toEqual({
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@agent-tool-platform/local-artifact-fixture@1.2.3'],
        });
        const realization = request.artifactRealizations[0];
        if (realization !== undefined) {
          document.servers['local-artifact-fixture'] = {
            type: 'stdio',
            command: realization.launch.executablePath,
            args: [realization.launch.entrypointPath],
          };
        }
        preparedMcp = document;
        const consumedArtifactRealizationIds = request.artifactRealizations.map(
          (candidate) => candidate.realizationId,
        );
        return consumedArtifactRealizationIds.length === 0
          ? { status: 'success' }
          : { status: 'success', consumedArtifactRealizationIds };
      }
      return { status: 'success' };
    });
    const driver: PreparationDriver = { execute };
    const clock = { now: () => new Date('2026-09-28T20:00:00.000Z') };

    const first = await prepareAgent(build, {
      environmentId: 'artifact-proof',
      readinessSnapshot: { schemaVersion: 1 },
      driver,
      clock,
    });

    expect(build.lock.schemaVersion).toBe(3);
    expect(build.lockText).toBe(repeatedBuild.lockText);
    expect(build.lockText).toContain(packed.integrity);
    expect(build.lockText).toContain('agent-tool-local-artifact-fixture');
    expect(build.lockText).not.toContain(root);
    expect(first.plan.actions.map((action) => action.kind)).toEqual([
      'make-local-artifact-available',
      'prepare-host-integration',
    ]);
    expect(first.artifactRealizations).toHaveLength(1);
    expect(first.artifactRealizations[0]?.disposition).toBe('newly-materialized');
    expect(first.instance.state).toBe('READY');
    expect(first.instance.bindings[0]?.state).toBe('READY');
    expect(first.runnable).toBe(true);
    expect(first.setupRequirements).toEqual([]);
    expect(JSON.stringify(first.instance)).not.toContain(root);
    expect(JSON.stringify(first.instance)).not.toContain(packed.integrity);
    expect(preparedMcp).toEqual({
      servers: {
        'local-artifact-fixture': {
          type: 'stdio',
          command: first.artifactRealizations[0]?.launch.executablePath,
          args: [first.artifactRealizations[0]?.launch.entrypointPath],
        },
      },
    });
    expect(JSON.stringify(preparedMcp)).not.toContain('npx');
    expect(await executePreparedLaunch(first.artifactRealizations[0]!)).toBe(
      JSON.stringify({
        name: '@agent-tool-platform/local-artifact-fixture',
        version: '1.2.3',
      }),
    );

    const bindingKey = build.capabilities[0]!.binding.key;
    const second = await prepareAgent(build, {
      environmentId: 'artifact-proof',
      readinessSnapshot: {
        schemaVersion: 1,
        availableLocalBindings: [bindingKey],
      },
      driver,
      existingInstance: first.instance,
      clock: { now: () => new Date('2026-09-28T21:00:00.000Z') },
    });

    expect(second.plan.actions.map((action) => action.kind)).toEqual([
      'verify-local-artifact',
      'prepare-host-integration',
    ]);
    expect(second.actionResults[0]).toMatchObject({ status: 'already-ready' });
    expect(second.artifactRealizations[0]?.disposition).toBe('already-materialized');
    expect(second.artifactRealizations[0]?.realizationId).toBe(
      first.artifactRealizations[0]?.realizationId,
    );
    expect(second.instance.state).toBe('READY');
    expect(second.disposition).toBe('updated');
  });

  it('does not accept claimed snapshot availability without exact verified evidence', async () => {
    const packed = await packFixture();
    const entry = entryFor(packed.integrity);
    const build = await buildVsCodeAgent(definition, { registry: readerFor(entry) });
    const result = await prepareAgent(build, {
      environmentId: 'artifact-proof',
      readinessSnapshot: {
        schemaVersion: 1,
        availableLocalBindings: [build.capabilities[0]!.binding.key],
      },
      driver: {
        execute: async (request) =>
          request.action.kind === 'prepare-host-integration'
            ? { status: 'success' }
            : { status: 'setup-required' },
      },
      clock: { now: () => new Date('2026-09-28T20:00:00.000Z') },
    });

    expect(result.plan.actions[0]?.kind).toBe('verify-local-artifact');
    expect(result.actionResults[0]?.status).toBe('setup-required');
    expect(result.instance.state).toBe('NEEDS_SETUP');
    expect(result.runnable).toBe(false);
    expect(result.artifactRealizations).toEqual([]);
  });

  it('rejects status-only artifact success and host integration that ignores a realization', async () => {
    const packed = await packFixture();
    const entry = entryFor(packed.integrity);
    const build = await buildVsCodeAgent(definition, { registry: readerFor(entry) });

    await expect(
      prepareAgent(build, {
        environmentId: 'artifact-proof',
        readinessSnapshot: { schemaVersion: 1 },
        driver: { execute: async () => ({ status: 'success' }) },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PREPARATION_RESULT' });

    const root = await temporaryRoot('atp-artifact-unconsumed-');
    const localDriver = createNpmLocalArtifactPreparationDriver(
      materializationOptions(root, packed.archivePath),
    );
    const ignoringHostDriver: PreparationDriver = {
      execute: async (request) =>
        request.action.kind === 'verify-local-artifact' ||
        request.action.kind === 'make-local-artifact-available'
          ? localDriver.execute(request)
          : { status: 'success' },
    };
    await expect(
      prepareAgent(build, {
        environmentId: 'artifact-proof',
        readinessSnapshot: { schemaVersion: 1 },
        driver: ignoringHostDriver,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PREPARATION_RESULT' });
  }, 30_000);

  it.each([
    {
      name: 'binding identity',
      mutate: (action: MutableLocalArtifactAction) => {
        action.binding.key = 'mutated@1.2.3#local-package';
      },
    },
    {
      name: 'package identity',
      mutate: (action: MutableLocalArtifactAction) => {
        action.artifact.identifier = '@agent-tool-platform/mutated-fixture';
      },
    },
    {
      name: 'artifact version',
      mutate: (action: MutableLocalArtifactAction) => {
        action.artifact.version = '1.2.4';
      },
    },
    {
      name: 'selected bin',
      mutate: (action: MutableLocalArtifactAction) => {
        if (action.artifact.localExecution === undefined) throw new Error('missing execution');
        action.artifact.localExecution.bin = 'agent-tool-mutated-fixture';
      },
    },
    {
      name: 'artifact SRI',
      mutate: (action: MutableLocalArtifactAction) => {
        if (action.artifact.localExecution === undefined) throw new Error('missing execution');
        action.artifact.localExecution.integrity = `sha512-${Buffer.alloc(64, 7).toString(
          'base64',
        )}`;
      },
    },
  ])(
    'rejects a driver that mutates the planned $name and returns self-consistent evidence',
    async ({ mutate }) => {
      const build = await buildFixtureAgent(canonicalFixtureIntegrity);
      const lockText = build.lockText;
      const driver: PreparationDriver = {
        execute: async (request) => {
          if (
            request.action.kind === 'verify-local-artifact' ||
            request.action.kind === 'make-local-artifact-available'
          ) {
            mutate(request.action as unknown as MutableLocalArtifactAction);
            return {
              status: 'success',
              artifactRealization: fakeRealizationFor(request.action),
            };
          }
          return { status: 'success' };
        },
      };

      await expect(
        prepareAgent(build, {
          environmentId: 'artifact-proof',
          readinessSnapshot: { schemaVersion: 1 },
          driver,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_PREPARATION_RESULT' });
      expect(build.lockText).toBe(lockText);
    },
  );

  it('rejects a driver that mutates the locked lifecycle policy', async () => {
    const build = await buildFixtureAgent(canonicalFixtureIntegrity);
    const driver: PreparationDriver = {
      execute: async (request) => {
        if (
          request.action.kind === 'verify-local-artifact' ||
          request.action.kind === 'make-local-artifact-available'
        ) {
          const original = fakeRealizationFor(request.action);
          const mutableAction = request.action as unknown as {
            artifact: { localExecution: { lifecycleScripts: string } };
          };
          mutableAction.artifact.localExecution.lifecycleScripts = 'allowed';
          return {
            status: 'success',
            artifactRealization: {
              ...original,
              artifact: structuredClone(request.action.artifact),
            } as unknown as PreparedArtifactRealization,
          };
        }
        return { status: 'success' };
      },
    };

    await expect(
      prepareAgent(build, {
        environmentId: 'artifact-proof',
        readinessSnapshot: { schemaVersion: 1 },
        driver,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PREPARATION_RESULT' });
  });

  it('accepts one exact host realization acknowledgement', async () => {
    const build = await buildFixtureAgent(canonicalFixtureIntegrity);
    const result = await prepareAgent(build, {
      environmentId: 'artifact-proof',
      readinessSnapshot: { schemaVersion: 1 },
      driver: driverWithFakeRealizations((request) => ({
        status: 'success',
        consumedArtifactRealizationIds: request.artifactRealizations.map(
          (realization) => realization.realizationId,
        ),
      })),
    });

    expect(result.instance.state).toBe('READY');
    expect(result.artifactRealizations).toHaveLength(1);
  });

  it('accepts exact host acknowledgement independent of request order', async () => {
    const build = await buildFixtureAgent(canonicalFixtureIntegrity, [
      defaultFixtureIdentity,
      secondaryFixtureIdentity,
    ]);
    const result = await prepareAgent(build, {
      environmentId: 'artifact-proof',
      readinessSnapshot: { schemaVersion: 1 },
      driver: driverWithFakeRealizations((request) => {
        const mutableRealizations = request.artifactRealizations as PreparedArtifactRealization[];
        mutableRealizations.reverse();
        return {
          status: 'success',
          consumedArtifactRealizationIds: mutableRealizations.map(
            (realization) => realization.realizationId,
          ),
        };
      }),
    });

    expect(result.instance.state).toBe('READY');
    expect(result.artifactRealizations).toHaveLength(2);
  });

  it.each([
    {
      name: 'duplicate acknowledgement',
      acknowledge: (ids: readonly string[]) => [ids[0]!, ids[0]!],
    },
    {
      name: 'unknown acknowledgement',
      acknowledge: () => [`sha256:${'f'.repeat(64)}`],
    },
    {
      name: 'missing acknowledgements',
      acknowledge: () => [],
    },
    {
      name: 'one missing acknowledgement',
      acknowledge: (ids: readonly string[]) => [ids[0]!],
    },
    {
      name: 'extra acknowledgement',
      acknowledge: (ids: readonly string[]) => [...ids, `sha256:${'f'.repeat(64)}`],
    },
  ])('rejects host $name', async ({ acknowledge }) => {
    const build = await buildFixtureAgent(canonicalFixtureIntegrity, [
      defaultFixtureIdentity,
      secondaryFixtureIdentity,
    ]);
    await expect(
      prepareAgent(build, {
        environmentId: 'artifact-proof',
        readinessSnapshot: { schemaVersion: 1 },
        driver: driverWithFakeRealizations((request) => ({
          status: 'success',
          consumedArtifactRealizationIds: acknowledge(
            request.artifactRealizations.map((realization) => realization.realizationId),
          ),
        })),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PREPARATION_RESULT' });
  });

  it('retains the host expected set when the driver clears or replaces request aliases', async () => {
    const build = await buildFixtureAgent(canonicalFixtureIntegrity);
    await expect(
      prepareAgent(build, {
        environmentId: 'artifact-proof',
        readinessSnapshot: { schemaVersion: 1 },
        driver: driverWithFakeRealizations((request) => {
          (request.artifactRealizations as PreparedArtifactRealization[]).splice(0);
          return { status: 'success' };
        }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PREPARATION_RESULT' });

    const replacementBuild = await buildFixtureAgent(canonicalFixtureIntegrity);
    const result = await prepareAgent(replacementBuild, {
      environmentId: 'artifact-proof',
      readinessSnapshot: { schemaVersion: 1 },
      driver: driverWithFakeRealizations((request) => {
        const originalIds = request.artifactRealizations.map(
          (realization) => realization.realizationId,
        );
        const mutable = request.artifactRealizations as PreparedArtifactRealization[];
        mutable[0] = {
          ...mutable[0]!,
          realizationId: `sha256:${'f'.repeat(64)}`,
        };
        return {
          status: 'success',
          consumedArtifactRealizationIds: originalIds,
        };
      }),
    });

    expect(result.instance.state).toBe('READY');
    expect(result.artifactRealizations[0]?.realizationId).not.toBe(`sha256:${'f'.repeat(64)}`);
  });

  it('maps an exact integrity failure to UNAVAILABLE instead of false readiness', async () => {
    const packed = await packFixture();
    const root = await temporaryRoot('atp-artifact-h7-mismatch-');
    const entry = entryFor(`sha512-${'A'.repeat(86)}==`);
    const build = await buildVsCodeAgent(definition, { registry: readerFor(entry) });
    const driver = createNpmLocalArtifactPreparationDriver(
      materializationOptions(root, packed.archivePath),
    );
    const result = await prepareAgent(build, {
      environmentId: 'artifact-proof',
      readinessSnapshot: { schemaVersion: 1 },
      driver,
      hostIntegration: 'available',
      clock: { now: () => new Date('2026-09-28T20:00:00.000Z') },
    });

    expect(result.actionResults[0]).toMatchObject({
      status: 'unavailable',
      reason: 'artifact-integrity-mismatch',
    });
    expect(result.instance.state).toBe('UNAVAILABLE');
    expect(result.runnable).toBe(false);
  });

  it('models Windows and Linux launch paths without shell argv or platform shim guessing', () => {
    const integrity = `sha512-${'A'.repeat(86)}==`;
    const artifact = {
      id: 'npm-package',
      kind: 'npm',
      identifier: '@agent-tool-platform/local-artifact-fixture',
      version: '1.2.3',
      availability: 'published',
      reference: 'v1.2.3',
      sourceRevision: gitRevision,
      localExecution: {
        schemaVersion: 1,
        kind: 'node-package-bin',
        bin: 'agent-tool-local-artifact-fixture',
        integrity,
        lifecycleScripts: 'forbidden',
      },
    } as const;
    const common = {
      binding: {
        key: 'local-artifact-fixture@1.2.3#local-package',
        capabilityId: 'local-artifact-fixture',
        capabilityVersion: '1.2.3',
        profileId: 'local-package',
        mode: 'local',
      },
      artifact,
      disposition: 'already-materialized',
      materialization: {
        kind: 'npm',
        layout: npmArtifactLayoutIdentity({
          packageName: artifact.identifier,
          version: artifact.version,
          binName: artifact.localExecution.bin,
          integrity: artifact.localExecution.integrity,
          lifecycleScripts: artifact.localExecution.lifecycleScripts,
        }),
      },
      verification: {
        status: 'verified',
        integrity,
        installationDigest: sha256,
        fileCount: 1,
        totalBytes: 1,
      },
    } as const;
    const windows = createPreparedArtifactRealization({
      ...common,
      launch: {
        kind: 'node',
        executablePath: 'C:\\Program Files\\nodejs\\node.exe',
        entrypointPath: 'C:\\artifact-root\\package\\bin\\fixture.mjs',
      },
    });
    const linux = createPreparedArtifactRealization({
      ...common,
      launch: {
        kind: 'node',
        executablePath: '/usr/bin/node',
        entrypointPath: '/artifact-root/package/bin/fixture.mjs',
      },
    });

    expect(preparedArtifactRealizationSchema.safeParse(windows).success).toBe(true);
    expect(preparedArtifactRealizationSchema.safeParse(linux).success).toBe(true);
    expect('args' in windows.launch).toBe(false);
    expect('command' in windows.launch).toBe(false);
    expect(() =>
      createPreparedArtifactRealization({
        ...common,
        materialization: {
          kind: 'npm',
          layout: `artifacts/npm/sha256-${'b'.repeat(64)}`,
        },
        launch: windows.launch,
      }),
    ).toThrow(/invalid/u);
  });
});
