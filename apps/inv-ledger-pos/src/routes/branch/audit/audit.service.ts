import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DB } from '../../../db/types.js';
import { AuditFilterDto } from '../dto/audit-filter.dto.js';
import { KYSELY_DB } from '@inv-ledger/databases';

@Injectable()
export class AuditService {
  constructor(@Inject(KYSELY_DB) private readonly db: Kysely<DB>) {}

  // [x] GET /api/inventory/ledger
  async getLedger(filters: AuditFilterDto) {
    let query = this.db
      .selectFrom('inventory_ledger')
      .selectAll()
      .orderBy('created_at', 'desc');

    if (filters.location_id) {
      query = query.where('location_id', '=', filters.location_id);
    }

    if (filters.product_id) {
      query = query.where('product_id', '=', filters.product_id);
    }

    if (filters.start_date) {
      query = query.where('created_at', '>=', new Date(filters.start_date));
    }

    if (filters.end_date) {
      query = query.where('created_at', '<=', new Date(filters.end_date));
    }

    // offset = (page - 1) * limit
    const offset = (filters.page - 1) * filters.limit;
    query = query.limit(filters.limit).offset(offset);

    return query.execute();
  }

  // [x] GET /api/inventory/ledger/:id
  async getLedgerEntry(id: string) {
    return this.db
      .selectFrom('inventory_ledger')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }
}
