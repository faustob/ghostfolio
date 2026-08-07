/**
 * Single definition site for the API's custom OpenTelemetry instruments.
 *
 * The SDK is registered at startup by `apps/api/src/otel.ts` (imported as the
 * first line of `main.ts`). Because OTel-JS does NOT rebind meters obtained
 * before registration, every instrument here is created LAZILY on first use
 * (memoised), so it always binds to the registered MeterProvider.
 */
import { metrics } from '@opentelemetry/api';
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
let httpServerActiveRequests: UpDownCounter | undefined;
let httpServerWorkerPoolSize: UpDownCounter | undefined;
let authAttempt: Counter | undefined;
let flowEntry: Counter | undefined;
let flowOutcome: Counter | undefined;
let flowDuration: Histogram | undefined;
let flowEntryToTerminalDuration: Histogram | undefined;
let flowValidationOutcome: Counter | undefined;
let webVitalDuration: Histogram | undefined;
let webVitalScore: Histogram | undefined;
let webJsErrors: Counter | undefined;
let webSessions: Counter | undefined;

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

/**
 * Throughput: incremented at the flow entry point, whatever the outcome.
 * Singular count name to match the existing `auth.attempt` convention.
 */
export function getFlowEntry(): Counter {
  if (!flowEntry) {
    flowEntry = getMeter().createCounter('flow.entry', {
      description: 'Business flow invocations counted at the entry point'
    });
  }

  return flowEntry;
}

/** Availability: terminal outcome of a business flow (success / failure). */
export function getFlowOutcome(): Counter {
  if (!flowOutcome) {
    flowOutcome = getMeter().createCounter('flow.outcome', {
      description: 'Terminal outcomes of a business flow by outcome'
    });
  }

  return flowOutcome;
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

/** Freshness: entry event to terminal state transition, in SECONDS. */
export function getFlowEntryToTerminalDuration(): Histogram {
  if (!flowEntryToTerminalDuration) {
    flowEntryToTerminalDuration = getMeter().createHistogram(
      'flow.entry_to_terminal.duration',
      {
        description:
          'Wall-clock time between the flow entry event and its terminal state transition',
        unit: 's'
      }
    );
  }

  return flowEntryToTerminalDuration;
}

/** Error rate: outcome of each validation step of a business flow. */
export function getFlowValidationOutcome(): Counter {
  if (!flowValidationOutcome) {
    flowValidationOutcome = getMeter().createCounter(
      'flow.validation.outcome',
      {
        description: 'Outcomes of the validation steps of a business flow'
      }
    );
  }

  return flowValidationOutcome;
}

/** Records the entry of a business flow (throughput denominator). */
export function recordFlowEntry({ flow }: { flow: string }) {
  getFlowEntry().add(1, { flow });
}

/**
 * Records the terminal state of a business flow: the outcome counter
 * (availability), the flow duration (latency) and the entry-to-terminal
 * duration (freshness).
 */
export function recordFlowOutcome({
  durationInSeconds,
  errorType,
  flow,
  outcome
}: {
  durationInSeconds: number;
  errorType?: string;
  flow: string;
  outcome: 'success' | 'failure';
}) {
  const attributes = {
    flow,
    outcome,
    ...(errorType ? { 'error.type': errorType } : {})
  };

  getFlowOutcome().add(1, attributes);
  getFlowDuration().record(durationInSeconds, attributes);
  getFlowEntryToTerminalDuration().record(durationInSeconds, attributes);
}

/** Records the outcome of a single validation step of a business flow. */
export function recordFlowValidationOutcome({
  errorType,
  flow,
  outcome,
  step
}: {
  errorType?: string;
  flow: string;
  // 'success' | 'failure' is the canonical vocabulary shared with
  // recordFlowOutcome; 'passed' | 'failed' stays valid for existing callers
  outcome: 'passed' | 'failed' | 'success' | 'failure';
  step: string;
}) {
  getFlowValidationOutcome().add(1, {
    flow,
    outcome,
    'flow.validation.step': step,
    ...(errorType ? { 'error.type': errorType } : {})
  });
}

/**
 * Browser RUM latency vitals in MILLISECONDS (LCP, INP and the SPA
 * route-transition time). CLS is unitless and therefore uses its own
 * histogram below rather than sharing this instrument's `ms` unit.
 */
export function getWebVitalDuration(): Histogram {
  if (!webVitalDuration) {
    webVitalDuration = getMeter().createHistogram('web.vital.duration', {
      description:
        'Browser real user monitoring latency vitals (LCP, INP, SPA route transitions)',
      unit: 'ms'
    });
  }

  return webVitalDuration;
}

/** Browser RUM unitless vitals (CLS is a visual-stability score, not a time). */
export function getWebVitalScore(): Histogram {
  if (!webVitalScore) {
    webVitalScore = getMeter().createHistogram('web.vital.score', {
      description: 'Browser real user monitoring unitless vitals (CLS)'
    });
  }

  return webVitalScore;
}

/** Error rate numerator: unhandled client-side JavaScript errors. */
export function getWebJsErrors(): Counter {
  if (!webJsErrors) {
    webJsErrors = getMeter().createCounter('web.js.errors', {
      description: 'Unhandled JavaScript errors reported by the browser'
    });
  }

  return webJsErrors;
}

/** Error rate denominator: browser sessions that started. */
export function getWebSessions(): Counter {
  if (!webSessions) {
    webSessions = getMeter().createCounter('web.sessions', {
      description: 'Browser sessions started, the JS error rate denominator'
    });
  }

  return webSessions;
}

/**
 * Records one Core Web Vital / SPA route-transition sample reported by the
 * browser. `metric` is the low-cardinality vital name (CLS, INP, LCP,
 * route-change) and `route` is the Angular route TEMPLATE, never a raw URL.
 */
export function recordWebVital({
  deviceType,
  metric,
  route,
  value
}: {
  deviceType?: string;
  metric: string;
  route: string;
  value: number;
}) {
  const attributes = {
    'http.route': route,
    'web.vital.name': metric,
    ...(deviceType ? { 'device.type': deviceType } : {})
  };

  // CLS is a unitless visual-stability score; every other vital is a duration
  if (metric === 'CLS') {
    getWebVitalScore().record(value, attributes);
  } else {
    getWebVitalDuration().record(value, attributes);
  }
}

/** Records an unhandled browser JavaScript error (error CLASS, no message). */
export function recordWebJsError({
  deviceType,
  errorType,
  route
}: {
  deviceType?: string;
  errorType: string;
  route: string;
}) {
  getWebJsErrors().add(1, {
    'error.type': errorType,
    'http.route': route,
    ...(deviceType ? { 'device.type': deviceType } : {})
  });
}

/** Records the start of a browser session (JS error rate denominator). */
export function recordWebSessionStart({
  deviceType,
  route
}: {
  deviceType?: string;
  route: string;
}) {
  getWebSessions().add(1, {
    'http.route': route,
    ...(deviceType ? { 'device.type': deviceType } : {})
  });
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
