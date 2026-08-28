import { describe, expect, it } from 'vitest';
import { resolveObserveConfig } from '../src/config';

describe('resolveObserveConfig', () => {
  it('supports standard OTEL variables and derives per-signal endpoints', () => {
    const config = resolveObserveConfig({}, {
      OTEL_SERVICE_NAME: 'mall-api',
      OTEL_SERVICE_VERSION: '2.3.4',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://observe.example.com/otel/',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Basic%20abc,x-tenant=mall',
      OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=staging,git.commit.sha=abc123',
    });

    expect(config.serviceName).toBe('mall-api');
    expect(config.serviceVersion).toBe('2.3.4');
    expect(config.environment).toBe('staging');
    expect(config.endpoints).toEqual({
      traces: 'https://observe.example.com/otel/v1/traces',
      metrics: 'https://observe.example.com/otel/v1/metrics',
      logs: 'https://observe.example.com/otel/v1/logs',
    });
    expect(config.headers).toEqual({ Authorization: 'Basic abc', 'x-tenant': 'mall' });
    expect(config.resourceAttributes['git.commit.sha']).toBe('abc123');
  });

  it('gives explicit options precedence and uses safe defaults for invalid input', () => {
    const config = resolveObserveConfig({
      serviceName: 'explicit',
      sampling: 0.25,
      traces: false,
      allowedHeaders: ['x-correlation-id'],
    }, {
      OTEL_SERVICE_NAME: 'environment',
      OTEL_TRACES_SAMPLER_ARG: 'not-a-number',
      OBSERVE_ENABLED: 'not-a-boolean',
      OBSERVE_ENVIRONMENT: 'production',
    });

    expect(config.serviceName).toBe('explicit');
    expect(config.sampling).toBe(0.25);
    expect(config.traces).toBe(false);
    expect(config.enabled).toBe(true);
    expect(config.environment).toBe('production');
    expect(config.allowedHeaders).toContain('x-correlation-id');
    expect(config.instanceId).toBeTruthy();
  });

  it('can disable all startup work without throwing', () => {
    expect(resolveObserveConfig({}, { OBSERVE_ENABLED: 'false' }).enabled).toBe(false);
    expect(resolveObserveConfig({ enabled: false }, { OBSERVE_ENABLED: 'true' }).enabled).toBe(false);
  });

  it('clamps sampling and accepts signal-specific endpoints', () => {
    const config = resolveObserveConfig({}, {
      OTEL_TRACES_SAMPLER_ARG: '9',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://default.test',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://traces.test/custom',
    });

    expect(config.sampling).toBe(1);
    expect(config.endpoints.traces).toBe('https://traces.test/custom');
    expect(config.endpoints.logs).toBe('https://default.test/v1/logs');
  });

  it('honors standard always_on and always_off sampler names', () => {
    expect(resolveObserveConfig({}, { OTEL_TRACES_SAMPLER: 'always_off' }).sampling).toBe(0);
    expect(resolveObserveConfig({}, { OTEL_TRACES_SAMPLER: 'always_on', OTEL_TRACES_SAMPLER_ARG: '0' }).sampling).toBe(1);
  });
});
