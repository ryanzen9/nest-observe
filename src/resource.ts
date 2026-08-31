import {
  defaultResource,
  resourceFromAttributes,
  type Resource,
} from "@opentelemetry/resources";
import { hostname } from "node:os";
import pkg from "../package.json";
import type { ResolvedObserveConfig } from "./types";
export const SDK_NAME = pkg.name;
export const SDK_VERSION = pkg.version;

export function createObserveResource(config: ResolvedObserveConfig): Resource {
  return defaultResource().merge(
    resourceFromAttributes({
      ...config.resourceAttributes,
      "service.name": config.serviceName,
      "service.version": config.serviceVersion,
      "deployment.environment.name": config.environment,
      "service.instance.id": config.instanceId,
      "telemetry.sdk.name": SDK_NAME,
      "telemetry.sdk.version": SDK_VERSION,
      "host.name": config.resourceAttributes["host.name"] ?? hostname(),
    }),
  );
}
