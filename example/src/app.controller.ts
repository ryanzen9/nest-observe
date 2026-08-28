import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { OrdersService, type CreateOrderInput, type Order } from './orders.service';

@Controller()
export class AppController {
  constructor(private readonly orders: OrdersService) {}

  @Get('health')
  health(): { status: string; service: string } {
    return { status: 'ok', service: 'nest-observe-example' };
  }

  @Post('orders')
  createOrder(@Body() input: CreateOrderInput): Order {
    return this.orders.create(input);
  }

  @Get('orders/:id/failure')
  failOrder(@Param('id') id: string): never {
    return this.orders.fail(id);
  }
}
