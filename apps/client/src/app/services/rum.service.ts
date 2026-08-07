import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { NavigationCancel, NavigationEnd, NavigationError, NavigationStart, Router } from '@angular/router';
import { DeviceDetectorService } from 'ngx-device-detector';
import { onCLS, onINP, onLCP } from 'web-vitals';

interface RumBeacon {
  deviceType?: string;
  errorType?: string;
  metric: 'cls' | 'inp' | 'lcp' | 'js-error' | 'route-change';
  route?: string;
  value?: number;
}

/**
 * Collects Real User Monitoring signals in the browser (Core Web Vitals,
 * unhandled JavaScript errors and SPA route-transition timings) and forwards
 * them to the server, which records them with the OpenTelemetry meter.
 *
 * This class holds no OpenTelemetry imports on purpose: in the browser the
 * OTel API would resolve to no-op providers.
 */
@Injectable({ providedIn: 'root' })
export class RumService {
  private static readonly ENDPOINT = '/api/v1/rum';

  private hasReportedErrorForSession = false;
  private isInitialized = false;
  private navigationStartedAt: number | undefined;

  private readonly deviceDetectorService = inject(DeviceDetectorService);
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  public initialize() {
    if (this.isInitialized || typeof window === 'undefined') {
      return;
    }

    this.isInitialized = true;

    this.initializeWebVitals();
    this.initializeErrorHooks();
    this.initializeRouteChangeTiming();
  }

  private getDeviceType() {
    return this.deviceDetectorService.getDeviceInfo().deviceType ?? 'unknown';
  }

  /**
   * Reduces a URL to a low-cardinality route template by keeping at most the
   * first two path segments and masking segments which look like identifiers.
   */
  private getRouteTemplate(url: string) {
    const [path] = (url ?? '/').split(/[?#]/);

    const segments = path
      .split('/')
      .filter((segment) => {
        return !!segment;
      })
      .slice(0, 2)
      .map((segment) => {
        return /\d/.test(segment) || segment.length > 24 ? '{id}' : segment;
      });

    return segments.length ? `/${segments.join('/')}` : '/';
  }

  private initializeErrorHooks() {
    window.addEventListener('error', (event) => {
      this.reportError((event as ErrorEvent)?.error);
    });

    window.addEventListener('unhandledrejection', (event) => {
      this.reportError((event as PromiseRejectionEvent)?.reason);
    });
  }

  private initializeRouteChangeTiming() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.navigationStartedAt = performance.now();
      } else if (
        event instanceof NavigationCancel ||
        event instanceof NavigationError
      ) {
        this.navigationStartedAt = undefined;
      } else if (event instanceof NavigationEnd) {
        const startedAt = this.navigationStartedAt;

        this.navigationStartedAt = undefined;

        if (startedAt === undefined) {
          return;
        }

        const route = this.getRouteTemplate(event.urlAfterRedirects);

        // Measure until the destination view has been rendered
        requestAnimationFrame(() => {
          this.send({
            route,
            metric: 'route-change',
            value: performance.now() - startedAt
          });
        });
      }
    });
  }

  private initializeWebVitals() {
    onCLS(({ value }) => {
      this.send({ value, metric: 'cls' });
    });

    onINP(({ value }) => {
      this.send({ value, metric: 'inp' });
    });

    onLCP(({ value }) => {
      this.send({ value, metric: 'lcp' });
    });
  }

  private reportError(error: unknown) {
    if (this.hasReportedErrorForSession) {
      return;
    }

    // Count error-affected sessions (once per session), never the message
    this.hasReportedErrorForSession = true;

    this.send({
      errorType: (error as Error)?.name ?? 'Error',
      metric: 'js-error'
    });
  }

  private send(beacon: RumBeacon) {
    const payload: RumBeacon = {
      ...beacon,
      deviceType: this.getDeviceType(),
      route: beacon.route ?? this.getRouteTemplate(this.router.url)
    };

    this.http.post(RumService.ENDPOINT, payload).subscribe({
      error: () => {
        // Never let telemetry failures surface to the user
      }
    });
  }
}
