import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler
} from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import * as semconv from '@opentelemetry/semantic-conventions';
import { Observable } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

import * as telemetry from '../../telemetry/telemetry';
import { PerformanceLoggingService } from './performance-logging.service';

@Injectable()
export class PerformanceLoggingInterceptor implements NestInterceptor {
  public constructor(
    private readonly performanceLoggingService: PerformanceLoggingService
  ) {}

  public intercept(
    context: ExecutionContext,
    next: CallHandler
  ): Observable<any> {
    const startTime = performance.now();

    const className = context.getClass().name;
    const methodName = context.getHandler().name;

    return next.handle().pipe(
      tap(() => {
        return this.performanceLoggingService.logPerformance({
          className,
          methodName,
          startTime
        });
      })
    );
  }
}

/**
 * Records the OTel semantic-convention HTTP server metrics
 * (http.server.request.duration in SECONDS) plus the throughput and
 * saturation SLI instruments for every inbound request, and adds a
 * slow-request span event when the P99 budget is exceeded.
 *
 * Registered globally via APP_INTERCEPTOR in AppModule.
 */
@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  public intercept(
    context: ExecutionContext,
    next: CallHandler
  ): Observable<any> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    telemetry.reportWorkerPoolSize();

    const http = context.switchToHttp();
    const request = http.getRequest();
    const response = http.getResponse();

    // Low cardinality: the matched route TEMPLATE, never the raw path
    const route = request?.route?.path ?? 'unknown';
    const method = request?.method ?? 'UNKNOWN';
    const tenantHeader = request?.headers?.['x-tenant-tier'];
    const tenant =
      typeof tenantHeader === 'string' && tenantHeader.length <= 32
        ? tenantHeader
        : 'standard';

    const baseAttributes = {
      [semconv.ATTR_HTTP_REQUEST_METHOD]: method,
      [semconv.ATTR_HTTP_ROUTE]: route,
      [semconv.ATTR_NETWORK_PROTOCOL_VERSION]: request?.httpVersion ?? '1.1',
      [semconv.ATTR_URL_SCHEME]: request?.protocol ?? 'http'
    };

    telemetry.getHttpServerRequests().add(1, {
      ...baseAttributes,
      'tenant.tier': tenant
    });

    const activeRequests = telemetry.getHttpServerActiveRequests();

    activeRequests.add(1, baseAttributes);

    const requestStartTime = performance.now();

    const recordRequest = (statusCode: number, errorType?: string) => {
      const durationInSeconds = (performance.now() - requestStartTime) / 1000;

      activeRequests.add(-1, baseAttributes);

      const attributes = {
        ...baseAttributes,
        [semconv.ATTR_HTTP_RESPONSE_STATUS_CODE]: statusCode,
        ...(errorType ? { [semconv.ATTR_ERROR_TYPE]: errorType } : {})
      };

      telemetry
        .getHttpServerRequestDuration()
        .record(durationInSeconds, attributes);

      const span = trace.getActiveSpan();

      if (span) {
        span.setAttribute(semconv.ATTR_HTTP_ROUTE, route);

        // Exception-to-status mapping for 5xx root cause attribution
        if (errorType) {
          span.setAttribute(semconv.ATTR_ERROR_TYPE, errorType);
        }

        if (durationInSeconds > telemetry.SLOW_REQUEST_BUDGET_SECONDS) {
          span.addEvent('http.server.slow_request', {
            [semconv.ATTR_HTTP_REQUEST_METHOD]: method,
            [semconv.ATTR_HTTP_RESPONSE_STATUS_CODE]: statusCode,
            [semconv.ATTR_HTTP_ROUTE]: route,
            'http.server.request.budget_s':
              telemetry.SLOW_REQUEST_BUDGET_SECONDS,
            'http.server.request.duration_s': durationInSeconds
          });
        }
      }
    };

    return next.handle().pipe(
      tap(() => {
        recordRequest(response?.statusCode ?? 200);
      }),
      catchError((error) => {
        const statusCode =
          typeof error?.getStatus === 'function'
            ? error.getStatus()
            : (error?.status ?? error?.statusCode ?? 500);

        // The error CLASS, never the message
        recordRequest(statusCode, error?.constructor?.name ?? 'Error');

        // Rethrow the very same error - propagation is unchanged
        throw error;
      })
    );
  }
}

export function LogPerformance(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor
) {
  const originalMethod = descriptor.value;

  descriptor.value = async function (...args: any[]) {
    const startTime = performance.now();
    const performanceLoggingService = new PerformanceLoggingService();

    const result = originalMethod.apply(this, args);

    if (result instanceof Promise) {
      // Handle async method
      return result
        .then((res: any) => {
          performanceLoggingService.logPerformance({
            startTime,
            className: target.constructor.name,
            methodName: propertyKey
          });

          return res;
        })
        .catch((error: any) => {
          throw error;
        });
    } else {
      // Handle sync method
      performanceLoggingService.logPerformance({
        startTime,
        className: target.constructor.name,
        methodName: propertyKey
      });

      return result;
    }
  };

  return descriptor;
}
