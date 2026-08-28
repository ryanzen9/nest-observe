import { Module } from '@nestjs/common';
import { ObserveModule } from '@ryanzeng/nest-observe';
import { AppController } from './app.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [ObserveModule.forRoot()],
  controllers: [AppController],
  providers: [OrdersService],
})
export class AppModule {}
