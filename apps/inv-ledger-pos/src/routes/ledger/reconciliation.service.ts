import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '@inv-ledger/databases';

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private readonly RECONCILIATION_LOCK_ID = 987654321;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDailyReconciliation() {
    const client: PoolClient = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const lockQuery = `SELECT pg_try_advisory_xact_lock($1) AS acquired;`;
      const lockRes = await client.query(lockQuery, [
        this.RECONCILIATION_LOCK_ID,
      ]);
      const isLockAcquired = lockRes.rows[0].acquired;

      if (!isLockAcquired) {
        this.logger.log(
          'Daily reconciliation script execution bypassed: Lock already held by a parallel cluster node',
        );
        await client.query(`ROLLBACK`);
        return;
      }

      this.logger.log(
        'Distributed Advisory Lock safely claimed. Initiating systemic wallet asset reconciliation audits...',
      );

      const auditQuery = `SELECT (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries) = (SELECT COALESCE(SUM(balance), 0) FROM account_snapshots) AS balances_match;`;
      const auditRes = await client.query(auditQuery);
      const balancesMatch = auditRes.rows[0].balances_match;

      if (!balancesMatch) {
        this.logger.error(
          'CRITICAL ALARM: Systemic asset imbalance discovered between immutable entries and account balance snapshots!',
        );
      } else {
        this.logger.log(
          'Ledger validation verified successfully. All global accounts are perfectly balanced to zero',
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occured';
      this.logger.error(
        `Fatal crash encountered during active cron auditing lifecycle: ${errorMessage}`,
      );
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}
