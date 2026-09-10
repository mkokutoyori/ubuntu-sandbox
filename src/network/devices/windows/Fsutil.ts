export interface FsutilHost {
  readonly volumes: {
    letters(): string[];
    capacityBytes(letter: string): number;
    freeBytes(letter: string): number;
  };
}

const LABEL_WIDTH = 29;
const NOT_FOUND = 'Error:  The system cannot find the path specified.';

function gigabytes(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(2)}GB`;
}

function total(label: string, bytes: number): string {
  return `${label.padEnd(LABEL_WIDTH)}: ${bytes} (${gigabytes(bytes)})`;
}

function letterOf(volumePath: string): string {
  return volumePath.trim().charAt(0).toUpperCase();
}

function isMounted(host: FsutilHost, letter: string): boolean {
  return host.volumes.letters().some((d) => d.charAt(0).toUpperCase() === letter);
}

function diskFree(host: FsutilHost, volumePath: string): string {
  const letter = letterOf(volumePath);
  if (!letter || !isMounted(host, letter)) return NOT_FOUND;
  const free = host.volumes.freeBytes(letter);
  return [
    total('Total # of free bytes', free),
    total('Total # of bytes', host.volumes.capacityBytes(letter)),
    total('Total # of avail free bytes', free),
  ].join('\n');
}

function volumeList(host: FsutilHost): string {
  return host.volumes.letters().map((d) => `${d.charAt(0).toUpperCase()}:\\`).join('\n');
}

const USAGE = [
  '---- VOLUME COMMANDS SUPPORTED ----',
  '',
  'diskfree                Query the free space of a volume',
  'dismount                Dismount a volume',
  'list                    List all the mounted volumes',
].join('\n');

export function cmdFsutil(host: FsutilHost, args: string[]): string {
  const sub = (args[0] ?? '').toLowerCase();
  if (sub !== 'volume') {
    return `Error:  The parameter "${args[0] ?? ''}" is not currently supported.`;
  }
  const action = (args[1] ?? '').toLowerCase();
  if (action === 'diskfree') {
    if (!args[2]) return USAGE;
    return diskFree(host, args[2]);
  }
  if (action === 'list') return volumeList(host);
  return USAGE;
}
