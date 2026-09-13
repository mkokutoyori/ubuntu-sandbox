const PAYLOAD_MARKER = 'ORACLE-BACKUP-PIECE-IMAGE';

export interface BackupPieceImage {
  readonly datafiles: Readonly<Record<string, string>>;
}

export function renderBackupPieceImage(banner: string, image: BackupPieceImage | null): string {
  if (!image || Object.keys(image.datafiles).length === 0) return banner;
  return `${banner}\n${PAYLOAD_MARKER} ${JSON.stringify(image)}\n`;
}

export function parseBackupPieceImage(text: string | null): BackupPieceImage | null {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.startsWith(`${PAYLOAD_MARKER} `));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(PAYLOAD_MARKER.length + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<BackupPieceImage>;
    if (!candidate.datafiles || typeof candidate.datafiles !== 'object') return null;
    return { datafiles: candidate.datafiles };
  } catch {
    return null;
  }
}
