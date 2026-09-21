import { sha256Hex } from '@/crypto/hash/sha256';

const PAYLOAD_MARKER = 'ORACLE-BACKUP-PIECE-IMAGE';

export interface BackupPieceImage {
  readonly datafiles: Readonly<Record<string, string>>;
  readonly archivedLogs?: Readonly<Record<string, string>>;
  readonly scn?: number;
  readonly checksum?: string;
}

export interface ParsedBackupPiece {
  readonly image: BackupPieceImage;
  readonly checksumOk: boolean;
}

function payloadChecksum(image: BackupPieceImage): string {
  const { datafiles, archivedLogs, scn } = image;
  return sha256Hex(JSON.stringify({ datafiles, archivedLogs, scn })).slice(0, 16);
}

export function renderBackupPieceImage(banner: string, image: BackupPieceImage | null): string {
  if (!image) return banner;
  const empty = Object.keys(image.datafiles).length === 0
    && Object.keys(image.archivedLogs ?? {}).length === 0;
  if (empty) return banner;
  const stamped = { ...image, checksum: payloadChecksum(image) };
  return `${banner}\n${PAYLOAD_MARKER} ${JSON.stringify(stamped)}\n`;
}

export function readBackupPieceImage(text: string | null): ParsedBackupPiece | null {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.startsWith(`${PAYLOAD_MARKER} `));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(PAYLOAD_MARKER.length + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<BackupPieceImage>;
    if (!candidate.datafiles || typeof candidate.datafiles !== 'object') return null;
    const logs = candidate.archivedLogs && typeof candidate.archivedLogs === 'object'
      ? { archivedLogs: candidate.archivedLogs }
      : {};
    const image: BackupPieceImage = typeof candidate.scn === 'number'
      ? { datafiles: candidate.datafiles, ...logs, scn: candidate.scn }
      : { datafiles: candidate.datafiles, ...logs };
    return {
      image,
      checksumOk: typeof candidate.checksum !== 'string'
        || candidate.checksum === payloadChecksum(image),
    };
  } catch {
    return null;
  }
}

export function parseBackupPieceImage(text: string | null): BackupPieceImage | null {
  const read = readBackupPieceImage(text);
  return read && read.checksumOk ? read.image : null;
}
