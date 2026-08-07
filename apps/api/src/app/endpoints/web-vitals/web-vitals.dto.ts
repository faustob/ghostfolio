import { IsIn, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class WebVitalsReportDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  deviceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  errorType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  metric?: string;

  @IsString()
  @MaxLength(256)
  route: string;

  @IsIn(['js-error', 'session-start', 'vital'])
  type: 'js-error' | 'session-start' | 'vital';

  @IsOptional()
  @IsNumber()
  value?: number;
}
