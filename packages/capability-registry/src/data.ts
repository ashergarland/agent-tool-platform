import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { buildCapabilityRegistry, serializeCapabilityRegistry } from './registry.js';
import { capabilityEntrySchema, type CapabilityEntry, type CapabilityRegistry } from './schema.js';
import {
  capabilityEntriesDirectory,
  capabilityRegistryPackageRoot,
  firstPartyRegistryPath,
} from './paths.js';

export interface RegistryDataIssue {
  readonly source: string;
  readonly message: string;
}

export interface JsonDocumentResult {
  readonly document?: unknown;
  readonly issues: readonly RegistryDataIssue[];
}

export interface LoadedCapabilityDocument {
  readonly filename: string;
  readonly document: unknown;
}

export interface LoadedCapabilityDocuments {
  readonly documents: readonly LoadedCapabilityDocument[];
  readonly issues: readonly RegistryDataIssue[];
}

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

export const readJsonDocument = async (
  path: string,
  source = path,
): Promise<JsonDocumentResult> => {
  let content: string;
  try {
    content = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return { issues: [{ source, message: 'file is missing' }] };
    }
    throw error;
  }

  try {
    return { document: JSON.parse(content) as unknown, issues: [] };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { issues: [{ source, message: `malformed JSON: ${error.message}` }] };
    }
    throw error;
  }
};

export const readCapabilityEntryDocuments = async (
  root = capabilityRegistryPackageRoot,
): Promise<LoadedCapabilityDocuments> => {
  const directory = join(root, capabilityEntriesDirectory);
  let filenames: string[];
  try {
    filenames = (await readdir(directory))
      .filter((filename) => filename.endsWith('.json'))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return {
        documents: [],
        issues: [{ source: capabilityEntriesDirectory, message: 'directory is missing' }],
      };
    }
    throw error;
  }

  const results = await Promise.all(
    filenames.map(async (filename) => ({
      filename,
      result: await readJsonDocument(join(directory, filename), filename),
    })),
  );

  return {
    documents: results.flatMap(({ filename, result }) =>
      result.document === undefined ? [] : [{ filename, document: result.document }],
    ),
    issues: results.flatMap(({ result }) => result.issues),
  };
};

const formatZodError = (error: z.ZodError): string =>
  error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');

export class CapabilityRegistryDataError extends Error {
  public override readonly name = 'CapabilityRegistryDataError';

  public constructor(public readonly issues: readonly RegistryDataIssue[]) {
    super(
      `Capability registry data is invalid:\n- ${issues.map((issue) => `${issue.source}: ${issue.message}`).join('\n- ')}`,
    );
  }
}

export const loadCapabilityEntries = async (
  root = capabilityRegistryPackageRoot,
): Promise<CapabilityEntry[]> => {
  const loaded = await readCapabilityEntryDocuments(root);
  const issues = [...loaded.issues];
  const entries: CapabilityEntry[] = [];

  for (const { filename, document } of loaded.documents) {
    const parsed = capabilityEntrySchema.safeParse(document);
    if (parsed.success) {
      entries.push(parsed.data);
    } else {
      issues.push({ source: filename, message: formatZodError(parsed.error) });
    }
  }

  if (issues.length > 0) throw new CapabilityRegistryDataError(issues);
  return entries;
};

const packageVersionSchema = z.object({ version: z.string().min(1) });

const readRegistryVersion = async (root: string): Promise<string> => {
  const result = await readJsonDocument(join(root, 'package.json'), 'package.json');
  if (result.document === undefined) throw new CapabilityRegistryDataError(result.issues);
  const parsed = packageVersionSchema.safeParse(result.document);
  if (!parsed.success) {
    throw new CapabilityRegistryDataError([
      { source: 'package.json', message: formatZodError(parsed.error) },
    ]);
  }
  return parsed.data.version;
};

export const generateFirstPartyRegistry = async (
  root = capabilityRegistryPackageRoot,
): Promise<CapabilityRegistry> =>
  buildCapabilityRegistry(await loadCapabilityEntries(root), await readRegistryVersion(root));

export const writeFirstPartyRegistry = async (
  root = capabilityRegistryPackageRoot,
): Promise<void> => {
  const path = join(root, firstPartyRegistryPath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    serializeCapabilityRegistry(await generateFirstPartyRegistry(root)),
    'utf8',
  );
};

export const checkFirstPartyRegistry = async (
  root = capabilityRegistryPackageRoot,
): Promise<RegistryDataIssue[]> => {
  const expected = serializeCapabilityRegistry(await generateFirstPartyRegistry(root));
  const path = join(root, firstPartyRegistryPath);
  let actual: string;
  try {
    actual = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return [{ source: firstPartyRegistryPath, message: 'generated registry is missing' }];
    }
    throw error;
  }
  return actual === expected
    ? []
    : [
        {
          source: firstPartyRegistryPath,
          message: 'generated registry is stale; run npm run registry:generate',
        },
      ];
};
