import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import * as otelApi from '@opentelemetry/api';
import { StatusCodes } from 'http-status-codes';

import * as telemetry from '../../../telemetry/telemetry';
import { WebVitalsReportDto } from './web-vitals.dto';

/**
 * Ingests real user monitoring (RUM) reports from the Angular client and
 * records them with the SERVER meter, which is bound to the OpenTelemetry SDK
 * registered at startup by `apps/api/src/otel.ts`.
 *
 * The browser cannot record these itself: no SDK is registered there, so
 * `metrics.getMeter()` would resolve to a no-op provider.
 */
@Controller('web-vitals')
export class WebVitalsController {
  @Post()
  @HttpCode(StatusCodes.NO_CONTENT)
  public reportWebVitals(@Body() report: WebVitalsReportDto) {
    const { deviceType, errorType, metric, route, traceParent, type, value } =
      report;

    // The browser sends a W3C traceparent for soft navigations. Extracting it
    // makes the route-transition span a CHILD of the browser navigation trace,
    // which is what lets an on-call engineer jump from a slow transition to the
    // /api/v1/portfolio server span (and its Prisma/market-data children).
    if (type === 'vital' && metric === 'route-change' && traceParent) {
      const parentContext = otelApi.propagation.extract(
        otelApi.context.active(),
        { traceparent: traceParent }
      );

      const navigationSpan = otelApi.trace
        .getTracer(telemetry.OTEL_SCOPE_NAME)
        .startSpan(
          'browser route change',
          {
            attributes: {
              'url.template': route,
              ...(deviceType ? { 'device.type': deviceType } : {}),
              ...(typeof value === 'number'
                ? { 'web.route_change.duration_ms': value }
                : {})
            },
            kind: otelApi.SpanKind.CLIENT
          },
          parentContext
        );

      navigationSpan.end();
    }

    if (type === 'session-start') {
      telemetry.recordWebSessionStart({ deviceType, route });
    } else if (type === 'js-error') {
      telemetry.recordWebJsError({
        deviceType,
        route,
        errorType: errorType ?? 'Error'
      });
    } else if (type === 'vital' && metric && typeof value === 'number') {
      telemetry.recordWebVital({ deviceType, metric, route, value });
    }
  }
}
