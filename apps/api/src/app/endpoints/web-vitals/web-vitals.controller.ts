import { Body, Controller, HttpCode, Post } from '@nestjs/common';
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
    const { deviceType, errorType, metric, route, type, value } = report;

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
