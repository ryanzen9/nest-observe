import { Body, Controller, Get, Inject, Param, Post } from "@nestjs/common";
import { ApiBody } from "@nestjs/swagger";
import { Trace } from "@ryanzeng/nest-observe";
import {
  OrdersService,
  type CreateOrderInput,
  type Order,
} from "./orders.service";

@Controller()
export class AppController {
  constructor(
    @Inject(OrdersService)
    private readonly orders: OrdersService,
  ) {}

  @Get("health")
  health(): { status: string; service: string } {
    return { status: "ok", service: "nest-observe-example" };
  }

  @Post("orders")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        sku: { type: "string" },
        quantity: { type: "number" },
      },
      required: ["sku", "quantity"],
    },
  })
  @Trace("order.create")
  createOrder(@Body() input: CreateOrderInput): Order {
    return this.orders.create(input);
  }

  @Get("orders/:id/failure")
  failOrder(@Param("id") id: string): never {
    return this.orders.fail(id);
  }
}
