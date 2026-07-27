import {
  Inject,
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { REDIS_CLIENT } from '@inv-ledger/caches';
import type { RedisClientType } from '@redis/client';

import { Observable, of, from } from 'rxjs';
import { mergeMap } from 'rxjs/operators';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: RedisClientType) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Promise<Observable<unknown>> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest();
    const response = httpContext.getResponse();

    const idempotencyKey = request.headers['idempotency-key'];

    if (!idempotencyKey) {
      return next.handle();
    }

    if (!request.user || !request.user.id) {
      return next.handle();
    }

    const redisKey = `idempotency:${request.user.id}:${idempotencyKey}`;

    const cachedData = await this.redis.get(redisKey);
    if (cachedData) {
      const parsedResponse = JSON.parse(cachedData);

      if (parsedResponse.status === 'PROCESSING') {
        throw new BadRequestException(
          'A matching concurrent transaction is actively processing. Please wait',
        );
      }

      response.status(parsedResponse.statusCode);
      return of(parsedResponse.body);
    }

    // Set lock status with 120s TTL
    await this.redis.set(redisKey, JSON.stringify({ status: 'PROCESSING' }), {
      EX: 120,
    });

    return next.handle().pipe(
      mergeMap(async (data) => {
        const statusCode = response.statusCode || 200;
        const cachePayload = {
          status: 'COMPLETED',
          statusCode,
          body: data,
        };

        // Persist final payload in Redis for 24 hours
        await this.redis.set(redisKey, JSON.stringify(cachePayload), {
          EX: 86400,
        });

        return data;
      }),
    );
  }
}
