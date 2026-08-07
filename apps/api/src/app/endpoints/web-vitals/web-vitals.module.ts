import { Module } from '@nestjs/common';

import { WebVitalsController } from './web-vitals.controller';

@Module({
  controllers: [WebVitalsController]
})
export class WebVitalsModule {}
