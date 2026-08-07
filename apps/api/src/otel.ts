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

/**
 * OpenTelemetry bootstrap for the Ghostfolio API.
 *
 * This module is imported as the FIRST line of apps/api/src/main.ts so the SDK
 * is registered as the global provider before any instrumented module runs.
 *
 * The OTLP endpoint is env-driven (OTEL_EXPORTER_OTLP_ENDPOINT); nothing is
 * hardcoded. If an OpenTelemetry language agent is already attached (which
 * registers its own global SDK), starting a second SDK is tolerated and logged
 * instead of crashing the process at startup.
 */
if (process.env.OTEL_DIAG_LOG_LEVEL === 'debug') {
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
}

const isDisabled =
  process.env.OTEL_SDK_DISABLED === 'true' ||
  // An attached agent registers the global SDK itself
  Boolean(process.env.OTEL_AGENT_ATTACHED);

if (!isDisabled) {
  try {
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

    sdk.start();

    process.once('SIGTERM', () => {
      void sdk.shutdown().catch(() => {
        // Ignore shutdown errors during process termination
      });
    });
  } catch (error) {
    // Tolerate an already-registered global provider (e.g. an OTel agent
    // attached via deployment configuration) instead of crashing at startup
    console.warn(
      `[otel] Skipping SDK registration: ${(error as Error)?.message}`
    );
  }
}
