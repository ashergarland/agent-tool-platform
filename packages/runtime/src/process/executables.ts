import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

/**
 * Executable resolution.
 *
 * Only absolute `PATH` entries are searched and only regular executable files are accepted, so
 * resolution cannot be redirected by a relative entry or by a directory that happens to share the
 * binary's name. The platform resolves *where* a binary is; deciding *which* binaries a capability
 * may run is capability policy.
 */

export class ExecutableResolutionError extends Error {
  public override readonly name = 'ExecutableResolutionError';
}

export interface ResolveExecutableOptions {
  /** Explicit path that bypasses the `PATH` search; still checked for executability. */
  readonly override?: string | undefined;
  /** The `PATH` value to search. Defaults to the current process `PATH`. */
  readonly pathValue?: string | undefined;
  readonly platform?: NodeJS.Platform;
}

const candidateNames = (name: string, platform: NodeJS.Platform): readonly string[] =>
  platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name];

export const isExecutableFile = async (
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> => {
  try {
    const stats = await stat(candidate);
    if (!stats.isFile()) return false;
    await access(candidate, platform === 'win32' ? constants.R_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const resolveExecutable = async (
  name: string,
  options: ResolveExecutableOptions = {},
): Promise<string> => {
  const platform = options.platform ?? process.platform;
  if (options.override) {
    const candidate = resolve(options.override);
    if (!(await isExecutableFile(candidate, platform))) {
      throw new ExecutableResolutionError(`Configured ${name} path is not an executable file`);
    }
    return candidate;
  }

  const searchPath = (options.pathValue ?? process.env['PATH'] ?? '')
    .split(delimiter)
    .filter(Boolean);
  for (const directory of searchPath) {
    // A relative PATH entry resolves against the current working directory, which a caller may be
    // able to influence; only absolute entries are trustworthy.
    if (!isAbsolute(directory)) continue;
    for (const fileName of candidateNames(name, platform)) {
      const candidate = join(directory, fileName);
      if (await isExecutableFile(candidate, platform)) return candidate;
    }
  }
  throw new ExecutableResolutionError(`${name} was not found on PATH`);
};
