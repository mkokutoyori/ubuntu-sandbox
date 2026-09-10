export type OmfBackupKind =
  | 'datafile-full'
  | 'datafile-incremental-0'
  | 'datafile-incremental-1'
  | 'archivelog'
  | 'controlfile-spfile'
  | 'autobackup';

const OMF_TYPE_CODE: Readonly<Record<OmfBackupKind, string>> = Object.freeze({
  'datafile-full':          'nnndf',
  'datafile-incremental-0': 'nnnd0',
  'datafile-incremental-1': 'nnnd1',
  'archivelog':             'annnn',
  'controlfile-spfile':     'ncsnf',
  'autobackup':             's',
});

const OMF_CATEGORY: Readonly<Record<OmfBackupKind, string>> = Object.freeze({
  'datafile-full':          'backupset',
  'datafile-incremental-0': 'backupset',
  'datafile-incremental-1': 'backupset',
  'archivelog':             'backupset',
  'controlfile-spfile':     'backupset',
  'autobackup':             'autobackup',
});

const UNIQUE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function omfUniqueString(): string {
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += UNIQUE_ALPHABET[Math.floor(Math.random() * UNIQUE_ALPHABET.length)];
  }
  return out;
}

export function omfDatedDirectory(
  recoveryFileDest: string,
  dbUniqueName: string,
  kind: OmfBackupKind,
  at: Date = new Date(),
): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const day = `${at.getFullYear()}_${pad(at.getMonth() + 1)}_${pad(at.getDate())}`;
  const root = recoveryFileDest.replace(/\/+$/, '');
  return `${root}/${dbUniqueName.toUpperCase()}/${OMF_CATEGORY[kind]}/${day}`;
}

export function omfBackupPiecePath(
  recoveryFileDest: string,
  dbUniqueName: string,
  kind: OmfBackupKind,
  label: string,
  at: Date = new Date(),
  unique: string = omfUniqueString(),
): string {
  const directory = omfDatedDirectory(recoveryFileDest, dbUniqueName, kind, at);
  return `${directory}/o1_mf_${OMF_TYPE_CODE[kind]}_${label}_${unique}_.bkp`;
}
