import { describe, expect, it } from 'vitest';
import { REDACTED, redact, sanitizeHeaders } from '../src/security/redaction';

describe('redaction', () => {
  it('recursively removes secrets and phone numbers without mutating input', () => {
    const input = {
      user: { password: 'secret', mobile: '13800138000', name: 'Ada' },
      token: 'jwt',
      items: [{ apiKey: 'key' }],
    };

    const output = redact(input) as typeof input;
    expect(output).toEqual({
      user: { password: REDACTED, mobile: REDACTED, name: 'Ada' },
      token: REDACTED,
      items: [{ apiKey: REDACTED }],
    });
    expect(input.user.password).toBe('secret');
  });

  it('only captures allow-listed HTTP headers and always protects credentials', () => {
    expect(sanitizeHeaders({
      authorization: 'Bearer secret',
      cookie: 'sid=secret',
      'content-type': 'application/json',
      'x-request-id': 'req-1',
      'x-private': 'nope',
    }, ['content-type', 'x-request-id', 'authorization'])).toEqual({
      'content-type': 'application/json',
      'x-request-id': 'req-1',
      authorization: REDACTED,
    });
  });

  it('handles errors and circular objects safely', () => {
    const value: Record<string, unknown> = { error: new Error('boom') };
    value.self = value;
    expect(() => redact(value)).not.toThrow();
    expect((redact(value) as Record<string, unknown>).self).toBe('[Circular]');
  });

  it('redacts phone numbers and credentials embedded in free-form log text', () => {
    const output = redact('user=13800138000 token=abc123 Authorization: Bearer jwt-secret');
    expect(output).not.toContain('13800138000');
    expect(output).not.toContain('abc123');
    expect(output).not.toContain('jwt-secret');
    expect(output).toContain(REDACTED);
  });
});
