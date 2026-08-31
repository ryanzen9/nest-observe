import { Logger } from '@nestjs/common';
import type { LogRecordExporter, ReadableLogRecord } from '@opentelemetry/sdk-logs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observe, type ObserveRuntime } from '../src/sdk';
import type { ObserveErrorEvent } from '../src/types';

class FailingLogExporter implements LogRecordExporter {
  export(
    _logs: ReadableLogRecord[],
    callback: Parameters<LogRecordExporter['export']>[1],
  ): void {
    callback({
      code: 1,
      error: new Error('HTTP 401 authorization=Basic super-secret'),
    });
  }

  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}

let runtime: ObserveRuntime | undefined;

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  vi.restoreAllMocks();
});

describe('observe diagnostics', () => {
  it('surfaces asynchronous exporter failures without breaking business logging', async () => {
    const events: ObserveErrorEvent[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    runtime = observe({
      traces: false,
      metrics: false,
      logs: true,
      onError: (event) => events.push(event),
      exporters: { log: new FailingLogExporter() },
    });

    expect(runtime.status).toBe('active');
    expect(() => new Logger('Orders').log('business continues')).not.toThrow();
    await runtime.forceFlush();

    expect(runtime.status).toBe('degraded');
    expect(runtime.lastError).toMatchObject({ signal: 'logs', stage: 'export' });
    expect(events).toHaveLength(1);
    expect(events[0]?.error.message).not.toContain('super-secret');
    expect(stderr.join('')).toContain('[nest-observe] logs export failed');
    expect(stderr.join('')).toContain('HTTP 401');
    expect(stderr.join('')).not.toContain('super-secret');
  });

  it('rate-limits repeated exporter failures with the same cause', async () => {
    const events: ObserveErrorEvent[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    runtime = observe({
      traces: false,
      metrics: false,
      logs: true,
      onError: (event) => events.push(event),
      exporters: { log: new FailingLogExporter() },
    });

    new Logger('Orders').log('first');
    await runtime.forceFlush();
    new Logger('Orders').log('second');
    await runtime.forceFlush();

    expect(events).toHaveLength(1);
  });

  it('reports synchronous initialization failures and remains fail-open by default', () => {
    const events: ObserveErrorEvent[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    runtime = observe({
      traces: false,
      logs: false,
      metrics: true,
      onError: (event) => events.push(event),
      exporters: { metricReader: {} as never },
    });

    expect(runtime.started).toBe(false);
    expect(runtime.status).toBe('inactive');
    expect(runtime.lastError).toMatchObject({ signal: 'sdk', stage: 'initialization' });
    expect(events).toHaveLength(1);
    expect(stderr).toHaveBeenCalledOnce();
  });

  it('can fail fast when synchronous initialization fails', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(() => observe({
      traces: false,
      logs: false,
      metrics: true,
      failFast: true,
      exporters: { metricReader: {} as never },
    })).toThrow('setMetricProducer');
  });
});
