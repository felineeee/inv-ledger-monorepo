import { Injectable, Inject } from '@nestjs/common';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { Migrator, FileMigrationProvider } from 'kysely/migration';
import { PG_POOL } from '@inv-ledger/databases';

@Injectable()
export class MigrationService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async runMigrations() {
    const db = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: this.pool }),
    });

    const migrator = new Migrator({
      db,
      provider: new FileMigrationProvider({
        fs,
        path,
        migrationFolder: path.join(__dirname, 'migrations'),
      }),
    });

    const { error, results } = await migrator.migrateToLatest();

    results?.forEach((it) => {
      if (it.status === 'Success') {
        console.log(
          `Migration "${it.migrationName}" was executed successfully`,
        );
      } else if (it.status === 'Error') {
        console.error(`Failed to execute migration "${it.migrationName}"`);
      }
    });

    if (error) {
      console.error('Failed to migrate:', error);
      await db.destroy();
      process.exit(1);
    }

    await db.destroy();
  }
}
