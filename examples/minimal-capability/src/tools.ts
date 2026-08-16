import {
  defineTool,
  timedOut,
  whenAborted,
  type AnyToolDefinition,
} from '@agent-tool-platform/runtime';
import { z } from 'zod';
import type { MinimalServices } from './services.js';

/**
 * Fixture tools.
 *
 * One read tool, one write tool, and two diagnostic read tools so cancellation and registry output
 * validation can be exercised end to end. Routing content is authored here; rendering, validation,
 * and publication are the platform's job.
 */

const noteIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u, 'note ids are lower-case slugs');

export const listNotes = defineTool({
  name: 'list_notes',
  title: 'List notes',
  summary: 'List stored note identifiers and their sizes.',
  description:
    'Return the identifiers and byte sizes of notes held by this fixture capability, optionally ' +
    'filtered by identifier prefix.',
  kind: 'read',
  routing: {
    useWhen: [
      'you need to know which notes exist before reading or replacing one',
      'you want the size of a note without fetching its text',
    ],
    doNotUseWhen: [
      'you need the text of a note; this tool never returns note contents',
      'you intend to modify a note; use put_note instead',
    ],
    nextSteps: ['put_note'],
    scope: 'the in-memory note store of this instance',
    changesState: false,
  },
  inputSchema: z.object({
    prefix: z.string().min(1).max(64).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  outputSchema: z.object({
    notes: z.array(z.object({ id: z.string(), bytes: z.number().int() })),
    total: z.number().int(),
    truncated: z.boolean(),
  }),
  handler(input, services: MinimalServices) {
    const total = services.notes.count(input.prefix);
    const notes = services.notes.list(input.prefix, input.limit);
    return Promise.resolve({ notes: [...notes], total, truncated: notes.length < total });
  },
});

export const putNote = defineTool({
  name: 'put_note',
  title: 'Store a note',
  summary: 'Create or replace one note.',
  description:
    'Create or replace a note in the in-memory store. Always preview with dryRun=true first, then ' +
    'execute with confirm=true once the user has approved the change.',
  kind: 'write',
  routing: {
    useWhen: ['the user asked to record or replace a note and has approved the exact content'],
    doNotUseWhen: [
      'you are exploring; use list_notes, which never changes state',
      'the user has not approved the exact text being written',
    ],
    prerequisites: ['list_notes'],
    scope: 'the in-memory note store of this instance',
    changesState: true,
  },
  inputSchema: z.object({
    id: noteIdSchema,
    text: z.string().min(1).max(4096),
    dryRun: z.boolean().default(true),
    confirm: z.boolean().default(false),
  }),
  outputSchema: z.object({
    mode: z.enum(['preview', 'execute']),
    id: z.string(),
    bytes: z.number().int(),
    stored: z.boolean(),
  }),
  handler(input, services: MinimalServices) {
    // The gate itself is platform-generic. The decision that *this* tool is gated, and that its
    // arguments are named `dryRun` and `confirm`, is the capability's.
    const decision = services.mutations.decide({
      toolName: 'put_note',
      dryRun: input.dryRun,
      confirm: input.confirm,
    });
    const bytes = Buffer.byteLength(input.text, 'utf8');
    if (decision.mode === 'preview') {
      return Promise.resolve({ mode: 'preview' as const, id: input.id, bytes, stored: false });
    }
    services.notes.put({ id: input.id, text: input.text });
    return Promise.resolve({ mode: 'execute' as const, id: input.id, bytes, stored: true });
  },
});

export const waitForCancellation = defineTool({
  name: 'wait_for_cancellation',
  title: 'Wait until cancelled',
  summary: 'Block until the invocation signal aborts or the delay elapses.',
  description:
    'Wait for the requested delay, returning early when the invocation is cancelled. Exists so ' +
    'cancellation, disconnect handling, and request deadlines can be observed end to end.',
  kind: 'read',
  routing: {
    useWhen: ['a test needs to observe platform cancellation behaviour'],
    doNotUseWhen: ['you want to do anything useful; this tool only waits'],
    changesState: false,
  },
  inputSchema: z.object({
    delayMs: z.number().int().min(0).max(60_000).default(50),
    throwOnCancel: z.boolean().default(false),
  }),
  outputSchema: z.object({ cancelled: z.boolean(), waitedMs: z.number().int() }),
  async handler(input, _services: MinimalServices, context) {
    const startedAt = Date.now();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, input.delayMs);
      }),
      whenAborted(context.signal),
    ]);
    if (timer) clearTimeout(timer);
    if (context.signal.aborted && input.throwOnCancel) {
      throw timedOut('The invocation was cancelled');
    }
    return { cancelled: context.signal.aborted, waitedMs: Date.now() - startedAt };
  },
});

export const brokenOutput = defineTool({
  name: 'broken_output',
  title: 'Return an invalid result',
  summary: 'Deliberately violate the declared output schema.',
  description:
    'Return a value that does not satisfy the declared output schema, so registry output ' +
    'validation and its non-disclosure behaviour can be observed.',
  kind: 'read',
  routing: {
    useWhen: ['a test needs to observe registry output validation'],
    doNotUseWhen: ['you want a usable result; this tool always fails'],
    changesState: false,
  },
  inputSchema: z.object({ secret: z.string().default('unused') }),
  outputSchema: z.object({ ok: z.literal(true) }),
  handler(input) {
    // The offending value carries a recognizable marker so a test can prove it never escapes.
    return Promise.resolve({ ok: `leaked:${input.secret}` } as unknown as { ok: true });
  },
}) as AnyToolDefinition<MinimalServices>;

export const minimalTools: readonly AnyToolDefinition<MinimalServices>[] = [
  listNotes,
  putNote,
  waitForCancellation,
  brokenOutput,
];
