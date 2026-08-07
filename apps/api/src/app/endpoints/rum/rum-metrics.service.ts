import { Injectable } from '@nestjs/common';
import { Attributes, Counter, Histogram, metrics } from '@opentelemetry/api';

import { RumBeaconDto } from './rum-beacon.dto';

const ALLOWED_DEVICE_TYPES = ['desktop', 'mobile', 'tablet', 'unknown'];

interface RumInstruments {
  cls: Histogram;
  inp: Histogram;
  jsErrors: Counter;
  lcp: Histogram;
  routeChange: Histogram;
}

@Injectable()
export class RumMetricsService {
  // NOTE: deliberately NOT a field initializer. Nest constructs this provider
  // while building the DI container; resolving the meter here would capture a
  // NoopMeter if that happened before the SDK registered its MeterProvider, and
  // OTel-JS does not rebind meters. The meter and every instrument are therefore
  // resolved lazily on the first recorded beacon and only cached afterwards.
  private instruments: RumInstruments | undefined;

  public record(beacon: RumBeaconDto) {
    const instruments = this.getInstruments();
    const attributes = this.getAttributes(beacon);

    if (beacon.metric === 'js-error') {
      instruments.jsErrors.add(1, {
        ...attributes,
        'error.type': this.sanitize(beacon.errorType, 64) ?? 'Error'
      });

      return;
    }

    if (typeof beacon.value !== 'number' || !Number.isFinite(beacon.value)) {
      return;
    }

    switch (beacon.metric) {
      case 'cls':
        instruments.cls.record(beacon.value, attributes);
        break;
      case 'inp':
        instruments.inp.record(beacon.value, attributes);
        break;
      case 'lcp':
        instruments.lcp.record(beacon.value, attributes);
        break;
      case 'route-change':
        instruments.routeChange.record(beacon.value, attributes);
        break;
    }
  }

  private getAttributes({ deviceType, route }: RumBeaconDto): Attributes {
    return {
      'device.type': ALLOWED_DEVICE_TYPES.includes(deviceType)
        ? deviceType
        : 'unknown',
      'http.route': this.sanitize(route, 128) ?? '/'
    };
  }

  /**
   * Lazily resolves the meter and the instruments on first use, so they always
   * bind to the MeterProvider registered by the SDK bootstrap.
   *
   * All names share one convention-shaped family: the `browser.` domain prefix
   * with dot-separated segments; durations carry their unit in the unit field.
   */
  private getInstruments(): RumInstruments {
    if (!this.instruments) {
      const meter = metrics.getMeter('ghostfolio-client');

      this.instruments = {
        cls: meter.createHistogram('browser.web_vital.cls', {
          description:
            'Cumulative Layout Shift reported by the browser (unitless visual-stability score)'
        }),
        inp: meter.createHistogram('browser.web_vital.inp', {
          description: 'Interaction to Next Paint reported by the browser',
          unit: 'ms'
        }),
        jsErrors: meter.createCounter('browser.js.errors', {
          description:
            'Unhandled client-side JavaScript errors reported by the browser'
        }),
        lcp: meter.createHistogram('browser.web_vital.lcp', {
          description: 'Largest Contentful Paint reported by the browser',
          unit: 'ms'
        }),
        routeChange: meter.createHistogram('browser.route_change.duration', {
          description: 'Duration of an SPA soft navigation (route transition)',
          unit: 'ms'
        })
      };
    }

    return this.instruments;
  }

  private sanitize(value: string | undefined, maxLength: number) {
    if (!value) {
      return undefined;
    }

    return value.slice(0, maxLength);
  }
}
