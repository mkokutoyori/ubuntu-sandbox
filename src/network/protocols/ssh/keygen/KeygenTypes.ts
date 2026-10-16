import type { OpenSshRelease } from '../OpenSshRelease';

export interface SshKeygenStore {
  read(path: string): string | null;
  write(path: string, content: string, secret: boolean): string | null;
  isDirectory(path: string): boolean;
  makePrivateDirectory(path: string): void;
}

export interface SshKeygenHost {
  readonly store: SshKeygenStore;
  readonly sshDir: string;
  readonly hostKeyDir: string;
  readonly user: string;
  readonly hostname: string;
  readonly release: OpenSshRelease;
  readonly stdin?: string;
  readonly nowSeconds?: () => number;
  readonly zoneOffsetMinutes?: (atMs: number) => number;
}

export interface SshKeygenOutcome {
  readonly output: string;
  readonly exitCode: number;
  readonly stderr?: string;
  readonly interleaved?: string;
}

export interface SshKeygenTerminal {
  print(line: string): void;
  ask(prompt: string, hidden: boolean): Promise<string | null>;
}

export type KeygenStep =
  | { readonly kind: 'print'; readonly line: string; readonly stream?: 'stderr' }
  | { readonly kind: 'ask'; readonly prompt: string; readonly hidden: boolean };

export type KeygenDialogue = Generator<KeygenStep, number, string | null | undefined>;

export type ConversionFormat = 'RFC4716' | 'PKCS8' | 'PEM';

export interface KeygenRequest {
  readonly all: boolean;
  readonly bits?: number;
  readonly bubblebabble: boolean;
  readonly changeComment: boolean;
  readonly changePassphrase: boolean;
  readonly comment?: string;
  readonly convertFrom: boolean;
  readonly convertTo: boolean;
  readonly file?: string;
  readonly findHost?: string;
  readonly deleteHost?: string;
  readonly format?: ConversionFormat;
  readonly genericRecord: boolean;
  readonly hashHosts: boolean;
  readonly fingerprint: boolean;
  readonly hash: string;
  readonly keyCipher?: string;
  readonly identity?: string;
  readonly namespace?: string;
  readonly operands: readonly string[];
  readonly signatureFile?: string;
  readonly signOperation?: string;
  readonly signerOptions: readonly string[];
  readonly newPassphrase?: string;
  readonly oldPassphrase?: string;
  readonly printPublic: boolean;
  readonly quiet: boolean;
  readonly recordHost?: string;
  readonly rounds?: number;
  readonly type?: string;
  readonly verbose: boolean;
}

export function print(line: string): KeygenStep {
  return { kind: 'print', line };
}

export function printError(line: string): KeygenStep {
  return { kind: 'print', line, stream: 'stderr' };
}

export function directoryOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut <= 0 ? '' : path.slice(0, cut);
}
