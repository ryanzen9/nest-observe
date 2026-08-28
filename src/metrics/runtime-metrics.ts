import { cpus } from 'node:os';
import { monitorEventLoopDelay, PerformanceObserver, performance } from 'node:perf_hooks';
import type { Meter, ObservableCallback, ObservableResult } from '@opentelemetry/api';

type RemovableInstrument = {
  addCallback(callback: ObservableCallback): void;
  removeCallback(callback: ObservableCallback): void;
};

export class RuntimeMetrics {
  private readonly callbacks: Array<{ instrument: RemovableInstrument; callback: ObservableCallback }> = [];
  private eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> | undefined;
  private gcObserver: PerformanceObserver | undefined;
  private started = false;
  private previousElu = performance.eventLoopUtilization();

  constructor(private readonly meter: Meter) {}

  private observe(instrument: RemovableInstrument, callback: ObservableCallback): void {
    instrument.addCallback(callback);
    this.callbacks.push({ instrument, callback });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const systemCpu = this.meter.createObservableGauge('system.cpu.utilization', { unit: '1' });
    this.observe(systemCpu, (result: ObservableResult) => {
      const cores = cpus();
      let idle = 0;
      let total = 0;
      for (const core of cores) {
        idle += core.times.idle;
        total += Object.values(core.times).reduce((sum, value) => sum + value, 0);
      }
      result.observe(total ? (total - idle) / total : 0);
    });

    const processCpu = this.meter.createObservableCounter('process.cpu.time', { unit: 's' });
    this.observe(processCpu, (result: ObservableResult) => {
      const cpu = process.cpuUsage();
      result.observe((cpu.user + cpu.system) / 1e6);
    });

    const rss = this.meter.createObservableGauge('process.memory.rss', { unit: 'By' });
    const heapUsed = this.meter.createObservableGauge('nodejs.memory.heap.used', { unit: 'By' });
    const heapTotal = this.meter.createObservableGauge('nodejs.memory.heap.total', { unit: 'By' });
    this.observe(rss, (result: ObservableResult) => result.observe(process.memoryUsage().rss));
    this.observe(heapUsed, (result: ObservableResult) => result.observe(process.memoryUsage().heapUsed));
    this.observe(heapTotal, (result: ObservableResult) => result.observe(process.memoryUsage().heapTotal));

    this.eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopDelay.enable();
    const delay = this.meter.createObservableGauge('nodejs.eventloop.delay', { unit: 's' });
    this.observe(delay, (result: ObservableResult) => {
      const mean = this.eventLoopDelay?.mean ?? 0;
      result.observe(Number.isFinite(mean) ? mean / 1e9 : 0);
      this.eventLoopDelay?.reset();
    });

    const utilization = this.meter.createObservableGauge('nodejs.eventloop.utilization', { unit: '1' });
    this.observe(utilization, (result: ObservableResult) => {
      const current = performance.eventLoopUtilization(this.previousElu);
      this.previousElu = performance.eventLoopUtilization();
      result.observe(current.utilization);
    });

    const gc = this.meter.createHistogram('nodejs.gc.duration', { unit: 's' });
    this.gcObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const detail = (entry as unknown as { detail?: { kind?: number } }).detail;
        gc.record(entry.duration / 1_000, { 'nodejs.gc.type': String(detail?.kind ?? 'unknown') });
      }
    });
    try { this.gcObserver.observe({ entryTypes: ['gc'] }); } catch { /* unsupported runtime */ }

    const uptime = this.meter.createObservableGauge('process.uptime', { unit: 's' });
    this.observe(uptime, (result: ObservableResult) => result.observe(process.uptime()));
  }

  stop(): void {
    for (const { instrument, callback } of this.callbacks) instrument.removeCallback(callback);
    this.callbacks.length = 0;
    this.eventLoopDelay?.disable();
    this.eventLoopDelay = undefined;
    this.gcObserver?.disconnect();
    this.gcObserver = undefined;
    this.started = false;
  }
}
