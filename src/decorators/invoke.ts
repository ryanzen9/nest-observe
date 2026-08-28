import { context, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { isObservable, Observable } from 'rxjs';
import { finalize, tap } from 'rxjs/operators';

function fail(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : new Error(String(error)));
  span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
}

export function invokeWithSpan<T>(
  tracer: Tracer,
  spanName: string,
  attributes: Record<string, string>,
  invoke: () => T,
  onFinish?: (durationSeconds: number, error?: unknown) => void,
): T {
  return tracer.startActiveSpan(spanName, { attributes }, (span) => {
    const started = process.hrtime.bigint();
    const finish = (error?: unknown) => {
      if (error !== undefined) fail(span, error);
      else span.setStatus({ code: SpanStatusCode.OK });
      onFinish?.(Number(process.hrtime.bigint() - started) / 1e9, error);
      span.end();
    };
    try {
      const result = invoke();
      if (result instanceof Promise) {
        return result.then(
          (value) => { finish(); return value; },
          (error: unknown) => { finish(error); throw error; },
        ) as T;
      }
      if (isObservable(result)) {
        const spanContext = context.active();
        const source = result as Observable<unknown>;
        return new Observable((subscriber) => context.with(spanContext, () => {
          let streamError: unknown;
          return source.pipe(
            tap({ error: (error: unknown) => { streamError = error; } }),
            finalize(() => finish(streamError)),
          ).subscribe(subscriber);
        })) as T;
      }
      finish();
      return result;
    } catch (error) {
      finish(error);
      throw error;
    }
  });
}
