import type { AgentToolApplication, PlatformConfig } from '@agent-tool-platform/runtime';
import {
  ConformanceRun,
  hasErrorCode,
  type ConformanceOptions,
  type ConformanceResult,
} from './harness.js';

/**
 * Lifecycle and readiness conformance.
 *
 * Proves the distinction the platform exists to enforce: the application state machine drives
 * readiness, draining, and cancellation, while the capability's own hooks run at the right points
 * and its domain state machine stays its own.
 */

export interface LifecycleConformanceOptions<
  TConfig extends PlatformConfig,
  TServices,
> extends ConformanceOptions {
  /** Builds a fresh, unstarted application. Called several times. */
  readonly createApplication: () => Promise<AgentToolApplication<TConfig, TServices>>;
  /** Observes whether the capability start hook ran. */
  readonly startedProbe?: (services: TServices) => boolean;
  /** Observes whether the capability stop hook ran. */
  readonly stoppedProbe?: (services: TServices) => boolean;
  /** A tool that waits, used to prove in-flight cancellation. */
  readonly cancellableTool?: { readonly name: string; readonly input: Record<string, unknown> };
  readonly apiKey?: string;
}

export const runLifecycleConformance = async <TConfig extends PlatformConfig, TServices>(
  options: LifecycleConformanceOptions<TConfig, TServices>,
): Promise<ConformanceResult> => {
  const run = new ConformanceRun('lifecycle');

  const application = await options.createApplication();
  try {
    run.equal('a fresh application is starting', application.lifecycle.state, 'starting');

    if (options.startedProbe) {
      run.check(
        'the capability start hook has not run before start()',
        options.startedProbe(application.services) === false,
      );
    }

    await application.start();
    run.equal('start() marks the application ready', application.lifecycle.state, 'ready');
    if (options.startedProbe) {
      run.check('the capability start hook ran', options.startedProbe(application.services));
    }

    const report = await application.readiness();
    run.check('readiness aggregates contributors', report.checks.length > 0);
    run.check(
      'readiness reports a state',
      ['ready', 'degraded', 'not_ready'].includes(report.state),
    );
    run.check(
      'readiness details never contain an absolute path',
      report.checks.every(
        (check) => check.detail === undefined || !/^([A-Za-z]:[\\/]|\/)/u.test(check.detail),
      ),
    );

    const ready = await application.http.inject({ method: 'GET', url: '/ready' });
    run.equal('a ready application answers 200', ready.statusCode, report.ready ? 200 : 503);

    if (options.cancellableTool && options.apiKey !== undefined) {
      const pending = application.http.inject({
        method: 'POST',
        url: `/tools/${options.cancellableTool.name}`,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        payload: options.cancellableTool.input,
      });
      application.lifecycle.beginDraining();
      const response = await pending;
      run.check(
        'in-flight work observes application cancellation',
        response.statusCode === 200 || response.statusCode >= 500,
        `status ${response.statusCode}`,
      );

      const rejected = await application.http.inject({
        method: 'POST',
        url: `/tools/${options.cancellableTool.name}`,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        payload: options.cancellableTool.input,
      });
      run.equal('a draining application refuses new work', rejected.statusCode, 503);

      const drainingReady = await application.http.inject({ method: 'GET', url: '/ready' });
      run.equal('a draining application is not ready', drainingReady.statusCode, 503);
    }
  } finally {
    await application.shutdown();
  }

  run.equal('shutdown() stops the application', application.lifecycle.state, 'stopped');
  if (options.stoppedProbe) {
    run.check('the capability stop hook ran', options.stoppedProbe(application.services));
  }

  const second = await options.createApplication();
  await second.start();
  second.lifecycle.beginDraining();
  if (options.cancellableTool) {
    await run.throws(
      'the invoker refuses work while draining',
      () =>
        second.invoker.invoke({
          toolName: options.cancellableTool!.name,
          input: options.cancellableTool!.input,
          requestId: 'draining',
          principal: { id: 'test', kind: 'anonymous' },
          transport: 'http',
        }),
      (error) => hasErrorCode(error, 'not_ready'),
    );
  }
  await second.shutdown();

  return run.finish(options);
};
