import { context, trace } from '@opentelemetry/api';
import { ConsoleLogger, Logger } from '@nestjs/common';
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
    expect(records[0]?.body).toEqual({ event: 'created', token: '[REDACTED]' });
    expect(String(records[2]?.body)).toContain('failed');
    expect(records[2]?.attributes).toMatchObject({
      'exception.type': 'Error',
      'exception.message': 'failed',
      'exception.stacktrace': expect.stringContaining('Error: failed'),
    });
  });

  it('preserves the message-stack overload used by Logger instances', () => {
    const records: StructuredLogRecord[] = [];
    const instrumentation = new NestLoggerInstrumentation({ emit: (record) => records.push(record) });
    const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const error = new Error('inventory unavailable');
    instrumentation.enable();

    new Logger('OrderService').error('reservation failed', error.stack);

    instrumentation.disable();
    errorOutput.mockRestore();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      body: 'reservation failed',
      severityText: 'ERROR',
      attributes: {
        'nestjs.context': 'OrderService',
        'exception.stacktrace': expect.stringContaining('Error: inventory unavailable'),
      },
    });
  });

  it('distinguishes the message-context overload from a stack', () => {
    const records: StructuredLogRecord[] = [];
    const instrumentation = new NestLoggerInstrumentation({ emit: (record) => records.push(record) });
    const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    instrumentation.enable();

    new ConsoleLogger().error('reservation failed', 'OrderService');

    instrumentation.disable();
    errorOutput.mockRestore();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      body: 'reservation failed',
      attributes: { 'nestjs.context': 'OrderService' },
    });
    expect(records[0]?.attributes).not.toHaveProperty('exception.stacktrace');
  });

  it('keeps the message as body when the second argument contains structured params', () => {
    const records: StructuredLogRecord[] = [];
    const instrumentation = new NestLoggerInstrumentation({ emit: (record) => records.push(record) });
    const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    instrumentation.enable();

    new Logger('OrderService').error('order creation failed', {
      event: 'order.failed',
      orderId: 42,
    });

    instrumentation.disable();
    errorOutput.mockRestore();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      body: 'order creation failed',
      attributes: {
        event: 'order.failed',
        orderId: 42,
        'nestjs.context': 'OrderService',
      },
    });
  });

  it('preserves explicit stack, context, and structured params', () => {
    const records: StructuredLogRecord[] = [];
    const instrumentation = new NestLoggerInstrumentation({ emit: (record) => records.push(record) });
    const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const error = new Error('payment rejected');
    instrumentation.enable();

    new ConsoleLogger().error(
      'checkout failed',
      { orderId: 42, token: 'jwt-secret' },
      error.stack,
      'CheckoutService',
    );

    instrumentation.disable();
    errorOutput.mockRestore();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      body: 'checkout failed',
      attributes: {
        orderId: 42,
        token: '[REDACTED]',
        'nestjs.context': 'CheckoutService',
        'exception.stacktrace': expect.stringContaining('Error: payment rejected'),
      },
    });
  });

  it('emits every message selected by Nest error overload parsing', () => {
    const records: StructuredLogRecord[] = [];
    const instrumentation = new NestLoggerInstrumentation({ emit: (record) => records.push(record) });
    const errorOutput = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    instrumentation.enable();

    new ConsoleLogger().error('first failure', 'second failure', undefined, 'OrderService');

    instrumentation.disable();
    errorOutput.mockRestore();
    expect(records.map((record) => record.body)).toEqual(['first failure', 'second failure']);
    expect(records.every((record) => record.attributes['nestjs.context'] === 'OrderService')).toBe(true);
  });

  it('keeps arrays as structured bodies and redacts nested values', () => {
    const records: StructuredLogRecord[] = [];
    const instrumentation = new NestLoggerInstrumentation({ emit: (record) => records.push(record) });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    instrumentation.enable();

    new Logger('OrderService').log([
      { event: 'created', password: 'secret' },
      { orderId: 42 },
    ]);

    instrumentation.disable();
    output.mockRestore();
    expect(records[0]?.body).toEqual([
      { event: 'created', password: '[REDACTED]' },
      { orderId: 42 },
    ]);
  });

  it('respects Nest log level filtering so exports match console output', () => {
    const records: StructuredLogRecord[] = [];
    const instrumentation = new NestLoggerInstrumentation({ emit: (record) => records.push(record) });
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    instrumentation.enable();

    const filtered = new ConsoleLogger('FilteredService', { logLevels: ['error', 'fatal'] });
    filtered.log('not exported');
    filtered.warn('not exported either');
    filtered.error('exported');

    const adjusted = new ConsoleLogger('AdjustedService');
    adjusted.setLogLevels(['fatal']);
    adjusted.error('not exported after adjustment');
    adjusted.fatal('exported');

    instrumentation.disable();
    output.mockRestore();
    expect(records.map((record) => record.severityText)).toEqual(['ERROR', 'FATAL']);
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
