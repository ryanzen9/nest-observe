import { redactText } from './security/redaction';
import type {
  ObserveErrorEvent,
  ObserveErrorStage,
  ObserveSignal,
  ObserveStatus,
} from './types';

type ExportResultLike = { code: number; error?: Error };
type ExportCallback = (result: ExportResultLike) => void;
type ExporterLike = { export(items: unknown, callback: ExportCallback): void };

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string') return new Error(value);
  try {
    return new Error(JSON.stringify(value));
  } catch {
    return new Error(String(value));
  }
}

function sanitizeError(error: Error): Error {
  const sanitized = new Error(redactText(error.message));
  sanitized.name = error.name;
  if (error.stack) sanitized.stack = redactText(error.stack);
  return sanitized;
}

/** Tracks pipeline health and reports each distinct failure once until recovery. */
export class ObserveDiagnostics {
  private currentStatus: ObserveStatus = 'starting';
  private currentError: ObserveErrorEvent | undefined;
  private readonly failedSignals = new Set<ObserveSignal>();
  private readonly reported = new Set<string>();

  constructor(
    private readonly logging: boolean,
    private readonly onError?: (event: ObserveErrorEvent) => void,
  ) {}

  get status(): ObserveStatus { return this.currentStatus; }
  get lastError(): ObserveErrorEvent | undefined { return this.currentError; }

  activate(): void {
    if (this.currentStatus === 'starting') this.currentStatus = 'active';
  }

  inactive(): void {
    this.currentStatus = 'inactive';
  }

  stop(): void {
    this.currentStatus = 'stopped';
  }

  success(signal: ObserveSignal): void {
    this.failedSignals.delete(signal);
    for (const fingerprint of this.reported) {
      if (fingerprint.startsWith(`${signal}\0`)) this.reported.delete(fingerprint);
    }
    if (this.currentStatus === 'degraded' && this.failedSignals.size === 0) {
      this.currentStatus = 'active';
    }
  }

  failure(signal: ObserveSignal, stage: ObserveErrorStage, value: unknown): void {
    const error = sanitizeError(toError(value));
    const event: ObserveErrorEvent = { signal, stage, error, timestamp: Date.now() };
    this.currentError = event;
    this.failedSignals.add(signal);
    if (this.currentStatus !== 'inactive' && this.currentStatus !== 'stopped') {
      this.currentStatus = 'degraded';
    }

    const fingerprint = `${signal}\0${stage}\0${error.name}\0${error.message}`;
    if (this.reported.has(fingerprint)) return;
    this.reported.add(fingerprint);

    try { this.onError?.(event); } catch { /* diagnostics must never affect business code */ }
    if (!this.logging) return;
    try {
      process.stderr.write(
        `[nest-observe] ${signal} ${stage} failed: ${redactText(error.message)}\n`,
      );
    } catch {
      // Diagnostics are best-effort and must never affect business code.
    }
  }
}

/** Observes asynchronous OTLP callback failures without changing exporter behavior. */
export function withExporterDiagnostics<T extends object>(
  exporter: T,
  signal: Exclude<ObserveSignal, 'sdk'>,
  diagnostics: ObserveDiagnostics,
): T {
  const delegate = exporter as unknown as ExporterLike;
  return new Proxy(exporter, {
    get(target, property) {
      if (property === 'export') {
        return (items: unknown, callback: ExportCallback): void => {
          try {
            delegate.export.call(target, items, (result) => {
              if (result.code === 0) {
                diagnostics.success(signal);
              } else {
                diagnostics.failure(
                  signal,
                  'export',
                  result.error ?? new Error(`${signal} export failed`),
                );
              }
              callback(result);
            });
          } catch (error) {
            diagnostics.failure(signal, 'export', error);
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
