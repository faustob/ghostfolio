/**
 * Telemetry for the "View Portfolio Performance and Allocation" business flow.
 *
 * The meter and every instrument for this flow are defined EXACTLY ONCE here
 * and recorded from the real measurement sites in `portfolio.controller.ts`
 * (the flow's HTTP entry points). The SDK that backs these instruments is
 * registered at startup by `apps/api/src/otel.ts`.
 *
 * IMPORTANT (binding order): OTel-JS has no proxy provider for METRICS —
 * `metrics.getMeter()` called before the SDK registers returns a NoopMeter
 * whose instruments are constant no-op singletons that never rebind. This
 * module is imported transitively by the Nest module graph, which may load
 * before/independently of the bootstrap, so every instrument here is resolved
 * LAZILY on first record via a memoised getter. By then `sdk.start()` has run
 * and the instruments bind to the real, registered provider.
 */
import {
  context,
  metrics,
  trace,
  Counter,
  Histogram,
  Span,
  SpanStatusCode
} from '@opentelemetry/api';

export const PORTFOLIO_FLOW_NAME = 'portfolio.performance.view';

const INSTRUMENTATION_SCOPE = 'ghostfolio.api.portfolio-flow';

interface PortfolioFlowInstruments {
  flowDuration: Histogram;
  flowEntries: Counter;
  flowOutcomes: Counter;
  flowValidationOutcomes: Counter;
}

let instruments: PortfolioFlowInstruments;

/**
 * Resolves the meter and the flow instruments on first use (memoised), so they
 * bind to the SDK registered at startup instead of the import-time no-op.
 */
function getInstruments(): PortfolioFlowInstruments {
  if (!instruments) {
    const meter = metrics.getMeter(INSTRUMENTATION_SCOPE);

    instruments = {
      /**
       * Latency: wall-clock duration of the flow, in SECONDS.
       * histogram_quantile(0.95, portfolio.flow.duration)
       */
      flowDuration: meter.createHistogram('portfolio.flow.duration', {
        description:
          'Duration of the portfolio performance/allocation flow, from entry to terminal state',
        unit: 's'
      }),

      /**
       * Throughput: incremented on every invocation of the flow's entry point,
       * independent of its eventual outcome.
       * rate(portfolio.flow.entries[1h])
       */
      flowEntries: meter.createCounter('portfolio.flow.entries', {
        description:
          'Number of times the portfolio performance/allocation flow was entered'
      }),

      /**
       * Success rate: terminal outcome of the flow.
       * count(portfolio.flow.outcomes{outcome="success"}) / count(portfolio.flow.outcomes)
       */
      flowOutcomes: meter.createCounter('portfolio.flow.outcomes', {
        description:
          'Terminal outcomes of the portfolio performance/allocation flow'
      }),

      /**
       * Validation failure rate.
       * count(portfolio.flow.validation.outcomes{outcome="failed"})
       *   / count(portfolio.flow.validation.outcomes)
       */
      flowValidationOutcomes: meter.createCounter(
        'portfolio.flow.validation.outcomes',
        {
          description:
            'Per-step validation outcomes within the portfolio performance/allocation flow'
        }
      )
    };
  }

  return instruments;
}

function errorType(error: unknown): string {
  // Error CLASS only — never the message (low cardinality).
  if (error instanceof Error) {
    return error.name;
  }

  return 'UnknownError';
}

/**
 * Records the per-step validation outcome of the currently running flow. Sets
 * the pass/fail attribute on the active span too, so each step is visible in
 * the trace alongside the shared flow id.
 */
export function recordPortfolioFlowValidation({
  passed,
  step
}: {
  passed: boolean;
  step: string;
}) {
  const outcome = passed ? 'passed' : 'failed';

  getInstruments().flowValidationOutcomes.add(1, {
    outcome,
    step,
    flow: PORTFOLIO_FLOW_NAME
  });

  const activeSpan = trace.getSpan(context.active());

  activeSpan?.setAttribute(`flow.validation.${step}.outcome`, outcome);
}

/**
 * Runs the flow's entry point inside a root span and records the entry,
 * outcome and latency signals. Behavior is preserved exactly: the callback's
 * value is returned untouched and any error is RETHROWN unchanged.
 */
export async function runPortfolioFlow<T>(
  { step }: { step: string },
  callback: () => Promise<T>
): Promise<T> {
  const { flowDuration, flowEntries, flowOutcomes } = getInstruments();

  const startTime = performance.now();

  flowEntries.add(1, { step, flow: PORTFOLIO_FLOW_NAME });

  return trace
    .getTracer(INSTRUMENTATION_SCOPE)
    .startActiveSpan(
      `${PORTFOLIO_FLOW_NAME}.${step}`,
      async (span: Span) => {
        span.setAttribute('flow', PORTFOLIO_FLOW_NAME);
        span.setAttribute('flow.step', step);

        let outcome = 'success';
        let failureType: string;

        try {
          const result = await callback();

          // Success outcome is recorded only AFTER the awaited call returns.
          return result;
        } catch (error) {
          outcome = 'failure';
          failureType = errorType(error);

          span.setStatus({ code: SpanStatusCode.ERROR });
          span.setAttribute('error.type', failureType);

          // Rethrow the SAME error — propagation is unchanged.
          throw error;
        } finally {
          const durationInSeconds = (performance.now() - startTime) / 1000;

          const attributes = {
            outcome,
            step,
            flow: PORTFOLIO_FLOW_NAME,
            ...(failureType ? { 'error.type': failureType } : {})
          };

          flowOutcomes.add(1, attributes);
          flowDuration.record(durationInSeconds, attributes);

          span.end();
        }
      }
    );
}
