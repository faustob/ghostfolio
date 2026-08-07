import { Attributes, Counter, Histogram, metrics, Tracer, trace } from '@opentelemetry/api';

/**
 * Shared OpenTelemetry instruments for the "Import and Record Investment
 * Activities" business flow.
 *
 * The meter and every instrument are resolved LAZILY on first record. OTel-JS
 * has no proxy meter provider: a meter obtained before the SDK is registered
 * returns a NoopMeter whose instruments never rebind. Resolving on first use
 * guarantees the instruments bind to the provider registered by
 * apps/api/src/otel.ts (imported as the first line of apps/api/src/main.ts).
 *
 * Each instrument is defined exactly once here and recorded at its real
 * measurement point (import controller / import service).
 */
export const IMPORT_FLOW_NAME = 'portfolio.activity.import';

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? 'ghostfolio-api';

let importFlowEntriesCounter: Counter;
let importFlowOutcomesCounter: Counter;
let importFlowDurationHistogram: Histogram;
let importValidationOutcomesCounter: Counter;

function getMeter() {
  return metrics.getMeter(SERVICE_NAME);
}

/** Tracer for the import flow root span (traces DO rebind via the proxy provider). */
export function getImportFlowTracer(): Tracer {
  return trace.getTracer(SERVICE_NAME);
}

/**
 * Throughput: incremented every time the import flow entry point is invoked,
 * independent of its eventual outcome.
 */
export function recordImportFlowEntry(attributes: Attributes) {
  importFlowEntriesCounter ??= getMeter().createCounter(
    'portfolio.activity.import.entries',
    {
      description:
        'Number of times the portfolio activity import flow entry point has been invoked, independent of its outcome'
    }
  );

  importFlowEntriesCounter.add(1, attributes);
}

/** Success rate: terminal outcome of the import flow (success / failure). */
export function recordImportFlowOutcome(attributes: Attributes) {
  importFlowOutcomesCounter ??= getMeter().createCounter(
    'portfolio.activity.import.outcomes',
    {
      description:
        'Terminal outcomes of the portfolio activity import business flow'
    }
  );

  importFlowOutcomesCounter.add(1, attributes);
}

/**
 * Latency and freshness: wall-clock duration in SECONDS between the flow entry
 * event and its terminal state transition.
 */
export function recordImportFlowDuration(
  durationInSeconds: number,
  attributes: Attributes
) {
  importFlowDurationHistogram ??= getMeter().createHistogram(
    'portfolio.activity.import.duration',
    {
      description:
        'Wall-clock duration between the portfolio activity import flow entry event and its terminal state transition',
      unit: 's'
    }
  );

  importFlowDurationHistogram.record(durationInSeconds, attributes);
}

/** Validation failure rate: outcome per validation step of the import flow. */
export function recordImportValidationOutcome(attributes: Attributes) {
  importValidationOutcomesCounter ??= getMeter().createCounter(
    'portfolio.activity.import.validation.outcomes',
    {
      description:
        'Outcomes (passed / failed) of the portfolio activity import validation steps'
    }
  );

  importValidationOutcomesCounter.add(1, attributes);
}
