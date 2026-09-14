const PAYLOAD_MARKER = 'ORACLE-CONTROL-FILE-IMAGE';

export interface ControlFileDatafile {
  readonly fileNo: number;
  readonly path: string;
  readonly sizeBytes: number;
  readonly tablespace: string;
}

export interface ControlFileImage {
  readonly dbName: string;
  readonly dbId: number;
  readonly datafiles: readonly ControlFileDatafile[];
  readonly backupSets: readonly unknown[];
}

export type ControlFileStructure = Omit<ControlFileImage, 'backupSets'>;

export function renderControlFileImage(banner: string, image: ControlFileImage): string {
  return `${banner}\n${PAYLOAD_MARKER} ${JSON.stringify(image)}\n`;
}

export function controlFileBanner(index: number): string {
  return `[ORACLE CONTROL FILE ${index + 1}]`;
}

export function controlFileBody(index: number, image: ControlFileImage): string {
  return renderControlFileImage(controlFileBanner(index), image);
}

export function controlFileStructureOf(
  dbName: string,
  dbId: number,
  datafiles: readonly ControlFileDatafile[],
): ControlFileStructure {
  return { dbName, dbId, datafiles: [...datafiles] };
}

export function mergeControlFileImage(
  existing: ControlFileImage | null,
  structure: ControlFileStructure,
): ControlFileImage {
  return { ...structure, backupSets: existing?.backupSets ?? [] };
}

export function parseControlFileImage(text: string | null): ControlFileImage | null {
  if (!text) return null;
  const line = text.split('\n').find((l) => l.startsWith(`${PAYLOAD_MARKER} `));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(PAYLOAD_MARKER.length + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<ControlFileImage>;
    if (typeof candidate.dbName !== 'string' || typeof candidate.dbId !== 'number') return null;
    return {
      dbName: candidate.dbName,
      dbId: candidate.dbId,
      datafiles: Array.isArray(candidate.datafiles) ? candidate.datafiles : [],
      backupSets: Array.isArray(candidate.backupSets) ? candidate.backupSets : [],
    };
  } catch {
    return null;
  }
}
