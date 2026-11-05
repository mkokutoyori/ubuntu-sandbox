import { globToRegexSource } from '../fs/Glob';
import { Streams, type CoreutilsRun } from '../coreutils/CoreutilsKit';

const BINARY = 2;
const MANUAL = 4;
const SOURCE = 8;
const EVERYTHING = BINARY | MANUAL | SOURCE;

const BINARY_DIRECTORIES = [
  '/usr/bin', '/usr/sbin', '/bin', '/sbin', '/usr/lib', '/usr/lib32', '/usr/lib64', '/etc', '/usr/etc', '/lib', '/lib32', '/lib64',
  '/usr/games', '/usr/games/bin', '/usr/games/lib', '/usr/emacs/etc', '/usr/lib/emacs/*/etc', '/usr/TeX/bin', '/usr/tex/bin',
  '/usr/interviews/bin/LINUX', '/usr/X11R6/bin', '/usr/X386/bin', '/usr/bin/X11', '/usr/X11/bin', '/usr/X11R5/bin', '/usr/local/bin',
  '/usr/local/sbin', '/usr/local/etc', '/usr/local/lib', '/usr/local/games', '/usr/local/games/bin', '/usr/local/emacs/etc',
  '/usr/local/TeX/bin', '/usr/local/tex/bin', '/usr/local/bin/X11', '/usr/contrib', '/usr/hosts', '/usr/include', '/usr/g++-include',
  '/usr/ucb', '/usr/old', '/usr/new', '/usr/local', '/usr/libexec', '/usr/share', '/opt/*/bin',
];

const MANUAL_DIRECTORIES = [
  '/usr/man/*', '/usr/share/man/*', '/usr/X386/man/*', '/usr/X11/man/*', '/usr/TeX/man/*', '/usr/interviews/man/mann', '/usr/share/info',
];

const SOURCE_DIRECTORIES = [
  '/usr/src/*', '/usr/src/lib/libc/*', '/usr/src/lib/libc/net/*', '/usr/src/ucb/pascal', '/usr/src/ucb/pascal/utilities', '/usr/src/undoc',
];

const HELP_TEXT = `
Usage:
 whereis [options] [-BMS <dir>... -f] <name>

Locate the binary, source, and manual-page files for a command.

Options:
 -b         search only for binaries
 -B <dirs>  define binaries lookup path
 -m         search only for manuals and infos
 -M <dirs>  define man and info lookup path
 -s         search only for sources
 -S <dirs>  define sources lookup path
 -f         terminate <dirs> argument list
 -u         search for unusual entries
 -g         interpret name as glob (pathnames pattern)
 -l         output effective lookup paths

 -h, --help     display this help
 -V, --version  display version

For more details see whereis(1).
`;

const VERSION_TEXT = 'whereis from util-linux 2.37.2\n';

export interface WhereisHost {
  environment(name: string): string | undefined;
  list(directory: string): readonly string[] | null;
  identity(directory: string): number | null;
  canonical(directory: string): string | null;
  providesBinary(name: string): boolean;
}

interface Searched {
  readonly type: number;
  readonly identity: number | null;
  readonly path: string;
}

class WhereisExit extends Error {
  constructor(readonly exitCode: number) {
    super('whereis exit');
  }
}

class Whereis {
  private searched: Searched[] = [];
  private unusual = false;
  private useGlob = false;
  private readonly streams = new Streams();

  constructor(private readonly host: WhereisHost) {}

  result(): CoreutilsRun {
    return this.streams.result();
  }

  private addDirectory(type: number, directory: string): void {
    const identity = this.host.identity(directory);
    if (this.host.list(directory) === null) return;
    if (identity !== null && this.searched.some((entry) => entry.identity === identity && entry.type === type)) return;
    this.searched.push({ type, identity, path: this.host.canonical(directory) ?? directory });
  }

  private addExpanded(type: number, pattern: string): void {
    const star = pattern.indexOf('*');
    const parent = pattern.slice(0, star);
    const rest = pattern.slice(star + 1);
    for (const name of this.host.list(parent) ?? []) {
      if (name === '.' || name === '..') continue;
      this.addDirectory(type, `${parent}${name}${rest}`);
    }
  }

  private construct(type: number, patterns: readonly string[]): void {
    for (const pattern of patterns) {
      if (pattern.includes('*')) this.addExpanded(type, pattern);
      else this.addDirectory(type, pattern);
    }
  }

  private constructFromEnvironment(name: string, type: number): void {
    const value = this.host.environment(name);
    if (value === undefined) return;
    for (const token of value.split(':')) if (token !== '') this.addDirectory(type, token);
  }

  private removeType(type: number): void {
    this.searched = this.searched.filter((entry) => (entry.type & type) === 0);
  }

  private matches(pattern: string, name: string, type: number): boolean {
    if (this.useGlob) return new RegExp(`^(?:${globToRegexSource(pattern, false)})$`, 's').test(name);
    if ((type & SOURCE) !== 0 && name.startsWith('s.') && this.matches(pattern, name.slice(2), type)) return true;
    let length = name.length;
    if ((type & MANUAL) !== 0) {
      for (const suffix of ['.Z', '.gz', '.xz', '.bz2', '.zst']) {
        if (length > suffix.length - 1 && name.endsWith(suffix)) { length -= suffix.length; break; }
      }
    }
    let at = 0;
    while (at < pattern.length && at < name.length && pattern[at] === name[at]) at++;
    length -= at;
    if (at === pattern.length && at === name.length) return true;
    if ((type & BINARY) === 0 && at === pattern.length && name[at] === '.') {
      let remaining = length - 1;
      let cursor = at + 1;
      while (remaining > 0 && cursor < name.length) {
        remaining--;
        if (name[cursor++] === '.') return name[cursor] === 'C' && cursor + 1 === name.length;
      }
      return true;
    }
    return false;
  }

  private lookup(pattern: string, want: number): void {
    const base = pattern.slice(pattern.lastIndexOf('/') + 1);
    let count = 0;
    let waiting: string | null = null;
    let line = this.unusual ? '' : `${base}:`;
    const binaryPresent = this.searched.some((entry) => entry.type === BINARY
      && (this.host.list(entry.path) ?? []).some((name) => this.matches(base, name, entry.type)));
    let injected = (want & BINARY) === 0 || binaryPresent || !this.host.providesBinary(base);
    const injectBinary = (): void => {
      if (injected) return;
      injected = true;
      line += ` /usr/bin/${base}`;
      count++;
    };
    for (const entry of this.searched) {
      if ((entry.type & want) === 0) continue;
      if (entry.type === BINARY) injectBinary();
      for (const name of this.host.list(entry.path) ?? []) {
        if (!this.matches(base, name, entry.type)) continue;
        if (this.unusual && count === 0) waiting = `${entry.path}/${name}`;
        else if (this.unusual && count === 1 && waiting !== null) {
          line += `${base}: ${waiting} ${entry.path}/${name}`;
          waiting = null;
        } else line += ` ${entry.path}/${name}`;
        count++;
      }
    }
    injectBinary();
    if (!this.unusual || count > 1) line += '\n';
    this.streams.stdout(line);
  }

  private listDirectories(): void {
    for (const entry of this.searched) {
      const label = entry.type === BINARY ? 'bin' : entry.type === MANUAL ? 'man' : 'src';
      this.streams.stdout(`${label}: ${entry.path}\n`);
    }
  }

  private badUsage(): never {
    this.streams.diagnostic('whereis: bad usage');
    this.streams.diagnostic("Try 'whereis --help' for more information.");
    throw new WhereisExit(1);
  }

  run(args: readonly string[]): void {
    if (args.length === 0) {
      this.streams.diagnostic('whereis: not enough arguments');
      this.streams.diagnostic("Try 'whereis --help' for more information.");
      throw new WhereisExit(1);
    }
    if (args[0] === '--help') { this.streams.stdout(HELP_TEXT); return; }
    if (args[0] === '--version') { this.streams.stdout(VERSION_TEXT); return; }
    this.construct(BINARY, BINARY_DIRECTORIES);
    this.constructFromEnvironment('PATH', BINARY);
    this.construct(MANUAL, MANUAL_DIRECTORIES);
    this.constructFromEnvironment('MANPATH', MANUAL);
    this.construct(SOURCE, SOURCE_DIRECTORIES);
    let want = EVERYTHING;
    let resettable = false;
    let missingTerminator = false;
    for (let index = 0; index < args.length; index++) {
      const word = args[index];
      if (!word.startsWith('-')) {
        this.lookup(word, want);
        resettable = true;
        continue;
      }
      const startedAt = index;
      for (let at = 1; at < word.length; at++) {
        const letter = word[at];
        if (letter === 'f') missingTerminator = false;
        else if (letter === 'u') { this.unusual = true; missingTerminator = false; }
        else if (letter === 'B' || letter === 'M' || letter === 'S') {
          if (at + 1 < word.length) this.badUsage();
          const type = letter === 'B' ? BINARY : letter === 'M' ? MANUAL : SOURCE;
          index++;
          this.removeType(type);
          for (let cursor = index; cursor < args.length && !args[cursor].startsWith('-'); cursor++) {
            this.addDirectory(type, args[cursor]);
            index = cursor;
          }
          missingTerminator = true;
        } else if (letter === 'b' || letter === 'm' || letter === 's') {
          if (resettable) { want = EVERYTHING; resettable = false; }
          const type = letter === 'b' ? BINARY : letter === 'm' ? MANUAL : SOURCE;
          want = want === EVERYTHING ? type : want | type;
          missingTerminator = false;
        } else if (letter === 'l') this.listDirectories();
        else if (letter === 'g') this.useGlob = true;
        else if (letter === 'V') { this.streams.stdout(VERSION_TEXT); return; }
        else if (letter === 'h') { this.streams.stdout(HELP_TEXT); return; }
        else this.badUsage();
        if (startedAt < index) break;
      }
    }
    if (missingTerminator) {
      this.streams.diagnostic('whereis: option -f is missing');
      throw new WhereisExit(1);
    }
  }
}

export function runWhereis(host: WhereisHost, args: readonly string[]): CoreutilsRun {
  const whereis = new Whereis(host);
  try {
    whereis.run(args);
  } catch (error) {
    if (!(error instanceof WhereisExit)) throw error;
    const run = whereis.result();
    return { ...run, exitCode: error.exitCode };
  }
  return whereis.result();
}
