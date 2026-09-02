import { ConsoleLogger } from "@nestjs/common";
import { trace } from "@opentelemetry/api";
import type { LogAttributes } from "@opentelemetry/api-logs";
import { redact, redactText } from "../security/redaction";
import type { StructuredLogEmitter, StructuredLogRecord } from "./types";

type LogMethod = "verbose" | "debug" | "log" | "warn" | "error" | "fatal";
type ParsedLogCall = {
  messages: unknown[];
  context?: string | undefined;
  stack?: string | undefined;
  params?: Record<string, unknown> | undefined;
};

type ConsoleLoggerWithInternals = ConsoleLogger & {
  context?: string;
  options?: {
    structuredParams?: boolean;
  };
  getContextAndMessagesToPrint?: (args: unknown[]) => ParsedLogCall;
  getContextAndStackAndMessagesToPrint?: (args: unknown[]) => ParsedLogCall;
};

const SEVERITY: Record<LogMethod, StructuredLogRecord["severityText"]> = {
  verbose: "TRACE",
  debug: "DEBUG",
  log: "INFO",
  warn: "WARN",
  error: "ERROR",
  fatal: "FATAL",
};

function bodyValue(message: unknown): unknown {
  if (message instanceof Error)
    return redactText(message.stack ?? `${message.name}: ${message.message}`);
  return redact(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value) as { constructor?: unknown } | null;
  if (prototype === null) return true;
  const constructor = Object.prototype.hasOwnProperty.call(prototype, "constructor")
    ? prototype.constructor
    : undefined;
  return typeof constructor === "function"
    && constructor instanceof constructor
    && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Object);
}

function isStackFormat(value: unknown): value is string {
  return typeof value === "string" && /^(.)+\n\s+at .+:\d+:\d+/.test(value);
}

function fallbackMessages(
  logger: ConsoleLoggerWithInternals,
  values: unknown[],
): ParsedLogCall {
  if (values.length <= 1) return { messages: values, context: logger.context };
  const lastValue = values.at(-1);
  const contextName = typeof lastValue === "string" ? lastValue : logger.context;
  const remaining = typeof lastValue === "string" ? values.slice(0, -1) : values;
  if (logger.options?.structuredParams === false) {
    return { messages: remaining, context: contextName };
  }
  const messages = [remaining[0]];
  const structuredParams: Record<string, unknown>[] = [];
  for (const value of remaining.slice(1)) {
    if (isPlainObject(value)) structuredParams.push(value);
    else messages.push(value);
  }
  const params = structuredParams.length > 0
    ? Object.assign({}, ...structuredParams) as Record<string, unknown>
    : undefined;
  return { messages, context: contextName, ...(params ? { params } : {}) };
}

function fallbackError(
  logger: ConsoleLoggerWithInternals,
  values: unknown[],
): ParsedLogCall {
  if (values.length === 2) {
    if (isStackFormat(values[1])) {
      return { messages: [values[0]], stack: values[1], context: logger.context };
    }
    return fallbackMessages(logger, values);
  }
  const trailingValue = values.at(-1);
  if (isStackFormat(trailingValue)) {
    return { ...fallbackMessages(logger, values.slice(0, -1)), stack: trailingValue };
  }
  const parsed = fallbackMessages(logger, values);
  if (parsed.messages.length <= 1) return parsed;
  const possibleStack = parsed.messages.at(-1);
  if (typeof possibleStack !== "string" && possibleStack !== undefined) return parsed;
  return {
    ...parsed,
    messages: parsed.messages.slice(0, -1),
    ...(possibleStack === undefined ? {} : { stack: possibleStack }),
  };
}

function parseLogCall(
  logger: ConsoleLoggerWithInternals,
  method: LogMethod,
  message: unknown,
  args: unknown[],
): ParsedLogCall {
  const values = [message, ...args];
  const nestParser = method === "error"
    ? logger.getContextAndStackAndMessagesToPrint
    : logger.getContextAndMessagesToPrint;
  // Delegate overload parsing to the installed Nest version so context, stack,
  // messages, and structured params match what ConsoleLogger actually prints.
  if (typeof nestParser === "function") return nestParser.call(logger, values);
  return method === "error"
    ? fallbackError(logger, values)
    : fallbackMessages(logger, values);
}

function exceptionAttributes(message: unknown, stack?: string): Record<string, string> {
  const error = message instanceof Error ? message : undefined;
  const stacktrace = stack ?? error?.stack;
  return {
    ...(error ? {
      "exception.type": error.name,
      "exception.message": redactText(error.message),
    } : {}),
    ...(stacktrace ? { "exception.stacktrace": redactText(stacktrace) } : {}),
  };
}

export class NestLoggerInstrumentation {
  private originals = new Map<LogMethod, (...args: unknown[]) => void>();
  private enabled = false;

  constructor(
    private readonly emitter: StructuredLogEmitter,
    private readonly resourceAttributes: Record<string, string> = {},
  ) {}

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    const prototype = ConsoleLogger.prototype as unknown as Record<
      LogMethod,
      (...args: unknown[]) => void
    >;
    for (const method of Object.keys(SEVERITY) as LogMethod[]) {
      const original = prototype[method];
      if (typeof original !== "function") continue;
      this.originals.set(method, original);
      const emitter = this.emitter;
      const resourceAttributes = this.resourceAttributes;
      prototype[method] = function (
        this: ConsoleLoggerWithInternals,
        message: unknown,
        ...args: unknown[]
      ) {
        try {
          // Nest 11+ filters log levels per instance (constructor logLevels,
          // setLogLevels, Logger.overrideLogger). Honor the same gate so
          // exported records match console output. Nest 10 has no
          // isLevelEnabled, so the feature check keeps exports unconditional.
          const gated = this as ConsoleLoggerWithInternals & {
            isLevelEnabled?: (level: LogMethod) => boolean;
          };
          if (typeof gated.isLevelEnabled === "function" && !gated.isLevelEnabled(method)) {
            return original.call(this, message, ...args);
          }
          const spanContext = trace.getActiveSpan()?.spanContext();
          const parsed = parseLogCall(this, method, message, args);
          const timestamp = Date.now();
          for (const parsedMessage of parsed.messages) {
            const params = parsed.params
              ? redact(parsed.params) as LogAttributes
              : {};
            const attributes: LogAttributes = {
              ...params,
              ...resourceAttributes,
              ...exceptionAttributes(parsedMessage, parsed.stack),
            };
            if (parsed.context) attributes["nestjs.context"] = parsed.context;
            if (spanContext?.traceId) attributes.trace_id = spanContext.traceId;
            if (spanContext?.spanId) attributes.span_id = spanContext.spanId;
            emitter.emit({
              body: bodyValue(parsedMessage),
              severityText: SEVERITY[method],
              attributes,
              timestamp,
            });
          }
        } catch {
          // Telemetry is best-effort and may never alter business logging behavior.
        }
        return original.call(this, message, ...args);
      };
    }
  }

  disable(): void {
    if (!this.enabled) return;
    const prototype = ConsoleLogger.prototype as unknown as Record<
      LogMethod,
      (...args: unknown[]) => void
    >;
    for (const [method, original] of this.originals)
      prototype[method] = original;
    this.originals.clear();
    this.enabled = false;
  }
}
