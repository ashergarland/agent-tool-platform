import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ToolRegistry,
  ToolRoutingError,
  composeToolDescription,
  createToolRegistry,
  defaultAnnotations,
  defineTool,
  type AnyToolDefinition,
} from '@agent-tool-platform/runtime';
import { createTestInvocationContext } from '@agent-tool-platform/testkit';
import { minimalTools } from '@agent-tool-platform/example-minimal-capability';

interface Services {
  readonly value: string;
}

const echoTool = defineTool({
  name: 'echo',
  title: 'Echo',
  summary: 'Return the supplied text.',
  description: 'Return exactly what was supplied.',
  kind: 'read',
  routing: {
    useWhen: ['a test needs a trivial read tool'],
    doNotUseWhen: ['anything real is required'],
    changesState: false,
  },
  inputSchema: z.object({ text: z.string().min(1) }),
  outputSchema: z.object({ text: z.string(), from: z.string() }),
  handler(input, services: Services) {
    return Promise.resolve({ text: input.text, from: services.value });
  },
});

const asDefinitions = (
  ...tools: readonly AnyToolDefinition<Services>[]
): readonly AnyToolDefinition<Services>[] => tools;

describe('ToolRegistry', () => {
  const services: Services = { value: 'fixture' };

  it('rejects duplicate tool names', () => {
    expect(() => createToolRegistry(asDefinitions(echoTool, echoTool))).toThrow(/Duplicate tool/u);
  });

  it('publishes JSON Schemas for input and output', () => {
    const registry = createToolRegistry(asDefinitions(echoTool));
    const tool = registry.get('echo');
    expect(tool.inputJsonSchema).toMatchObject({ type: 'object' });
    expect(tool.outputJsonSchema).toMatchObject({ type: 'object' });
  });

  it('retains both the declared and the rendered description', () => {
    const tool = createToolRegistry(asDefinitions(echoTool)).get('echo');
    expect(tool.baseDescription).toBe('Return exactly what was supplied.');
    expect(tool.description).toContain('Return exactly what was supplied.');
    expect(tool.description).toContain('Use when:');
    expect(tool.description).toContain('Do not use when:');
    expect(tool.description).toContain('read-only');
  });

  it('validates input and reports issue paths without echoing the value', async () => {
    const registry = createToolRegistry(asDefinitions(echoTool));
    await expect(
      registry.invoke('echo', { text: 12345 }, services, createTestInvocationContext()),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('turns an invalid handler result into an internal failure without leaking the value', async () => {
    const broken = defineTool({
      ...echoTool,
      name: 'broken',
      outputSchema: z.object({ text: z.number() }),
      handler() {
        return Promise.resolve({ text: 'super-secret-value' } as unknown as { text: number });
      },
    });
    const registry = createToolRegistry(asDefinitions(broken));
    let thrown: unknown;
    try {
      await registry.invoke('broken', { text: 'x' }, services, createTestInvocationContext());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'internal_error' });
    const payload = (thrown as { toPayload(id: string): unknown }).toPayload('req');
    expect(JSON.stringify(payload)).not.toContain('super-secret-value');
    expect((thrown as Error).message).toContain('does not match its declared output schema');
  });

  it('normalizes handler failures through the shared error model', async () => {
    const failing = defineTool({
      ...echoTool,
      name: 'failing',
      handler() {
        return Promise.reject(new Error('/etc/shadow could not be read'));
      },
    });
    const registry = createToolRegistry(asDefinitions(failing));
    await expect(
      registry.invoke('failing', { text: 'x' }, services, createTestInvocationContext()),
    ).rejects.toMatchObject({ code: 'internal_error' });
    await registry
      .invoke('failing', { text: 'x' }, services, createTestInvocationContext())
      .catch((error: Error) => {
        expect(error.message).not.toContain('/etc/shadow');
      });
  });

  it('exposes list, names, has, get, and invoke', async () => {
    const registry = createToolRegistry(asDefinitions(echoTool));
    expect(registry.names()).toEqual(['echo']);
    expect(registry.has('echo')).toBe(true);
    expect(registry.has('nope')).toBe(false);
    expect(() => registry.get('nope')).toThrow(/Unknown tool/u);
    await expect(
      registry.invoke('echo', { text: 'hi' }, services, createTestInvocationContext()),
    ).resolves.toEqual({ text: 'hi', from: 'fixture' });
  });

  it('preserves read and write classification with matching annotations', () => {
    const registry = new ToolRegistry(minimalTools);
    const read = registry.get('list_notes');
    const write = registry.get('put_note');

    expect(read.kind).toBe('read');
    expect(read.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(write.kind).toBe('write');
    expect(write.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
  });

  it('lets a tool override the derived annotations', () => {
    const nonDestructiveWrite = defineTool({
      ...echoTool,
      name: 'gentle_write',
      kind: 'write',
      routing: { ...echoTool.routing, changesState: true },
      annotations: { destructiveHint: false, idempotentHint: true },
    });
    expect(defaultAnnotations(nonDestructiveWrite)).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
});

describe('routing validation', () => {
  const invalid = (patch: Partial<AnyToolDefinition<Services>>): (() => unknown) => {
    return () => createToolRegistry(asDefinitions({ ...echoTool, ...patch }));
  };

  it('rejects malformed tool names', () => {
    expect(invalid({ name: 'Not Snake Case' })).toThrow(ToolRoutingError);
    expect(invalid({ name: '9leading' })).toThrow(ToolRoutingError);
  });

  it('rejects empty presentation metadata', () => {
    expect(invalid({ title: '  ' })).toThrow(/non-empty title/u);
    expect(invalid({ summary: '' })).toThrow(/non-empty summary/u);
    expect(invalid({ description: '' })).toThrow(/non-empty description/u);
  });

  it('rejects routing that omits guidance', () => {
    expect(invalid({ routing: { useWhen: [], doNotUseWhen: ['x'], changesState: false } })).toThrow(
      /invalid routing metadata/u,
    );
    expect(invalid({ routing: { useWhen: ['x'], doNotUseWhen: [], changesState: false } })).toThrow(
      /invalid routing metadata/u,
    );
  });

  it('rejects a kind that contradicts changesState', () => {
    expect(
      invalid({ routing: { useWhen: ['x'], doNotUseWhen: ['y'], changesState: true } }),
    ).toThrow(/changesState/u);
  });

  it('renders an optional scope but never requires one', () => {
    const withoutScope = composeToolDescription({
      description: 'does a thing',
      routing: { useWhen: ['a'], doNotUseWhen: ['b'], changesState: false },
    });
    expect(withoutScope).not.toContain('Scope:');

    const withScope = composeToolDescription({
      description: 'does a thing',
      routing: {
        useWhen: ['a'],
        doNotUseWhen: ['b'],
        changesState: true,
        scope: 'one workspace',
        prerequisites: ['first'],
        nextSteps: ['later'],
      },
    });
    expect(withScope).toContain('Scope: one workspace');
    expect(withScope).toContain('CHANGES state');
    expect(withScope).toContain('Run these first:');
    expect(withScope).toContain('Typical next steps:');
  });
});
