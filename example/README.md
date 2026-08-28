# NestJS + OpenObserve example

这个应用演示如何通过 `@ryanzeng/nest-observe` 将 NestJS 的 logs、metrics、traces、exceptions 和 runtime metrics 发送到 OpenObserve。

## 本地运行

在仓库根目录安装依赖并构建 SDK：

```bash
pnpm install
pnpm --filter @ryanzeng/nest-observe build
```

启动本地 OpenObserve，并准备应用环境变量：

```bash
docker compose -f example/docker-compose.yml up -d
cp example/.env.example example/.env
pnpm --dir example start:dev
```

打开 <http://localhost:5080>，使用以下本地演示账号登录：

- 邮箱：`root@example.com`
- 密码：`Complexpass#123`
- 组织：`default`

## 产生观测数据

```bash
curl http://localhost:3000/health

curl -X POST http://localhost:3000/orders \
  -H 'content-type: application/json' \
  -d '{"sku":"SKU-001","quantity":2}'

curl http://localhost:3000/orders/demo/failure
```

等待约 10 秒后，可在 OpenObserve 中按 `service.name = nest-observe-example` 查看日志与链路；Metrics 页面可查看 `http.server.*`、`nestjs.method.*`、`process.*`、`nodejs.*` 等指标。失败接口会返回 500，用于演示异常事件、ERROR span 和错误日志之间的关联。

## 关键接入点

入口文件的第一条 import 必须先初始化 SDK，早于 NestJS 和业务模块：

```ts
import '@ryanzeng/nest-observe/register';
```

应用模块导入全局模块，用于 Discovery fallback，并在应用关闭时 flush/shutdown：

```ts
imports: [ObserveModule.forRoot()]
```

`.env` 中的通用 endpoint 必须包含 OpenObserve 组织，但不要包含 `/v1/traces` 等信号路径：

```env
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:5080/api/default
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<base64(email:password)>
```

SDK 会分别派生 `/v1/traces`、`/v1/metrics` 和 `/v1/logs`。连接 OpenObserve Cloud 时，从 **Data Sources > OpenTelemetry** 复制 endpoint 和 token，例如：

```env
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.openobserve.ai/api/<organization>
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Basic%20<token>
```

不要提交包含真实凭据的 `.env`；本项目已忽略该文件。

## 验证

```bash
pnpm --dir example check
```
