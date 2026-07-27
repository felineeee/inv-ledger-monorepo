import {
  Inject,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '@inv-ledger/databases';
import * as crypto from 'crypto';

export interface LedgerEntry {
  id?: number;
  transaction_id: string;
  account_id: string;
  amount: bigint;
  description?: string;
  previous_hash: string;
  current_hash?: string;
  created_at?: Date;
}

const GENESIS_HASH =
  '0000000000000000000000000000000000000000000000000000000000000000';

@Injectable()
export class LedgerRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getLastEntryHash(
    accountId: string,
    client: PoolClient,
  ): Promise<string> {
    const query = `SELECT current_hash FROM ledger_entries WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1`;
    try {
      const res = await client.query(query, [accountId]);
      if (res.rows.length === 0) {
        return GENESIS_HASH;
      }
      return res.rows[0].current_hash;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        `Database read failure during hash audit fetchL ${errorMessage}`,
      );
    }
  }
  async insertLedgerEntry(
    entry: LedgerEntry,
    client: PoolClient,
  ): Promise<LedgerEntry> {
    const rawData = `${entry.transaction_id}|${entry.account_id}|${entry.amount.toString()}|${entry.previous_hash}`;

    entry.current_hash = crypto
      .createHash('sha256')
      .update(rawData)
      .digest('hex');

    const query = `INSERT INTO ledger_entries (transaction_id, account_id, amount, description, previous_hash, current_hash) VALUES($1, $2, $3, $4, $5, $6) RETURNING id, created_at`;

    try {
      const res = await client.query(query, [
        entry.transaction_id,
        entry.account_id,
        entry.amount.toString(),
        entry.description || null,
        entry.previous_hash,
        entry.current_hash,
      ]);

      return {
        ...entry,
        id: parseInt(res.rows[0].id, 10),
        created_at: res.rows[0].created_at,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(
        `Database append failure on ledger writing: ${errorMessage}`,
      );
    }
  }
}
