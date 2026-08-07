/**
 * OpenTelemetry bootstrap for the Ghostfolio API.
 *
 * This module is imported as the FIRST statement of `apps/api/src/main.ts`, so
 * the SDK is registered as the global provider before any instrumented module
 * (HTTP server, Prisma, Redis, ...) is loaded. Everything that later calls
 * `metrics.getMeter(...)` / `trace.getTracer(...)` from `@opentelemetry/api`
 * therefore binds to a real provider instead of a no-op.
 *
 * The auto-instrumentations provide the standard semantic-convention HTTP
 * server/client and database telemetry (`http.server.request.duration`,
 * `http.client.request.duration`, `db.client.operation.duration`) with the
 * standard low-cardinality attributes, so no hand-rolled middleware is needed.
 */
import { diag, DiagConsoleLogger, DiagLogLevel } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION
} from '@opentelemetry/semantic-conventions';

if (process.env.OTEL_LOG_LEVEL === 'debug') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

// An OTel language agent (`--require @opentelemetry/auto-instrumentations-node/register`
// or a vendor preload) may already have registered a global SDK from outside
// the repository. Registering a second one would leak a duplicate exporter, so
// detect it and keep the agent's provider instead.
const hasPreRegisteredSdk =
  Boolean(process.env.OTEL_SDK_DISABLED === 'true') ||
  Boolean((globalThis as Record<string, unknown>)['__ghostfolioOtelStarted']);

if (!hasPreRegisteredSdk) {
  (globalThis as Record<string, unknown>)['__ghostfolioOtelStarted'] = true;

  try {
    const sdk = new NodeSDK({
      instrumentations: [getNodeAutoInstrumentations()],
      metricReader: new PeriodicExportingMetricReader({
        // Endpoint resolved from OTEL_EXPORTER_OTLP_ENDPOINT /
        // OTEL_EXPORTER_OTLP_METRICS_ENDPOINT — never hardcoded.
        exporter: new OTLPMetricExporter()
      }),
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]:
          process.env.OTEL_SERVICE_NAME || 'ghostfolio-api',
        [ATTR_SERVICE_VERSION]: process.env.npm_package_version
      }),
      // Endpoint resolved from OTEL_EXPORTER_OTLP_ENDPOINT /
      // OTEL_EXPORTER_OTLP_TRACES_ENDPOINT — never hardcoded.
      traceExporter: new OTLPTraceExporter()
    });

    sdk.start();

    process.once('SIGTERM', () => {
      void sdk.shutdown().catch(() => {
        // Ignore shutdown errors so they never mask the real exit reason
      });
    });
  } catch (error) {
    // Tolerate an already-registered global provider (agent attached at
    // runtime): log and continue with whatever provider is in place so the
    // application always starts.
    diag.warn(
      `OpenTelemetry SDK was not started: ${
        error instanceof Error ? error.name : 'UnknownError'
      }`
    );
  }
}
