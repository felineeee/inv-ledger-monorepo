import { Module } from '@nestjs/common';
import { PurchaseOrderService } from './purchase-order.service';
import { PurchaseOrderController } from './purchase-order.controller';
import { ReceivingService } from './receiving.service';

@Module({
  controllers: [PurchaseOrderController],
  providers: [PurchaseOrderService, ReceivingService],
})
export class PurchaseOrderModule {}
