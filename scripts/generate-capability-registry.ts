import { writeFirstPartyRegistry } from '../packages/capability-registry/src/data.js';

await writeFirstPartyRegistry();
process.stdout.write('Generated the first-party capability registry.\n');
