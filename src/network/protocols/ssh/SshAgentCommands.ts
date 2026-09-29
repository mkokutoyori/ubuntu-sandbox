import { agentKeyOf, type SshAgent, type SshAgentKeyReader } from './SshAgent';
import type { SshKeygenOutcome } from './SshKeygenCommand';
import type { OpenSshRelease } from './OpenSshRelease';
import { OPENSSH_DEFAULT_IDENTITY_FILES } from './SshConnectOptions';
import { unprotectedPrivateKeyWarning } from './PrivateKeyPermissions';
import {
  isFingerprintHash, keygenBlobDigest, keygenKeyFacts, sshPublicKeyFromBlob,
} from '@/network/devices/linux/network/SshKeygenMaterial';
import { bsdGetoptDiagnostic, shortOptions } from '@/network/devices/linux/commands/Getopt';
import { base64ToBytes } from '@/crypto/encoding';

export interface SshAgentHost {
  readonly agent: SshAgent;
  readonly reader: SshAgentKeyReader;
  readonly homeDir: string;
  readonly authSocket: string;
  readonly release: OpenSshRelease;
  agentUnreachable(): string | null;
  privateKeyMode(path: string): number | null;
  setEnvironment(name: string, value: string): void;
}

const AGENT_PID = 1;

export function runSshAgentCommand(
  args: readonly string[],
  host: SshAgentHost,
): SshKeygenOutcome {
  if (args.includes('-k')) {
    host.agent.removeAll();
    return { output: `echo Agent pid ${AGENT_PID} killed;`, exitCode: 0 };
  }
  const lines = args.includes('-c')
    ? [
        `setenv SSH_AUTH_SOCK ${host.authSocket};`,
        `setenv SSH_AGENT_PID ${AGENT_PID};`,
        `echo Agent pid ${AGENT_PID};`,
      ]
    : [
        `SSH_AUTH_SOCK=${host.authSocket}; export SSH_AUTH_SOCK;`,
        `SSH_AGENT_PID=${AGENT_PID}; export SSH_AGENT_PID;`,
        `echo Agent pid ${AGENT_PID};`,
      ];
  host.setEnvironment('SSH_AUTH_SOCK', host.authSocket);
  host.setEnvironment('SSH_AGENT_PID', String(AGENT_PID));
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
  t: 'key lifetimes',
  T: 'agent signature tests',
  x: 'agent locks',
  X: 'agent locks',
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

function addFile(path: string, host: SshAgentHost, quiet: boolean, lines: string[]): boolean {
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
  const key = agentKeyOf(path, material);
  if (key === null) {
    lines.push(`Error loading key "${path}": invalid format`);
    return false;
  }
  host.agent.install(key);
  if (!quiet) lines.push(`Identity added: ${path} (${key.comment})`);
  return true;
}

function deleteFile(path: string, host: SshAgentHost, quiet: boolean, lines: string[]): boolean {
  const key = loadPublic(path, host);
  if (key === null) {
    lines.push(`Bad key file ${path}: No such file or directory`);
    return false;
  }
  if (!host.agent.removeKey(key.blob)) {
    lines.push(`Could not remove identity "${path}": agent refused operation`);
    return false;
  }
  if (!quiet) lines.push(`Identity removed: ${path} ${key.label} (${key.comment})`);
  return true;
}

function listIdentities(host: SshAgentHost, listing: string, hash: string): SshKeygenOutcome {
  const keys = host.agent.list();
  if (keys.length === 0) return { output: 'The agent has no identities.', exitCode: 1 };
  const lines = keys.map(k => (listing === 'l'
    ? `${k.bits} ${keygenBlobDigest(k.blob, hash)} ${k.comment} (${k.algorithm})`
    : `${k.publicKey} ${k.comment}`));
  return { output: lines.join('\n'), exitCode: 0 };
}

export function runSshAddCommand(
  args: readonly string[],
  host: SshAgentHost,
): SshKeygenOutcome {
  const unreachable = host.agentUnreachable();
  if (unreachable !== null) return { output: unreachable, exitCode: 2 };
  let deleting = false;
  let deleteAll = false;
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
      case 'd': deleting = true; break;
      case 'D': deleteAll = true; break;
      case 'q': quiet = true; break;
    }
  }
  if (listing !== null && deleteAll) return { output: 'Invalid combination of actions', exitCode: 255 };
  if (listing !== null) return listIdentities(host, listing, hash);
  if (deleteAll) {
    host.agent.removeAll();
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
    const done = deleting ? deleteFile(path, host, quiet, lines) : addFile(path, host, quiet, lines);
    if (!done) failed = true;
  }
  return { output: lines.join('\n'), exitCode: failed ? 1 : 0 };
}
