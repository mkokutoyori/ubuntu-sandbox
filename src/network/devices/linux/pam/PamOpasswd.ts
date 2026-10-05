import { SIMULATED_HASH_PREFIX } from '../iam/fs/AccountDatabaseParser';
import type { PamWritableFiles } from './PamLinuxHost';

export const OPASSWD_PATH = '/etc/security/opasswd';

interface OpasswdRecord {
  readonly name: string;
  readonly uid: string;
  readonly hashes: string[];
}

function parse(content: string | null): OpasswdRecord[] {
  if (content === null) return [];
  const records: OpasswdRecord[] = [];
  for (const line of content.split('\n')) {
    const fields = line.split(':');
    if (fields.length < 4 || fields[0] === '') continue;
    records.push({
      name: fields[0],
      uid: fields[1],
      hashes: fields[3] === '' ? [] : fields[3].split(','),
    });
  }
  return records;
}

function render(records: readonly OpasswdRecord[]): string {
  return records.map((record) => `${record.name}:${record.uid}:${record.hashes.length}:${record.hashes.join(',')}`).join('\n') + (records.length > 0 ? '\n' : '');
}

function hashOf(password: string): string {
  return `${SIMULATED_HASH_PREFIX}${password}`;
}

export class PamOpasswd {
  constructor(
    private readonly readFile: (path: string) => string | null,
    private readonly files: PamWritableFiles,
  ) {}

  used(name: string, password: string, depth: number): boolean {
    const record = parse(this.readFile(OPASSWD_PATH)).find((entry) => entry.name === name);
    if (record === undefined) return false;
    return record.hashes.slice(-depth).includes(hashOf(password));
  }

  remember(name: string, uid: number, oldPassword: string, depth: number): void {
    const records = parse(this.readFile(OPASSWD_PATH));
    let record = records.find((entry) => entry.name === name);
    if (record === undefined) {
      record = { name, uid: String(uid), hashes: [] };
      records.push(record);
    }
    record.hashes.push(hashOf(oldPassword));
    while (record.hashes.length > depth) record.hashes.shift();
    this.files.mkdirp('/etc/security');
    this.files.writeFile(OPASSWD_PATH, render(records));
  }
}
