import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config.js';
import vitestConfig from '../vitest.config.js';

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const appRoot = resolve(workspaceRoot, 'apps', 'agent-builder');
const tsconfigPath = resolve(appRoot, 'tsconfig.json');
const configFile = ts.readConfigFile(tsconfigPath, (path) => ts.sys.readFile(path));

if (configFile.error !== undefined) {
  throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
}

const parsedConfig = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  appRoot,
  undefined,
  tsconfigPath,
);

const packages = [
  ['@agent-tool-platform/agent-kit', 'agent-kit'],
  ['@agent-tool-platform/capability-registry', 'capability-registry'],
  ['@agent-tool-platform/runtime', 'runtime'],
] as const;

describe('Builder public package boundary', () => {
  it('uses no Vite or Vitest package aliases', () => {
    expect(viteConfig.resolve?.alias).toBeUndefined();
    expect(vitestConfig.resolve?.alias).toBeUndefined();
  });

  it.each(packages)('resolves %s through its built public outputs', (packageName, directory) => {
    const expectedRuntime = realpathSync.native(
      resolve(workspaceRoot, 'packages', directory, 'dist', 'index.js'),
    );
    const runtime = realpathSync.native(fileURLToPath(import.meta.resolve(packageName)));
    expect(runtime).toBe(expectedRuntime);

    const resolution = ts.resolveModuleName(
      packageName,
      resolve(appRoot, 'src', 'server', 'service.ts'),
      parsedConfig.options,
      ts.sys,
    ).resolvedModule;
    expect(resolution).toBeDefined();

    const expectedDeclaration = realpathSync.native(
      resolve(workspaceRoot, 'packages', directory, 'dist', 'index.d.ts'),
    );
    const declaration = realpathSync.native(resolution?.resolvedFileName ?? '');
    expect(declaration).toBe(expectedDeclaration);
  });
});
