import { inject, Injectable } from '@angular/core';
import {
  ActivatedRouteSnapshot,
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationStart,
  Router
} from '@angular/router';
import { onCLS, onINP, onLCP } from 'web-vitals';

interface WebVitalsReport {
  deviceType?: string;
  errorType?: string;
  metric?: string;
  route: string;
  type: 'js-error' | 'session-start' | 'vital';
  value?: number;
}

/**
 * Browser real user monitoring (RUM) collector.
 *
 * This runs in the BROWSER, where the OpenTelemetry SDK registered by the API
 * process does not exist - calling `metrics.getMeter()` here would resolve to a
 * no-op provider and emit nothing. Therefore this service holds ZERO OTel
 * imports: it only COLLECTS measurements and POSTs them to `/api/v1/web-vitals`,
 * which records them with the server meter using the standard names.
 */
@Injectable({
  providedIn: 'root'
})
export class WebVitalsService {
  private static readonly ENDPOINT = '/api/v1/web-vitals';

  private deviceType: string | undefined;
  private isInitialized = false;
  private navigationStartTime: number | undefined;

  private readonly router = inject(Router);

  /**
   * Starts the collectors. Safe to call more than once - only the first call
   * registers the listeners.
   */
  public initialize({ deviceType }: { deviceType?: string } = {}) {
    if (this.isInitialized || typeof window === 'undefined') {
      return;
    }

    this.isInitialized = true;
    this.deviceType = deviceType;

    this.send({
      deviceType: this.deviceType,
      route: this.getRoute(),
      type: 'session-start'
    });

    this.observeWebVitals();
    this.observeJsErrors();
    this.observeRouteChanges();
  }

  /**
   * Resolves the low-cardinality Angular route TEMPLATE (e.g. /portfolio/:id)
   * of the currently activated route, never the raw URL with its identifiers.
   */
  private getRoute() {
    try {
      const segments: string[] = [];
      let snapshot: ActivatedRouteSnapshot | null =
        this.router.routerState.snapshot.root;

      while (snapshot) {
        const path = snapshot.routeConfig?.path;

        if (path) {
          segments.push(path);
        }

        snapshot = snapshot.firstChild;
      }

      return segments.length > 0 ? `/${segments.join('/')}` : '/';
    } catch {
      return 'unknown';
    }
  }

  private observeJsErrors() {
    window.addEventListener('error', (event) => {
      this.send({
        deviceType: this.deviceType,
        // The error CLASS, never the message
        errorType: event.error?.constructor?.name ?? 'Error',
        route: this.getRoute(),
        type: 'js-error'
      });
    });

    window.addEventListener('unhandledrejection', (event) => {
      this.send({
        deviceType: this.deviceType,
        errorType: event.reason?.constructor?.name ?? 'UnhandledRejection',
        route: this.getRoute(),
        type: 'js-error'
      });
    });
  }

  /** Times SPA soft navigations (route change start -> view activated). */
  private observeRouteChanges() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        this.navigationStartTime = performance.now();
      } else if (event instanceof NavigationEnd) {
        if (this.navigationStartTime !== undefined) {
          const duration = performance.now() - this.navigationStartTime;

          this.navigationStartTime = undefined;

          this.send({
            deviceType: this.deviceType,
            metric: 'route-change',
            route: this.getRoute(),
            type: 'vital',
            value: duration
          });
        }
      } else if (
        event instanceof NavigationCancel ||
        event instanceof NavigationError
      ) {
        this.navigationStartTime = undefined;
      }
    });
  }

  private observeWebVitals() {
    onCLS(({ value }) => {
      this.send({
        deviceType: this.deviceType,
        metric: 'CLS',
        route: this.getRoute(),
        type: 'vital',
        value
      });
    });

    onINP(({ value }) => {
      this.send({
        deviceType: this.deviceType,
        metric: 'INP',
        route: this.getRoute(),
        type: 'vital',
        value
      });
    });

    onLCP(({ value }) => {
      this.send({
        deviceType: this.deviceType,
        metric: 'LCP',
        route: this.getRoute(),
        type: 'vital',
        value
      });
    });
  }

  /**
   * Delivers a report without blocking the page. Reporting must never affect
   * the application, so every failure is swallowed here (and only here).
   */
  private send(report: WebVitalsReport) {
    try {
      const body = JSON.stringify(report);

      if (typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(
          WebVitalsService.ENDPOINT,
          new Blob([body], { type: 'application/json' })
        );

        return;
      }

      void fetch(WebVitalsService.ENDPOINT, {
        body,
        headers: { 'content-type': 'application/json' },
        keepalive: true,
        method: 'POST'
      }).catch(() => {
        // Ignore telemetry delivery failures
      });
    } catch {
      // Ignore telemetry delivery failures
    }
  }
}
