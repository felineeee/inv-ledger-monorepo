import { Inject, Injectable, ConflictException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { DB } from '../../../db/types.js';
import {
  CreateTransferDto,
  DispatchTransferDto,
  DispatchTransferItemDto,
  ReceiveTransferDto,
  ReceiveTransferItemDto,
} from '../dto/branch-transfers.dto.js';
import { KYSELY_DB } from '@inv-ledger/databases';
@Injectable()
export class TransferService {
  constructor(@Inject(KYSELY_DB) private readonly db: Kysely<DB>) {}

  // [x] GET /api/transfers
  async findAll(status?: string) {
    let query = this.db
      .selectFrom('transfers')
      .selectAll()
      .orderBy('created_at', 'desc');
    if (status) query = query.where('status', '=', status);
    return query.execute();
  }

  // [x] GET /api/transfers/:id
  async findOne(id: string) {
    const transfer = await this.db
      .selectFrom('transfers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    const items = await this.db
      .selectFrom('transfer_items')
      .selectAll()
      .where('transfer_id', '=', id)
      .execute();

    return { ...transfer, items };
  }

  // [x] GET /api/locations/:id/transfers/incoming
  async findIncoming(locationId: string) {
    return this.db
      .selectFrom('transfers')
      .selectAll()
      .where('destination_location_id', '=', locationId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  // [x] GET /api/locations/:id/transfers/outgoing
  async findOutgoing(locationId: string) {
    return this.db
      .selectFrom('transfers')
      .selectAll()
      .where('source_location_id', '=', locationId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  // [x] POST /api/transfers
  async create(dto: CreateTransferDto) {
    return this.db.transaction().execute(async (trx) => {
      // 1. Create the parent transfer record
      const transfer = await trx
        .insertInto('transfers')
        .values({
          source_location_id: dto.source_location_id,
          destination_location_id: dto.destination_location_id,
          status: 'PENDING',
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      // 2. Prepare and bulk insert the transfer items
      const itemsToInsert = dto.items.map((item) => ({
        transfer_id: transfer.id,
        product_id: item.product_id,
        variant_id: item.variant_id ?? null,
        quantity_requested: item.quantity_requested,
        quantity_dispatched: 0,
        quantity_received: 0,
      }));

      const items = await trx
        .insertInto('transfer_items')
        .values(itemsToInsert)
        .returningAll()
        .execute();

      return { ...transfer, items };
    });
  }

  // [x] PATCH /api/transfers/:id/cancel
  async cancel(id: string) {
    const transfer = await this.db
      .selectFrom('transfers')
      .select('status')
      .where('id', '=', id)
      .executeTakeFirstOrThrow();

    if (transfer.status !== 'PENDING') {
      throw new ConflictException(
        `Cannot cancel a transfer in ${transfer.status} state.`,
      );
    }

    return this.db
      .updateTable('transfers')
      .set({ status: 'CANCELLED' })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  // [x] POST /api/transfers/:id/dispatch
  async dispatch(id: string, dto: DispatchTransferDto) {
    return this.db.transaction().execute(async (trx) => {
      // 1. Verify transfer state
      const transfer = await trx
        .selectFrom('transfers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      if (transfer.status !== 'PENDING') {
        throw new ConflictException(
          `Cannot dispatch a transfer in ${transfer.status} state.`,
        );
      }

      // 2. Loop through items, deduct stock from source, write ledger
      for (const itemDto of dto.items) {
        const transferItem = await trx
          .selectFrom('transfer_items')
          .selectAll()
          .where('id', '=', itemDto.transfer_item_id)
          .where('transfer_id', '=', id)
          .executeTakeFirstOrThrow();

        if (itemDto.quantity_dispatched <= 0) continue;

        // A. Update transfer item
        await trx
          .updateTable('transfer_items')
          .set({ quantity_dispatched: itemDto.quantity_dispatched })
          .where('id', '=', transferItem.id)
          .execute();

        // B. Check if source inventory has enough stock on hand
        const sourceLevel = await trx
          .selectFrom('inventory_levels')
          .selectAll()
          .where('location_id', '=', transfer.source_location_id)
          .where('product_id', '=', transferItem.product_id)
          // Handle variant null-safety check
          .$if(transferItem.variant_id !== null, (qb) =>
            qb.where('variant_id', '=', transferItem.variant_id),
          )
          .$if(transferItem.variant_id === null, (qb) =>
            qb.where('variant_id', 'is', null),
          )
          .executeTakeFirst();

        if (
          !sourceLevel ||
          sourceLevel.quantity_on_hand < itemDto.quantity_dispatched
        ) {
          throw new ConflictException(
            `Insufficient stock on hand at source location for product ${transferItem.product_id}`,
          );
        }

        // C. Deduct stock from source location inventory
        await trx
          .updateTable('inventory_levels')
          .set({
            quantity_on_hand: (eb) =>
              eb('quantity_on_hand', '-', itemDto.quantity_dispatched),
            updated_at: sql`NOW()`,
          })
          .where('id', '=', sourceLevel.id)
          .execute();

        // D. Write TRANSFER_OUT to audit ledger
        await trx
          .insertInto('inventory_ledger')
          .values({
            location_id: transfer.source_location_id,
            product_id: transferItem.product_id,
            variant_id: transferItem.variant_id,
            transaction_type: 'TRANSFER_OUT',
            quantity_change: -itemDto.quantity_dispatched, // Negative change
            reference_type: 'TRANSFER',
            reference_id: transfer.id,
          })
          .execute();
      }

      // 3. Update transfer status to IN_TRANSIT
      return trx
        .updateTable('transfers')
        .set({
          status: 'IN_TRANSIT',
          dispatched_at: sql`NOW()`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  // [x] POST /api/transfers/:id/receive
  async receive(id: string, dto: ReceiveTransferDto) {
    return this.db.transaction().execute(async (trx) => {
      const transfer = await trx
        .selectFrom('transfers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      if (transfer.status !== 'IN_TRANSIT') {
        throw new ConflictException(
          `Cannot receive a transfer unless it is IN_TRANSIT. Current state: ${transfer.status}`,
        );
      }

      for (const itemDto of dto.items) {
        const transferItem = await trx
          .selectFrom('transfer_items')
          .selectAll()
          .where('id', '=', itemDto.transfer_item_id)
          .where('transfer_id', '=', id)
          .executeTakeFirstOrThrow();

        if (itemDto.quantity_received <= 0) continue;

        // A. Update received count on item manifest
        await trx
          .updateTable('transfer_items')
          .set({ quantity_received: itemDto.quantity_received })
          .where('id', '=', transferItem.id)
          .execute();

        // B. Upsert destination inventory levels (increment stock)
        let destLevelQuery = trx
          .selectFrom('inventory_levels')
          .select('id')
          .where('location_id', '=', transfer.destination_location_id)
          .where('product_id', '=', transferItem.product_id);

        if (transferItem.variant_id) {
          destLevelQuery = destLevelQuery.where(
            'variant_id',
            '=',
            transferItem.variant_id,
          );
        } else {
          destLevelQuery = destLevelQuery.where('variant_id', 'is', null);
        }

        const existingDestLevel = await destLevelQuery.executeTakeFirst();

        if (existingDestLevel) {
          await trx
            .updateTable('inventory_levels')
            .set({
              quantity_on_hand: (eb) =>
                eb('quantity_on_hand', '+', itemDto.quantity_received),
              updated_at: sql`NOW()`,
            })
            .where('id', '=', existingDestLevel.id)
            .execute();
        } else {
          await trx
            .insertInto('inventory_levels')
            .values({
              location_id: transfer.destination_location_id,
              product_id: transferItem.product_id,
              variant_id: transferItem.variant_id,
              quantity_on_hand: itemDto.quantity_received,
              quantity_reserved: 0,
              reorder_point: 0,
            })
            .execute();
        }

        // C. Write TRANSFER_IN to audit ledger
        await trx
          .insertInto('inventory_ledger')
          .values({
            location_id: transfer.destination_location_id,
            product_id: transferItem.product_id,
            variant_id: transferItem.variant_id,
            transaction_type: 'TRANSFER_IN',
            quantity_change: itemDto.quantity_received, // Positive change
            reference_type: 'TRANSFER',
            reference_id: transfer.id,
          })
          .execute();
      }

      // 4. Mark transfer as COMPLETED
      return trx
        .updateTable('transfers')
        .set({
          status: 'COMPLETED',
          received_at: sql`NOW()`,
        })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  // [x] POST /api/transfers/:id/reject
  async reject(id: string) {
    return this.db.transaction().execute(async (trx) => {
      const transfer = await trx
        .selectFrom('transfers')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirstOrThrow();

      if (transfer.status !== 'IN_TRANSIT') {
        throw new ConflictException(
          `Can only reject an IN_TRANSIT shipment. Current state: ${transfer.status}`,
        );
      }

      // Note: Rejection logic can vary. Usually, if a shipment is completely rejected,
      // the stock remains 'TRANSFER_OUT' on the books or gets rerouted back to source.
      // For standard handling, we flag the status as REJECTED.
      return trx
        .updateTable('transfers')
        .set({ status: 'REJECTED' })
        .where('id', '=', id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
}
