import { Module } from '@nestjs/common';
import { LedgerService } from './ledger.service.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerRepository } from './ledger.repository.js';
import { DatabaseModule } from '@inv-ledger/databases';

@Module({
  imports: [DatabaseModule],
  providers: [LedgerService, LedgerRepository],
  controllers: [LedgerController],
  exports: [LedgerService, LedgerRepository],
})
export class LedgerModule {}
