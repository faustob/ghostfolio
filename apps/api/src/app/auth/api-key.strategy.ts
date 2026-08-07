import { UserService } from '@ghostfolio/api/app/user/user.service';
import { ApiKeyService } from '@ghostfolio/api/services/api-key/api-key.service';
import { ConfigurationService } from '@ghostfolio/api/services/configuration/configuration.service';
import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';
import { HEADER_KEY_TOKEN } from '@ghostfolio/common/config';
import { hasRole } from '@ghostfolio/common/permissions';

import { HttpException, Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { StatusCodes, getReasonPhrase } from 'http-status-codes';
import { HeaderAPIKeyStrategy } from 'passport-headerapikey';

import { recordAuthAttempt } from '../../telemetry/telemetry';

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(
  HeaderAPIKeyStrategy,
  'api-key'
) {
  public constructor(
    private readonly apiKeyService: ApiKeyService,
    private readonly configurationService: ConfigurationService,
    private readonly prismaService: PrismaService,
    private readonly userService: UserService
  ) {
    super({ header: HEADER_KEY_TOKEN, prefix: 'Api-Key ' }, false);
  }

  public async validate(apiKey: string) {
    const user = await this.validateApiKey(apiKey);

    if (this.configurationService.get('ENABLE_FEATURE_SUBSCRIPTION')) {
      if (hasRole(user, 'INACTIVE')) {
        throw new HttpException(
          getReasonPhrase(StatusCodes.TOO_MANY_REQUESTS),
          StatusCodes.TOO_MANY_REQUESTS
        );
      }

      if (await this.userService.isDailyRequestLimitExceeded({ user })) {
        throw new HttpException(
          getReasonPhrase(StatusCodes.TOO_MANY_REQUESTS),
          StatusCodes.TOO_MANY_REQUESTS
        );
      }

      await this.prismaService.analytics.upsert({
        create: { user: { connect: { id: user.id } } },
        update: {
          activityCount: { increment: 1 },
          lastRequestAt: new Date()
        },
        where: { userId: user.id }
      });
    }

    recordAuthAttempt({ method: 'api-key', outcome: 'granted' });

    return user;
  }

  private async validateApiKey(apiKey: string) {
    if (!apiKey) {
      recordAuthAttempt({
        method: 'api-key',
        outcome: 'denied',
        reason: 'missing_api_key'
      });

      throw new HttpException(
        getReasonPhrase(StatusCodes.UNAUTHORIZED),
        StatusCodes.UNAUTHORIZED
      );
    }

    try {
      const { id } = await this.apiKeyService.getUserByApiKey(apiKey);

      return this.userService.user({ id });
    } catch {
      recordAuthAttempt({
        method: 'api-key',
        outcome: 'denied',
        reason: 'invalid_api_key'
      });

      throw new HttpException(
        getReasonPhrase(StatusCodes.UNAUTHORIZED),
        StatusCodes.UNAUTHORIZED
      );
    }
  }
}
