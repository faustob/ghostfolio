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
let webVitalLcp: Histogram | undefined;
let webVitalInp: Histogram | undefined;
let webVitalCls: Histogram | undefined;
let webErrorCount: Counter | undefined;
let webNavigationDuration: Histogram | undefined;

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
 * Browser RUM instruments.
 *
 * They follow the same dot-separated, semantic-convention-shaped scheme as the
 * existing http.server.* corpus: one `web.` domain prefix, a singular noun and
 * the measurement last, plain counts unsuffixed and durations carrying their
 * unit in the instrument's unit field (never in the name).
 */

/** Core Web Vital: Largest Contentful Paint, reported by the browser. */
export function getWebVitalLcp(): Histogram {
  if (!webVitalLcp) {
    webVitalLcp = getMeter().createHistogram('web.vital.lcp', {
      description: 'Largest Contentful Paint reported by real user sessions',
      unit: 'ms'
    });
  }

  return webVitalLcp;
}

/** Core Web Vital: Interaction to Next Paint, reported by the browser. */
export function getWebVitalInp(): Histogram {
  if (!webVitalInp) {
    webVitalInp = getMeter().createHistogram('web.vital.inp', {
      description: 'Interaction to Next Paint reported by real user sessions',
      unit: 'ms'
    });
  }

  return webVitalInp;
}

/** Core Web Vital: Cumulative Layout Shift - a unitless score, not a latency. */
export function getWebVitalCls(): Histogram {
  if (!webVitalCls) {
    webVitalCls = getMeter().createHistogram('web.vital.cls', {
      description: 'Cumulative Layout Shift reported by real user sessions',
      unit: '1'
    });
  }

  return webVitalCls;
}

/** Unhandled client-side JavaScript errors reported by the browser. */
export function getWebErrorCount(): Counter {
  if (!webErrorCount) {
    webErrorCount = getMeter().createCounter('web.error.count', {
      description: 'Unhandled JavaScript errors reported by the browser'
    });
  }

  return webErrorCount;
}

/** SPA soft-navigation (route transition) duration. */
export function getWebNavigationDuration(): Histogram {
  if (!webNavigationDuration) {
    webNavigationDuration = getMeter().createHistogram(
      'web.navigation.duration',
      {
        description: 'Duration of SPA soft navigations in the browser',
        unit: 'ms'
      }
    );
  }

  return webNavigationDuration;
}

/**
 * Records one browser RUM measurement reported by the Angular client.
 *
 * `route` MUST be the low-cardinality route TEMPLATE (never the raw path with
 * identifiers) and `deviceType` the device class, so the Core Web Vitals can be
 * segmented as the archetype requires.
 */
export function recordWebVital({
  deviceType,
  name,
  route,
  value
}: {
  deviceType?: string;
  name: 'cls' | 'inp' | 'lcp';
  route: string;
  value: number;
}) {
  const attributes = {
    'device.class': deviceType ?? 'unknown',
    'web.route': route
  };

  if (name === 'lcp') {
    getWebVitalLcp().record(value, attributes);
  } else if (name === 'inp') {
    getWebVitalInp().record(value, attributes);
  } else {
    getWebVitalCls().record(value, attributes);
  }
}

/** Records an unhandled browser JavaScript error (error CLASS, never message). */
export function recordWebError({
  deviceType,
  errorType,
  route
}: {
  deviceType?: string;
  errorType?: string;
  route: string;
}) {
  getWebErrorCount().add(1, {
    'device.class': deviceType ?? 'unknown',
    'error.type': errorType ?? 'Error',
    'web.route': route
  });
}

/** Records an SPA route-transition duration tagged with the destination route. */
export function recordWebNavigation({
  deviceType,
  route,
  value
}: {
  deviceType?: string;
  route: string;
  value: number;
}) {
  getWebNavigationDuration().record(value, {
    'device.class': deviceType ?? 'unknown',
    'web.route': route
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
