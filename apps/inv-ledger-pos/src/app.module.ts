import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { LedgerModule } from './routes/ledger/ledger.module.js';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from '@inv-ledger/configs';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '@inv-ledger/databases';
import { RedisModule } from '@inv-ledger/caches';
import { AuditModule } from './routes/branch/audit/audit.module.js';
import { InventoryModule } from './routes/branch/inventory/inventory.module.js';
import { HealthModule } from './routes/health/health.module.js';
import { LocationsModule } from './routes/branch/location/location.module.js';
import { PurchaseOrderModule } from './routes/procurement/purchase-order/purchase-order.module.js';
import { SupplierModule } from './routes/procurement/supplier/supplier.module.js';
import { ReturnModule } from './routes/return/return/return.module.js';
import { StocktakeModule } from './routes/stocktake/stocktake/stocktake.module.js';
import { TransferModule } from './routes/transfer/transfer/transfer.module.js';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    LedgerModule,
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    DatabaseModule,
    RedisModule,
    AuditModule,
    InventoryModule,
    HealthModule,
    LocationsModule,
    PurchaseOrderModule,
    SupplierModule,
    ReturnModule,
    StocktakeModule,
    TransferModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
