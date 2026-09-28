import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { buildChildEnvironment } from '../process/child-environment.js';
import { runBoundedProcess } from '../process/run.js';

const manifestName = '.agent-tool-platform-artifact.json';
const materializationSchemaVersion = 1;
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const executableNamePattern = /^[a-z0-9][a-z0-9._-]*$/u;
const integrityPattern = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const sha256Pattern = /^sha256:[0-9a-f]{64}$/u;
const layoutPattern = /^artifacts\/npm\/sha256-[0-9a-f]{64}$/u;

export const npmArtifactMaterializationErrorCodes = [
  'invalid-input',
  'not-materialized',
  'corrupt-installation',
  'integrity-mismatch',
  'limit-exceeded',
  'materialization-failed',
] as const;

export type NpmArtifactMaterializationErrorCode =
  (typeof npmArtifactMaterializationErrorCodes)[number];

export class NpmArtifactMaterializationError extends Error {
  public override readonly name = 'NpmArtifactMaterializationError';

  public constructor(
    public readonly code: NpmArtifactMaterializationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface NpmLocalArtifactSpec {
  readonly packageName: string;
  readonly version: string;
  readonly binName: string;
  readonly integrity: string;
  readonly lifecycleScripts: 'forbidden';
}

export type NpmArtifactSource =
  | {
      readonly kind: 'registry';
      readonly registryUrl?: string;
    }
  | {
      readonly kind: 'archive';
      readonly path: string;
    };

export interface NpmArtifactMaterializationLimits {
  readonly maxArchiveBytes: number;
  readonly maxInstalledBytes: number;
  readonly maxFileCount: number;
  readonly maxPathLength: number;
  readonly maxMetadataBytes: number;
  readonly downloadTimeoutMs: number;
  readonly materializationTimeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxStderrBytes: number;
}

export interface NpmArtifactMaterializationOptions {
  readonly root: string;
  readonly source?: NpmArtifactSource;
  readonly npmCliPath?: string;
  readonly nodeExecutablePath?: string;
  readonly limits?: Partial<NpmArtifactMaterializationLimits>;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof globalThis.fetch;
}

export interface NpmArtifactMaterializationResult {
  readonly disposition: 'materialized' | 'already-materialized';
  readonly identityDigest: `sha256:${string}`;
  readonly layout: string;
  readonly launch: {
    readonly kind: 'node';
    readonly executablePath: string;
    readonly entrypointPath: string;
  };
  readonly verification: {
    readonly status: 'verified';
    readonly integrity: string;
    readonly installationDigest: `sha256:${string}`;
    readonly fileCount: number;
    readonly totalBytes: number;
  };
}

const maximumLimits: NpmArtifactMaterializationLimits = {
  maxArchiveBytes: 100 * 1024 * 1024,
  maxInstalledBytes: 500 * 1024 * 1024,
  maxFileCount: 50_000,
  maxPathLength: 1_024,
  maxMetadataBytes: 1024 * 1024,
  downloadTimeoutMs: 120_000,
  materializationTimeoutMs: 300_000,
  maxOutputBytes: 1024 * 1024,
  maxStderrBytes: 64 * 1024,
};

const manifestSchema = z.strictObject({
  schemaVersion: z.literal(materializationSchemaVersion),
  kind: z.literal('npm-local-artifact'),
  identity: z.strictObject({
    packageName: z.string(),
    version: z.string(),
    binName: z.string(),
    integrity: z.string(),
    lifecycleScripts: z.literal('forbidden'),
  }),
  identityDigest: z.string().regex(sha256Pattern),
  layout: z.string().regex(layoutPattern),
  packagePath: z.string().min(1).max(maximumLimits.maxPathLength),
  entrypointPath: z.string().min(1).max(maximumLimits.maxPathLength),
  verification: z.strictObject({
    installationDigest: z.string().regex(sha256Pattern),
    fileCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  }),
});

type MaterializationManifest = z.infer<typeof manifestSchema>;

const packageManifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]),
});

const fail = (
  code: NpmArtifactMaterializationErrorCode,
  message: string,
  cause?: unknown,
): never => {
  throw new NpmArtifactMaterializationError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
};

const compareCodeUnits = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const normalizeLimits = (
  input: Partial<NpmArtifactMaterializationLimits> | undefined,
): NpmArtifactMaterializationLimits => {
  const limits = { ...maximumLimits };
  for (const key of Object.keys(maximumLimits) as (keyof NpmArtifactMaterializationLimits)[]) {
    const value = input?.[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail('invalid-input', `Materialization limit ${key} must be a positive safe integer.`);
    }
    limits[key] = Math.min(value, maximumLimits[key]);
  }
  return limits;
};

const normalizeSpec = (input: NpmLocalArtifactSpec): NpmLocalArtifactSpec => {
  if (
    typeof input !== 'object' ||
    input === null ||
    !packageNamePattern.test(input.packageName) ||
    input.packageName.length > 214
  ) {
    return fail('invalid-input', 'The npm package identity is invalid.');
  }
  if (!semanticVersionPattern.test(input.version) || input.version.length > 200) {
    return fail('invalid-input', 'The npm package version must be exact.');
  }
  if (!executableNamePattern.test(input.binName) || input.binName.length > 100) {
    return fail('invalid-input', 'The npm executable selection is invalid.');
  }
  if (!integrityPattern.test(input.integrity) || input.integrity.length > 95) {
    return fail('invalid-input', 'The npm artifact integrity is invalid.');
  }
  if (input.lifecycleScripts !== 'forbidden') {
    return fail('invalid-input', 'The v1 npm materializer requires forbidden lifecycle scripts.');
  }
  return {
    packageName: input.packageName,
    version: input.version,
    binName: input.binName,
    integrity: input.integrity,
    lifecycleScripts: 'forbidden',
  };
};

const identityFor = (
  spec: NpmLocalArtifactSpec,
): { readonly digest: `sha256:${string}`; readonly layout: string } => {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: materializationSchemaVersion,
        kind: 'npm-local-artifact',
        packageName: spec.packageName,
        version: spec.version,
        binName: spec.binName,
        integrity: spec.integrity,
        lifecycleScripts: spec.lifecycleScripts,
      }),
    )
    .digest('hex');
  return {
    digest: `sha256:${digest}`,
    layout: `artifacts/npm/sha256-${digest}`,
  };
};

export const npmArtifactLayoutIdentity = (input: NpmLocalArtifactSpec): string =>
  identityFor(normalizeSpec(input)).layout;

const isWithin = (root: string, candidate: string, includeRoot = false): boolean => {
  const fromRoot = relative(root, candidate);
  return (
    (includeRoot && fromRoot === '') ||
    (fromRoot !== '' &&
      fromRoot !== '..' &&
      !fromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(fromRoot))
  );
};

const prepareRoot = async (input: string, create: boolean): Promise<string> => {
  if (
    typeof input !== 'string' ||
    input.length === 0 ||
    input.length > 4_096 ||
    input.includes('\0') ||
    !isAbsolute(input) ||
    input.startsWith('\\\\') ||
    input.startsWith('//')
  ) {
    return fail('invalid-input', 'The materialization root must be an absolute local path.');
  }
  const resolved = resolve(input);
  if (resolved === parse(resolved).root) {
    return fail('invalid-input', 'The materialization root must not be a filesystem root.');
  }
  if (create) await mkdir(resolved, { recursive: true });

  let metadata;
  try {
    metadata = await lstat(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!create && (code === 'ENOENT' || code === 'ENOTDIR')) {
      return fail('not-materialized', 'The local artifact root does not exist.');
    }
    return fail('invalid-input', 'The materialization root is not usable.', error);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    return fail('invalid-input', 'The materialization root must be a real directory.');
  }
  return realpath(resolved);
};

const ensureDirectory = async (root: string, path: string): Promise<void> => {
  if (!isWithin(root, path)) {
    return fail('invalid-input', 'A derived materialization path escaped its root.');
  }
  await mkdir(path, { recursive: true });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    return fail('corrupt-installation', 'A materialization layout component is not a directory.');
  }
  if (!isWithin(root, await realpath(path))) {
    return fail('corrupt-installation', 'A materialization layout component escaped its root.');
  }
};

const publicHttpsUrl = (value: string, label: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    return fail('invalid-input', `${label} is invalid.`, error);
  }
  const hostname = url.hostname.toLowerCase().replace(/\.+$/u, '');
  const address = hostname.replace(/^\[|\]$/gu, '');
  if (
    url.protocol !== 'https:' ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.includes('.privatelink.') ||
    /^(?:0|10|127|169\.254|192\.168)\./u.test(address) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./u.test(address) ||
    address === '::' ||
    address === '::1' ||
    address.startsWith('::ffff:') ||
    /^f[cd][0-9a-f]{2}:/u.test(address) ||
    /^fe[89ab][0-9a-f]:/u.test(address)
  ) {
    return fail('invalid-input', `${label} must be a public HTTPS URL.`);
  }
  return url;
};

const normalizedRegistryUrl = (input: string | undefined): string => {
  const url = publicHttpsUrl(input ?? 'https://registry.npmjs.org/', 'The npm registry URL');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
};

const executableFile = async (input: string, label: string): Promise<string> => {
  if (!isAbsolute(input) || input.length > 4_096 || input.includes('\0')) {
    return fail('invalid-input', `${label} must be an absolute file path.`);
  }
  try {
    const canonical = await realpath(input);
    const metadata = await stat(canonical);
    if (!metadata.isFile()) return fail('invalid-input', `${label} must be a regular file.`);
    return canonical;
  } catch (error) {
    return fail('invalid-input', `${label} is not usable.`, error);
  }
};

const readBoundedText = async (path: string, maxBytes: number): Promise<string> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    return fail('corrupt-installation', 'Artifact metadata must be a regular file.');
  }
  if (metadata.size > maxBytes) {
    return fail('limit-exceeded', 'Artifact metadata exceeds its configured limit.');
  }
  return readFile(path, 'utf8');
};

const hashFile = async (
  path: string,
  algorithm: 'sha256' | 'sha512',
  maxBytes: number,
): Promise<{ readonly digest: string; readonly bytes: number }> => {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) return fail('corrupt-installation', 'Expected a regular file.');
    if (metadata.size > maxBytes) {
      return fail('limit-exceeded', 'Artifact content exceeds its configured byte limit.');
    }
    const hash = createHash(algorithm);
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (!Buffer.isBuffer(chunk)) {
        return fail('corrupt-installation', 'Artifact file streams must emit buffers.');
      }
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        return fail('limit-exceeded', 'Artifact content exceeds its configured byte limit.');
      }
      hash.update(chunk);
    }
    return { digest: hash.digest(algorithm === 'sha512' ? 'base64' : 'hex'), bytes };
  } finally {
    await handle.close();
  }
};

const verifyArchiveIntegrity = async (
  path: string,
  expectedIntegrity: string,
  limits: NpmArtifactMaterializationLimits,
): Promise<void> => {
  const hashed = await hashFile(path, 'sha512', limits.maxArchiveBytes);
  if (`sha512-${hashed.digest}` !== expectedIntegrity) {
    return fail('integrity-mismatch', 'The npm package archive does not match locked integrity.');
  }
};

const copyArchive = async (
  source: string,
  destination: string,
  limits: NpmArtifactMaterializationLimits,
): Promise<void> => {
  if (!isAbsolute(source) || source.length > 4_096 || source.includes('\0')) {
    return fail('invalid-input', 'The npm package archive path must be absolute.');
  }
  const sourceMetadata = await lstat(source).catch((error: unknown) =>
    fail('invalid-input', 'The npm package archive is not readable.', error),
  );
  if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
    return fail('invalid-input', 'The npm package archive must be a regular non-symlink file.');
  }
  if (sourceMetadata.size > limits.maxArchiveBytes) {
    return fail('limit-exceeded', 'The npm package archive exceeds its configured byte limit.');
  }

  const sourceHandle = await open(source, 'r');
  const destinationHandle = await open(destination, 'wx', 0o600);
  try {
    let bytes = 0;
    for await (const chunk of sourceHandle.createReadStream({ autoClose: false })) {
      if (!Buffer.isBuffer(chunk)) {
        return fail('materialization-failed', 'The npm package archive stream is invalid.');
      }
      bytes += chunk.byteLength;
      if (bytes > limits.maxArchiveBytes) {
        return fail('limit-exceeded', 'The npm package archive exceeds its configured byte limit.');
      }
      let offset = 0;
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await destinationHandle.write(
          chunk,
          offset,
          chunk.byteLength - offset,
          null,
        );
        if (bytesWritten === 0) {
          return fail('materialization-failed', 'The npm package archive copy made no progress.');
        }
        offset += bytesWritten;
      }
    }
  } finally {
    await Promise.all([sourceHandle.close(), destinationHandle.close()]);
  }
};

interface NpmCommandContext {
  readonly npmCliPath: string;
  readonly nodeExecutablePath: string;
  readonly cwd: string;
  readonly cachePath: string;
  readonly userConfigPath: string;
  readonly globalConfigPath: string;
  readonly limits: NpmArtifactMaterializationLimits;
  readonly signal: AbortSignal | undefined;
}

const runNpmCommand = async (
  context: NpmCommandContext,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> => {
  const environment = buildChildEnvironment({
    pathEntries: [dirname(context.nodeExecutablePath)],
    tempDir: context.cwd,
    extra: {
      npm_config_cache: context.cachePath,
      npm_config_userconfig: context.userConfigPath,
      npm_config_globalconfig: context.globalConfigPath,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_ignore_scripts: 'true',
      npm_config_update_notifier: 'false',
    },
  });
  const result = await runBoundedProcess({
    executablePath: context.nodeExecutablePath,
    label: 'npm',
    args: [context.npmCliPath, ...args],
    cwd: context.cwd,
    env: environment,
    timeoutMs,
    maxOutputBytes: context.limits.maxOutputBytes,
    maxStderrBytes: context.limits.maxStderrBytes,
    signal: context.signal,
  }).catch((error: unknown) =>
    fail('materialization-failed', 'The bounded npm subprocess could not start.', error),
  );
  if (
    result.code !== 0 ||
    result.timedOut ||
    result.aborted ||
    result.outputLimitReached ||
    result.stoppedEarly
  ) {
    return fail('materialization-failed', 'The bounded npm subprocess did not complete safely.');
  }
  return result.stdout;
};

interface RegistryFetchContext {
  readonly fetch: typeof globalThis.fetch;
  readonly limits: NpmArtifactMaterializationLimits;
  readonly signal: AbortSignal | undefined;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maximumRedirects = 5;

const discardResponseBody = async (response: Response): Promise<void> => {
  try {
    await response.body?.cancel();
  } catch (error) {
    return fail('materialization-failed', 'The npm HTTPS response could not be discarded.', error);
  }
};

const fetchWithRedirects = async (
  initialUrl: URL,
  accept: string,
  context: RegistryFetchContext,
): Promise<Response> => {
  let currentUrl = initialUrl;
  const timeoutSignal = AbortSignal.timeout(context.limits.downloadTimeoutMs);
  const signal =
    context.signal === undefined ? timeoutSignal : AbortSignal.any([context.signal, timeoutSignal]);

  for (let redirects = 0; redirects <= maximumRedirects; redirects += 1) {
    let response: Response;
    try {
      response = await context.fetch(currentUrl, {
        headers: { accept },
        redirect: 'manual',
        signal,
      });
    } catch (error) {
      return fail('materialization-failed', 'The bounded npm HTTPS request failed.', error);
    }
    if (!redirectStatuses.has(response.status)) {
      if (!response.ok) {
        await discardResponseBody(response);
        return fail('materialization-failed', 'The npm HTTPS request returned an error status.');
      }
      return response;
    }
    await discardResponseBody(response);
    if (redirects === maximumRedirects) {
      return fail('limit-exceeded', 'The npm HTTPS request exceeded its redirect limit.');
    }
    const location = response.headers.get('location');
    if (location === null) {
      return fail('materialization-failed', 'The npm HTTPS redirect has no location.');
    }
    currentUrl = publicHttpsUrl(new URL(location, currentUrl).toString(), 'The npm redirect URL');
  }
  return fail('materialization-failed', 'The npm HTTPS request could not be completed.');
};

const boundedResponseBytes = async (response: Response, maxBytes: number): Promise<Buffer> => {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      return fail('materialization-failed', 'The npm HTTPS response length is invalid.');
    }
    if (length > maxBytes) {
      return fail('limit-exceeded', 'The npm HTTPS response exceeds its byte limit.');
    }
  }
  if (response.body === null) {
    return fail('materialization-failed', 'The npm HTTPS response has no body.');
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const value: unknown = result.value;
      if (!(value instanceof Uint8Array)) {
        return fail('materialization-failed', 'The npm HTTPS response stream is invalid.');
      }
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        return fail('limit-exceeded', 'The npm HTTPS response exceeds its byte limit.');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
};

const downloadArchive = async (
  response: Response,
  archivePath: string,
  expectedIntegrity: string,
  maxBytes: number,
): Promise<void> => {
  const archive = await boundedResponseBytes(response, maxBytes);
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  if (integrity !== expectedIntegrity) {
    return fail('integrity-mismatch', 'The npm package archive does not match locked integrity.');
  }
  await writeFile(archivePath, archive, { flag: 'wx', mode: 0o600 });
};

const registryArchive = async (
  spec: NpmLocalArtifactSpec,
  source: Extract<NpmArtifactSource, { readonly kind: 'registry' }>,
  archivePath: string,
  context: RegistryFetchContext,
): Promise<void> => {
  const registryUrl = normalizedRegistryUrl(source.registryUrl);
  const metadataUrl = new URL(
    `${encodeURIComponent(spec.packageName)}/${encodeURIComponent(spec.version)}`,
    registryUrl,
  );
  const metadataResponse = await fetchWithRedirects(metadataUrl, 'application/json', context);
  const metadataBytes = await boundedResponseBytes(
    metadataResponse,
    context.limits.maxMetadataBytes,
  );

  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataBytes.toString('utf8'));
  } catch (error) {
    return fail('materialization-failed', 'The npm registry metadata response is invalid.', error);
  }
  const parsedMetadata = z
    .object({
      name: z.string(),
      version: z.string(),
      dist: z.object({
        integrity: z.string(),
        tarball: z.string(),
        unpackedSize: z.number().int().nonnegative(),
        fileCount: z.number().int().nonnegative(),
      }),
    })
    .safeParse(metadata);
  if (
    !parsedMetadata.success ||
    parsedMetadata.data.name !== spec.packageName ||
    parsedMetadata.data.version !== spec.version
  ) {
    return fail('materialization-failed', 'The npm registry metadata response is incomplete.');
  }
  if (parsedMetadata.data.dist.integrity !== spec.integrity) {
    return fail('integrity-mismatch', 'The npm registry does not match locked artifact integrity.');
  }
  if (parsedMetadata.data.dist.unpackedSize > context.limits.maxInstalledBytes) {
    return fail('limit-exceeded', 'The npm package exceeds its unpacked-size limit.');
  }
  if (parsedMetadata.data.dist.fileCount > context.limits.maxFileCount) {
    return fail('limit-exceeded', 'The npm package exceeds its file-count limit.');
  }

  const tarballUrl = publicHttpsUrl(parsedMetadata.data.dist.tarball, 'The npm tarball URL');
  const archiveResponse = await fetchWithRedirects(tarballUrl, 'application/octet-stream', context);
  await downloadArchive(
    archiveResponse,
    archivePath,
    spec.integrity,
    context.limits.maxArchiveBytes,
  );
};

const packagePathFor = (workspace: string, packageName: string): string =>
  join(workspace, 'node_modules', ...packageName.split('/'));

const portableRelativePath = (root: string, path: string): string => {
  if (!isWithin(root, path)) {
    return fail('corrupt-installation', 'An installed artifact path escaped its layout.');
  }
  return relative(root, path).split(sep).join('/');
};

const packageBinTarget = (
  packageName: string,
  bin: string | Record<string, string>,
  binName: string,
): string | undefined => {
  if (typeof bin === 'string') {
    const impliedName = packageName.slice(packageName.lastIndexOf('/') + 1);
    return impliedName === binName ? bin : undefined;
  }
  return bin[binName];
};

const inspectInstalledPackage = async (
  workspace: string,
  spec: NpmLocalArtifactSpec,
  limits: NpmArtifactMaterializationLimits,
): Promise<{ readonly packagePath: string; readonly entrypointPath: string }> => {
  const packagePath = packagePathFor(workspace, spec.packageName);
  const packageMetadata = await lstat(packagePath).catch((error: unknown) =>
    fail('corrupt-installation', 'The exact npm package is not installed.', error),
  );
  if (packageMetadata.isSymbolicLink() || !packageMetadata.isDirectory()) {
    return fail('corrupt-installation', 'The npm package installation is not a real directory.');
  }
  const manifestPath = join(packagePath, 'package.json');
  const document = await readBoundedText(manifestPath, limits.maxMetadataBytes);
  let manifest: unknown;
  try {
    manifest = JSON.parse(document);
  } catch (error) {
    return fail('corrupt-installation', 'The installed npm package metadata is invalid.', error);
  }
  const parsedManifest = packageManifestSchema.safeParse(manifest);
  if (
    !parsedManifest.success ||
    parsedManifest.data.name !== spec.packageName ||
    parsedManifest.data.version !== spec.version
  ) {
    return fail('corrupt-installation', 'The installed npm package identity is not exact.');
  }
  const target = packageBinTarget(parsedManifest.data.name, parsedManifest.data.bin, spec.binName);
  if (
    target === undefined ||
    target.length === 0 ||
    target.length > limits.maxPathLength ||
    target.includes('\0') ||
    target.includes('\\') ||
    target.startsWith('/') ||
    /^[A-Za-z]:/u.test(target) ||
    /(?:^|\/)\.\.(?:\/|$)/u.test(target)
  ) {
    return fail('corrupt-installation', 'The exact npm bin target is missing or unsafe.');
  }
  const entrypointPath = resolve(packagePath, target);
  if (!isWithin(packagePath, entrypointPath)) {
    return fail('corrupt-installation', 'The exact npm bin target escaped its package.');
  }
  const entrypointMetadata = await lstat(entrypointPath).catch((error: unknown) =>
    fail('corrupt-installation', 'The exact npm bin target is unavailable.', error),
  );
  if (entrypointMetadata.isSymbolicLink() || !entrypointMetadata.isFile()) {
    return fail('corrupt-installation', 'The exact npm bin target must be a regular file.');
  }
  const canonicalEntrypoint = await realpath(entrypointPath);
  if (!isWithin(await realpath(packagePath), canonicalEntrypoint)) {
    return fail('corrupt-installation', 'The exact npm bin target escaped its package.');
  }
  return { packagePath, entrypointPath: canonicalEntrypoint };
};

interface TreeEvidence {
  readonly installationDigest: `sha256:${string}`;
  readonly fileCount: number;
  readonly totalBytes: number;
}

const installationEvidence = async (
  workspace: string,
  limits: NpmArtifactMaterializationLimits,
): Promise<TreeEvidence> => {
  const records: string[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  const visit = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    );
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      const relativePath = portableRelativePath(workspace, absolutePath);
      if (relativePath === manifestName) continue;
      if (relativePath.length > limits.maxPathLength) {
        return fail('limit-exceeded', 'An installed artifact path exceeds its configured limit.');
      }
      fileCount += 1;
      if (fileCount > limits.maxFileCount) {
        return fail('limit-exceeded', 'The installation exceeds its configured file-count limit.');
      }
      if (entry.isDirectory()) {
        records.push(`D\0${relativePath}`);
        await visit(absolutePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        if (target.length > limits.maxPathLength) {
          return fail(
            'limit-exceeded',
            'An installed symlink target exceeds its configured limit.',
          );
        }
        const canonicalTarget = await realpath(absolutePath).catch((error: unknown) =>
          fail('corrupt-installation', 'An installed symlink target is invalid.', error),
        );
        if (!isWithin(workspace, canonicalTarget)) {
          return fail('corrupt-installation', 'An installed symlink escapes its layout.');
        }
        records.push(`L\0${relativePath}\0${target}`);
        continue;
      }
      if (!entry.isFile()) {
        return fail('corrupt-installation', 'The installation contains an unsupported file type.');
      }
      const remaining = limits.maxInstalledBytes - totalBytes;
      const hashed = await hashFile(absolutePath, 'sha256', remaining);
      totalBytes += hashed.bytes;
      if (totalBytes > limits.maxInstalledBytes) {
        return fail('limit-exceeded', 'The installation exceeds its configured byte limit.');
      }
      records.push(`F\0${relativePath}\0${String(hashed.bytes)}\0${hashed.digest}`);
    }
  };

  await visit(workspace);
  const digest = createHash('sha256').update(records.join('\n')).digest('hex');
  return {
    installationDigest: `sha256:${digest}`,
    fileCount,
    totalBytes,
  };
};

const resultFor = async (
  root: string,
  spec: NpmLocalArtifactSpec,
  identity: ReturnType<typeof identityFor>,
  nodeExecutablePath: string,
  limits: NpmArtifactMaterializationLimits,
  disposition: NpmArtifactMaterializationResult['disposition'],
): Promise<NpmArtifactMaterializationResult> => {
  const workspace = join(root, ...identity.layout.split('/'));
  const workspaceMetadata = await lstat(workspace).catch((error: unknown) =>
    fail('not-materialized', 'The exact local artifact is not materialized.', error),
  );
  if (workspaceMetadata.isSymbolicLink() || !workspaceMetadata.isDirectory()) {
    return fail('corrupt-installation', 'The materialized artifact layout is invalid.');
  }
  const manifestText = await readBoundedText(
    join(workspace, manifestName),
    limits.maxMetadataBytes,
  );
  let manifestDocument: unknown;
  try {
    manifestDocument = JSON.parse(manifestText);
  } catch (error) {
    return fail('corrupt-installation', 'The materialized artifact manifest is invalid.', error);
  }
  const parsedManifest = manifestSchema.safeParse(manifestDocument);
  if (!parsedManifest.success) {
    return fail('corrupt-installation', 'The materialized artifact manifest is malformed.');
  }
  const manifest = parsedManifest.data;
  if (
    manifest.identity.packageName !== spec.packageName ||
    manifest.identity.version !== spec.version ||
    manifest.identity.binName !== spec.binName ||
    manifest.identity.integrity !== spec.integrity ||
    manifest.identity.lifecycleScripts !== spec.lifecycleScripts ||
    manifest.identityDigest !== identity.digest ||
    manifest.layout !== identity.layout
  ) {
    return fail('corrupt-installation', 'The materialized artifact identity does not match.');
  }
  const installed = await inspectInstalledPackage(workspace, spec, limits);
  if (
    manifest.packagePath !== portableRelativePath(workspace, installed.packagePath) ||
    manifest.entrypointPath !== portableRelativePath(workspace, installed.entrypointPath)
  ) {
    return fail('corrupt-installation', 'The materialized executable identity does not match.');
  }
  const evidence = await installationEvidence(workspace, limits);
  if (
    evidence.installationDigest !== manifest.verification.installationDigest ||
    evidence.fileCount !== manifest.verification.fileCount ||
    evidence.totalBytes !== manifest.verification.totalBytes
  ) {
    return fail(
      'corrupt-installation',
      'The materialized artifact failed corruption verification.',
    );
  }
  return {
    disposition,
    identityDigest: identity.digest,
    layout: identity.layout,
    launch: {
      kind: 'node',
      executablePath: nodeExecutablePath,
      entrypointPath: installed.entrypointPath,
    },
    verification: {
      status: 'verified',
      integrity: spec.integrity,
      ...evidence,
    },
  };
};

const verificationContext = async (
  input: NpmLocalArtifactSpec,
  options: NpmArtifactMaterializationOptions,
  createRoot: boolean,
): Promise<{
  readonly root: string;
  readonly spec: NpmLocalArtifactSpec;
  readonly identity: ReturnType<typeof identityFor>;
  readonly nodeExecutablePath: string;
  readonly limits: NpmArtifactMaterializationLimits;
}> => {
  const spec = normalizeSpec(input);
  const limits = normalizeLimits(options.limits);
  const root = await prepareRoot(options.root, createRoot);
  const nodeExecutablePath = await executableFile(
    options.nodeExecutablePath ?? process.execPath,
    'The Node executable',
  );
  return { root, spec, identity: identityFor(spec), nodeExecutablePath, limits };
};

export const verifyNpmLocalArtifact = async (
  input: NpmLocalArtifactSpec,
  options: NpmArtifactMaterializationOptions,
): Promise<NpmArtifactMaterializationResult> => {
  try {
    const context = await verificationContext(input, options, false);
    return await resultFor(
      context.root,
      context.spec,
      context.identity,
      context.nodeExecutablePath,
      context.limits,
      'already-materialized',
    );
  } catch (error) {
    if (error instanceof NpmArtifactMaterializationError) throw error;
    return fail('materialization-failed', 'Local artifact verification failed.', error);
  }
};

export const materializeNpmLocalArtifact = async (
  input: NpmLocalArtifactSpec,
  options: NpmArtifactMaterializationOptions,
): Promise<NpmArtifactMaterializationResult> => {
  try {
    const context = await verificationContext(input, options, true);
    const finalPath = join(context.root, ...context.identity.layout.split('/'));
    const layoutParent = dirname(finalPath);
    await ensureDirectory(context.root, join(context.root, 'artifacts'));
    await ensureDirectory(context.root, layoutParent);

    try {
      await lstat(finalPath);
      return await resultFor(
        context.root,
        context.spec,
        context.identity,
        context.nodeExecutablePath,
        context.limits,
        'already-materialized',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const staging = await mkdtemp(join(context.root, '.staging-'));
    try {
      const workspace = join(staging, 'workspace');
      const downloadPath = join(staging, 'download');
      const cachePath = join(staging, 'cache');
      const userConfigPath = join(staging, 'user.npmrc');
      const globalConfigPath = join(staging, 'global.npmrc');
      await Promise.all([
        mkdir(workspace),
        mkdir(downloadPath),
        mkdir(cachePath),
        writeFile(userConfigPath, '', { encoding: 'utf8', mode: 0o600 }),
        writeFile(globalConfigPath, '', { encoding: 'utf8', mode: 0o600 }),
      ]);
      await writeFile(
        join(workspace, 'package.json'),
        `${JSON.stringify({
          name: 'agent-tool-platform-local-artifact',
          version: '0.0.0',
          private: true,
        })}\n`,
        { encoding: 'utf8', mode: 0o600 },
      );

      const npmCliPath = await executableFile(
        options.npmCliPath ?? process.env['npm_execpath'] ?? '',
        'The npm CLI module',
      );
      const commandContext: NpmCommandContext = {
        npmCliPath,
        nodeExecutablePath: context.nodeExecutablePath,
        cwd: workspace,
        cachePath,
        userConfigPath,
        globalConfigPath,
        limits: context.limits,
        signal: options.signal,
      };
      const archivePath = join(downloadPath, 'package.tgz');
      const source = options.source ?? { kind: 'registry' as const };
      if (source.kind === 'archive') {
        await copyArchive(source.path, archivePath, context.limits);
      } else {
        await registryArchive(context.spec, source, archivePath, {
          fetch: options.fetch ?? globalThis.fetch,
          limits: context.limits,
          signal: options.signal,
        });
      }
      await verifyArchiveIntegrity(archivePath, context.spec.integrity, context.limits);

      const registryUrl = normalizedRegistryUrl(
        source.kind === 'registry' ? source.registryUrl : undefined,
      );
      await runNpmCommand(
        commandContext,
        [
          'install',
          archivePath,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--no-save',
          '--package-lock=false',
          '--fetch-retries=0',
          `--fetch-timeout=${String(context.limits.downloadTimeoutMs)}`,
          `--registry=${registryUrl}`,
          '--loglevel=error',
        ],
        context.limits.materializationTimeoutMs,
      );

      const installed = await inspectInstalledPackage(workspace, context.spec, context.limits);
      const evidence = await installationEvidence(workspace, context.limits);
      const manifest: MaterializationManifest = {
        schemaVersion: materializationSchemaVersion,
        kind: 'npm-local-artifact',
        identity: context.spec,
        identityDigest: context.identity.digest,
        layout: context.identity.layout,
        packagePath: portableRelativePath(workspace, installed.packagePath),
        entrypointPath: portableRelativePath(workspace, installed.entrypointPath),
        verification: evidence,
      };
      await writeFile(join(workspace, manifestName), `${JSON.stringify(manifest)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });

      try {
        await rename(workspace, finalPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        const collision =
          code === 'EEXIST' ||
          code === 'ENOTEMPTY' ||
          (process.platform === 'win32' && code === 'EPERM');
        if (!collision) {
          return fail(
            'materialization-failed',
            'The verified artifact could not be committed.',
            error,
          );
        }
        try {
          await lstat(finalPath);
        } catch {
          return fail(
            'materialization-failed',
            'The verified artifact could not be committed.',
            error,
          );
        }
        return await resultFor(
          context.root,
          context.spec,
          context.identity,
          context.nodeExecutablePath,
          context.limits,
          'already-materialized',
        );
      }
      return await resultFor(
        context.root,
        context.spec,
        context.identity,
        context.nodeExecutablePath,
        context.limits,
        'materialized',
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } catch (error) {
    if (error instanceof NpmArtifactMaterializationError) throw error;
    return fail('materialization-failed', 'Local artifact materialization failed.', error);
  }
};
