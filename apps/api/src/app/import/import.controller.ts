import { HasPermission } from '@ghostfolio/api/decorators/has-permission.decorator';
import { HasPermissionGuard } from '@ghostfolio/api/guards/has-permission.guard';
import { TransformDataSourceInRequestInterceptor } from '@ghostfolio/api/interceptors/transform-data-source-in-request/transform-data-source-in-request.interceptor';
import { TransformDataSourceInResponseInterceptor } from '@ghostfolio/api/interceptors/transform-data-source-in-response/transform-data-source-in-response.interceptor';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { SubscriptionType } from '@ghostfolio/common/enums';
import { ImportResponse } from '@ghostfolio/common/interfaces';
import { hasPermission, permissions } from '@ghostfolio/common/permissions';
import * as telemetry from '@ghostfolio/api/telemetry/telemetry';
import type { RequestWithUser } from '@ghostfolio/common/types';

import * as otelApi from '@opentelemetry/api';

import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Logger,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { DataSource } from '@prisma/client';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';

import { ImportDataDto } from './import-data.dto';
import { ImportService } from './import.service';

const FLOW_NAME = 'portfolio.activity.import';

@Controller('import')
export class ImportController {
  private readonly logger = new Logger(ImportController.name);

  public constructor(
    private readonly configurationService: ConfigurationService,
    private readonly importService: ImportService,
    @Inject(REQUEST) private readonly request: RequestWithUser
  ) {}

  @Post()
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  @HasPermission(permissions.createActivity)
  @UseInterceptors(TransformDataSourceInRequestInterceptor)
  @UseInterceptors(TransformDataSourceInResponseInterceptor)
  public async import(
    @Body() importData: ImportDataDto,
    @Query('dryRun') isDryRunParam = 'false'
  ): Promise<ImportResponse> {
    const isDryRun = isDryRunParam === 'true';

    const flowStartedAt = Date.now();
    const flowSpan = otelApi.trace
      .getTracer(telemetry.OTEL_SCOPE_NAME)
      .startSpan('flow portfolio.activity.import', {
        attributes: {
          flow: FLOW_NAME,
          'flow.dry_run': isDryRun,
          'http.request.method': 'POST',
          'http.route': '/api/v1/import'
        }
      });

    telemetry.recordFlowEntry({ flow: FLOW_NAME });

    if (
      !hasPermission(this.request.user.permissions, permissions.createAccount)
    ) {
      telemetry.recordFlowOutcome({
        flow: FLOW_NAME,
        outcome: 'failure',
        durationInSeconds: (Date.now() - flowStartedAt) / 1000,
        errorType: 'FORBIDDEN'
      });
      flowSpan.setStatus({ code: otelApi.SpanStatusCode.ERROR });
      flowSpan.setAttribute('http.response.status_code', StatusCodes.FORBIDDEN);
      flowSpan.end();

      throw new HttpException(
        getReasonPhrase(StatusCodes.FORBIDDEN),
        StatusCodes.FORBIDDEN
      );
    }

    let maxActivitiesToImport = this.configurationService.get(
      'MAX_ACTIVITIES_TO_IMPORT'
    );

    if (
      this.configurationService.get('ENABLE_FEATURE_SUBSCRIPTION') &&
      this.request.user.subscription?.type === SubscriptionType.Premium
    ) {
      maxActivitiesToImport = Number.MAX_SAFE_INTEGER;
    }

    try {
      const activities = await this.importService.import({
        isDryRun,
        maxActivitiesToImport,
        accountsWithBalancesDto: importData.accounts ?? [],
        activitiesDto: importData.activities,
        assetProfilesWithMarketDataDto: importData.assetProfiles ?? [],
        platformsDto: importData.platforms ?? [],
        tagsDto: importData.tags ?? [],
        user: this.request.user
      });

      telemetry.recordFlowOutcome({
        flow: FLOW_NAME,
        outcome: 'success',
        durationInSeconds: (Date.now() - flowStartedAt) / 1000
      });
      flowSpan.setAttribute('flow.activities.count', activities.length);
      flowSpan.setAttribute('http.response.status_code', StatusCodes.CREATED);
      flowSpan.end();

      return { activities };
    } catch (error) {
      telemetry.recordFlowOutcome({
        flow: FLOW_NAME,
        outcome: 'failure',
        durationInSeconds: (Date.now() - flowStartedAt) / 1000,
        errorType: error?.name ?? 'Error'
      });
      flowSpan.setStatus({ code: otelApi.SpanStatusCode.ERROR });
      flowSpan.setAttribute(
        'http.response.status_code',
        StatusCodes.BAD_REQUEST
      );
      flowSpan.end();

      this.logger.error(error);

      throw new HttpException(
        {
          error: getReasonPhrase(StatusCodes.BAD_REQUEST),
          message: [error.message]
        },
        StatusCodes.BAD_REQUEST
      );
    }
  }

  @Get('dividends/:dataSource/:symbol')
  @UseGuards(AuthGuard('jwt'), HasPermissionGuard)
  @UseInterceptors(TransformDataSourceInRequestInterceptor)
  @UseInterceptors(TransformDataSourceInResponseInterceptor)
  public async gatherDividends(
    @Param('dataSource') dataSource: DataSource,
    @Param('symbol') symbol: string
  ): Promise<ImportResponse> {
    let maxActivitiesToImport = this.configurationService.get(
      'MAX_ACTIVITIES_TO_IMPORT'
    );

    if (
      this.configurationService.get('ENABLE_FEATURE_SUBSCRIPTION') &&
      this.request.user.subscription?.type === SubscriptionType.Premium
    ) {
      maxActivitiesToImport = Number.MAX_SAFE_INTEGER;
    }

    const activities = await this.importService.getDividends({
      dataSource,
      symbol,
      userCurrency: this.request.user.settings.settings.baseCurrency,
      userId: this.request.user.id
    });

    return { activities: activities.slice(0, maxActivitiesToImport) };
  }
}
