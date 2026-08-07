import { Module } from '@nestjs/common';

import { RumController } from './rum.controller';

@Module({
  controllers: [RumController]
})
export class RumModule {}
