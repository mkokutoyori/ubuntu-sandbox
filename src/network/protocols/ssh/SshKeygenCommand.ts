import {
  KEYGEN_ALGORITHMS,
  keygenPair,
  keygenFingerprint,
  keygenPublicOf,
  keygenRandomart,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { SshKnownHostEntry } from '@/network/devices/linux/network/SshKnownHostEntry';

export interface SshKeygenStore {
  read(path: string): string | null;
  write(path: string, content: string, secret: boolean): boolean;
  ensureDir(path: string): void;
}

export interface SshKeygenHost {
  readonly store: SshKeygenStore;
  readonly separator: string;
  readonly sshDir: string;
  readonly hostKeyDir: string;
  readonly user: string;
  readonly hostname: string;
}

export interface SshKeygenOutcome {
  readonly output: string;
  readonly exitCode: number;
}

const DEFAULT_FILE_NAMES: Readonly<Record<string, string>> = {
  ed25519: 'id_ed25519',
  rsa: 'id_rsa',
  ecdsa: 'id_ecdsa',
};

function join(host: SshKeygenHost, ...parts: string[]): string {
  return parts.join(host.separator);
}

function directoryOf(host: SshKeygenHost, path: string): string {
  const cut = path.lastIndexOf(host.separator);
  return cut <= 0 ? '' : path.slice(0, cut);
}

export function defaultKeygenFile(
  host: Pick<SshKeygenHost, 'separator' | 'sshDir'>,
  type: string,
): string {
  return [host.sshDir, DEFAULT_FILE_NAMES[type] ?? DEFAULT_FILE_NAMES.ed25519].join(host.separator);
}

export function knownHostsPathOf(host: SshKeygenHost): string {
  return join(host, host.sshDir, 'known_hosts');
}

export function runSshKeygenCommand(
  args: readonly string[],
  host: SshKeygenHost,
): SshKeygenOutcome {
  const knownHosts = knownHostsPathOf(host);

  if (args[0] === '-R' && args[1]) {
    const before = SshKnownHostEntry.parseFile(host.store.read(knownHosts) ?? '');
    const after = before.filter(e => !e.matches(args[1]));
    if (!host.store.write(knownHosts, SshKnownHostEntry.serializeFile(after), false)) {
      return { output: `Unable to write ${knownHosts}`, exitCode: 1 };
    }
    return {
      output: [
        `# Host ${args[1]} found: line 1`,
        `${knownHosts} updated.`,
        `Original contents retained as ${knownHosts}.old`,
      ].join('\n'),
      exitCode: 0,
    };
  }

  const fIdx = args.indexOf('-f');
  const tIdx = args.indexOf('-t');
  const cIdx = args.indexOf('-C');
  const bIdx = args.indexOf('-b');
  const eIdx = args.indexOf('-E');
  const requested = tIdx >= 0 ? (args[tIdx + 1] ?? '').toLowerCase() : 'ed25519';
  const algoPrefix = KEYGEN_ALGORITHMS[requested];
  const file = fIdx >= 0 ? args[fIdx + 1] : defaultKeygenFile(host, requested);

  const upperF = args.indexOf('-F');
  if (upperF >= 0 && args[upperF + 1]) {
    const wanted = args[upperF + 1];
    const entries = SshKnownHostEntry.parseFile(host.store.read(knownHosts) ?? '');
    const lines: string[] = [];
    entries.forEach((entry, index) => {
      if (!entry.matches(wanted)) return;
      lines.push(`# Host ${wanted} found: line ${index + 1}`);
      lines.push(entry.toLine());
    });
    return { output: lines.join('\n'), exitCode: lines.length > 0 ? 0 : 1 };
  }

  if (args.includes('-A')) {
    const dir = (fIdx >= 0 ? args[fIdx + 1] : host.hostKeyDir).replace(/[/\\]$/, '');
    for (const type of ['ed25519', 'rsa', 'ecdsa']) {
      const privatePath = join(host, dir, `ssh_host_${type}_key`);
      if ((host.store.read(privatePath) ?? '') !== '') continue;
      const pair = keygenPair(KEYGEN_ALGORITHMS[type]!, `root@${host.hostname}`);
      host.store.write(privatePath, pair.priv, true);
      host.store.write(`${privatePath}.pub`, `${pair.pub}\n`, false);
    }
    return { output: '', exitCode: 0 };
  }

  if (args.includes('-l')) {
    const target = fIdx >= 0 ? args[fIdx + 1] : file;
    const candidate = target.endsWith('.pub') ? target : `${target}.pub`;
    const data = (host.store.read(candidate) ?? host.store.read(target) ?? '').trim();
    if (!data) return { output: `${target}: No such file or directory`, exitCode: 1 };
    const shape = keygenFingerprint(data, eIdx >= 0 ? (args[eIdx + 1] ?? '') : 'sha256');
    if (shape === null) {
      return { output: `unknown fingerprint hash type "${args[eIdx + 1]}"`, exitCode: 1 };
    }
    return { output: shape, exitCode: 0 };
  }

  if (args.includes('-y')) {
    const source = fIdx >= 0 ? args[fIdx + 1] : file;
    const material = host.store.read(source);
    if (material === null) return { output: `${source}: No such file or directory`, exitCode: 1 };
    const derived = keygenPublicOf(material);
    if (derived === null) return { output: `Load key "${source}": invalid format`, exitCode: 1 };
    return { output: derived, exitCode: 0 };
  }

  if (algoPrefix === undefined) {
    return { output: `unknown key type ${requested}`, exitCode: 255 };
  }

  const directory = directoryOf(host, file);
  if (directory !== '' && !directory.endsWith(':')) host.store.ensureDir(directory);
  if (host.store.read(file) !== null) {
    return { output: `${file} already exists.\nOverwrite (y/n)? `, exitCode: 1 };
  }
  const comment = cIdx >= 0 ? (args[cIdx + 1] ?? '') : `${host.user}@${host.hostname}`;
  const bits = bIdx >= 0 ? Number.parseInt(args[bIdx + 1] ?? '', 10) : NaN;
  const pair = keygenPair(algoPrefix, comment, Number.isFinite(bits) ? bits : undefined);
  host.store.write(file, pair.priv, true);
  host.store.write(`${file}.pub`, `${pair.pub}\n`, false);
  if (args.includes('-q')) return { output: '', exitCode: 0 };
  const fingerprint = keygenFingerprint(pair.pub, 'sha256') ?? '';
  return {
    output: [
      `Generating public/private ${requested} key pair.`,
      `Your identification has been saved in ${file}`,
      `Your public key has been saved in ${file}.pub`,
      'The key fingerprint is:',
      fingerprint.split(' ').slice(1).join(' '),
      "The key's randomart image is:",
      keygenRandomart(pair.pub),
    ].join('\n'),
    exitCode: 0,
  };
}

export interface KeygenVfs {
  readFile(path: string): string | null;
  writeFile(path: string, content: string, uid: number, gid: number, umask: number): boolean;
  resolveInode(path: string): unknown;
  mkdirp(path: string, permissions: number, uid: number, gid: number): unknown;
}

export interface KeygenIdentity {
  readonly uid: number;
  readonly gid: number;
  readonly user: string;
  readonly hostname: string;
  readonly sshDir: string;
  readonly hostKeyDir?: string;
}

export function vfsKeygenHost(vfs: KeygenVfs, identity: KeygenIdentity): SshKeygenHost {
  return {
    store: {
      read: (path: string) => vfs.readFile(path),
      write: (path: string, content: string, secret: boolean) =>
        vfs.writeFile(path, content, identity.uid, identity.gid, secret ? 0o077 : 0o022) !== false,
      ensureDir: (path: string) => {
        if (!vfs.resolveInode(path)) vfs.mkdirp(path, 0o700, identity.uid, identity.gid);
      },
    },
    separator: '/',
    sshDir: identity.sshDir,
    hostKeyDir: identity.hostKeyDir ?? '/etc/ssh',
    user: identity.user,
    hostname: identity.hostname,
  };
}
