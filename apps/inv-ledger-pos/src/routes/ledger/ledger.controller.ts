import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { LedgerService } from './ledger.service.js';
import { AuthGuard } from '@inv-ledger/guards';
import { CurrentUser } from '@inv-ledger/decorators';
import { TransferRequestDto } from './dto/transfer-request.dto.js';
import { IdempotencyInterceptor } from '@inv-ledger/interceptors';
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledgerService: LedgerService) {}

  @Post()
  @UseGuards(AuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @HttpCode(HttpStatus.OK)
  async initiateTransfer(
    @CurrentUser() user: { id: string },
    @Body() body: TransferRequestDto,
  ) {
    const amountInCents = BigInt(body.amount);
    const result = await this.ledgerService.executeTransfer(
      user.id,
      body.target_account_id,
      body.source_account_id,
      amountInCents,
      body.description,
    );

    return {
      success: true,
      message: 'Asset transfer processed',
      ...result,
    };
  }

  @Post('accounts')
  @UseGuards(AuthGuard)
  async openNewWallet(
    @CurrentUser() user: { id: string },
    @Body() body: { type: string; currency?: string },
  ) {
    return await this.ledgerService.createAccount(
      user.id,
      body.type,
      body.currency || 'USD',
    );
  }
}
