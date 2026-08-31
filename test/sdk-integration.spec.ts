import { Logger } from "@nestjs/common";
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Trace } from "../src/decorators";
import { SDK_NAME, SDK_VERSION } from "../src/resource";
import { observe, type ObserveRuntime } from "../src/sdk";

const spans = new InMemorySpanExporter();
const logs = new InMemoryLogRecordExporter();
const metricExporter = new InMemoryMetricExporter(
  AggregationTemporality.CUMULATIVE,
);
const metricReader = new PeriodicExportingMetricReader({
  exporter: metricExporter,
  exportIntervalMillis: 60_000,
});
let runtime: ObserveRuntime | undefined;

afterAll(async () => runtime?.shutdown());

describe("observe pipeline", () => {
  it("exports correlated traces, logs, HTTP/runtime metrics and unified resources", async () => {
    runtime = observe({
      serviceName: "mall-api",
      serviceVersion: "1.2.3",
      environment: "test",
      sampling: 1,
      exporters: { span: spans, log: logs, metricReader },
    });
    expect(runtime.started).toBe(true);
    const output = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    class Orders {
      @Trace({ attributes: { token: "jwt-secret" } })
      create() {
        new Logger("Orders").log("created");
      }
    }
    new Orders().create();
    const tracer = trace.getTracer("integration");
    tracer.startActiveSpan(
      "GET /orders/:id",
      {
        kind: SpanKind.SERVER,
        attributes: {
          "http.request.method": "GET",
          "http.route": "/orders/:id",
          "http.response.status_code": 200,
        },
      },
      (span) => {
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      },
    );
    await runtime.forceFlush();
    output.mockRestore();

    const traceSpan = spans
      .getFinishedSpans()
      .find((span) => span.name === "Orders.create");
    expect(traceSpan?.resource.attributes).toMatchObject({
      "service.name": "mall-api",
      "service.version": "1.2.3",
      "deployment.environment.name": "test",
      "telemetry.sdk.name": SDK_NAME,
      "telemetry.sdk.version": SDK_VERSION,
    });
    expect(traceSpan?.attributes.token).toBe("[REDACTED]");
    const log = logs
      .getFinishedLogRecords()
      .find((record) => record.body === "created");
    expect(log?.spanContext?.traceId).toBe(traceSpan?.spanContext().traceId);
    expect(log?.attributes).toMatchObject({
      "nestjs.context": "Orders",
      "service.name": "mall-api",
    });

    const metrics = metricExporter
      .getMetrics()
      .flatMap((item) => item.scopeMetrics.flatMap((scope) => scope.metrics));
    expect(metrics.map((metric) => metric.descriptor.name)).toEqual(
      expect.arrayContaining([
        "process.memory.rss",
        "nodejs.eventloop.utilization",
      ]),
    );
    expect(
      metricExporter.getMetrics()[0]?.resource.attributes["service.name"],
    ).toBe("mall-api");
  });
});
