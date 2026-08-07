/**
 * OpenTelemetry SDK bootstrap for the Ghostfolio API.
 *
 * This module registers the OpenTelemetry SDK as the GLOBAL instance at
 * process startup. It is imported as the FIRST import of `apps/api/src/main.ts`
 * so that every meter/tracer resolved via `@opentelemetry/api` afterwards is
 * bound to a real (non no-op) provider.
 *
 * The exporter endpoint is env-driven (OTEL_EXPORTER_OTLP_ENDPOINT). The SDK is
 * started unconditionally; if an OpenTelemetry agent is already attached, the
 * failing registration is caught and logged so the application still starts.
 */
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import * as semconv from '@opentelemetry/semantic-conventions';

// Registration site for the global OTel SDK used by the business-flow
// instrumentation in apps/api/src/telemetry/telemetry.ts and by the
// portfolio performance/allocation view flow spans.
const serviceName = process.env.OTEL_SERVICE_NAME ?? 'ghostfolio-api';

let sdk: NodeSDK | undefined;

try {
  sdk = new NodeSDK({
    instrumentations: [
      getNodeAutoInstrumentations({
        // Filesystem spans are extremely noisy for an HTTP API
        '@opentelemetry/instrumentation-fs': { enabled: false }
      })
    ],
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter()
    }),
    resource: resourceFromAttributes({
      [semconv.ATTR_SERVICE_NAME]: serviceName,
      [semconv.ATTR_SERVICE_VERSION]:
        process.env.npm_package_version ?? 'unknown'
    }),
    traceExporter: new OTLPTraceExporter()
  });

  sdk.start();

  process.once('SIGTERM', () => {
    void sdk?.shutdown();
  });
} catch (error) {
  // An OpenTelemetry agent may already have registered a global SDK. Continue
  // with the provider it installed rather than preventing startup.
  // eslint-disable-next-line no-console
  console.warn(
    '[otel] Could not start the OpenTelemetry SDK; continuing with the already registered provider',
    error
  );
}

export { sdk };
