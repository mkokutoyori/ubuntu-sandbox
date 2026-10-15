import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';
import { parseKeygenRequest } from './keygen/KeygenRequest';
import { knownHostsDialogue } from './keygen/KnownHostsDialogue';
import {
  changeCommentDialogue,
  changePassphraseDialogue,
  convertFromDialogue,
  convertToDialogue,
  fingerprintDialogue,
  printPublicDialogue,
  recordDialogue,
} from './keygen/KeyFileDialogues';
import { allHostKeysDialogue, generationDialogue } from './keygen/GenerationDialogue';
import {
  print,
  type KeygenDialogue,
  type SshKeygenHost,
  type SshKeygenOutcome,
  type SshKeygenStore,
  type SshKeygenTerminal,
} from './keygen/KeygenTypes';
import type { OpenSshRelease } from './OpenSshRelease';

export { DEFAULT_KEYGEN_TYPE } from './keygen/GenerationDialogue';
export type { SshKeygenHost, SshKeygenOutcome, SshKeygenStore, SshKeygenTerminal };

function* keygenDialogue(args: readonly string[], host: SshKeygenHost): KeygenDialogue {
  const request = parseKeygenRequest(args, host.release);
  if ('exitCode' in request) {
    for (const line of request.output.split('\n')) yield print(line);
    return request.exitCode;
  }
  if (request.deleteHost !== undefined || request.findHost !== undefined || request.hashHosts) return yield* knownHostsDialogue(request, host);
  if (request.all) return yield* allHostKeysDialogue(request, host);
  if (request.fingerprint || request.bubblebabble) return yield* fingerprintDialogue(request, host);
  if (request.changePassphrase) return yield* changePassphraseDialogue(request, host);
  if (request.changeComment) return yield* changeCommentDialogue(request, host);
  if (request.convertTo) return yield* convertToDialogue(request, host);
  if (request.convertFrom) return yield* convertFromDialogue(request, host);
  if (request.printPublic) return yield* printPublicDialogue(request, host);
  if (request.recordHost !== undefined) return yield* recordDialogue(request, host);
  return yield* generationDialogue(request, host);
}

function typedLines(stdin: string | undefined): string[] | null {
  if (stdin === undefined) return null;
  const lines = stdin.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function runSshKeygenCommand(
  args: readonly string[], host: SshKeygenHost, stdin?: string,
): SshKeygenOutcome {
  const typed = typedLines(stdin);
  const dialogue = keygenDialogue(args, host);
  let transcript = '';
  let answer: string | null | undefined;
  for (;;) {
    const step = dialogue.next(answer);
    if (step.done === true) return { output: transcript.replace(/\n$/, ''), exitCode: step.value };
    answer = undefined;
    if (step.value.kind === 'print') {
      transcript += `${step.value.line}\n`;
      continue;
    }
    transcript += step.value.prompt;
    if (typed === null) {
      transcript += '\n';
      answer = '';
      continue;
    }
    answer = typed.length > 0 ? typed.shift()! : null;
  }
}

export async function runSshKeygenInteractive(
  args: readonly string[], host: SshKeygenHost, terminal: SshKeygenTerminal,
): Promise<number> {
  const dialogue = keygenDialogue(args, host);
  let answer: string | null | undefined;
  for (;;) {
    const step = dialogue.next(answer);
    if (step.done === true) return step.value;
    answer = undefined;
    if (step.value.kind === 'print') terminal.print(step.value.line);
    else answer = await terminal.ask(step.value.prompt, step.value.hidden);
  }
}

export type KeygenVfs = Pick<
  VirtualFileSystem, 'readFile' | 'writeFile' | 'resolveInode' | 'mkdirp' | 'normalizePath' | 'checkAccess'
>;

export interface KeygenIdentity {
  readonly uid: number;
  readonly gid: number;
  readonly user: string;
  readonly hostname: string;
  readonly sshDir: string;
  readonly cwd: string;
  readonly hostKeyDir?: string;
  readonly release: OpenSshRelease;
}

function writeFailureReason(vfs: KeygenVfs, target: string, identity: KeygenIdentity): string {
  const components = target.split('/').filter(Boolean).slice(0, -1);
  let path = '';
  for (const component of components) {
    const directory = vfs.resolveInode(path || '/');
    if (directory && !vfs.checkAccess(directory, 'x', identity.uid, identity.gid)) return 'Permission denied';
    path += `/${component}`;
    if (!vfs.resolveInode(path)) return 'No such file or directory';
  }
  return 'Permission denied';
}

export function vfsKeygenHost(vfs: KeygenVfs, identity: KeygenIdentity): SshKeygenHost {
  const absolute = (path: string) => vfs.normalizePath(path, identity.cwd);
  return {
    store: {
      read: (path: string) => vfs.readFile(absolute(path)),
      write: (path: string, content: string, secret: boolean) => {
        const target = absolute(path);
        if (vfs.writeFile(target, content, identity.uid, identity.gid, secret ? 0o077 : 0o022, false, undefined, false)) {
          return null;
        }
        return writeFailureReason(vfs, target, identity);
      },
      isDirectory: (path: string) => vfs.resolveInode(absolute(path))?.type === 'directory',
      makePrivateDirectory: (path: string) => {
        vfs.mkdirp(absolute(path), 0o700, identity.uid, identity.gid);
      },
    },
    sshDir: identity.sshDir,
    hostKeyDir: identity.hostKeyDir ?? '/etc/ssh',
    user: identity.user,
    hostname: identity.hostname,
    release: identity.release,
  };
}
