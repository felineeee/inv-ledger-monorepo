import { Inject, Injectable, BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { DB } from '../../../db/types.js';
import {
  CreateSupplierDto,
  UpdateSupplierDto,
} from '../dto/purchase-order.dto.js';
import { KYSELY_DB } from '@inv-ledger/databases';

@Injectable()
export class SupplierService {
  constructor(@Inject(KYSELY_DB) private readonly db: Kysely<DB>) {}

  async findAll() {
    return this.db
      .selectFrom('suppliers')
      .selectAll()
      .orderBy('name', 'asc')
      .execute();
  }

  async findOne(id: string) {
    return this.db
      .selectFrom('suppliers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }

  async create(dto: CreateSupplierDto) {
    return this.db
      .insertInto('suppliers')
      .values({
        name: dto.name,
        contact_email: dto.contact_email ?? null,
        lead_time_days: dto.lead_time_days ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  async update(id: string, dto: UpdateSupplierDto) {
    if (Object.keys(dto).length === 0) {
      throw new BadRequestException('Provide at least one field to update');
    }

    return this.db
      .updateTable('suppliers')
      .set(dto)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
