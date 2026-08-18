import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const targets = [
  'coverage',
  'openapi.fixture.json',
  'packages/runtime/dist',
  'packages/runtime/tsconfig.build.tsbuildinfo',
  'packages/testkit/dist',
  'packages/testkit/tsconfig.build.tsbuildinfo',
  'examples/minimal-capability/dist',
  'examples/minimal-capability/tsconfig.build.tsbuildinfo',
];

for (const target of targets) {
  rmSync(join(repositoryRoot, target), { recursive: true, force: true });
}

process.stdout.write('Removed build and coverage output.\n');
