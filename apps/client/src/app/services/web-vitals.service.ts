import { DOCUMENT, inject, Injectable } from '@angular/core';
import { onCLS, onINP, onLCP } from 'web-vitals';

interface RumBeacon {
  deviceType: string;
  errorType?: string;
  name?: 'cls' | 'inp' | 'lcp';
  route: string;
  type: 'js-error' | 'route-change' | 'web-vital';
  value?: number;
}

/**
 * Collects real user monitoring signals in the BROWSER and beacons them to the
 * API, which records them with the server OpenTelemetry meter. This service
 * deliberately holds no OpenTelemetry imports: in the browser the global OTel
 * providers are no-ops, so metrics created here would silently emit nothing.
 */
@Injectable({
  providedIn: 'root'
})
export class WebVitalsService {
  private deviceType = 'unknown';
  private isInitialized = false;
  private routeChangeStart: number | undefined;

  private readonly document = inject(DOCUMENT);

  public initialize(deviceType?: string) {
    if (this.isInitialized) {
      return;
    }

    this.isInitialized = true;
    this.deviceType = deviceType || 'unknown';

    onCLS(({ value }) => {
      this.send({
        value,
        deviceType: this.deviceType,
        name: 'cls',
        route: this.getCurrentRoute(),
        type: 'web-vital'
      });
    });

    onINP(({ value }) => {
      this.send({
        value,
        deviceType: this.deviceType,
        name: 'inp',
        route: this.getCurrentRoute(),
        type: 'web-vital'
      });
    });

    onLCP(({ value }) => {
      this.send({
        value,
        deviceType: this.deviceType,
        name: 'lcp',
        route: this.getCurrentRoute(),
        type: 'web-vital'
      });
    });

    window.addEventListener('error', ({ error }: ErrorEvent) => {
      this.send({
        deviceType: this.deviceType,
        errorType: error?.name ?? 'Error',
        route: this.getCurrentRoute(),
        type: 'js-error'
      });
    });

    window.addEventListener(
      'unhandledrejection',
      ({ reason }: PromiseRejectionEvent) => {
        this.send({
          deviceType: this.deviceType,
          errorType: reason?.name ?? 'UnhandledRejection',
          route: this.getCurrentRoute(),
          type: 'js-error'
        });
      }
    );
  }

  /**
   * Reports the elapsed time of the SPA soft navigation which just completed,
   * tagged with the destination route TEMPLATE.
   */
  public reportRouteChange({ route }: { route: string }) {
    const now = performance.now();
    const start = this.routeChangeStart;

    this.routeChangeStart = now;

    if (start === undefined) {
      // The very first NavigationEnd is the initial load, covered by LCP
      return;
    }

    this.send({
      route,
      deviceType: this.deviceType,
      type: 'route-change',
      value: now - start
    });
  }

  private getCurrentRoute(): string {
    const [, firstSegment, secondSegment] =
      this.document.location.pathname.split('/');

    if (!firstSegment) {
      return '/';
    }

    return secondSegment
      ? `/${firstSegment}/${secondSegment}`
      : `/${firstSegment}`;
  }

  private send(beacon: RumBeacon) {
    const body = JSON.stringify(beacon);

    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          '/api/v1/rum',
          new Blob([body], { type: 'application/json' })
        );
      } else {
        void fetch('/api/v1/rum', {
          body,
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          method: 'POST'
        }).catch(() => {
          // Telemetry must never affect the application
        });
      }
    } catch {
      // Telemetry must never affect the application
    }
  }
}
