import type { ToolRegistry } from '@agent-tool-platform/runtime';
import {
  ConformanceRun,
  hasErrorCode,
  type ConformanceOptions,
  type ConformanceResult,
} from './harness.js';
import { createTestInvocationContext } from './fixtures.js';

/**
 * Registry conformance.
 *
 * Proves the properties every transport relies on: names are unique and well formed, schemas are
 * published, input and output are both validated, and a handler that violates its own contract
 * fails as a server defect without leaking the offending value.
 */

export interface RegistryConformanceOptions<TServices> extends ConformanceOptions {
  readonly registry: ToolRegistry<TServices>;
  readonly services: TServices;
  /** A tool that deliberately returns a value violating its output schema, if the fixture has one. */
  readonly invalidOutputTool?: {
    readonly name: string;
    readonly input: unknown;
    readonly marker: string;
  };
  /** A tool plus an input that its schema must reject. */
  readonly invalidInputSample?: { readonly name: string; readonly input: unknown };
}

export const runRegistryConformance = async <TServices>(
  options: RegistryConformanceOptions<TServices>,
): Promise<ConformanceResult> => {
  const run = new ConformanceRun('registry');
  const { registry } = options;
  const tools = registry.list();

  run.check('registry publishes at least one tool', tools.length > 0);
  run.check('tool names are unique', new Set(tools.map((tool) => tool.name)).size === tools.length);
  run.check('list() and size agree', tools.length === registry.size);

  for (const tool of tools) {
    run.check(`${tool.name}: has() is true`, registry.has(tool.name));
    run.check(
      `${tool.name}: input JSON Schema is an object`,
      typeof tool.inputJsonSchema === 'object' && tool.inputJsonSchema !== null,
    );
    run.check(
      `${tool.name}: output JSON Schema is an object`,
      typeof tool.outputJsonSchema === 'object' && tool.outputJsonSchema !== null,
    );
    run.check(
      `${tool.name}: base description is retained separately from the rendered description`,
      tool.baseDescription.length > 0 && tool.description.includes(tool.baseDescription.trim()),
    );
    run.check(
      `${tool.name}: rendered description carries routing guidance`,
      tool.description.includes('Use when:') && tool.description.includes('Do not use when:'),
    );
    run.check(
      `${tool.name}: readOnlyHint matches kind`,
      tool.annotations.readOnlyHint === (tool.kind === 'read'),
    );
    run.check(
      `${tool.name}: destructiveHint matches kind`,
      tool.annotations.destructiveHint === (tool.kind === 'write'),
    );
    run.check(
      `${tool.name}: routing.changesState matches kind`,
      tool.routing.changesState === (tool.kind === 'write'),
    );
  }

  await run.throws(
    'unknown tool names produce not_found',
    () => registry.get('definitely_not_a_registered_tool'),
    (error) => hasErrorCode(error, 'not_found'),
  );

  if (options.invalidInputSample) {
    const sample = options.invalidInputSample;
    await run.throws(
      'invalid input produces bad_request',
      () =>
        registry.invoke(sample.name, sample.input, options.services, createTestInvocationContext()),
      (error) => hasErrorCode(error, 'bad_request'),
    );
  }

  if (options.invalidOutputTool) {
    const sample = options.invalidOutputTool;
    await run.throws(
      'invalid handler output becomes an internal failure that does not leak the value',
      () =>
        registry.invoke(sample.name, sample.input, options.services, createTestInvocationContext()),
      (error) => {
        if (!hasErrorCode(error, 'internal_error')) return false;
        const serialized = JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          details: (error as { details?: unknown }).details,
        });
        return !serialized.includes(sample.marker);
      },
    );
  }

  return run.finish(options);
};
