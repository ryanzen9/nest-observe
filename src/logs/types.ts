import type { LogAttributes } from '@opentelemetry/api-logs';

export interface StructuredLogRecord {
  body: unknown;
  severityText: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';
  attributes: LogAttributes;
  timestamp?: number;
}

export interface StructuredLogEmitter {
  emit(record: StructuredLogRecord): void;
}
