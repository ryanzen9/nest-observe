import { context, type Attributes } from "@opentelemetry/api";
import { logs, SeverityNumber, type Logger } from "@opentelemetry/api-logs";
import type { StructuredLogEmitter, StructuredLogRecord } from "./types";

const SEVERITY_NUMBER: Record<
  StructuredLogRecord["severityText"],
  SeverityNumber
> = {
  TRACE: SeverityNumber.TRACE,
  DEBUG: SeverityNumber.DEBUG,
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
  FATAL: SeverityNumber.FATAL,
};

export class OpenTelemetryLogEmitter implements StructuredLogEmitter {
  private readonly logger: Logger;

  constructor(
    name = "@ryanzeng/nest-observe",
    version?: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? logs.getLogger(name, version);
  }

  emit(record: StructuredLogRecord): void {
    this.logger.emit({
      body: record.body as never,
      severityText: record.severityText,
      severityNumber: SEVERITY_NUMBER[record.severityText],
      attributes: record.attributes as Attributes,
      ...(record.timestamp === undefined
        ? {}
        : { timestamp: record.timestamp }),
      context: context.active(),
    });
  }
}
