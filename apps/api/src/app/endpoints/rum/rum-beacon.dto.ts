import { IsIn, IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class RumBeaconDto {
  @IsIn(['cls', 'inp', 'lcp', 'js-error', 'route-change'])
  public metric: 'cls' | 'inp' | 'lcp' | 'js-error' | 'route-change';

  @IsOptional()
  @IsNumber()
  public value?: number;

  // Low-cardinality route TEMPLATE (e.g. /portfolio/activities), never a raw path with ids
  @IsOptional()
  @IsString()
  @MaxLength(128)
  public route?: string;

  // Error CLASS (e.g. TypeError), never the message
  @IsOptional()
  @IsString()
  @MaxLength(64)
  public errorType?: string;

  @IsOptional()
  @IsIn(['desktop', 'mobile', 'tablet', 'unknown'])
  public deviceType?: 'desktop' | 'mobile' | 'tablet' | 'unknown';
}
