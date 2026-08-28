import type { Meter, ObservableCallback } from '@opentelemetry/api';
import { describe, expect, it, vi } from 'vitest';
import { RuntimeMetrics } from '../src/metrics/runtime-metrics';

describe('RuntimeMetrics', () => {
  it('registers every required runtime instrument and can be stopped', () => {
    const names: string[] = [];
    const callbacks: ObservableCallback[] = [];
    const removeCallback = vi.fn();
    const meter = {
      createObservableGauge: (name: string) => {
        names.push(name);
        return { addCallback: (callback: ObservableCallback) => callbacks.push(callback), removeCallback };
      },
      createObservableCounter: (name: string) => {
        names.push(name);
        return { addCallback: (callback: ObservableCallback) => callbacks.push(callback), removeCallback };
      },
      createHistogram: (name: string) => {
        names.push(name);
        return { record: vi.fn() };
      },
    } as unknown as Meter;

    const metrics = new RuntimeMetrics(meter);
    metrics.start();
    expect(names).toEqual(expect.arrayContaining([
      'system.cpu.utilization',
      'process.cpu.time',
      'process.memory.rss',
      'nodejs.memory.heap.used',
      'nodejs.memory.heap.total',
      'nodejs.eventloop.delay',
      'nodejs.eventloop.utilization',
      'nodejs.gc.duration',
      'process.uptime',
    ]));
    expect(callbacks.length).toBeGreaterThanOrEqual(8);
    metrics.stop();
    expect(removeCallback).toHaveBeenCalled();
  });
});
