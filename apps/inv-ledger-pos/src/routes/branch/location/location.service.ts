import {
  Injectable,
  Inject,
  NotFoundException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { KYSELY_DB } from '@inv-ledger/databases';
import type { Kysely } from '@inv-ledger/databases';
import { randomUUID } from 'crypto';
import { DB } from '../../../db/types.js';
import { CreateLocationDto, UpdateLocationDto } from '../dto/location.dto.js';

@Injectable()
export class LocationService {
  constructor(@Inject(KYSELY_DB) private readonly db: Kysely<DB>) {}
  async createLocation(createLocationDto: CreateLocationDto) {
    return this.db
      .insertInto('locations')
      .values(createLocationDto)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async getLocationAll(activeOnly = true) {
    return this.db.selectFrom('locations').selectAll().execute();
  }
  async getLocationById(id: string) {
    return this.db
      .selectFrom('locations')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  }
  async updateLocation(id: string, updateLocationDto: UpdateLocationDto) {
    if (Object.keys(updateLocationDto).length === 0) {
      throw new BadRequestException(
        'At least one field must be provided for an update.',
      );
    }

    return this.db
      .updateTable('locations')
      .set(updateLocationDto)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }
}
