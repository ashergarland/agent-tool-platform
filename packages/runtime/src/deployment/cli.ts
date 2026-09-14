import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateDeploymentContract } from './validate.js';

export interface DeploymentValidationCliIo {
  readonly stdout: { readonly write: (value: string) => unknown };
  readonly stderr: { readonly write: (value: string) => unknown };
  readonly cwd: string;
}

interface DeploymentValidationCliOptions {
  readonly declaration: string;
  readonly instance?: string;
}

const usage = 'Usage: agent-tool-validate-deployment --declaration <path> [--instance <path>]\n';

const parseArguments = (argv: readonly string[]): DeploymentValidationCliOptions => {
  let declaration: string | undefined;
  let instance: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--declaration' && flag !== '--instance') {
      throw new Error(`Unknown argument ${flag ?? '(missing)'}\n${usage.trimEnd()}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}\n${usage.trimEnd()}`);
    }
    if (flag === '--declaration') {
      if (declaration !== undefined) throw new Error('--declaration may be provided only once');
      declaration = value;
    } else {
      if (instance !== undefined) throw new Error('--instance may be provided only once');
      instance = value;
    }
    index += 1;
  }

  if (declaration === undefined) throw new Error(`--declaration is required\n${usage.trimEnd()}`);
  return {
    declaration,
    ...(instance === undefined ? {} : { instance }),
  };
};

const loadJson = async (path: string, cwd: string): Promise<unknown> => {
  const absolutePath = resolve(cwd, path);
  const source = await readFile(absolutePath, 'utf8');
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(
      `${absolutePath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const runDeploymentValidationCli = async (
  argv: readonly string[],
  io: DeploymentValidationCliIo = {
    stdout: process.stdout,
    stderr: process.stderr,
    cwd: process.cwd(),
  },
): Promise<number> => {
  try {
    const options = parseArguments(argv);
    const declaration = await loadJson(options.declaration, io.cwd);
    const instance =
      options.instance === undefined ? undefined : await loadJson(options.instance, io.cwd);
    const result = validateDeploymentContract({
      declaration,
      ...(instance === undefined ? {} : { instance }),
    });

    if (!result.valid) {
      io.stderr.write(`Deployment contract is invalid:\n- ${result.errors.join('\n- ')}\n`);
      return 1;
    }

    io.stdout.write(
      instance === undefined
        ? 'Capability profile declaration is valid.\n'
        : 'Capability profile declaration and deployment instance are valid.\n',
    );
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
};
