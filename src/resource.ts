import { hostname } from 'node:os';
import { defaultResource, resourceFromAttributes, type Resource } from '@opentelemetry/resources';
import type { ResolvedObserveConfig } from './types';

export const SDK_NAME = '@ryanzen9/nest-observe';
export const SDK_VERSION = '0.1.0';

export function createObserveResource(config: ResolvedObserveConfig): Resource {
  return defaultResource().merge(resourceFromAttributes({
    ...config.resourceAttributes,
    'service.name': config.serviceName,
    'service.version': config.serviceVersion,
    'deployment.environment.name': config.environment,
    'service.instance.id': config.instanceId,
    'telemetry.sdk.name': SDK_NAME,
    'telemetry.sdk.version': SDK_VERSION,
    'host.name': config.resourceAttributes['host.name'] ?? hostname(),
  }));
}
