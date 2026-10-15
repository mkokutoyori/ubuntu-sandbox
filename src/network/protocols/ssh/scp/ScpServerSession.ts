import type { ConnectionChannel } from '../connection/SshConnection';
import type { ISftpFileSystem } from '../sftp/ISftpFileSystem';
import { globPaths, hasMagic, type GlobFileSystem } from '@/network/devices/linux/fs/Glob';
import { ScpPeer } from './ScpPeer';
import { peerFaultReporter, runScpSink, runScpSource, type ScpNamedPath } from './ScpRoles';

export interface ScpServerWord {
  readonly text: string;
  readonly literal: boolean;
}

export interface ScpServerCommand {
  readonly role: 'sink' | 'source';
  readonly recursive: boolean;
  readonly preserveTimes: boolean;
  readonly targetMustBeDirectory: boolean;
  readonly words: readonly ScpServerWord[];
}

const SINK_UMASK = 0o022;

const SERVER_FLAGS = new Set(['-t', '-f', '-r', '-p', '-d', '-v']);

function splitWords(command: string, backslashEscapes: boolean): ScpServerWord[] | null {
  const words: ScpServerWord[] = [];
  let text = '';
  let literal = false;
  let open = false;
  let quote: string | null = null;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (backslashEscapes && quote === '"' && char === '\\' && index + 1 < command.length && '"\\$`'.includes(command[index + 1])) text += command[++index];
      else text += char;
      continue;
    }
    if (char === '"' || (char === "'" && backslashEscapes)) {
      quote = char;
      literal = true;
      open = true;
    } else if (backslashEscapes && char === '\\' && index + 1 < command.length) {
      text += command[++index];
      literal = true;
      open = true;
    } else if (/\s/.test(char)) {
      if (open) words.push({ text, literal });
      text = '';
      literal = false;
      open = false;
    } else {
      text += char;
      open = true;
    }
  }
  if (quote !== null) return null;
  if (open) words.push({ text, literal });
  return words;
}

export function parseScpServerCommand(command: string, windowsQuoting = false): ScpServerCommand | null {
  const words = splitWords(command.trim(), !windowsQuoting);
  if (words === null || words.length === 0 || words[0].text !== 'scp') return null;
  const flags: string[] = [];
  let index = 1;
  for (; index < words.length; index++) {
    if (words[index].text === '--') { index++; break; }
    if (!words[index].text.startsWith('-')) break;
    for (const letter of words[index].text.slice(1)) flags.push(`-${letter}`);
  }
  const operands = words.slice(index);
  if (operands.length === 0 || flags.some((flag) => !SERVER_FLAGS.has(flag))) return null;
  const sink = flags.includes('-t');
  const source = flags.includes('-f');
  if (sink === source) return null;
  return {
    role: sink ? 'sink' : 'source',
    recursive: flags.includes('-r'),
    preserveTimes: flags.includes('-p'),
    targetMustBeDirectory: flags.includes('-d'),
    words: operands,
  };
}

function globFileSystemOf(fs: ISftpFileSystem): GlobFileSystem {
  return {
    listNames: (directory) => {
      const listed = fs.listDirectory(directory);
      return listed.ok ? listed.value.map((entry) => entry.name) : null;
    },
    existsNoFollow: (path) => fs.getEntryType(path) !== null,
    isDirectory: (path) => fs.getEntryType(path) === 'directory',
  };
}

export class ScpServerSession {
  constructor(
    private readonly channel: ConnectionChannel,
    private readonly fs: ISftpFileSystem,
    private readonly cwd: string,
    private readonly command: ScpServerCommand,
    private readonly finished: (exitCode: number) => void,
  ) {}

  start(): void {
    const peer = new ScpPeer(this.channel);
    const reporter = peerFaultReporter(peer);
    const environment = {
      peer, fs: this.fs, reporter, umask: SINK_UMASK,
      recursive: this.command.recursive, preserve: this.command.preserveTimes,
    };
    const run = this.command.role === 'sink'
      ? this.sink(environment)
      : runScpSource(environment, this.sourceNames());
    void run.then((exitCode) => this.finished(exitCode));
  }

  private async sink(environment: Parameters<typeof runScpSink>[0]): Promise<number> {
    const words = this.command.words;
    if (words.length !== 1) {
      environment.reporter.fault('ambiguous target');
      return 1;
    }
    const target: ScpNamedPath = { shown: words[0].text, path: this.fs.normalizePath(words[0].text, this.cwd) };
    if (this.command.targetMustBeDirectory) {
      const type = this.fs.getEntryType(target.path);
      if (type !== 'directory') {
        environment.reporter.fault(`${target.shown}: ${type === null ? 'No such file or directory' : 'Not a directory'}`);
        return 1;
      }
    }
    return runScpSink(environment, target);
  }

  private sourceNames(): ScpNamedPath[] {
    const names: ScpNamedPath[] = [];
    const glob = globFileSystemOf(this.fs);
    for (const word of this.command.words) {
      const normalized = this.fs.normalizePath(word.text, this.cwd);
      if (word.literal || !hasMagic(word.text)) {
        names.push({ shown: word.text, path: normalized });
        continue;
      }
      const matches = globPaths(glob, normalized, { noCheck: true });
      for (const match of matches) {
        names.push({ shown: word.text.startsWith('/') || /^[A-Za-z]:/.test(word.text) ? match : this.relativeToCwd(match), path: match });
      }
    }
    return names;
  }

  private relativeToCwd(path: string): string {
    const prefix = `${this.cwd.replace(/\/+$/, '')}/`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : path;
  }
}
