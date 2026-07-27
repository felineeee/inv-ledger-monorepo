import {
  Global,
  Module,
  OnApplicationShutdown,
  OnModuleInit,
  Inject,
  Logger,
} from '@nestjs/common';
import { createClient } from 'redis';
import type { RedisClientType } from 'redis';
import { REDIS_CLIENT } from './redis.constants.js';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: async () => {
        const client = createClient({
          url: process.env.REDIS_URL || 'redis://localhost:6381',
        });

        await client.connect();
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RedisModule.name);

  constructor(
    @Inject(REDIS_CLIENT) private readonly redisClient: RedisClientType,
  ) {}

  async onModuleInit() {
    this.redisClient.on('error', (err) => {
      this.logger.error('Redis Client Error', err);
    });

    try {
      const response = await this.redisClient.ping();
      if (response === 'PONG') {
        this.logger.log('Successfully connected to Redis');
      }
    } catch (error) {
      this.logger.error('Failed to ping Redis on startup', error);
      throw error;
    }
  }

  async onApplicationShutdown() {
    this.logger.log('Closing Redis connection...');
    await this.redisClient.quit();
  }
}
