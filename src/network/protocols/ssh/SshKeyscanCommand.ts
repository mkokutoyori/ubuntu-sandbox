import type { HostKeyProbeResult, ProbedHostKey } from './SshHostKeyProbe';
import { hashKnownHostsToken } from './SshPureUtils';
import { sshfpRecords } from './SshfpRecord';
import { getoptDiagnostic, shortOptions } from '@/network/devices/linux/commands/Getopt';
import { isIpLiteral } from '@/network/dns/compat/DnsWireCompat';

export interface SshKeyscanHost {
  resolve(hostOrAddress: string): string | null;
  probe(ip: string, port: number, hostKeyAlgorithms: readonly string[]): HostKeyProbeResult | null;
  readFile?(path: string): string | null;
  readonly stdin?: string;
}

export interface SshKeyscanLine {
  readonly stream: 'stdout' | 'stderr';
  readonly text: string;
}

export interface SshKeyscanOutcome {
  readonly lines: readonly SshKeyscanLine[];
  readonly output: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const OPTSTRING = 'cDHv46p:T:t:f:';
const DEFAULT_PORT = 22;

const USAGE = [
  'usage: ssh-keyscan [-46cDHv] [-f file] [-p port] [-T timeout] [-t type]',
  '\t\t   [host | addrlist namelist]',
];

interface KeyType {
  readonly shortname: string;
  readonly names: readonly string[];
  readonly proposal: readonly string[];
}

const KEY_TYPES: readonly KeyType[] = [
  { shortname: 'DSA', names: ['ssh-dss'], proposal: ['ssh-dss'] },
  {
    shortname: 'RSA',
    names: ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512'],
    proposal: ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
  },
  {
    shortname: 'ECDSA',
    names: ['ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'],
    proposal: ['ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'],
  },
  { shortname: 'ED25519', names: ['ssh-ed25519'], proposal: ['ssh-ed25519'] },
  { shortname: 'XMSS', names: ['ssh-xmss@openssh.com'], proposal: ['ssh-xmss@openssh.com'] },
  {
    shortname: 'ECDSA-SK',
    names: ['sk-ecdsa-sha2-nistp256@openssh.com', 'webauthn-sk-ecdsa-sha2-nistp256@openssh.com'],
    proposal: ['sk-ecdsa-sha2-nistp256@openssh.com'],
  },
  { shortname: 'ED25519-SK', names: ['sk-ssh-ed25519@openssh.com'], proposal: ['sk-ssh-ed25519@openssh.com'] },
];

const DEFAULT_KEY_TYPES: ReadonlySet<string> = new Set(['RSA', 'ECDSA', 'ED25519', 'ECDSA-SK', 'ED25519-SK']);

function keyTypeFromName(name: string): KeyType | null {
  return KEY_TYPES.find((t) => t.names.includes(name) || t.shortname.toLowerCase() === name.toLowerCase()) ?? null;
}

function parsePort(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

const TIME_MULTIPLIERS: Readonly<Record<string, number>> = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

function parseTimeout(text: string): number | null {
  let total = 0;
  const pattern = /(\d+)([smhdwSMHDW]?)/y;
  let at = 0;
  while (at < text.length) {
    pattern.lastIndex = at;
    const match = pattern.exec(text);
    if (!match) return null;
    total += Number(match[1]) * TIME_MULTIPLIERS[match[2].toLowerCase()];
    at = pattern.lastIndex;
  }
  return text.length > 0 && total > 0 ? total : null;
}

function hostListFromFile(text: string): string[] {
  const hosts: string[] = [];
  for (const raw of text.split('\n')) {
    const hash = raw.indexOf('#');
    const line = (hash < 0 ? raw : raw.slice(0, hash)).replace(/[ \t\r]+$/, '');
    if (line !== '') hosts.push(line);
  }
  return hosts;
}

function hostPort(host: string, port: number): string {
  return port === DEFAULT_PORT ? host : `[${host}]:${port}`;
}

export function runSshKeyscanCommand(
  args: readonly string[],
  host: SshKeyscanHost,
): SshKeyscanOutcome {
  const lines: SshKeyscanLine[] = [];
  const stderr = (text: string): void => { lines.push({ stream: 'stderr', text }); };
  const stdout = (text: string): void => { lines.push({ stream: 'stdout', text }); };
  const finish = (exitCode: number): SshKeyscanOutcome => ({
    lines,
    output: lines.filter((l) => l.stream === 'stdout').map((l) => l.text).join('\n'),
    stderr: lines.filter((l) => l.stream === 'stderr').map((l) => l.text).join('\n'),
    exitCode,
  });
  const usage = (): SshKeyscanOutcome => {
    for (const line of USAGE) stderr(line);
    return finish(1);
  };

  if (args.length === 0) return usage();
  let port = DEFAULT_PORT;
  let hashHosts = false;
  let getCert = false;
  let printSshfp = false;
  let wanted: ReadonlySet<string> = DEFAULT_KEY_TYPES;
  const files: string[] = [];
  const operands: string[] = [];
  for (const option of shortOptions(args, OPTSTRING)) {
    if (option.kind === 'operand') {
      operands.push(option.value);
      continue;
    }
    if (option.kind !== 'option') {
      stderr(getoptDiagnostic('ssh-keyscan', option));
      return usage();
    }
    const value = option.argument ?? '';
    switch (option.letter) {
      case 'H': hashHosts = true; break;
      case 'c': getCert = true; break;
      case 'D': printSshfp = true; break;
      case 'p': {
        const parsed = parsePort(value);
        if (parsed === null) {
          stderr(`Bad port '${value}'`);
          return finish(1);
        }
        port = parsed;
        break;
      }
      case 'T':
        if (parseTimeout(value) === null) {
          stderr(`Bad timeout '${value}'`);
          return usage();
        }
        break;
      case 'f': files.push(value); break;
      case 't': {
        const types = new Set<string>();
        for (const name of value.split(',').filter((n) => n !== '')) {
          const type = keyTypeFromName(name);
          if (type === null) {
            stderr(`Unknown key type "${name}"`);
            return finish(255);
          }
          types.add(type.shortname);
        }
        wanted = types;
        break;
      }
      default: break;
    }
  }
  if (operands.length === 0 && files.length === 0) return usage();

  const targets: string[] = [];
  for (const file of files) {
    const text = file === '-' ? host.stdin ?? '' : host.readFile?.(file) ?? null;
    if (text === null) {
      stderr(`ssh-keyscan: ${file}: No such file or directory`);
      return finish(255);
    }
    targets.push(...hostListFromFile(text));
  }
  targets.push(...operands);

  let foundOne = false;
  const printKey = (outputName: string, key: ProbedHostKey): void => {
    foundOne = true;
    const names = getCert || (!hashHosts && port === DEFAULT_PORT) ? [outputName] : outputName.split(',');
    for (const name of names) {
      if (printSshfp) {
        for (const record of sshfpRecords(name, key.algorithm, key.publicKey)) stdout(record);
        continue;
      }
      const known = hostPort(name, port).toLowerCase();
      stdout(`${hashHosts ? hashKnownHostsToken(known) : known} ${key.algorithm} ${key.publicKey}`);
    }
  };

  for (const target of targets) {
    const [nameList, ...rest] = target.trim().split(/[ \t]+/);
    const outputName = rest.length > 0 ? rest.join(' ') : nameList;
    for (const type of KEY_TYPES) {
      if (!wanted.has(type.shortname)) continue;
      for (const name of nameList.split(',').filter((n) => n !== '')) {
        const ip = isIpLiteral(name) ? name : host.resolve(name);
        if (ip === null) {
          stderr(`getaddrinfo ${name}: Name or service not known`);
          continue;
        }
        const result = host.probe(ip, port, getCert ? [] : type.proposal);
        if (result === null) continue;
        if (result.serverIdentification !== null) {
          stderr(`${printSshfp ? ';' : '#'} ${name}:${port} ${result.serverIdentification}`);
        }
        if (result.hostKey !== null) printKey(outputName, result.hostKey);
        break;
      }
    }
  }
  return finish(foundOne ? 0 : 1);
}
