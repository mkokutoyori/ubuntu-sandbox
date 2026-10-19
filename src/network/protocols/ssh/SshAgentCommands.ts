import { agentKeyOf, type SshAgentKeyReader } from './SshAgent';
import { callAgent, type AgentCall, type AgentPort } from './agent/AgentService';
import type { AgentIdentityEntry } from './agent/AgentWire';
import type { SshKeygenOutcome } from './SshKeygenCommand';
import type { OpenSshRelease } from './OpenSshRelease';
import { OPENSSH_DEFAULT_IDENTITY_FILES } from './SshConnectOptions';
import { unprotectedPrivateKeyWarning } from './PrivateKeyPermissions';
import {
  isFingerprintHash, keygenBlobDigest, keygenKeyFacts, keygenLoadPrivate, keygenSerializePrivate, sshPublicKeyFromBlob,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { bsdGetoptDiagnostic, shortOptions } from '@/network/devices/linux/commands/Getopt';
import { base64ToBytes, bytesToBase64 } from '@/crypto/encoding';

export interface SshAgentHost {
  readonly agent: AgentPort | undefined;
  readonly agentUnavailable: string;
  readonly reader: SshAgentKeyReader;
  readonly homeDir: string;
  readonly release: OpenSshRelease;
  privateKeyMode(path: string): number | null;
  typedLine(): string | null;
}

export interface SshAgentLauncher {
  readonly release: OpenSshRelease;
  environment(name: string): string | undefined;
  start(request: { readonly lifetime: number | null; readonly socket: string | null }): { readonly pid: number; readonly socket: string } | null;
  kill(pid: number): boolean;
  runWith(command: string[], agent: { readonly pid: number; readonly socket: string }): Promise<SshKeygenOutcome>;
}

const AGENT_USAGE = [
  'usage: ssh-agent [-c | -s] [-Dd] [-a bind_address] [-E fingerprint_hash]',
  '                 [-P allowed_providers] [-t life]',
  '       ssh-agent [-a bind_address] [-E fingerprint_hash] [-P allowed_providers]',
  '                 [-t life] command [arg ...]',
  '       ssh-agent [-c | -s] -k',
].join('\n');

const AGENT_OPTSTRING = '+cDdksE:a:P:t:';

function lifetimeSeconds(text: string): number | null {
  const match = /^(\d+)([smhdw]?)$/i.exec(text);
  if (match === null) return null;
  const unit = { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2].toLowerCase() as '' | 's' | 'm' | 'h' | 'd' | 'w'];
  return Number(match[1]) * unit;
}

export async function runSshAgentCommand(
  args: readonly string[],
  host: SshAgentLauncher,
): Promise<SshKeygenOutcome> {
  let csh: boolean | null = null;
  let kill = false;
  let lifetime: number | null = null;
  let socket: string | null = null;
  const operands: string[] = [];
  for (const option of shortOptions(args, AGENT_OPTSTRING)) {
    if (option.kind === 'operand') {
      operands.push(option.value);
      continue;
    }
    if (option.kind === 'invalid' || option.kind === 'missing-argument') {
      return { output: `${bsdGetoptDiagnostic(option)}\n${AGENT_USAGE}`, exitCode: 1 };
    }
    if (option.kind !== 'option') continue;
    switch (option.letter) {
      case 'c': csh = true; break;
      case 's': csh = false; break;
      case 'k': kill = true; break;
      case 'a': socket = option.argument ?? null; break;
      case 'E':
        if (!isFingerprintHash(option.argument ?? '')) {
          return { output: `Invalid hash algorithm "${option.argument ?? ''}"`, exitCode: 1 };
        }
        break;
      case 't':
        lifetime = lifetimeSeconds(option.argument ?? '');
        if (lifetime === null) return { output: `Invalid lifetime\n${AGENT_USAGE}`, exitCode: 1 };
        break;
    }
  }
  const cshSyntax = csh ?? /csh$/.test(host.environment('SHELL') ?? '');
  if (kill) {
    const pid = host.environment('SSH_AGENT_PID');
    if (pid === undefined || pid === '') return { output: 'SSH_AGENT_PID not set, cannot kill agent', exitCode: 1 };
    if (!/^\d+$/.test(pid)) return { output: `SSH_AGENT_PID="${pid}", which is not a good PID: Invalid argument`, exitCode: 1 };
    if (!host.kill(Number(pid))) return { output: 'kill: No such process', exitCode: 1 };
    return {
      output: [
        cshSyntax ? 'unsetenv SSH_AUTH_SOCK;' : 'unset SSH_AUTH_SOCK;',
        cshSyntax ? 'unsetenv SSH_AGENT_PID;' : 'unset SSH_AGENT_PID;',
        `echo Agent pid ${pid} killed;`,
      ].join('\n'),
      exitCode: 0,
    };
  }
  const started = host.start({ lifetime, socket });
  if (started === null) return { output: `bind: ${socket ?? ''}: Address already in use`, exitCode: 1 };
  if (operands.length > 0) {
    const result = await host.runWith(operands, started);
    host.kill(started.pid);
    return result;
  }
  const lines = cshSyntax
    ? [`setenv SSH_AUTH_SOCK ${started.socket};`, `setenv SSH_AGENT_PID ${started.pid};`, `echo Agent pid ${started.pid};`]
    : [`SSH_AUTH_SOCK=${started.socket}; export SSH_AUTH_SOCK;`, `SSH_AGENT_PID=${started.pid}; export SSH_AGENT_PID;`, `echo Agent pid ${started.pid};`];
  return { output: lines.join('\n'), exitCode: 0 };
}

const UNSIMULATED_ADD_OPTIONS: Readonly<Record<string, string>> = {
  c: 'key use confirmations',
  e: 'PKCS#11 tokens',
  s: 'PKCS#11 tokens',
  K: 'FIDO authenticators',
  S: 'FIDO authenticators',
  h: 'destination constraints',
  H: 'destination constraints',
  M: 'XMSS keys',
  m: 'XMSS keys',
  T: 'agent signature tests',
};

interface PublicKeyOnDisk {
  readonly blob: string;
  readonly label: string;
  readonly comment: string;
}

function publicKeyText(text: string | null): PublicKeyOnDisk | null {
  const line = (text ?? '').split('\n').map(l => l.trim()).find(l => l !== '' && !l.startsWith('#'));
  if (line === undefined) return null;
  const [, blob = ''] = line.split(/\s+/);
  try {
    if (sshPublicKeyFromBlob(base64ToBytes(blob)) === null) return null;
  } catch {
    return null;
  }
  const facts = keygenKeyFacts(line);
  return { blob, label: facts.label, comment: facts.comment };
}

function loadPublic(path: string, host: SshAgentHost): PublicKeyOnDisk | null {
  const material = host.reader.readFile(path);
  const direct = publicKeyText(material) ?? publicKeyText(host.reader.readFile(`${path}.pub`));
  if (direct !== null) return direct;
  const fromPrivate = material === null ? null : agentKeyOf(path, material);
  return fromPrivate === null ? null : { blob: fromPrivate.blob, label: fromPrivate.algorithm, comment: '(null)' };
}

const PASSPHRASE_TRIES = 3;

function* addFile(
  path: string, host: SshAgentHost, quiet: boolean, lifetime: number | undefined, lines: string[],
): AgentProgram<boolean> {
  const material = host.reader.readFile(path);
  if (material === null) {
    lines.push(`${path}: No such file or directory`);
    return false;
  }
  const mode = host.privateKeyMode(path);
  const warning = mode === null ? null : unprotectedPrivateKeyWarning(path, mode);
  if (warning !== null) {
    lines.push(...warning);
    return false;
  }
  let loaded = keygenLoadPrivate(material, '');
  for (let attempt = 0; loaded.kind === 'encrypted' || loaded.kind === 'wrong-passphrase'; attempt++) {
    if (attempt === PASSPHRASE_TRIES) return false;
    lines.push(attempt === 0 ? `Enter passphrase for ${path}: ` : `Bad passphrase, try again for ${path}: `);
    const typed = host.typedLine();
    if (typed === null || typed === '') return false;
    loaded = keygenLoadPrivate(material, typed);
  }
  if (loaded.kind !== 'key') {
    lines.push(loaded.kind === 'unsupported-cipher'
      ? `Error loading key "${path}": unknown or unsupported key cipher`
      : `Error loading key "${path}": invalid format`);
    return false;
  }
  const key = agentKeyOf(path, keygenSerializePrivate(loaded.key, undefined));
  if (key === null) {
    lines.push(`Error loading key "${path}": invalid format`);
    return false;
  }
  if (!(yield { op: 'add', key, ...(lifetime === undefined ? {} : { lifetime }) })) {
    lines.push(`Could not add identity "${path}": agent refused operation`);
    return false;
  }
  if (!quiet) lines.push(`Identity added: ${path} (${key.comment})`);
  if (lifetime !== undefined && !quiet) lines.push(`Lifetime set to ${lifetime} seconds`);
  return true;
}

function* deleteFile(path: string, host: SshAgentHost, quiet: boolean, lines: string[]): AgentProgram<boolean> {
  const key = loadPublic(path, host);
  if (key === null) {
    lines.push(`Bad key file ${path}: No such file or directory`);
    return false;
  }
  if (!(yield { op: 'remove', blob: base64ToBytes(key.blob) })) {
    lines.push(`Could not remove identity "${path}": agent refused operation`);
    return false;
  }
  if (!quiet) lines.push(`Identity removed: ${path} ${key.label} (${key.comment})`);
  return true;
}

function* lockAgent(action: 'lock' | 'unlock', host: SshAgentHost): AgentProgram<SshKeygenOutcome> {
  const lines = ['Enter lock password: '];
  const password = host.typedLine();
  if (password === null) return { output: lines.join('\n'), exitCode: 1 };
  if (action === 'lock') {
    lines.push('Again: ');
    if (host.typedLine() !== password) {
      lines.push('Passwords do not match.');
      return { output: lines.join('\n'), exitCode: 1 };
    }
  }
  const done = yield { op: action, password };
  lines.push(done ? (action === 'lock' ? 'Agent locked.' : 'Agent unlocked.') : (action === 'lock' ? 'Failed to lock agent.' : 'Failed to unlock agent.'));
  return { output: lines.join('\n'), exitCode: done ? 0 : 1 };
}

function* listIdentities(listing: string, hash: string): AgentProgram<SshKeygenOutcome> {
  const entries = (yield { op: 'identities' }) as readonly AgentIdentityEntry[];
  if (entries.length === 0) return { output: 'The agent has no identities.', exitCode: 1 };
  const lines = entries.map((entry) => {
    const blob = bytesToBase64(entry.blob);
    const algorithm = sshPublicKeyFromBlob(entry.blob)?.algorithm ?? '';
    const facts = keygenKeyFacts(`${algorithm} ${blob}`);
    return listing === 'l'
      ? `${facts.bits} ${keygenBlobDigest(blob, hash)} ${entry.comment} (${facts.label})`
      : `${algorithm} ${blob} ${entry.comment}`;
  });
  return { output: lines.join('\n'), exitCode: 0 };
}

function* sshAddProgram(
  args: readonly string[],
  host: SshAgentHost,
): AgentProgram<SshKeygenOutcome> {
  if (host.agent === undefined) return { output: host.agentUnavailable, exitCode: 2 };
  let deleting = false;
  let deleteAll = false;
  let lock: 'lock' | 'unlock' | null = null;
  let lifetime: number | undefined;
  let quiet = false;
  let listing: string | null = null;
  let hash = 'sha256';
  const files: string[] = [];
  for (const option of shortOptions(args, host.release.addOptstring)) {
    if (option.kind === 'operand') {
      files.push(option.value);
      continue;
    }
    if (option.kind === 'invalid' || option.kind === 'missing-argument') {
      return { output: `${bsdGetoptDiagnostic(option)}\n${host.release.addUsage}`, exitCode: 1 };
    }
    if (option.kind !== 'option') continue;
    const unsimulated = UNSIMULATED_ADD_OPTIONS[option.letter];
    if (unsimulated !== undefined) {
      return { output: `ssh-add: -${option.letter}: ${unsimulated} are not simulated`, exitCode: 1 };
    }
    switch (option.letter) {
      case 'l':
      case 'L':
        if (listing !== null) return { output: `-${listing} flag already specified`, exitCode: 255 };
        listing = option.letter;
        break;
      case 'E':
        if (!isFingerprintHash(option.argument ?? '')) {
          return { output: `Invalid hash algorithm "${option.argument ?? ''}"`, exitCode: 255 };
        }
        hash = option.argument ?? 'sha256';
        break;
      case 't': {
        const seconds = lifetimeSeconds(option.argument ?? '');
        if (seconds === null || seconds === 0) return { output: `Invalid lifetime\n${host.release.addUsage}`, exitCode: 1 };
        lifetime = seconds;
        break;
      }
      case 'x': lock = 'lock'; break;
      case 'X': lock = 'unlock'; break;
      case 'd': deleting = true; break;
      case 'D': deleteAll = true; break;
      case 'q': quiet = true; break;
    }
  }
  if (listing !== null && deleteAll) return { output: 'Invalid combination of actions', exitCode: 255 };
  if (lock !== null) return yield* lockAgent(lock, host);
  if (listing !== null) return yield* listIdentities(listing, hash);
  if (deleteAll) {
    if (!(yield { op: 'removeAll' })) return { output: 'Failed to remove all identities.', exitCode: 1 };
    return { output: quiet ? '' : 'All identities removed.', exitCode: 0 };
  }
  const defaults = files.length === 0;
  const targets = defaults
    ? OPENSSH_DEFAULT_IDENTITY_FILES
      .map(file => `${host.homeDir}/.ssh/${file}`)
      .filter(path => host.reader.readFile(path) !== null)
    : files;
  const lines: string[] = [];
  let failed = defaults && targets.length === 0;
  for (const path of targets) {
    const done = deleting ? yield* deleteFile(path, host, quiet, lines) : yield* addFile(path, host, quiet, lifetime, lines);
    if (!done) failed = true;
  }
  return { output: lines.join('\n'), exitCode: failed ? 1 : 0 };
}

type AgentProgram<T> = Generator<AgentCall, T, unknown>;

export async function runSshAddCommand(
  args: readonly string[],
  host: SshAgentHost,
): Promise<SshKeygenOutcome> {
  const program = sshAddProgram(args, host);
  let step = program.next();
  while (!step.done) step = program.next(await callAgent(host.agent as AgentPort, step.value as AgentCall));
  return step.value as SshKeygenOutcome;
}
