import type { ToolRegistry } from '@agent-tool-platform/runtime';
import { ConformanceRun, type ConformanceOptions, type ConformanceResult } from './harness.js';

/**
 * Routing conformance.
 *
 * Routing content is the difference between an agent that picks the right tool and one that tries
 * them all. These checks are about content quality, not schema validity, which the registry has
 * already enforced.
 */

export interface RoutingConformanceOptions<TServices> extends ConformanceOptions {
  readonly registry: ToolRegistry<TServices>;
  /** Server-wide instructions, checked for presence and routing content. */
  readonly instructions?: string;
  /** Minimum number of `useWhen` entries a tool must declare. Default: 1. */
  readonly minimumUseWhen?: number;
}

export const runRoutingConformance = <TServices>(
  options: RoutingConformanceOptions<TServices>,
): ConformanceResult => {
  const run = new ConformanceRun('routing');
  const tools = options.registry.list();
  const names = new Set(tools.map((tool) => tool.name));
  const minimumUseWhen = options.minimumUseWhen ?? 1;

  for (const tool of tools) {
    run.check(
      `${tool.name}: declares at least ${minimumUseWhen} useWhen entries`,
      tool.routing.useWhen.length >= minimumUseWhen,
    );
    run.check(
      `${tool.name}: declares at least one doNotUseWhen entry`,
      tool.routing.doNotUseWhen.length >= 1,
    );
    run.check(
      `${tool.name}: summary is a single line`,
      !tool.summary.includes('\n'),
      'summaries are used as OpenAPI operation summaries and must not wrap',
    );

    for (const prerequisite of tool.routing.prerequisites ?? []) {
      run.check(
        `${tool.name}: prerequisite ${prerequisite} is a registered tool`,
        names.has(prerequisite),
      );
    }
    for (const next of tool.routing.nextSteps ?? []) {
      run.check(`${tool.name}: nextStep ${next} is a registered tool`, names.has(next));
    }

    run.check(
      `${tool.name}: state disclosure matches kind`,
      tool.kind === 'write'
        ? tool.description.includes('CHANGES state')
        : tool.description.includes('read-only'),
    );
  }

  if (options.instructions !== undefined) {
    run.check('server instructions are non-empty', options.instructions.trim().length > 0);
    run.check(
      'server instructions mention routing',
      /routing/iu.test(options.instructions),
      'server-wide instructions exist to express cross-tool routing a single description cannot',
    );
  }

  return run.finish(options);
};
