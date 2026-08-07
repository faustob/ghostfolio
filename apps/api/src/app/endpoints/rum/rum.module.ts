import { Module } from '@nestjs/common';

import { RumMetricsService } from './rum-metrics.service';
import { RumController } from './rum.controller';

@Module({
  controllers: [RumController],
  providers: [RumMetricsService]
})
export class RumModule {}
