import { validateStaticFirstPartyRegistry } from '../packages/capability-registry/src/validation.js';

const result = await validateStaticFirstPartyRegistry();
for (const error of result.errors) process.stderr.write(`${error}\n`);
if (!result.valid) {
  process.exitCode = 1;
} else {
  process.stdout.write('First-party capability registry is valid.\n');
}
