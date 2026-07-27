import { Inject, Injectable, ConflictException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { DB } from '../../../db/types.js';
import { ProcessReturnDto, RestockReturnDto } from '../dto/return.dto.js';
import { KYSELY_DB } from '@inv-ledger/databases';

@Injectable()
export class ReturnService {
  constructor(@Inject(KYSELY_DB) private readonly db: Kysely<DB>) {}

  // [x] POST /api/returns
  async processReturn(dto: ProcessReturnDto) {
    return this.db.transaction().execute(async (trx) => {
      // 1. Write the RETURN to the audit ledger
      const returnEvent = await trx
        .insertInto('inventory_ledger')
        .values({
          location_id: dto.store_location_id,
          product_id: dto.product_id,
          variant_id: dto.variant_id ?? null,
          transaction_type: 'RETURN',
          quantity_change: dto.quantity,
          reference_type: 'CUSTOMER_RETURN', // Optional: could tie this to an Order ID later
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 2. Add stock to the quarantine location
      let levelQuery = trx
        .selectFrom('inventory_levels')
        .select('id')
        .where('location_id', '=', dto.store_location_id)
        .where('product_id', '=', dto.product_id);

      levelQuery = dto.variant_id
        ? levelQuery.where('variant_id', '=', dto.variant_id)
        : levelQuery.where('variant_id', 'is', null);

      const existingLevel = await levelQuery.executeTakeFirst();

      if (existingLevel) {
        await trx
          .updateTable('inventory_levels')
          .set({
            quantity_on_hand: (eb) => eb('quantity_on_hand', '+', dto.quantity),
            updated_at: sql`NOW()`,
          })
          .where('id', '=', existingLevel.id)
          .execute();
      } else {
        await trx
          .insertInto('inventory_levels')
          .values({
            location_id: dto.store_location_id,
            product_id: dto.product_id,
            variant_id: dto.variant_id ?? null,
            quantity_on_hand: dto.quantity,
            quantity_reserved: 0,
            reorder_point: 0,
          })
          .execute();
      }

      // Return the ledger event ID, this becomes the "Return ID" for future actions
      return returnEvent;
    });
  }

  // [x] POST /api/returns/:id/restock
  async restock(ledgerId: string, dto: RestockReturnDto) {
    return this.db.transaction().execute(async (trx) => {
      // 1. Fetch original return event
      const returnEvent = await trx
        .selectFrom('inventory_ledger')
        .selectAll()
        .where('id', '=', ledgerId)
        .executeTakeFirstOrThrow();

      if (returnEvent.transaction_type !== 'RETURN') {
        throw new ConflictException('Provided ID is not a Return event.');
      }

      // 2. Prevent Double Processing
      const alreadyProcessed = await trx
        .selectFrom('inventory_ledger')
        .select('id')
        .where('reference_id', '=', ledgerId)
        .where('reference_type', '=', 'RETURN_LEDGER')
        .executeTakeFirst();

      if (alreadyProcessed)
        throw new ConflictException(
          'This return has already been resolved (restocked or discarded).',
        );

      // 3. Deduct from Quarantine Location
      let quarantineQuery = trx
        .selectFrom('inventory_levels')
        .select('id')
        .where('location_id', '=', returnEvent.location_id)
        .where('product_id', '=', returnEvent.product_id);
      quarantineQuery = returnEvent.variant_id
        ? quarantineQuery.where('variant_id', '=', returnEvent.variant_id)
        : quarantineQuery.where('variant_id', 'is', null);

      const quarantineLevel = await quarantineQuery.executeTakeFirstOrThrow();

      await trx
        .updateTable('inventory_levels')
        .set({
          quantity_on_hand: (eb) =>
            eb('quantity_on_hand', '-', returnEvent.quantity_change),
          updated_at: sql`NOW()`,
        })
        .where('id', '=', quarantineLevel.id)
        .execute();

      // 4. Add to Destination Location (Sales Floor)
      let destQuery = trx
        .selectFrom('inventory_levels')
        .select('id')
        .where('location_id', '=', dto.destination_location_id)
        .where('product_id', '=', returnEvent.product_id);
      destQuery = returnEvent.variant_id
        ? destQuery.where('variant_id', '=', returnEvent.variant_id)
        : destQuery.where('variant_id', 'is', null);

      const destLevel = await destQuery.executeTakeFirst();

      if (destLevel) {
        await trx
          .updateTable('inventory_levels')
          .set({
            quantity_on_hand: (eb) =>
              eb('quantity_on_hand', '+', returnEvent.quantity_change),
            updated_at: sql`NOW()`,
          })
          .where('id', '=', destLevel.id)
          .execute();
      } else {
        await trx
          .insertInto('inventory_levels')
          .values({
            location_id: dto.destination_location_id,
            product_id: returnEvent.product_id,
            variant_id: returnEvent.variant_id ?? null,
            quantity_on_hand: returnEvent.quantity_change,
            quantity_reserved: 0,
            reorder_point: 0,
          })
          .execute();
      }

      // 5. Write RESTOCK to Ledger, linking back to the original RETURN
      return trx
        .insertInto('inventory_ledger')
        .values({
          location_id: dto.destination_location_id,
          product_id: returnEvent.product_id,
          variant_id: returnEvent.variant_id,
          transaction_type: 'RESTOCK',
          quantity_change: returnEvent.quantity_change,
          reference_type: 'RETURN_LEDGER',
          reference_id: ledgerId, // Ties the events together!
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  // [x] POST /api/returns/:id/discard
  async discard(ledgerId: string) {
    return this.db.transaction().execute(async (trx) => {
      // 1. Fetch original return event
      const returnEvent = await trx
        .selectFrom('inventory_ledger')
        .selectAll()
        .where('id', '=', ledgerId)
        .executeTakeFirstOrThrow();

      if (returnEvent.transaction_type !== 'RETURN')
        throw new ConflictException('Provided ID is not a Return event.');

      // 2. Prevent Double Processing
      const alreadyProcessed = await trx
        .selectFrom('inventory_ledger')
        .select('id')
        .where('reference_id', '=', ledgerId)
        .where('reference_type', '=', 'RETURN_LEDGER')
        .executeTakeFirst();

      if (alreadyProcessed)
        throw new ConflictException('This return has already been resolved.');

      // 3. Deduct from Quarantine Location
      let quarantineQuery = trx
        .selectFrom('inventory_levels')
        .select('id')
        .where('location_id', '=', returnEvent.location_id)
        .where('product_id', '=', returnEvent.product_id);
      quarantineQuery = returnEvent.variant_id
        ? quarantineQuery.where('variant_id', '=', returnEvent.variant_id)
        : quarantineQuery.where('variant_id', 'is', null);

      const quarantineLevel = await quarantineQuery.executeTakeFirstOrThrow();

      await trx
        .updateTable('inventory_levels')
        .set({
          quantity_on_hand: (eb) =>
            eb('quantity_on_hand', '-', returnEvent.quantity_change),
          updated_at: sql`NOW()`,
        })
        .where('id', '=', quarantineLevel.id)
        .execute();

      // 4. Write DAMAGE to Ledger
      return trx
        .insertInto('inventory_ledger')
        .values({
          location_id: returnEvent.location_id,
          product_id: returnEvent.product_id,
          variant_id: returnEvent.variant_id,
          transaction_type: 'DAMAGE',
          quantity_change: -returnEvent.quantity_change,
          reference_type: 'RETURN_LEDGER',
          reference_id: ledgerId,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
}
