import type { Attributes } from '@opentelemetry/api';

export interface StructuredLogRecord {
  body: unknown;
  severityText: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  attributes: Attributes;
  timestamp?: number;
}

export interface StructuredLogEmitter {
  emit(record: StructuredLogRecord): void;
}
