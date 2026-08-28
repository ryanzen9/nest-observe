import type { Attributes, AttributeValue, Context, Span } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { isSensitiveKey, redactText, REDACTED } from './redaction';

const DROP_VALUE = /(?:request\.body|db\.(?:query\.)?parameters?|db\.statement\.parameters?|redis\.(?:args|value))/i;

function cleanValue(value: AttributeValue): AttributeValue {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) {
    return value.map((item) => typeof item === 'string' ? redactText(item) : item) as AttributeValue;
  }
  return value;
}

function cleanAttributes(attributes: Attributes | undefined): void {
  if (!attributes) return;
  const mutable = attributes as Record<string, AttributeValue | undefined>;
  for (const [key, value] of Object.entries(mutable)) {
    if (value === undefined) continue;
    if (DROP_VALUE.test(key) || isSensitiveKey(key)) mutable[key] = REDACTED;
    else mutable[key] = cleanValue(value);
  }
}

/** Last-line protection for spans emitted by third-party instrumentation. */
export class SpanRedactionProcessor implements SpanProcessor {
  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    const mutable = span as ReadableSpan & {
      name: string;
      status: { code: number; message?: string };
      events: Array<{ attributes?: Attributes }>;
    };
    try {
      mutable.name = redactText(mutable.name);
      cleanAttributes(mutable.attributes);
      if (mutable.status.message) mutable.status.message = redactText(mutable.status.message);
      for (const event of mutable.events) cleanAttributes(event.attributes);
    } catch {
      // A non-standard immutable span is left untouched rather than breaking export.
    }
  }

  forceFlush(): Promise<void> { return Promise.resolve(); }
  shutdown(): Promise<void> { return Promise.resolve(); }
}
