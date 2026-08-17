import { badRequest, notFound, type MutationGate } from '@agent-tool-platform/runtime';

/**
 * A deliberately tiny in-memory service.
 *
 * The fixture exists to prove the platform, so its "domain" is the smallest thing that still has
 * a read path, a write path, cancellable work, and observable lifecycle state. It must not grow
 * into a pretend product capability.
 */

export interface Note {
  readonly id: string;
  readonly text: string;
}

export interface NoteSummary {
  readonly id: string;
  readonly bytes: number;
}

export class NoteStore {
  private readonly notes = new Map<string, Note>();
  private started = false;
  private stopped = false;

  public constructor(private readonly maxNotes: number) {}

  public get isStarted(): boolean {
    return this.started;
  }

  public get isStopped(): boolean {
    return this.stopped;
  }

  public get size(): number {
    return this.notes.size;
  }

  public start(): void {
    this.started = true;
  }

  public stop(): void {
    this.stopped = true;
    this.notes.clear();
  }

  public list(prefix: string | undefined, limit: number): readonly NoteSummary[] {
    const matches = [...this.notes.values()]
      .filter((note) => (prefix === undefined ? true : note.id.startsWith(prefix)))
      .sort((left, right) => left.id.localeCompare(right.id));
    return matches
      .slice(0, limit)
      .map((note) => ({ id: note.id, bytes: Buffer.byteLength(note.text, 'utf8') }));
  }

  public count(prefix: string | undefined): number {
    if (prefix === undefined) return this.notes.size;
    return [...this.notes.keys()].filter((id) => id.startsWith(prefix)).length;
  }

  public get(id: string): Note {
    const note = this.notes.get(id);
    if (!note) throw notFound(`Unknown note: ${id}`);
    return note;
  }

  public put(note: Note): void {
    if (!this.notes.has(note.id) && this.notes.size >= this.maxNotes) {
      throw badRequest(`This deployment stores at most ${this.maxNotes} notes`, {
        maxNotes: this.maxNotes,
      });
    }
    this.notes.set(note.id, note);
  }
}

/**
 * Counts route-handler entries.
 *
 * This exists so a test can distinguish "the platform refused the request" from "the handler ran
 * and then failed". Proving the admission guard rejects a request *before* any capability code
 * begins requires an observable at the handler's first line; a response status alone cannot tell
 * the two apart.
 */
export class RouteProbe {
  private starts = 0;

  public get startCount(): number {
    return this.starts;
  }

  public enter(): void {
    this.starts += 1;
  }
}

export interface MinimalServices {
  readonly notes: NoteStore;
  readonly mutations: MutationGate;
  readonly routeProbe: RouteProbe;
}
