/**
 * Single definition site for the API's custom OpenTelemetry instruments.
 *
 * The SDK is registered at startup by `apps/api/src/otel.ts` (imported as the
 * first line of `main.ts`). Because OTel-JS does NOT rebind meters obtained
 * before registration, every instrument here is created LAZILY on first use
 * (memoised), so it always binds to the registered MeterProvider.
 */
import { metrics, SpanStatusCode, trace } from '@opentelemetry/api';
import type {
  Counter,
  Histogram,
  Meter,
  UpDownCounter
} from '@opentelemetry/api';

export const OTEL_SCOPE_NAME = 'ghostfolio-api';

/** P99 budget in seconds - a handler slower than this gets a span event. */
export const SLOW_REQUEST_BUDGET_SECONDS = 2;

let meter: Meter | undefined;

function getMeter(): Meter {
  if (!meter) {
    meter = metrics.getMeter(OTEL_SCOPE_NAME);
  }

  return meter;
}

let httpServerRequestDuration: Histogram | undefined;
let httpServerRequests: Counter | undefined;
let flowEntries: Counter | undefined;
let flowOutcomes: Counter | undefined;
let flowDuration: Histogram | undefined;
let flowEntryToTerminalDuration: Histogram | undefined;
let flowValidationOutcomes: Counter | undefined;
let httpServerActiveRequests: UpDownCounter | undefined;
let httpServerWorkerPoolSize: UpDownCounter | undefined;
let authAttempt: Counter | undefined;

/**
 * OTel semantic convention: inbound request duration in SECONDS.
 * Availability and 5xx error rate are derived from its
 * http.response.status_code / error.type attributes.
 */
export function getHttpServerRequestDuration(): Histogram {
  if (!httpServerRequestDuration) {
    httpServerRequestDuration = getMeter().createHistogram(
      'http.server.request.duration',
      {
        description: 'Duration of inbound HTTP requests',
        unit: 's'
      }
    );
  }

  return httpServerRequestDuration;
}

/** Throughput broken down by route and tenant cohort. */
export function getHttpServerRequests(): Counter {
  if (!httpServerRequests) {
    httpServerRequests = getMeter().createCounter('http.server.requests', {
      description: 'Inbound HTTP requests by route and tenant cohort'
    });
  }

  return httpServerRequests;
}

/** Saturation: in-flight requests (goes up AND down -> UpDownCounter). */
export function getHttpServerActiveRequests(): UpDownCounter {
  if (!httpServerActiveRequests) {
    httpServerActiveRequests = getMeter().createUpDownCounter(
      'http.server.active_requests',
      {
        description: 'Number of inbound HTTP requests currently being handled'
      }
    );
  }

  return httpServerActiveRequests;
}

/** Saturation denominator: the configured worker pool size. */
export function getHttpServerWorkerPoolSize(): UpDownCounter {
  if (!httpServerWorkerPoolSize) {
    httpServerWorkerPoolSize = getMeter().createUpDownCounter(
      'http.server.worker_pool.size',
      {
        description: 'Configured worker pool size available to handle requests'
      }
    );
  }

  return httpServerWorkerPoolSize;
}

/** Authentication / authorization decisions. */
export function getAuthAttempt(): Counter {
  if (!authAttempt) {
    authAttempt = getMeter().createCounter('auth.attempt', {
      description: 'Authentication and authorization decisions by outcome'
    });
  }

  return authAttempt;
}

let workerPoolSizeReported = false;

/**
 * Publishes the configured worker pool size exactly once so that saturation
 * (active_requests / worker_pool.size) can be computed directly.
 */
export function reportWorkerPoolSize() {
  if (workerPoolSizeReported) {
    return;
  }

  workerPoolSizeReported = true;

  const poolSize =
    Number.parseInt(process.env.UV_THREADPOOL_SIZE ?? '', 10) || 4;

  getHttpServerWorkerPoolSize().add(poolSize);
}

/** Throughput: every invocation of a business flow's entry point. */
export function getFlowEntries(): Counter {
  if (!flowEntries) {
    flowEntries = getMeter().createCounter('flow.entries', {
      description: 'Business flow entry point invocations'
    });
  }

  return flowEntries;
}

/** Availability: terminal outcome of a business flow (success / failure). */
export function getFlowOutcomes(): Counter {
  if (!flowOutcomes) {
    flowOutcomes = getMeter().createCounter('flow.outcomes', {
      description: 'Terminal outcomes of a business flow by outcome'
    });
  }

  return flowOutcomes;
}

/** Latency: end-to-end duration of a business flow in SECONDS. */
export function getFlowDuration(): Histogram {
  if (!flowDuration) {
    flowDuration = getMeter().createHistogram('flow.duration', {
      description: 'End-to-end duration of a business flow',
      unit: 's'
    });
  }

  return flowDuration;
}

/** Freshness: wall-clock time from flow entry to its terminal state. */
export function getFlowEntryToTerminalDuration(): Histogram {
  if (!flowEntryToTerminalDuration) {
    flowEntryToTerminalDuration = getMeter().createHistogram(
      'flow.entry_to_terminal.duration',
      {
        description:
          'Wall-clock time between a business flow entry event and its terminal state',
        unit: 's'
      }
    );
  }

  return flowEntryToTerminalDuration;
}

/** Validation failure rate: outcome of each validation step of a flow. */
export function getFlowValidationOutcomes(): Counter {
  if (!flowValidationOutcomes) {
    flowValidationOutcomes = getMeter().createCounter(
      'flow.validation.outcomes',
      {
        description: 'Outcome of each validation step of a business flow'
      }
    );
  }

  return flowValidationOutcomes;
}

export function recordFlowEntry({
  flow,
  step
}: {
  flow: string;
  step: string;
}) {
  getFlowEntries().add(1, { flow, 'flow.step': step });
}

export function recordFlowValidation({
  flow,
  outcome,
  step
}: {
  flow: string;
  outcome: 'passed' | 'failed';
  step: string;
}) {
  getFlowValidationOutcomes().add(1, {
    flow,
    outcome,
    'flow.validation.step': step
  });
}

/**
 * Wraps a business flow's entry point: emits the entry counter, a root-ish
 * span for the flow, and on termination the outcome counter plus the latency
 * and entry-to-terminal (freshness) histograms.
 *
 * Behavior is preserved exactly: the original promise's value is returned and
 * the very same error is rethrown.
 */
export async function runFlow<T>(
  {
    flow,
    step,
    attributes = {}
  }: {
    flow: string;
    step: string;
    attributes?: Record<string, string | number | boolean>;
  },
  execute: () => Promise<T>
): Promise<T> {
  recordFlowEntry({ flow, step });

  const baseAttributes = { flow, 'flow.step': step, ...attributes };
  const startTime = performance.now();

  return trace
    .getTracer(OTEL_SCOPE_NAME)
    .startActiveSpan(`flow ${flow} ${step}`, { attributes: baseAttributes }, (span) => {
      const terminate = (
        outcome: 'success' | 'failure',
        errorType?: string
      ) => {
        const durationInSeconds = (performance.now() - startTime) / 1000;
        const outcomeAttributes = {
          ...baseAttributes,
          outcome,
          ...(errorType ? { 'error.type': errorType } : {})
        };

        getFlowOutcomes().add(1, outcomeAttributes);
        getFlowDuration().record(durationInSeconds, outcomeAttributes);
        getFlowEntryToTerminalDuration().record(
          durationInSeconds,
          outcomeAttributes
        );

        span.setAttribute('flow.outcome', outcome);

        if (errorType) {
          span.setAttribute('error.type', errorType);
          span.setStatus({ code: SpanStatusCode.ERROR });
        }

        span.end();
      };

      return execute().then(
        (result) => {
          terminate('success');

          return result;
        },
        (error) => {
          terminate('failure', error?.constructor?.name ?? 'Error');

          // Rethrow the very same error - propagation is unchanged
          throw error;
        }
      );
    });
}

export function recordAuthAttempt({
  method,
  outcome,
  reason
}: {
  method: string;
  outcome: 'granted' | 'denied';
  reason?: string;
}) {
  getAuthAttempt().add(1, {
    outcome,
    'auth.method': method,
    ...(reason ? { 'auth.denial_reason': reason } : {})
  });
}
