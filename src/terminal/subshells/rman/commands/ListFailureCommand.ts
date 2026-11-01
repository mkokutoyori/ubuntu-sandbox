import { ok, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import { formatOracleDate, rmanNowMs, rmanWall } from '../core/pureUtils';
import type { IRmanCommand, RmanCommandContext } from './types';
import { renderTable, type TableColumn, type TableStyle } from '@/network/devices/shells/cli/TextTable';

const RMAN_TABLE: TableStyle = { gap: 1, rule: true };
const FIRST_FAILURE_ID = 100;

interface Failure {
  readonly id: number;
  readonly priority: 'CRITICAL' | 'HIGH';
  readonly summary: string;
}

export class ListFailureCommand implements IRmanCommand<string[]> {
  readonly name = 'LIST FAILURE';

  execute(_args: string[], { ctx }: RmanCommandContext): Result<string[], RmanError> {
    const missing = ctx.getDatafiles().filter(file => !ctx.vfs.fileExists(file.path));
    const failures: Failure[] = [];
    for (const file of missing.filter(entry => entry.tablespace.toUpperCase() === 'SYSTEM')) {
      failures.push({ id: FIRST_FAILURE_ID + file.fileNo, priority: 'CRITICAL', summary: `System datafile ${file.fileNo}: '${file.path}' is missing` });
    }
    const others = missing.filter(entry => entry.tablespace.toUpperCase() !== 'SYSTEM');
    if (others.length > 0) {
      failures.push({ id: FIRST_FAILURE_ID + Math.min(...others.map(entry => entry.fileNo)), priority: 'HIGH', summary: 'One or more non-system datafiles are missing' });
    }
    if (failures.length === 0) return ok(['', 'no failures found that match specification', '']);

    const detected = formatOracleDate(rmanWall(ctx, rmanNowMs(ctx))).replace(/^(\d{2}-[A-Z]{3}-)\d{2}(\d{2}).*$/, '$1$2');
    const columns: ReadonlyArray<TableColumn<Failure>> = [
      { header: 'Failure ID', width: 10, value: failure => String(failure.id) },
      { header: 'Priority',   width: 8,  value: failure => failure.priority },
      { header: 'Status',     width: 9,  value: () => 'OPEN' },
      { header: 'Time Detected', width: 13, value: () => detected },
      { header: 'Summary',               value: failure => failure.summary },
    ];
    return ok(['', 'List of Database Failures', '=========================', '', ...renderTable(failures, columns, RMAN_TABLE), '']);
  }
}
