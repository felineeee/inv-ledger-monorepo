import { Inject, Injectable, ConflictException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { DB } from '../../../db/types.js';
import { ReceivePODto } from '../dto/purchase-order.dto.js';
import { KYSELY_DB } from '@inv-ledger/databases';

@Injectable()
export class ReceivingService {
  constructor(@Inject(KYSELY_DB) private readonly db: Kysely<DB>) {}

  // [x] POST /api/purchase-orders/:id/receive
  async receivePurchaseOrder(id: string, dto: ReceivePODto) {
    return this.db.transaction().execute(async (trx) => {
      // 1. Validate PO state
      const po = await trx
        .selectFrom('purchase_orders')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      if (po.status !== 'SENT' && po.status !== 'PARTIAL') {
        throw new ConflictException(
          `Cannot receive inventory for a PO in ${po.status} status.`,
        );
      }

      // 2. Process each received item
      for (const receivedItem of dto.items) {
        const poItem = await trx
          .selectFrom('purchase_order_items')
          .selectAll()
          .where('id', '=', receivedItem.po_item_id)
          .where('po_id', '=', id)
          .executeTakeFirstOrThrow();

        // A. Update PO Line Item
        await trx
          .updateTable('purchase_order_items')
          .set({
            quantity_received: (eb) =>
              eb('quantity_received', '+', receivedItem.quantity_received),
          })
          .where('id', '=', poItem.id)
          .execute();

        // B. Write to Immutable Ledger
        await trx
          .insertInto('inventory_ledger')
          .values({
            location_id: po.destination_location_id,
            product_id: poItem.product_id,
            variant_id: poItem.variant_id,
            transaction_type: 'RECEIPT',
            quantity_change: receivedItem.quantity_received,
            reference_type: 'PURCHASE_ORDER',
            reference_id: po.id,
          })
          .execute();

        // C. Upsert Inventory Level (Using the same pattern from manual adjustments)
        let levelQuery = trx
          .selectFrom('inventory_levels')
          .select('id')
          .where('location_id', '=', po.destination_location_id)
          .where('product_id', '=', poItem.product_id);

        if (poItem.variant_id) {
          levelQuery = levelQuery.where('variant_id', '=', poItem.variant_id);
        } else {
          levelQuery = levelQuery.where('variant_id', 'is', null);
        }

        const existingLevel = await levelQuery.executeTakeFirst();

        if (existingLevel) {
          await trx
            .updateTable('inventory_levels')
            .set({
              quantity_on_hand: (eb) =>
                eb('quantity_on_hand', '+', receivedItem.quantity_received),
              updated_at: sql`NOW()`,
            })
            .where('id', '=', existingLevel.id)
            .execute();
        } else {
          await trx
            .insertInto('inventory_levels')
            .values({
              location_id: po.destination_location_id,
              product_id: poItem.product_id,
              variant_id: poItem.variant_id,
              quantity_on_hand: receivedItem.quantity_received,
              quantity_reserved: 0,
              reorder_point: 0,
            })
            .execute();
        }
      }

      // 3. Evaluate completion status (Are we PARTIAL or fully RECEIVED?)
      const allItems = await trx
        .selectFrom('purchase_order_items')
        .select(['quantity_ordered', 'quantity_received'])
        .where('po_id', '=', id)
        .execute();

      // Check if every item has received >= what was ordered
      const isFullyReceived = allItems.every(
        (item) => item.quantity_received >= item.quantity_ordered,
      );
      const nextStatus = isFullyReceived ? 'RECEIVED' : 'PARTIAL';

      await trx
        .updateTable('purchase_orders')
        .set({ status: nextStatus })
        .where('id', '=', id)
        .execute();

      return {
        success: true,
        status: nextStatus,
        message: `PO marked as ${nextStatus}`,
      };
    });
  }

  // [x] GET /api/purchase-orders/:id/receipts
  async getPOReceiptHistory(id: string) {
    return this.db
      .selectFrom('inventory_ledger')
      .selectAll()
      .where('reference_type', '=', 'PURCHASE_ORDER')
      .where('reference_id', '=', id)
      .orderBy('created_at', 'desc')
      .execute();
  }
}
