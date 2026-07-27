import { Inject, Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { DB } from '../../../db/types.js';
import {
  InventoryAdjustmentDto,
  SetReorderThresholdDto,
} from '../dto/inventory-adjustment.dto.js';
import { KYSELY_DB } from '@inv-ledger/databases';
@Injectable()
export class InventoryService {
  constructor(@Inject(KYSELY_DB) private readonly db: Kysely<DB>) {}

  async getInventoryByLocation(locationId: string) {
    return this.db
      .selectFrom('inventory_levels')
      .selectAll()
      .where('location_id', '=', locationId)
      .execute();
  }

  async setReorderThreshold(
    locationId: string,
    productId: string,
    dto: SetReorderThresholdDto,
  ) {
    return this.db
      .updateTable('inventory_levels')
      .set({
        reorder_point: dto.reorder_point,
        updated_at: sql`NOW()`,
      })
      .where('location_id', '=', locationId)
      .where('product_id', '=', productId)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  /**
   * Atomically adjusts stock and logs an immutable audit trail.
   *
   * Process Summary:
   * 1. Transaction Wrapper (trx): Guarantees atomicity—rolls back both ledger and stock updates if either fails.
   * 2. Immutable Audit Log: Inserts an append-only row into `inventory_ledger` with reference metadata (sale, return, etc.).
   * 3. Variant-Aware Lookup: Queries `inventory_levels` handling `NULL` variants (`WHERE variant_id IS NULL`).
   * 4. Atomic Upsert:
   *    - IF EXISTS: Runs an in-database atomic addition (`quantity_on_hand + change`) to prevent race conditions.
   *    - IF NOT EXISTS: Inserts an initial `inventory_levels` record.
   *
   * @returns { level, audit } Updated stock snapshot and the audit log record.
   */
  async adjustInventory(dto: InventoryAdjustmentDto) {
    // Wraps all inner operations into a single PostgreSQL transaction block (BEGIN ... COMMIT)
    return this.db.transaction().execute(async (trx) => {
      // 1. Write to the ledger using transaction_type and new reference fields
      const ledgerEntry = await trx
        .insertInto('inventory_ledger')
        .values({
          location_id: dto.location_id,
          product_id: dto.product_id,
          variant_id: dto.variant_id ?? null,
          transaction_type: dto.transaction_type,
          quantity_change: dto.quantity_change,
          reference_type: dto.reference_type ?? null,
          reference_id: dto.reference_id ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 2. Safely handle the upsert taking the COALESCE index into account
      // We look for the existing level first
      let query = trx
        .selectFrom('inventory_levels')
        .selectAll()
        .where('location_id', '=', dto.location_id)
        .where('product_id', '=', dto.product_id);

      if (dto.variant_id) {
        query = query.where('variant_id', '=', dto.variant_id);
      } else {
        query = query.where('variant_id', 'is', null);
      }

      const existingLevel = await query.executeTakeFirst();

      let updatedLevel;

      if (existingLevel) {
        // UPDATE if it exists
        updatedLevel = await trx
          .updateTable('inventory_levels')
          .set({
            quantity_on_hand: (eb) =>
              eb('quantity_on_hand', '+', dto.quantity_change),
            updated_at: sql`NOW()`,
          })
          .where('id', '=', existingLevel.id)
          .returningAll()
          .executeTakeFirstOrThrow();
      } else {
        // INSERT if it does not exist
        updatedLevel = await trx
          .insertInto('inventory_levels')
          .values({
            location_id: dto.location_id,
            product_id: dto.product_id,
            variant_id: dto.variant_id ?? null,
            quantity_on_hand: dto.quantity_change,
            quantity_reserved: 0,
            reorder_point: 0,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }

      return {
        level: updatedLevel,
        audit: ledgerEntry,
      };
    });
  }

  async getSingleProductInventory(locationId: string, productId: string) {
    return this.db
      .selectFrom('inventory_levels')
      .selectAll()
      .where('location_id', '=', locationId)
      .where('product_id', '=', productId)
      .executeTakeFirstOrThrow();
  }

  async getProductInventoryAcrossLocations(productId: string) {
    return this.db
      .selectFrom('inventory_levels as il')
      .innerJoin('locations as l', 'l.id', 'il.location_id')
      .select([
        'il.product_id',
        'il.variant_id',
        'il.quantity_on_hand',
        'il.quantity_reserved',
        'il.reorder_point',
        'l.id as location_id',
        'l.name as location_name',
        'l.type as location_type',
      ])
      .where('il.product_id', '=', productId)
      .execute();
  }

  async getLowStockReport() {
    return this.db
      .selectFrom('inventory_levels as il')
      .innerJoin('locations as l', 'l.id', 'il.location_id')
      .select([
        'il.product_id',
        'il.variant_id',
        'il.quantity_on_hand',
        'il.quantity_reserved',
        'il.reorder_point',
        'l.id as location_id',
        'l.name as location_name',
      ])
      .whereRef('il.quantity_on_hand', '<=', 'il.reorder_point')
      .execute();
  }
}
