import type { BackupSet } from '../catalog/types';
import { formatOracleDate, formatSize, formatElapsed, rmanWall } from './pureUtils';
import { renderTable, type TableColumn, type TableStyle } from '@/network/devices/shells/cli/TextTable';

const RMAN_TABLE: TableStyle = { gap: 1, rule: true };
const RMAN_NESTED_TABLE: TableStyle = { gap: 1, rule: true, indent: '  ' };

function typeOf(set: BackupSet): string {
  switch (set.type) {
    case 'FULL':           return 'Full';
    case 'INCREMENTAL_0':  return 'Incr';
    case 'INCREMENTAL_1':  return 'Incr';
    case 'ARCHIVELOG':     return 'ArchLog';
    case 'CONTROLFILE':    return 'Full';
    case 'DATAFILECOPY':   return 'DFCopy';
  }
}

function levelOf(set: BackupSet): string {
  switch (set.type) {
    case 'INCREMENTAL_0': return '0';
    case 'INCREMENTAL_1': return '1';
    default:              return '';
  }
}

const setColumns = (wall: WallOf): ReadonlyArray<TableColumn<BackupSet>> => [
  { header: 'BS Key',          width: 7,  value: set => String(set.bsKey) },
  { header: 'Type',                       value: typeOf },
  { header: 'LV',              width: 2,  value: levelOf },
  { header: 'Size',            width: 10, value: set => formatSize(set.sizeBytes) },
  { header: 'Device Type',     width: 11, value: () => 'DISK' },
  { header: 'Elapsed Time',    width: 12, value: set => formatElapsed(set.completionTime - set.startTime) },
  { header: 'Completion Time',            value: set => formatOracleDate(wall(set.completionTime)) },
];

interface DatafileRow {
  readonly fileNo: number;
  readonly level: string;
  readonly ckpScn: number;
  readonly ckpTime: number;
  readonly path: string;
}

const datafileColumns = (wall: WallOf): ReadonlyArray<TableColumn<DatafileRow>> => [
  { header: 'File',     width: 4,  align: 'right', value: row => String(row.fileNo) },
  { header: 'LV',       width: 2,  value: row => row.level },
  { header: 'Type',     width: 4,  value: () => 'Full' },
  { header: 'Ckp SCN',  width: 10, value: row => String(row.ckpScn) },
  { header: 'Ckp Time', width: 20, value: row => formatOracleDate(wall(row.ckpTime)) },
  { header: 'Name',                value: row => row.path },
];

interface ArchivedLogRow {
  readonly thread: number;
  readonly sequence: number;
  readonly path: string;
  readonly firstScn: number;
  readonly nextScn: number;
}

const ARCHIVED_LOG_COLUMNS: ReadonlyArray<TableColumn<ArchivedLogRow>> = [
  { header: 'Key',      width: 7,  value: row => String(row.sequence) },
  { header: 'Thrd',     width: 4,  value: row => String(row.thread) },
  { header: 'Seq',      width: 7,  value: row => String(row.sequence) },
  { header: 'S',        width: 1,  value: () => 'A' },
  { header: 'Low SCN',  width: 10, value: row => String(row.firstScn) },
  { header: 'Next SCN', width: 10, value: row => String(row.nextScn) },
  { header: 'Name',                value: row => row.path },
];

export type WallOf = (atMs: number) => Date;

export function backupSetLines(sets: ReadonlyArray<BackupSet>, ctx?: { hostZoneName?(): string }): string[] {
  const wall: WallOf = (atMs) => rmanWall(ctx, atMs);
  const lines: string[] = ['', 'List of Backup Sets', '===================', ''];
  const table = renderTable(sets, setColumns(wall), RMAN_TABLE);
  lines.push(table[0], table[1]);
  sets.forEach((set, index) => {
    lines.push(table[index + 2]);
    if (set.keepNote) lines.push(`  Keep: ${set.keepNote}`);
    for (const piece of set.pieces) {
      lines.push(`        BP Key: ${piece.key.bpKey}   Status: ${piece.status}  Compressed: ${
        piece.compressed ? 'YES' : 'NO'}  Encrypted: ${piece.encrypted ? 'YES' : 'NO'}  Tag: ${piece.tag.label}`);
      lines.push(`          Piece Name: ${piece.path}`);
    }
    if (set.type === 'CONTROLFILE') {
      lines.push('  Control File Included: Ckp SCN: 1892354    Ckp time: '
        + formatOracleDate(wall(set.completionTime)));
    }
    if (set.datafiles.length > 0) {
      lines.push(`  List of Datafiles in backup set ${set.bsKey}`);
      lines.push(...renderTable(
        set.datafiles.map(df => ({
          fileNo: df.fileNo, level: levelOf(set), ckpScn: df.ckpScn.value,
          ckpTime: df.ckpTime, path: df.path,
        })),
        datafileColumns(wall), RMAN_NESTED_TABLE));
    }
  });
  lines.push('');
  return lines;
}

export function restorePreviewLines(
  sets: ReadonlyArray<BackupSet>,
  logs: ReadonlyArray<ArchivedLogRow>,
  untilScn?: number,
  ctx?: { hostZoneName?(): string },
): string[] {
  const checkpoints = sets.flatMap(set => set.datafiles.length > 0
    ? set.datafiles.map(df => df.ckpScn.value)
    : set.pieces.map(piece => piece.checkpointScn.value));
  const recoveryScn = untilScn ?? (checkpoints.length > 0 ? Math.min(...checkpoints) : 0);
  const fuzziness = Math.max(recoveryScn, ...checkpoints, 0);
  const lines = backupSetLines(sets, ctx);
  if (logs.length > 0) {
    lines.push('List of Archived Log Copies for database', '=======================================');
    lines.push(...renderTable(logs, ARCHIVED_LOG_COLUMNS, RMAN_TABLE));
    lines.push('');
  }
  const beyond = logs.reduce((high, log) => Math.max(high, log.nextScn), fuzziness);
  lines.push(
    `recovery will be done up to SCN ${recoveryScn}`,
    `Media recovery start SCN is ${recoveryScn}`,
    `Recovery must be done beyond SCN ${beyond} to clear datafile fuzziness`,
  );
  return lines;
}
