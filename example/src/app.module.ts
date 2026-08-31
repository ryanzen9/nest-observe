import { Module } from "@nestjs/common";
import { ObserveModule } from "@ryanzeng/nest-observe";
import dotenv from "dotenv";
import { AppController } from "./app.controller";
import { OrdersService } from "./orders.service";
import { SERVICE_NAME, SERVICE_VERSION } from "./pkg";

dotenv.config();

const ENVIRONMENT = process.env.NODE_ENV || "local";
const ENDPOINT =
  process.env.OBSERVE_ENDPOINT || "http://localhost:5080/api/default";
const AUTHORIZATION =
  process.env.OBSERVE_AUTHORIZATION ||
  "Basic cm9vdEBleGFtcGxlLmNvbTpDb21wbGV4cGFzcyMxMjM=";

@Module({
  imports: [
    ObserveModule.forRoot({
      enabled: true,
      serviceName: SERVICE_NAME,
      serviceVersion: SERVICE_VERSION,
      environment: ENVIRONMENT,

      endpoint: ENDPOINT,
      headers: {
        Authorization: AUTHORIZATION,
      },

      traces: true,
      metrics: true,
      logs: true,
      sampling: 1,

      controllerTracing: true,
      providerTracing: true,
      allowedHeaders: ["x-correlation-id"],

      exportTimeoutMillis: 10_000,
      metricExportIntervalMillis: 60_000,

      onError(event) {
        console.error(event.signal, event.stage, event.error.message);
      },
    }),
  ],
  controllers: [AppController],
  providers: [OrdersService],
})
export class AppModule {}
