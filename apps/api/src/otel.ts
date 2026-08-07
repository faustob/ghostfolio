import { diag, DiagConsoleLogger, DiagLogLevel, metrics } from '@opentelemetry/api';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

if (process.env.OTEL_LOG_LEVEL === 'debug') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

// Defensive: if an OTel language agent (e.g. --require @opentelemetry/auto-instrumentations-node/register)
// is already attached, a global MeterProvider is registered and we must NOT start a second SDK.
const existingProviderName = metrics.getMeterProvider()?.constructor?.name;
const hasGlobalProvider =
  !!existingProviderName && existingProviderName !== 'NoopMeterProvider';

if (!hasGlobalProvider && !process.env.GHOSTFOLIO_OTEL_DISABLED) {
  // Endpoint stays env-driven via OTEL_EXPORTER_OTLP_ENDPOINT (never hardcoded)
  const sdk = new NodeSDK({
    instrumentations: [getNodeAutoInstrumentations()],
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter()
    }),
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'ghostfolio-api',
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? 'unknown'
    }),
    traceExporter: new OTLPTraceExporter()
  });

  try {
    // Runs synchronously at module load, i.e. before bootstrap() builds the Nest
    // DI container, so the global MeterProvider is registered first
    sdk.start();

    process.once('SIGTERM', () => {
      void sdk.shutdown().catch(() => {
        // Ignore shutdown errors so the process can exit
      });
    });
  } catch (error) {
    // Tolerate an already-registered global provider (agent attached at runtime)
    console.warn('[otel] SDK not started:', (error as Error)?.message);
  }
}
