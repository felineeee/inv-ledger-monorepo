import {
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { DB } from '../../../db/types.js';
import {
  CreateStocktakeDto,
  SubmitCountBatchDto,
  CorrectStockTakeItemDto,
} from '../dto/stocktake.dto.js';
import { KYSELY_DB } from '@inv-ledger/databases';

@Injectable()
export class StocktakeService {
  constructor(@Inject(KYSELY_DB) private readonly db: Kysely<DB>) {}

  // [x] GET /api/stocktakes
  async findAll() {
    return this.db
      .selectFrom('stocktakes')
      .selectAll()
      .orderBy('started_at', 'desc')
      .execute();
  }

  // [x] GET /api/stocktakes/:id
  async findOne(id: string) {
    const stocktake = await this.db
      .selectFrom('stocktakes')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    const items = await this.db
      .selectFrom('stocktake_items')
      .selectAll()
      .where('stocktake_id', '=', id)
      .execute();
    return { ...stocktake, items };
  }

  // [x] POST /api/stocktakes
  async create(dto: CreateStocktakeDto) {
    return this.db.transaction().execute(async (trx) => {
      // 1. Create Stocktake Session
      const stocktake = await trx
        .insertInto('stocktakes')
        .values({ location_id: dto.location_id, status: 'IN_PROGRESS' })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 2. Take Snapshot of current inventory levels
      const levels = await trx
        .selectFrom('inventory_levels')
        .selectAll()
        .where('location_id', '=', dto.location_id)
        .execute();

      if (levels.length > 0) {
        const snapshotItems = levels.map((level) => ({
          stocktake_id: stocktake.id,
          product_id: level.product_id,
          variant_id: level.variant_id,
          expected_quantity: level.quantity_on_hand,
          counted_quantity: 0,
          variance: 0,
        }));

        await trx.insertInto('stocktake_items').values(snapshotItems).execute();
      }

      return this.findOne(stocktake.id);
    });
  }

  // [x] DELETE /api/stocktakes/:id
  async remove(id: string) {
    const stocktake = await this.db
      .selectFrom('stocktakes')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    if (stocktake.status !== 'IN_PROGRESS')
      throw new ConflictException('Can only cancel IN_PROGRESS stocktakes.');

    await this.db.deleteFrom('stocktakes').where('id', '=', id).execute();
    return { success: true, message: 'Stocktake aborted.' };
  }

  // [x] POST /api/stocktakes/:id/count
  async submitCount(id: string, dto: SubmitCountBatchDto) {
    return this.db.transaction().execute(async (trx) => {
      const stocktake = await trx
        .selectFrom('stocktakes')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      if (stocktake.status !== 'IN_PROGRESS')
        throw new ConflictException('Stocktake is no longer IN_PROGRESS.');

      for (const count of dto.items) {
        // Find existing snapshot item
        let query = trx
          .selectFrom('stocktake_items')
          .selectAll()
          .where('stocktake_id', '=', id)
          .where('product_id', '=', count.product_id);
        query = count.variant_id
          ? query.where('variant_id', '=', count.variant_id)
          : query.where('variant_id', 'is', null);

        const existingItem = await query.executeTakeFirst();

        if (existingItem) {
          // Increment or set count (Assuming barcode batching increments)
          await trx
            .updateTable('stocktake_items')
            .set({
              counted_quantity: (eb) =>
                eb('counted_quantity', '+', count.counted_quantity),
            })
            .where('id', '=', existingItem.id)
            .execute();
        } else {
          // "Found Stock" edge case - item wasn't in original snapshot
          await trx
            .insertInto('stocktake_items')
            .values({
              stocktake_id: id,
              product_id: count.product_id,
              variant_id: count.variant_id ?? null,
              expected_quantity: 0,
              counted_quantity: count.counted_quantity,
              variance: 0, // Calculated at completion
            })
            .execute();
        }
      }
      return { success: true, message: 'Counts recorded.' };
    });
  }

  // [x] PATCH /api/stocktakes/:id/count/:itemId
  async correctCount(id: string, itemId: string, dto: CorrectStockTakeItemDto) {
    const stocktake = await this.db
      .selectFrom('stocktakes')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    if (stocktake.status !== 'IN_PROGRESS')
      throw new ConflictException('Stocktake is closed.');

    return this.db
      .updateTable('stocktake_items')
      .set({ counted_quantity: dto.counted_quantity })
      .where('id', '=', itemId)
      .where('stocktake_id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  // [x] GET /api/stocktakes/:id/variance-report
  async getVarianceReport(id: string) {
    // Returns only items where counted != expected
    return this.db
      .selectFrom('stocktake_items')
      .selectAll()
      .where('stocktake_id', '=', id)
      .whereRef('counted_quantity', '!=', 'expected_quantity')
      .execute();
  }

  // [x] POST /api/stocktakes/:id/complete
  async complete(id: string) {
    return this.db.transaction().execute(async (trx) => {
      const stocktake = await trx
        .selectFrom('stocktakes')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      if (stocktake.status !== 'IN_PROGRESS')
        throw new ConflictException('Already completed or cancelled.');

      const items = await trx
        .selectFrom('stocktake_items')
        .selectAll()
        .where('stocktake_id', '=', id)
        .execute();

      for (const item of items) {
        const variance = item.counted_quantity - item.expected_quantity;

        // 1. Update the variance on the stocktake item
        await trx
          .updateTable('stocktake_items')
          .set({ variance })
          .where('id', '=', item.id)
          .execute();

        // 2. Only hit inventory levels and ledger if there's a discrepancy
        if (variance !== 0) {
          const transactionType = variance < 0 ? 'SHRINKAGE' : 'ADJUSTMENT';

          // Update inventory levels (Upsert style for "found stock")
          let levelQuery = trx
            .selectFrom('inventory_levels')
            .select('id')
            .where('location_id', '=', stocktake.location_id)
            .where('product_id', '=', item.product_id);
          levelQuery = item.variant_id
            ? levelQuery.where('variant_id', '=', item.variant_id)
            : levelQuery.where('variant_id', 'is', null);

          const existingLevel = await levelQuery.executeTakeFirst();

          if (existingLevel) {
            await trx
              .updateTable('inventory_levels')
              .set({
                quantity_on_hand: item.counted_quantity,
                updated_at: sql`NOW()`,
              })
              .where('id', '=', existingLevel.id)
              .execute();
          } else {
            await trx
              .insertInto('inventory_levels')
              .values({
                location_id: stocktake.location_id,
                product_id: item.product_id,
                variant_id: item.variant_id ?? null,
                quantity_on_hand: item.counted_quantity,
                quantity_reserved: 0,
                reorder_point: 0,
              })
              .execute();
          }

          // Write to Audit Ledger
          await trx
            .insertInto('inventory_ledger')
            .values({
              location_id: stocktake.location_id,
              product_id: item.product_id,
              variant_id: item.variant_id ?? null,
              transaction_type: transactionType,
              quantity_change: variance, // Will automatically be negative for shrinkage
              reference_type: 'STOCKTAKE',
              reference_id: stocktake.id,
            })
            .execute();
        }
      }

      // Finalize Stocktake
      await trx
        .updateTable('stocktakes')
        .set({ status: 'COMPLETED', completed_at: sql`NOW()` })
        .where('id', '=', id)
        .execute();

      return {
        success: true,
        message: 'Stocktake completed. Variances resolved and ledger updated.',
      };
    });
  }
}
