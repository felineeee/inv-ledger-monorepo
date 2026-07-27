import { ConsoleLogger, Injectable, Scope } from '@nestjs/common';

@Injectable({ scope: Scope.TRANSIENT })
export class PiiScrubberLogger extends ConsoleLogger {
  private readonly piiKeys = new Set([
    'account_id',
    'target_account_id',
    'user_id',
    'senderUserId',
  ]);

  override log(message: unknown, context?: string) {
    const scrubbedMessage = this.processPayload(message);
    super.log(
      typeof scrubbedMessage === 'string'
        ? scrubbedMessage
        : JSON.stringify(scrubbedMessage),
      context,
    );
  }

  override error(message: unknown, stack?: string, context?: string) {
    const scrubbedMessage = this.processPayload(message);
    super.error(
      typeof scrubbedMessage === 'string'
        ? scrubbedMessage
        : JSON.stringify(scrubbedMessage),
      stack,
      context,
    );
  }

  override warn(message: unknown, context?: string) {
    const scrubbedMessage = this.processPayload(message);
    super.warn(
      typeof scrubbedMessage === 'string'
        ? scrubbedMessage
        : JSON.stringify(scrubbedMessage),
      context,
    );
  }

  private processPayload(payload: unknown): unknown {
    if (payload === null || payload === undefined) {
      return payload;
    }

    if (typeof payload !== 'object') {
      return payload;
    }

    if (Array.isArray(payload)) {
      return payload.map((item) => this.processPayload(item));
    }

    const scrubbedObj: Record<string, unknown> = {};
    for (const key in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, key)) {
        const val = (payload as Record<string, unknown>)[key];
        if (this.piiKeys.has(key) && typeof val === 'string') {
          scrubbedObj[key] = this.maskString(val);
        } else {
          scrubbedObj[key] = this.processPayload(val);
        }
      }
    }

    return scrubbedObj;
  }

  private maskString(val: string): string {
    if (val.length <= 8) {
      return '********';
    }
    return `${val.substring(0, 4)}-****-${val.substring(val.length - 4)}`;
  }
}
