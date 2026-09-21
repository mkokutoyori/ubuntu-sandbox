import type { VfsAdapter, BlockCorruptionType } from '../integration/IRmanOracleContext';
import { readBackupPieceImage } from './BackupPieceImage';
import { parseDatafileImage } from '@/database/oracle/storage/DatafileImage';

const DATAFILE_BANNER = 'ORACLE DATAFILE';
const SEGMENT_MARKER  = 'ORACLE-SEGMENT-IMAGE';

export type PieceFault = 'missing' | 'unreadable' | 'checksum';

export interface PieceVerdict {
  readonly path:  string;
  readonly fault: PieceFault | null;
}

export function bannerIsIntact(text: string, banner: string): boolean {
  return text.length === 0 || text.includes(banner);
}

export function validateBackupPiece(vfs: VfsAdapter, path: string): PieceVerdict {
  if (!vfs.fileExists(path)) return { path, fault: 'missing' };
  const read = vfs.readFile(path);
  if (read.ok === false) return { path, fault: 'unreadable' };
  const text = new TextDecoder().decode(read.value);
  if (!bannerIsIntact(text, 'ORACLE RMAN BACKUP PIECE')) return { path, fault: 'unreadable' };
  const parsed = readBackupPieceImage(text);
  if (parsed === null) return { path, fault: null };
  return { path, fault: parsed.checksumOk ? null : 'checksum' };
}

export function pieceFaultMessage(verdict: PieceVerdict): string {
  switch (verdict.fault) {
    case 'missing':
      return `ORA-19505: failed to identify file "${verdict.path}"\n`
        + 'ORA-27037: unable to obtain file status';
    case 'unreadable':
    case 'checksum':
      return `ORA-19870: error reading backup piece ${verdict.path}\n`
        + `ORA-19501: read error on file "${verdict.path}"`;
    default:
      return '';
  }
}

export function datafileFault(
  vfs: VfsAdapter,
  datafile: { path: string; tablespace: string },
  checkLogical: boolean,
): BlockCorruptionType | null {
  const read = vfs.readFile(datafile.path);
  const text = read.ok ? new TextDecoder().decode(read.value) : '';
  if (!bannerIsIntact(text, DATAFILE_BANNER)) return 'CORRUPT';
  if (!checkLogical || !text.includes(SEGMENT_MARKER)) return null;
  const payload = parseDatafileImage(text);
  if (payload === null) return 'LOGICAL';
  return payload.tablespace.toUpperCase() === datafile.tablespace.toUpperCase()
    ? null
    : 'LOGICAL';
}
