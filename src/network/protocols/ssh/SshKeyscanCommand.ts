import type { ProbedHostKey } from './SshHostKeyProbe';
import type { SshKeygenOutcome } from './SshKeygenCommand';

export interface SshKeyscanHost {
  resolve(hostOrAddress: string): string | null;
  probe(ip: string, port: number): ProbedHostKey | null;
}

const VALUE_FLAGS: ReadonlySet<string> = new Set(['-f', '-O', '-T']);

const TYPES: Readonly<Record<string, string>> = {
  ed25519: 'ssh-ed25519',
  rsa: 'ssh-rsa',
  ecdsa: 'ecdsa-sha2-nistp256',
};

const USAGE =
  'usage: ssh-keyscan [-46cDHqv] [-f file] [-O option] [-p port] [-T timeout]\n' +
  '                   [-t type] [host | addrlist namelist]';

export function runSshKeyscanCommand(
  args: readonly string[],
  host: SshKeyscanHost,
): SshKeygenOutcome {
  let port = 22;
  let wanted: readonly string[] | null = null;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p' && i + 1 < args.length) {
      port = Number.parseInt(args[++i], 10) || 22;
    } else if (args[i] === '-t' && i + 1 < args.length) {
      wanted = args[++i].split(',').map(k => TYPES[k.trim().toLowerCase()] ?? k.trim());
    } else if (VALUE_FLAGS.has(args[i]) && i + 1 < args.length) {
      i++;
    } else if (!args[i].startsWith('-')) {
      positional.push(args[i]);
    }
  }
  const target = positional[0];
  if (!target) return { output: USAGE, exitCode: 1 };
  const ip = host.resolve(target);
  if (ip === null) return { output: `# ${target} unknown host`, exitCode: 1 };
  const hostKey = host.probe(ip, port);
  if (!hostKey) return { output: `# ${target} no host key`, exitCode: 1 };
  if (wanted !== null && !wanted.includes(hostKey.algorithm)) {
    return { output: '', exitCode: 0 };
  }
  return { output: `${target} ${hostKey.algorithm} ${hostKey.publicKey}`, exitCode: 0 };
}
