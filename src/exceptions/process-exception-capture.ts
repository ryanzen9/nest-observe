import { trace, SpanStatusCode } from '@opentelemetry/api';
import type { StructuredLogEmitter } from '../logs/types';
import { redactText } from '../security/redaction';

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export class ProcessExceptionCapture {
  private listening = false;
  private readonly onUncaughtException = (value: unknown) => this.capture(value, 'uncaughtException');

  constructor(private readonly emitter?: StructuredLogEmitter) {}

  start(): void {
    if (this.listening) return;
    this.listening = true;
    process.on('uncaughtExceptionMonitor', this.onUncaughtException);
  }

  stop(): void {
    if (!this.listening) return;
    process.off('uncaughtExceptionMonitor', this.onUncaughtException);
    this.listening = false;
  }

  capture(value: unknown, source = 'nestjs'): void {
    try {
      const error = asError(value);
      const span = trace.getActiveSpan();
      span?.recordException(error);
      span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
      const spanContext = span?.spanContext();
      this.emitter?.emit({
        body: redactText(error.stack ?? error.message),
        severityText: 'ERROR',
        attributes: {
          'exception.type': error.name,
          'exception.message': redactText(error.message),
          'exception.stacktrace': redactText(error.stack ?? ''),
          'exception.source': source,
          ...(spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {}),
        },
        timestamp: Date.now(),
      });
    } catch {
      // Exception reporting must not replace or swallow the original exception.
    }
  }
}
