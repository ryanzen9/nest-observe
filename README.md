# @ryanzeng/nest-observe

面向 NestJS 的零配置、Vendor Neutral Observability SDK。基于 OpenTelemetry，通过标准 OTLP 同时发送 Traces、Metrics 和 Logs，可连接 OpenObserve、Grafana、Jaeger、Datadog、Elastic 等兼容后端。

## 快速开始

```bash
pnpm add @ryanzeng/nest-observe
```

把注册入口放在应用入口的第一条 import（必须早于 `@nestjs/core` 和业务模块）：

```ts
import '@ryanzeng/nest-observe/register';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
}

void bootstrap();
```

设置标准 OpenTelemetry 环境变量：

```env
OTEL_SERVICE_NAME=mall-app
OTEL_SERVICE_VERSION=1.0.0
OTEL_EXPORTER_OTLP_ENDPOINT=https://observe.example.com
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20xxx
OTEL_RESOURCE_ATTRIBUTES=git.commit.sha=abc123
OBSERVE_ENVIRONMENT=production
```

通用 endpoint 会自动派生 `/v1/traces`、`/v1/metrics` 和 `/v1/logs`。也可使用标准的 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`、`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`、`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` 分别覆盖。

初始化或 exporter 配置失败时，SDK 会降级为 no-op，不会阻止业务应用启动。

## OpenObserve 完整示例

仓库内的 [`example`](./example) 是一个可直接运行的 NestJS 应用，包含本地 OpenObserve Docker Compose、环境变量模板、成功/异常接口和 E2E 测试。完整步骤见 [`example/README.md`](./example/README.md)。

## Nest Module

`register` 已能在加载阶段自动挂载 HTTP、Nest Controller、Provider、Prisma 和 Logger instrumentation。也可以导入全局 Module；它为较晚初始化或测试场景提供 Discovery fallback，并在 Nest 关闭时 flush/shutdown：

```ts
import { Module } from '@nestjs/common';
import { ObserveModule } from '@ryanzeng/nest-observe';

@Module({
  imports: [ObserveModule.forRoot()],
})
export class AppModule {}
```

## 装饰器

```ts
import { Injectable } from '@nestjs/common';
import { IgnoreTrace, Trace } from '@ryanzeng/nest-observe';

@Injectable()
export class OrderService {
  @Trace('order.create')
  async createOrder() {
    return this.reserveInventory();
  }

  @Trace()
  private async reserveInventory() {
    // 自动成为 order.create 的 child span
  }

  @IgnoreTrace()
  healthCheck() {
    return 'ok';
  }
}
```

`@Trace()` 支持同步函数、Promise 和 RxJS Observable，自动记录耗时、异常、ERROR status，并继承当前 context。`@Trace()` 也可应用在 class 上。

## 自动采集内容

Traces：

- Node HTTP client/server、Nest Controller/handler、Provider method
- Prisma instrumentation
- `@Trace()` 自定义 span 和自然 parent/child context
- Controller/Provider 异常事件、错误状态及 stack trace

Logs：

- 默认 Nest `Logger` 的 `verbose/debug/log/warn/error/fatal`
- OTLP severity、`nestjs.context`、`trace_id`、`span_id`
- `service.name`、`service.version`、`deployment.environment.name`
- `StructuredLogEmitter` 抽象可用于后续 Pino/Winston adapter

Metrics：

- `system.cpu.utilization`、`process.cpu.time`
- `process.memory.rss`、`nodejs.memory.heap.used`、`nodejs.memory.heap.total`
- `nodejs.eventloop.delay`、`nodejs.eventloop.utilization`
- `nodejs.gc.duration`、`process.uptime`
- `http.server.request.count`、`http.server.request.duration`、`http.server.error.count`
- `nestjs.method.calls`、`nestjs.method.duration`、`nestjs.method.errors`

HTTP 与 Nest method 指标只使用 route template、method、status、controller/provider/method 等有限维度，避免把 URL id 或请求数据变成高基数标签。

## 程序化配置

```ts
import { observe } from '@ryanzeng/nest-observe';

const telemetry = observe({
  serviceName: 'mall-app',
  serviceVersion: '1.0.0',
  environment: 'production',
  traces: true,
  logs: true,
  metrics: true,
  providerTracing: true,
  controllerTracing: true,
  sampling: 0.1,
  allowedHeaders: ['x-correlation-id'],
});

await telemetry.forceFlush();
await telemetry.shutdown();
```

环境变量方式仍是推荐方式。有合理默认值的配置无需填写。

### Sampling

支持显式 `sampling`（0–1）以及标准环境变量：

```env
OTEL_TRACES_SAMPLER=parentbased_traceidratio
OTEL_TRACES_SAMPLER_ARG=0.1
```

也支持 `always_on`、`always_off`、`parentbased_always_on` 和 `parentbased_always_off`。HTTP/runtime/method metrics 不依赖 trace sampling。

## 安全与隐私

- 不采集 request body、完整 Redis value 或数据库参数。
- HTTP header 只按白名单采集；默认仅包含 `accept`、`content-type`、`user-agent`、`x-request-id`、`traceparent`。
- `Authorization`、Cookie、password、secret、token、API key 和手机号字段始终脱敏，即使误加入 header allowlist。
- 常见签名、token、password 等 URL query 参数由 HTTP instrumentation 脱敏。
- Batch processor 异步发送，带有有限队列、batch size、export timeout 和 metric cardinality limit。

## 资源属性

三类信号统一带有：

```text
service.name
service.version
deployment.environment.name
service.instance.id
telemetry.sdk.name
telemetry.sdk.version
host.name
```

`OTEL_RESOURCE_ATTRIBUTES` 可补充 `git.commit.sha`、`container.id` 等自定义资源信息。

## 开发

项目使用 TDD。完整检查：

```bash
pnpm install
pnpm check
```

最低运行环境为 Node.js 20，支持 NestJS 10、11 和 12。
