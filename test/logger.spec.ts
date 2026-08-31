import { context, trace } from '@opentelemetry/api';
import { Logger } from '@nestjs/common';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NestLoggerInstrumentation, type StructuredLogRecord } from '../src/logs';

const provider = new NodeTracerProvider();
beforeAll(() => provider.register());
afterAll(() => provider.shutdown());

describe('NestLoggerInstrumentation', () => {
  it('bridges Nest logger levels, context, and active trace identifiers', () => {
    const records: StructuredLogRecord[] = [];
    const instrumentation = new NestLoggerInstrumentation({ emit: (record) => records.push(record) });
    const spanContext = { traceId: '1'.repeat(32), spanId: '2'.repeat(16), traceFlags: 1 };
    const span = trace.wrapSpanContext(spanContext);
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    instrumentation.enable();

    context.with(trace.setSpan(context.active(), span), () => {
      const logger = new Logger('OrderService');
      logger.log({ event: 'created', token: 'jwt-secret' });
      logger.warn('slow');
      logger.error(new Error('failed'));
      logger.fatal('fatal');
    });
    instrumentation.disable();
    output.mockRestore();
    errorOutput.mockRestore();

    expect(records.map((record) => record.severityText)).toEqual(['INFO', 'WARN', 'ERROR', 'FATAL']);
    expect(records[0]?.attributes).toMatchObject({
      trace_id: spanContext.traceId,
      span_id: spanContext.spanId,
      'nestjs.context': 'OrderService',
    });
    expect(records[0]?.body).toBe('{"event":"created","token":"[REDACTED]"}');
    expect(String(records[2]?.body)).toContain('failed');
  });

  it('never lets an emitter failure affect application logging', () => {
    const instrumentation = new NestLoggerInstrumentation({ emit: () => { throw new Error('offline'); } });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    instrumentation.enable();
    expect(() => new Logger('Safe').log('business continues')).not.toThrow();
    instrumentation.disable();
    output.mockRestore();
  });
});
