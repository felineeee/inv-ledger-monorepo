import { Inject, Injectable, ConflictException } from '@nestjs/common';
import { DB } from '../../../db/types.js';
import { Kysely } from 'kysely';
import {
  CreatePurchaseOrderDto,
  UpdatePurchaseOrderDto,
  UpdatePOStatusDto,
} from '../dto/purchase-order.dto.js';
import { KYSELY_DB } from '@inv-ledger/databases';
@Injectable()
export class PurchaseOrderService {
  constructor(@Inject(KYSELY_DB) private readonly db: Kysely<DB>) {}

  // [x] GET /api/purchase-orders
  async findAll(status?: string) {
    let query = this.db
      .selectFrom('purchase_orders')
      .selectAll()
      .orderBy('created_at', 'desc');
    if (status) {
      query = query.where('status', '=', status);
    }
    return query.execute();
  }

  // [x] GET /api/purchase-orders/:id
  async findOne(id: string) {
    // Fetch parent PO
    const po = await this.db
      .selectFrom('purchase_orders')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    // Fetch nested line items
    const items = await this.db
      .selectFrom('purchase_order_items')
      .selectAll()
      .where('id', '=', id)
      .execute();

    return { ...po, items };
  }

  // [x] POST /api/purchase-orders
  async create(dto: CreatePurchaseOrderDto) {
    return this.db.transaction().execute(async (trx) => {
      // 1. Insert parent PO
      const po = await trx
        .insertInto('purchase_orders')
        .values({
          supplier_id: dto.supplier_id,
          destination_location_id: dto.destination_location_id,
          expected_delivery_date: dto.expected_delivery_date
            ? new Date(dto.expected_delivery_date)
            : null,
          status: 'DRAFT', // Always start as DRAFT
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 2. Prepare and Bulk Insert line items
      const itemsToInsert = dto.items.map((item) => ({
        po_id: po.id,
        product_id: item.product_id,
        variant_id: item.variant_id ?? null,
        quantity_ordered: item.quantity_ordered,
        unit_cost: item.unit_cost,
        quantity_received: 0,
      }));

      const items = await trx
        .insertInto('purchase_order_items')
        .values(itemsToInsert)
        .returningAll()
        .execute();

      return { ...po, items };
    });
  }

  // [x] PATCH /api/purchase-orders/:id
  async update(id: string, dto: UpdatePurchaseOrderDto) {
    return this.db.transaction().execute(async (trx) => {
      // Verify it's a DRAFT
      const po = await trx
        .selectFrom('purchase_orders')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      if (po.status !== 'DRAFT') {
        throw new ConflictException(
          'Only DRAFT purchase orders can be edited.',
        );
      }

      // Update PO header if fields provided
      if (dto.supplier_id || dto.expected_delivery_date) {
        await trx
          .updateTable('purchase_orders')
          .set({
            supplier_id: dto.supplier_id,
            expected_delivery_date: dto.expected_delivery_date
              ? new Date(dto.expected_delivery_date)
              : undefined,
          })
          .where('id', '=', id)
          .execute();
      }

      // Replace items entirely if provided (simplest and safest way to handle nested DRAFT edits)
      if (dto.items && dto.items.length > 0) {
        await trx
          .deleteFrom('purchase_order_items')
          .where('po_id', '=', id)
          .execute();

        const itemsToInsert = dto.items.map((item) => ({
          po_id: id,
          product_id: item.product_id,
          variant_id: item.variant_id ?? null,
          quantity_ordered: item.quantity_ordered,
          unit_cost: item.unit_cost,
          quantity_received: 0,
        }));
        await trx
          .insertInto('purchase_order_items')
          .values(itemsToInsert)
          .execute();
      }

      return this.findOne(id); // Re-fetch the updated aggregate
    });
  }

  // [x] PATCH /api/purchase-orders/:id/status
  async updateStatus(id: string, dto: UpdatePOStatusDto) {
    const po = await this.db
      .selectFrom('purchase_orders')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    if (po.status !== 'DRAFT') {
      throw new ConflictException(
        `Cannot transition status from ${po.status}.`,
      );
    }

    return this.db
      .updateTable('purchase_orders')
      .set({ status: dto.status })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  // [x] DELETE /api/purchase-orders/:id
  async remove(id: string) {
    const po = await this.db
      .selectFrom('purchase_orders')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    if (po.status !== 'DRAFT') {
      throw new ConflictException(
        'Cannot delete a Purchase Order that has already been sent.',
      );
    }

    // Assuming your schema has ON DELETE CASCADE on purchase_order_items.
    // If not, you must delete from purchase_order_items first.
    await this.db.deleteFrom('purchase_orders').where('id', '=', id).execute();
    return { success: true, message: 'Purchase Order deleted' };
  }
}
