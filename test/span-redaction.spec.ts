import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { describe, expect, it } from 'vitest';
import { REDACTED, SpanRedactionProcessor } from '../src/security';

describe('SpanRedactionProcessor', () => {
  it('sanitizes third-party span attributes, errors and prohibited payload fields', () => {
    const span = {
      name: 'request for 13800138000',
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.header.authorization': 'Bearer jwt-secret',
        'http.request.body': '{"password":"secret"}',
        'db.query.parameters': '["private"]',
        note: 'token=abc123',
      },
      status: { code: SpanStatusCode.ERROR, message: 'phone=13800138000' },
      events: [{ name: 'exception', attributes: { 'exception.message': 'token=xyz' } }],
    };
    new SpanRedactionProcessor().onEnd(span as never);

    expect(span.name).not.toContain('13800138000');
    expect(span.attributes['http.request.header.authorization']).toBe(REDACTED);
    expect(span.attributes['http.request.body']).toBe(REDACTED);
    expect(span.attributes['db.query.parameters']).toBe(REDACTED);
    expect(span.attributes.note).not.toContain('abc123');
    expect(span.events[0]?.attributes['exception.message']).not.toContain('xyz');
  });
});
