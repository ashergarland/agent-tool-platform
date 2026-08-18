/**
 * Platform application lifecycle.
 *
 * This is the *application* state machine, not a domain state machine. A capability such as Doc
 * RAG keeps its own index lifecycle; the platform only guarantees that the capability's `start`
 * and `stop` hooks run at the right points and that a single application-wide `AbortSignal` fires
 * when the process begins draining.
 */

export type ApplicationState = 'starting' | 'ready' | 'draining' | 'stopped';

export class ApplicationLifecycle {
  private current: ApplicationState = 'starting';
  private readonly controller = new AbortController();
  private readonly listeners = new Set<(state: ApplicationState) => void>();

  public get state(): ApplicationState {
    return this.current;
  }

  /** Aborted once the application begins draining. Combined into every invocation signal. */
  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** True while the application should admit new work. */
  public get accepting(): boolean {
    return this.current === 'starting' || this.current === 'ready';
  }

  public get draining(): boolean {
    return this.current === 'draining' || this.current === 'stopped';
  }

  public onStateChange(listener: (state: ApplicationState) => void): () => void {
    this.listeners.add(listener);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public markReady(): void {
    if (this.current === 'starting') this.transition('ready');
  }

  public beginDraining(): void {
    if (this.current === 'draining' || this.current === 'stopped') return;
    this.transition('draining');
    this.controller.abort(new Error('The application is shutting down'));
  }

  public markStopped(): void {
    if (this.current === 'stopped') return;
    if (!this.controller.signal.aborted) {
      this.controller.abort(new Error('The application is shutting down'));
    }
    this.transition('stopped');
  }

  private transition(next: ApplicationState): void {
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }
}
