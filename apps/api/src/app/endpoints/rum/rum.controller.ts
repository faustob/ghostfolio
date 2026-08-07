import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { RumBeaconDto } from './rum-beacon.dto';
import { RumMetricsService } from './rum-metrics.service';

@Controller('rum')
export class RumController {
  public constructor(private readonly rumMetricsService: RumMetricsService) {}

  /**
   * Ingests Real User Monitoring beacons (Core Web Vitals, client JS errors and
   * SPA route-transition timings) sent by the Angular client and records them
   * with the server-side OpenTelemetry meter.
   */
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post()
  public recordBeacon(@Body() beacon: RumBeaconDto) {
    this.rumMetricsService.record(beacon);
  }
}
