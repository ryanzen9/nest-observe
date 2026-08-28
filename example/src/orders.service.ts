import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { Trace } from '@ryanzeng/nest-observe';

export interface CreateOrderInput {
  sku: string;
  quantity: number;
}

export interface Order extends CreateOrderInput {
  id: string;
  status: 'created';
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  @Trace('order.create')
  create(input: CreateOrderInput): Order {
    const order = {
      id: randomUUID(),
      sku: input.sku,
      quantity: input.quantity,
      status: 'created' as const,
    };
    this.logger.log({ event: 'order.created', orderId: order.id });
    return order;
  }

  @Trace('order.failure')
  fail(id: string): never {
    this.logger.error({ event: 'order.failed', orderId: id });
    throw new Error(`Unable to load order ${id}`);
  }
}
