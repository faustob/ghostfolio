import * as telemetry from '@ghostfolio/api/telemetry/telemetry';

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Version
} from '@nestjs/common';

const DEVICE_CLASSES = new Set(['desktop', 'mobile', 'tablet', 'unknown']);
const VITAL_NAMES = new Set(['cls', 'inp', 'lcp']);

export interface RumBeaconDto {
  deviceType?: string;
  errorType?: string;
  name?: string;
  route?: string;
  type?: string;
  value?: number;
}

/**
 * Keeps the metric dimensions low cardinality: only the route TEMPLATE the
 * client already resolved (a leading slash plus known path segments), never a
 * raw path containing identifiers.
 */
function sanitizeRoute(route?: string): string {
  if (!route || route.length > 64 || !/^\/[a-z0-9\-/]*$/i.test(route)) {
    return 'unknown';
  }

  return route;
}

function sanitizeDeviceType(deviceType?: string): string {
  return DEVICE_CLASSES.has(deviceType) ? deviceType : 'unknown';
}

/** The error CLASS only - never the message and never a stack trace. */
function sanitizeErrorType(errorType?: string): string {
  if (
    !errorType ||
    errorType.length > 48 ||
    !/^[A-Za-z0-9_]+$/.test(errorType)
  ) {
    return 'Error';
  }

  return errorType;
}

/**
 * Collects real user monitoring beacons from the Angular client.
 *
 * `main.ts` calls `app.setGlobalPrefix('api')` and
 * `app.enableVersioning({ defaultVersion: '1', type: VersioningType.URI })`, so
 * this controller is served at `/api/v1/rum`. The `@Version('1')` decorator
 * pins the URI version explicitly rather than relying on the default, which is
 * exactly the URL the browser reporter beacons to.
 */
@Controller('rum')
export class RumController {
  @Post()
  @Version('1')
  @HttpCode(HttpStatus.NO_CONTENT)
  public collect(@Body() beacon: RumBeaconDto) {
    const deviceType = sanitizeDeviceType(beacon?.deviceType);
    const route = sanitizeRoute(beacon?.route);

    if (beacon?.type === 'js-error') {
      telemetry.recordWebError({
        deviceType,
        route,
        errorType: sanitizeErrorType(beacon?.errorType)
      });

      return;
    }

    if (typeof beacon?.value !== 'number' || !Number.isFinite(beacon.value)) {
      return;
    }

    if (beacon?.type === 'route-change') {
      telemetry.recordWebNavigation({
        deviceType,
        route,
        value: beacon.value
      });

      return;
    }

    if (beacon?.type === 'web-vital' && VITAL_NAMES.has(beacon?.name)) {
      telemetry.recordWebVital({
        deviceType,
        route,
        name: beacon.name as 'cls' | 'inp' | 'lcp',
        value: beacon.value
      });
    }
  }
}
