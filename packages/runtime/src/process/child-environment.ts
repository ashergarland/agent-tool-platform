import { delimiter } from 'node:path';

/**
 * Builds the complete environment handed to every child process.
 *
 * Seeded by the Data Cruncher implementation. The environment is an allowlist constructed from
 * scratch rather than a filtered copy of `process.env`, which is the only construction where
 * "did we remember to remove the new secret?" is not a question. Application credentials, proxy
 * settings, `NODE_OPTIONS`, and tool-specific configuration variables therefore cannot reach a
 * child that might expose them (`jq` exposes `env`/`$ENV` to filters, for example).
 */

export interface ChildEnvironmentOptions {
  /** Directories placed on the child `PATH`. Usually only the resolved binaries' directories. */
  readonly pathEntries: readonly string[];
  /** Scratch directory used for `HOME` and every temporary-directory variable. */
  readonly tempDir: string;
  readonly platform?: NodeJS.Platform;
  readonly source?: NodeJS.ProcessEnv;
  /**
   * Additional variables the capability explicitly wants the child to see. Supplying a secret here
   * is a capability decision, made visibly, rather than an accident of inheritance.
   */
  readonly extra?: Readonly<Record<string, string>>;
}

export const buildChildEnvironment = ({
  pathEntries,
  tempDir,
  platform = process.platform,
  source = process.env,
  extra = {},
}: ChildEnvironmentOptions): Record<string, string> => {
  const environment: Record<string, string> = {
    PATH: [...new Set(pathEntries)].join(delimiter),
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    HOME: tempDir,
    TMPDIR: tempDir,
    TMP: tempDir,
    TEMP: tempDir,
  };

  if (platform === 'win32') {
    // Windows binaries need the OS root to load system libraries. Neither value is sensitive.
    // Note: libuv additionally copies a fixed list of Windows variables (USERNAME, USERPROFILE,
    // HOMEDRIVE and similar) into every child on this platform. None is an application secret, and
    // the supported production platform is Linux, where this allowlist is exact.
    for (const key of ['SystemRoot', 'windir'] as const) {
      const value = source[key];
      if (value) environment[key] = value;
    }
  }

  for (const [key, value] of Object.entries(extra)) {
    if (typeof value === 'string') environment[key] = value;
  }

  return environment;
};
