import {
  Inject,
  Global,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService, ConfigModule } from '@nestjs/config';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import { PG_POOL, KYSELY_DB } from './database.constats.js';
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PG_POOL,
      useFactory: (ConfigService: ConfigService) => {
        const connectionString = ConfigService.get<string>('DATABASE_URL');

        return new Pool({
          connectionString,
          max: 25,
          min: 5,
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        });
      },
      inject: [ConfigService],
    },
    {
      provide: KYSELY_DB,
      useFactory: (pool: Pool) => {
        return new Kysely<any>({
          dialect: new PostgresDialect({ pool }),
        });
      },
      inject: [PG_POOL],
    },
  ],
  exports: [PG_POOL, KYSELY_DB],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onModuleInit() {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
  }

  async onApplicationShutdown() {
    await this.pool.end();
  }
}
