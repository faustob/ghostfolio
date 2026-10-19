import { Histogram, metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader
} from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { onCLS, onINP, onLCP } from 'web-vitals';

// Browser-side RUM telemetry: registers its own MeterProvider (the server's
// OTel SDK does not extend into the browser process) and reports Core Web
// Vitals, JS error rate and SPA route-transition timing.

let initialized = false;
let navigationStartTimestamp = performance.now();
let hasErrorThisPageLoad = false;
let pageLoadRecorded = false;
let errorSessionRecorded = false;

let routeChangeDurationHistogram: Histogram | undefined;

const otlpEndpoint =
  (window as any).__OTEL_EXPORTER_OTLP_ENDPOINT__ ??
  `${window.location.origin}/api/v1/otel/v1/metrics`;

export function initBrowserTelemetry() {
  if (initialized) {
    return;
  }

  initialized = true;

  const meterProvider = new MeterProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: 'ghostfolio-client'
    }),
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: otlpEndpoint }),
        exportIntervalMillis: 10000
      })
    ]
  });

  metrics.setGlobalMeterProvider(meterProvider);

  const meter = metrics.getMeter('ghostfolio-client-web');

  const lcpHistogram = meter.createHistogram('web.vital.lcp', { unit: 'ms' });
  const inpHistogram = meter.createHistogram('web.vital.inp', { unit: 'ms' });
  const clsHistogram = meter.createHistogram('web.vital.cls');
  const jsErrorsCounter = meter.createCounter('web.js_errors');
  const jsErrorSessionsCounter = meter.createCounter(
    'web.js_error_sessions'
  );
  const pageLoadsCounter = meter.createCounter('web.page_loads');

  routeChangeDurationHistogram = meter.createHistogram(
    'web.route_change.duration',
    { unit: 'ms' }
  );

  onLCP(({ value }) => {
    lcpHistogram.record(value, { 'url.path': window.location.pathname });
  });

  onINP(({ value }) => {
    inpHistogram.record(value, { 'url.path': window.location.pathname });
  });

  onCLS(({ value }) => {
    clsHistogram.record(value, { 'url.path': window.location.pathname });
  });

  window.addEventListener('error', () => {
    hasErrorThisPageLoad = true;
    jsErrorsCounter.add(1, { 'url.path': window.location.pathname });

    if (!errorSessionRecorded) {
      errorSessionRecorded = true;
      jsErrorSessionsCounter.add(1);
    }
  });

  window.addEventListener('unhandledrejection', () => {
    hasErrorThisPageLoad = true;
    jsErrorsCounter.add(1, { 'url.path': window.location.pathname });

    if (!errorSessionRecorded) {
      errorSessionRecorded = true;
      jsErrorSessionsCounter.add(1);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !pageLoadRecorded) {
      pageLoadRecorded = true;
      pageLoadsCounter.add(1, {
        has_js_error: String(hasErrorThisPageLoad)
      });
    }
  });
}

/**
 * Subscribes to Router navigation events so every SPA transition's start
 * timestamp is captured, and records route-change duration generically on
 * NavigationEnd for every soft navigation (not just a single route), tagged
 * with the resolved route TEMPLATE (never the raw URL) to keep the metric
 * low-cardinality.
 */
export function subscribeRouterNavigationTiming(router: Router) {
  router.events.subscribe((event) => {
    if (event instanceof NavigationStart) {
      navigationStartTimestamp = performance.now();
    } else if (event instanceof NavigationEnd) {
      const routeTemplate =
        router.routerState.snapshot.root.firstChild?.routeConfig?.path ??
        router.routerState.snapshot.url;

      routeChangeDurationHistogram?.record(
        performance.now() - navigationStartTimestamp,
        { route: routeTemplate }
      );
    }
  });
}

// NOTE: a same-origin server route (e.g. /api/v1/otel/v1/metrics) must exist
// to proxy these OTLP metric POSTs from the browser to the collector
// configured via OTEL_EXPORTER_OTLP_ENDPOINT on the server, since browsers
// cannot reach the collector directly (CORS/network boundary). Confirm this
// proxy route is implemented server-side.

/**
 * Records the elapsed time since the last navigation start as the SPA
 * route-transition duration, tagged with the destination route TEMPLATE
 * (never the raw URL) to keep the metric low-cardinality.
 */
export function recordRouteChangeDuration(routeTemplate: string) {
  routeChangeDurationHistogram?.record(
    performance.now() - navigationStartTimestamp,
    { route: routeTemplate }
  );
}
