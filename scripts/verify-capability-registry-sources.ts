import { resolve } from 'node:path';
import { loadFirstPartyCapabilityRegistry } from '../packages/capability-registry/src/validation.js';
import {
  verifyCapabilitySources,
  type CapabilitySourceRoot,
} from '../packages/capability-registry/src/source-validation.js';

const parseSourceRoot = (argument: string): CapabilitySourceRoot => {
  const separator = argument.indexOf('=');
  if (separator <= 0 || separator === argument.length - 1) {
    throw new Error(`Invalid source checkout "${argument}"; expected capability-id=path`);
  }
  return {
    capabilityId: argument.slice(0, separator),
    root: resolve(argument.slice(separator + 1)),
  };
};

const arguments_ = process.argv.slice(2);
if (arguments_.length === 0) {
  process.stderr.write(
    'Usage: npm run registry:verify-sources -- capability-id=checkout-path [...]\n',
  );
  process.exitCode = 2;
} else {
  const roots = arguments_.map(parseSourceRoot);
  const registry = await loadFirstPartyCapabilityRegistry();
  const requestedCapabilities = new Set(roots.map(({ capabilityId }) => capabilityId));
  const selectedRegistry = {
    ...registry,
    capabilities: registry.capabilities.filter(({ id }) => requestedCapabilities.has(id)),
  };
  const issues = await verifyCapabilitySources(selectedRegistry, roots);
  for (const issue of issues) {
    process.stderr.write(`${issue.capabilityId}: ${issue.message}\n`);
  }
  if (issues.length > 0) {
    process.exitCode = 1;
  } else {
    process.stdout.write(`Verified ${roots.length} capability source checkouts.\n`);
  }
}
