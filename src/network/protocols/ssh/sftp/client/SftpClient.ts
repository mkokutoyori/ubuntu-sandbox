import { globPaths, hasMagic, type GlobFileSystem } from '@/network/devices/linux/fs/Glob';
import { simulationNowMs } from '@/network/core/SystemClock';
import type { SftpWireAttrs } from '../SftpWireCodec';
import { formatListing, scaledSize } from './SftpListing';
import { SftpLocalPort } from './SftpLocalPort';
import { parseSftpLine, type SftpListingFlags, type SftpParsedCommand } from './SftpCommandParser';
import {
  baseName, isDirectoryMode, pathAppend, SftpTransfers, type SftpTransferOptions,
} from './SftpTransfers';
import { SftpProtocolFailure, SftpWireClient, type SftpDirectoryEntry, type SftpDiagnostics } from './SftpWireClient';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export const SFTP_HELP = [
  'Available commands:',
  'bye                                Quit sftp',
  "cd path                            Change remote directory to 'path'",
  "chgrp [-h] grp path                Change group of file 'path' to 'grp'",
  "chmod [-h] mode path               Change permissions of file 'path' to 'mode'",
  "chown [-h] own path                Change owner of file 'path' to 'own'",
  'df [-hi] [path]                    Display statistics for current directory or',
  "                                   filesystem containing 'path'",
  'exit                               Quit sftp',
  'get [-afpR] remote [local]         Download file',
  'help                               Display this help text',
  "lcd path                           Change local directory to 'path'",
  'lls [ls-options [path]]            Display local directory listing',
  'lmkdir path                        Create local directory',
  'ln [-s] oldpath newpath            Link remote file (-s for symlink)',
  'lpwd                               Print local working directory',
  'ls [-1afhlnrSt] [path]             Display remote directory listing',
  "lumask umask                       Set local umask to 'umask'",
  'mkdir path                         Create remote directory',
  'progress                           Toggle display of progress meter',
  'put [-afpR] local [remote]         Upload file',
  'pwd                                Display remote working directory',
  'quit                               Quit sftp',
  'reget [-fpR] remote [local]        Resume download file',
  'rename oldpath newpath             Rename remote file',
  'reput [-fpR] local [remote]        Resume upload file',
  'rm path                            Delete remote file',
  'rmdir path                         Remove remote directory',
  'symlink oldpath newpath            Symlink remote file',
  'version                            Show SFTP version',
  "!command                           Execute 'command' in local shell",
  '!                                  Escape to local shell',
  '?                                  Synonym for help',
];

export interface SftpClientHost {
  readonly local: SftpLocalPort;
  listCommand(arguments_: string): string;
  runShell(command: string | null): Promise<{ readonly output: string; readonly exitCode: number }>;
}

export interface SftpClientFlags {
  readonly quiet: boolean;
  readonly showProgress: boolean;
  readonly resumeAll: boolean;
  readonly fsyncAll: boolean;
  readonly preserveAll: boolean;
  readonly recursiveAll: boolean;
  readonly limitKbps: number | null;
  readonly timeZoneOffsetMinutes: (atMs: number) => number;
}

export type SftpDispatch = 'continue' | 'quit' | 'abort';

interface RemoteGlob {
  readonly paths: string[];
  readonly matched: number;
  readonly attributes: Map<string, SftpWireAttrs | null>;
}

const TERMINAL_WIDTH = 80;

function bytewise(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class SftpClient {
  private readonly transfers: SftpTransfers;
  private remoteDirectory = '/';
  private startDirectory = '/';
  private showProgress: boolean;

  constructor(
    private readonly wire: SftpWireClient,
    private readonly host: SftpClientHost,
    private readonly flags: SftpClientFlags,
    private readonly diagnostics: SftpDiagnostics,
    private readonly emit: (text: string) => void,
  ) {
    this.showProgress = flags.showProgress;
    const self = this;
    this.transfers = new SftpTransfers(
      wire, host.local, diagnostics,
      { get showProgress() { return self.showProgress; }, limitKbps: flags.limitKbps },
      (line) => this.print(line),
      (line) => this.print(line),
    );
  }

  get remotePath(): string {
    return this.remoteDirectory;
  }

  private print(line: string): void {
    this.emit(`${line}\n`);
  }

  initialize(): boolean {
    const here = this.wire.realpath('.');
    if (here === null) {
      this.print('Need cwd');
      return false;
    }
    this.remoteDirectory = here;
    this.startDirectory = here;
    return true;
  }

  private absolute(path: string): string {
    return path.startsWith('/') ? path : pathAppend(this.remoteDirectory, path);
  }

  private remoteIsDirectory(path: string): boolean {
    const attrs = this.wire.stat(path, true);
    return attrs !== null && isDirectoryMode(attrs.permissions);
  }

  private remoteGlob(pattern: string, noCheck: boolean, mark: boolean): RemoteGlob | null {
    const attributes = new Map<string, SftpWireAttrs | null>();
    const view: GlobFileSystem = {
      listNames: (directory) => {
        const entries = this.wire.readDirectory(directory === '' ? '.' : directory);
        if (entries === null) return null;
        return entries.map((entry) => entry.filename);
      },
      existsNoFollow: (path) => this.wire.lstat(path, true) !== null,
      isDirectory: (path) => this.remoteIsDirectory(path),
    };
    const base = hasMagic(pattern)
      ? globPaths(view, pattern)
      : (this.wire.lstat(pattern.replace(/\/+$/, '') || '/', true) !== null ? [pattern.replace(/(.)\/+$/, '$1')] : []);
    const matched = base.length;
    let paths = [...base];
    if (matched === 0) {
      if (!noCheck) return null;
      paths = [pattern];
    }
    if (matched > 0) {
      for (const path of paths) attributes.set(path, this.wire.stat(path, true));
      if (mark) {
        paths = paths.map((path) => {
          const attrs = attributes.get(path);
          return attrs !== undefined && attrs !== null && isDirectoryMode(attrs.permissions) && !path.endsWith('/') ? `${path}/` : path;
        });
        for (const [index, path] of paths.entries()) {
          if (path !== base[index]) attributes.set(path, attributes.get(base[index]) ?? null);
        }
      }
    }
    return { paths, matched, attributes };
  }

  private transferOptions(command: SftpParsedCommand, resume: boolean): SftpTransferOptions {
    return {
      preserve: command.preserve || this.flags.preserveAll,
      resume: resume || this.flags.resumeAll,
      fsync: command.fsync || this.flags.fsyncAll,
    };
  }

  private processGet(command: SftpParsedCommand, resumeForced: boolean): boolean {
    const source = this.absolute(command.path1!);
    const glob = this.remoteGlob(source, false, true);
    if (glob === null) {
      this.diagnostics.error(`File "${source}" not found.`);
      return false;
    }
    const local = this.host.local;
    const destination = command.path2;
    if (glob.matched > 1 && destination !== null && !local.isDirectory(destination)) {
      this.diagnostics.error(`Multiple source paths, but destination "${destination}" is not a directory`);
      return false;
    }
    let ok = true;
    const options = this.transferOptions(command, resumeForced);
    for (const remote of glob.paths) {
      const filename = baseName(remote);
      let target: string;
      if (glob.matched === 1 && destination !== null) {
        target = local.isDirectory(destination) ? pathAppend(destination, filename) : destination;
      } else if (destination !== null) {
        target = pathAppend(destination, filename);
      } else {
        target = filename;
      }
      if (!this.flags.quiet) this.print(`${options.resume ? 'Resuming' : 'Fetching'} ${remote} to ${target}`);
      const recursive = command.recursive || this.flags.recursiveAll;
      const success = remote.endsWith('/') && recursive
        ? this.transfers.downloadDirectory(remote, target, true, options)
        : this.transfers.download(remote, target, null, options);
      if (!success) ok = false;
    }
    return ok;
  }

  private processPut(command: SftpParsedCommand, resumeForced: boolean): boolean {
    const local = this.host.local;
    const source = command.path1!;
    const destination = command.path2 === null ? null : this.absolute(command.path2);
    const glob = local.glob(source, true);
    const destinationIsDirectory = destination === null ? true : this.remoteIsDirectory(destination);
    if (glob.matched > 1 && destination !== null && !destinationIsDirectory) {
      this.diagnostics.error(`Multiple paths match, but destination "${destination}" is not a directory`);
      return false;
    }
    let ok = true;
    const options = this.transferOptions(command, resumeForced);
    for (const path of glob.paths) {
      const stat = local.stat(path);
      if (typeof stat === 'string') {
        this.diagnostics.error(`stat ${path}: ${stat}`);
        ok = false;
        continue;
      }
      const filename = baseName(path);
      let target: string;
      if (glob.matched === 1 && destination !== null) {
        target = destinationIsDirectory ? pathAppend(destination, filename) : destination;
      } else if (destination !== null) {
        target = pathAppend(destination, filename);
      } else {
        target = this.absolute(filename);
      }
      if (!this.flags.quiet) this.print(`${options.resume ? 'Resuming upload of' : 'Uploading'} ${path} to ${target}`);
      const recursive = command.recursive || this.flags.recursiveAll;
      const success = stat.type === 'directory' && recursive
        ? this.transfers.uploadDirectory(path.replace(/[/\\]+$/, ''), target, true, options)
        : this.transfers.upload(path, target, options);
      if (!success) ok = false;
    }
    return ok;
  }

  private sortEntries(entries: readonly SftpDirectoryEntry[], flags: SftpListingFlags): SftpDirectoryEntry[] {
    const sorted = [...entries];
    if (flags.sort === 'none') return sorted;
    const direction = flags.reverse ? -1 : 1;
    const compare = (left: SftpDirectoryEntry, right: SftpDirectoryEntry): number => {
      if (flags.sort === 'name') return direction * bytewise(left.filename, right.filename);
      const key = flags.sort === 'time' ? 'mtime' : 'size';
      const a = left.attrs[key] ?? 0;
      const b = right.attrs[key] ?? 0;
      return direction * (a === b ? 0 : a < b ? 1 : -1);
    };
    return sorted.sort(compare);
  }

  private listingEntry(attrs: SftpWireAttrs): { mode: number; uid: number; gid: number; size: number; mtimeMs: number } {
    return {
      mode: attrs.permissions ?? 0, uid: attrs.uid ?? 0, gid: attrs.gid ?? 0, size: attrs.size ?? 0,
      mtimeMs: (attrs.mtime ?? 0) * 1000,
    };
  }

  private longListing(name: string, attrs: SftpWireAttrs, siUnits: boolean): string {
    const entry = this.listingEntry(attrs);
    return formatListing(name, entry, 'remote', simulationNowMs(), siUnits, this.flags.timeZoneOffsetMinutes(entry.mtimeMs));
  }

  private columns(names: readonly string[], extra: number): { columns: number; spacing: number } {
    const longest = names.reduce((widest, name) => Math.max(widest, name.length), 0) + extra;
    const columns = Math.max(Math.floor(TERMINAL_WIDTH / (longest + 2)), 1);
    return { columns, spacing: Math.min(Math.floor(TERMINAL_WIDTH / columns), TERMINAL_WIDTH) };
  }

  private stripPath(path: string, strip: string | null): string {
    if (strip === null) return path;
    if (path.startsWith(strip)) {
      let length = strip.length;
      if (!strip.endsWith('/') && path[length] === '/') length++;
      return path.slice(length);
    }
    return path;
  }

  private listDirectory(path: string, strip: string | null, flags: SftpListingFlags): boolean {
    const entries = this.wire.readDirectory(path);
    if (entries === null) return false;
    const visible = (entry: SftpDirectoryEntry): boolean => !entry.filename.startsWith('.') || flags.showAll;
    const layout = this.columns(
      entries.filter(visible).map((entry) => entry.filename), this.stripPath(path, strip).length,
    );
    let used = 1;
    let text = '';
    for (const entry of this.sortEntries(entries, flags)) {
      if (!visible(entry)) continue;
      const shown = this.stripPath(pathAppend(path, entry.filename), strip);
      if (flags.long) {
        text += `${flags.numeric || flags.siUnits
          ? this.longListing(shown, entry.attrs, flags.siUnits)
          : entry.longname}\n`;
      } else if (flags.short) {
        text += `${padToWidth(shown, layout.spacing)}\n`;
      } else {
        text += padToWidth(shown, layout.spacing);
        if (used >= layout.columns) {
          text += '\n';
          used = 1;
        } else {
          used++;
        }
      }
    }
    if (!flags.long && !flags.short && used !== 1) text += '\n';
    this.emit(text);
    return true;
  }

  private listGlobbed(path: string, strip: string | null, flags: SftpListingFlags): boolean {
    const glob = this.remoteGlob(path, true, true);
    if (glob === null || glob.matched === 0) {
      this.diagnostics.error(`Can't ls: "${path}" not found`);
      return false;
    }
    if (glob.matched === 1) {
      const attrs = glob.attributes.get(glob.paths[0]);
      if (attrs !== undefined && attrs !== null && isDirectoryMode(attrs.permissions)) {
        return this.listDirectory(glob.paths[0], strip, flags);
      }
    }
    const ordered = [...glob.paths];
    if (flags.sort !== 'none') {
      const direction = flags.reverse ? -1 : 1;
      ordered.sort((left, right) => {
        if (flags.sort === 'name') return direction * bytewise(left, right);
        const key = flags.sort === 'time' ? 'mtime' : 'size';
        const a = glob.attributes.get(left)?.[key] ?? 0;
        const b = glob.attributes.get(right)?.[key] ?? 0;
        return direction * (a === b ? 0 : a < b ? 1 : -1);
      });
    }
    const layout = this.columns(glob.paths, 0);
    let used = 1;
    let text = '';
    for (const entry of ordered) {
      const shown = this.stripPath(entry, strip);
      if (flags.long) {
        const attrs = glob.attributes.get(entry);
        if (attrs === undefined || attrs === null) {
          this.diagnostics.error(`no stat information for ${shown}`);
          continue;
        }
        text += `${this.longListing(shown, attrs, flags.siUnits)}\n`;
      } else if (flags.short) {
        text += `${padToWidth(shown, layout.spacing)}\n`;
      } else {
        text += padToWidth(shown, layout.spacing);
        if (used >= layout.columns) {
          text += '\n';
          used = 1;
        } else {
          used++;
        }
      }
    }
    if (!flags.long && used !== 1) text += '\n';
    this.emit(text);
    return true;
  }

  private statistics(path: string, human: boolean, inodes: boolean): boolean {
    const stats = this.wire.filesystemStats(path);
    if (stats === null) return false;
    const percent = (total: number, free: number): string =>
      (total === 0 ? 'ERR' : `${padToWidth(String(Math.floor((100 * (total - free)) / total)), 3, 'right')}%`);
    const inodeCapacity = percent(stats.files, stats.freeFiles);
    const dataCapacity = percent(stats.blocks, stats.freeBlocks);
    if (inodes) {
      this.print('     Inodes        Used       Avail      (root)    %Capacity');
      this.print(`${padToWidth(String(stats.files), 11, 'right')} ${padToWidth(String(stats.files - stats.freeFiles), 11, 'right')} ${padToWidth(String(stats.availableFiles), 11, 'right')} ${padToWidth(String(stats.freeFiles), 11, 'right')}         ${inodeCapacity}`);
    } else if (human) {
      const scale = (blocks: number): string => `${padToWidth(scaledSize(blocks * stats.fragmentSize), 7, 'right')}B`;
      this.print('    Size     Used    Avail   (root)    %Capacity');
      this.print(`${scale(stats.blocks)} ${scale(stats.blocks - stats.freeBlocks)} ${scale(stats.availableBlocks)} ${scale(stats.freeBlocks)}         ${dataCapacity}`);
    } else {
      const kilobytes = (blocks: number): string => padToWidth(String(Math.floor((stats.fragmentSize * blocks) / 1024)), 12, 'right');
      this.print('        Size         Used        Avail       (root)    %Capacity');
      this.print(`${kilobytes(stats.blocks)} ${kilobytes(stats.blocks - stats.freeBlocks)} ${kilobytes(stats.availableBlocks)} ${kilobytes(stats.freeBlocks)}         ${dataCapacity}`);
    }
    return true;
  }

  private change(command: SftpParsedCommand, owner: boolean, group: boolean, abortOnError: boolean): boolean {
    const glob = this.remoteGlob(this.absolute(command.path1!), true, false);
    let ok = true;
    for (const path of glob?.paths ?? []) {
      const attrs = command.human ? this.wire.lstat(path, false) : this.wire.stat(path, false);
      if (attrs === null) {
        ok = false;
        if (abortOnError) break;
        continue;
      }
      if (attrs.uid === undefined || attrs.gid === undefined) {
        this.diagnostics.error(`Can't get current ownership of remote file "${path}"`);
        ok = false;
        if (abortOnError) break;
        continue;
      }
      if (!this.flags.quiet) this.print(`Changing ${owner ? 'owner' : 'group'} on ${path}`);
      const updated: SftpWireAttrs = {
        uid: owner ? command.number : attrs.uid,
        gid: group ? command.number : attrs.gid,
      };
      const success = command.human ? this.wire.setLinkAttributes(path, updated) : this.wire.setAttributes(path, updated);
      if (!success) {
        ok = false;
        if (abortOnError) break;
      }
    }
    return ok;
  }

  async runLine(line: string, abortOnError: boolean, echo: boolean): Promise<SftpDispatch> {
    const parsed = parseSftpLine(line, this.host.local.windowsStyle);
    const ignoreErrors = parsed.kind === 'command' ? parsed.command.ignoreErrors : parsed.ignoreErrors;
    const disableEcho = parsed.kind === 'command' ? parsed.command.disableEcho : parsed.disableEcho;
    const abort = abortOnError && !ignoreErrors;
    if (echo && !disableEcho) this.print(`sftp> ${line}`);
    if (parsed.kind === 'blank') return 'continue';
    if (parsed.kind === 'invalid') {
      this.diagnostics.error(parsed.diagnostic);
      return abort ? 'abort' : 'continue';
    }
    let ok: boolean;
    try {
      ok = await this.dispatch(parsed.command, abort);
    } catch (failure) {
      if (failure instanceof SftpProtocolFailure) {
        this.print(failure.message);
        return 'abort';
      }
      throw failure;
    }
    if (abort && !ok) return 'abort';
    return parsed.command.verb === 'quit' ? 'quit' : 'continue';
  }

  private dispatchSync(command: SftpParsedCommand, abort: boolean): boolean {
    const local = this.host.local;
    switch (command.verb) {
      case 'reget': return this.processGet(command, true);
      case 'get': return this.processGet(command, false);
      case 'reput': return this.processPut(command, true);
      case 'put': return this.processPut(command, false);
      case 'rename':
        return this.wire.rename(this.absolute(command.path1!), this.absolute(command.path2!), command.legacy);
      case 'symlink':
        return this.wire.symbolicLink(command.path1!, this.absolute(command.path2!));
      case 'link': {
        const target = this.absolute(command.path2!);
        return command.symbolic
          ? this.wire.symbolicLink(command.path1!, target)
          : this.wire.hardLink(this.absolute(command.path1!), target);
      }
      case 'rm': {
        const glob = this.remoteGlob(this.absolute(command.path1!), true, false);
        let ok = true;
        for (const path of glob?.paths ?? []) {
          if (!this.flags.quiet) this.print(`Removing ${path}`);
          if (!this.wire.remove(path)) {
            ok = false;
            if (abort) break;
          }
        }
        return ok;
      }
      case 'mkdir':
        return this.wire.makeDirectory(this.absolute(command.path1!), { permissions: 0o777 }, true);
      case 'rmdir':
        return this.wire.removeDirectory(this.absolute(command.path1!));
      case 'chdir': {
        const requested = command.path1 === null || command.path1 === '' ? this.startDirectory : command.path1;
        const resolved = this.wire.realpath(this.absolute(requested));
        if (resolved === null) return false;
        const attrs = this.wire.stat(resolved, false);
        if (attrs === null) return false;
        if (attrs.permissions === undefined) {
          this.diagnostics.error("Can't change directory: Can't check target");
          return false;
        }
        if (!isDirectoryMode(attrs.permissions)) {
          this.diagnostics.error(`Can't change directory: "${resolved}" is not a directory`);
          return false;
        }
        this.remoteDirectory = resolved;
        return true;
      }
      case 'ls': {
        if (command.path1 === null) {
          this.listDirectory(this.remoteDirectory, this.remoteDirectory, command.listing);
          return true;
        }
        const strip = command.path1.startsWith('/') ? null : this.remoteDirectory;
        return this.listGlobbed(this.absolute(command.path1), strip, command.listing);
      }
      case 'df':
        return this.statistics(this.absolute(command.path1 ?? this.remoteDirectory), command.human, command.inodes);
      case 'lchdir': {
        const requested = command.path1 === null || command.path1 === '' ? '~' : command.path1;
        const expanded = local.expandTilde(requested);
        const failure = local.changeDirectory(expanded);
        if (failure !== null) {
          this.diagnostics.error(`Couldn't change local directory to "${expanded}": ${failure}`);
          return false;
        }
        return true;
      }
      case 'lmkdir': {
        const failure = local.makeDirectory(command.path1!);
        if (failure !== null) {
          this.diagnostics.error(`Couldn't create local directory "${command.path1}": ${failure}`);
          return false;
        }
        return true;
      }
      case 'lumask':
        local.setUmask(command.number);
        this.print(`Local umask: ${command.number.toString(8).padStart(3, '0')}`);
        return true;
      case 'chmod': {
        const glob = this.remoteGlob(this.absolute(command.path1!), true, false);
        let ok = true;
        for (const path of glob?.paths ?? []) {
          if (!this.flags.quiet) this.print(`Changing mode on ${path}`);
          const success = command.human
            ? this.wire.setLinkAttributes(path, { permissions: command.number })
            : this.wire.setAttributes(path, { permissions: command.number });
          if (!success) {
            ok = false;
            if (abort) break;
          }
        }
        return ok;
      }
      case 'chown': return this.change(command, true, false, abort);
      case 'chgrp': return this.change(command, false, true, abort);
      case 'pwd':
        this.print(`Remote working directory: ${this.remoteDirectory}`);
        return true;
      case 'lpwd':
        this.print(`Local working directory: ${local.cwd}`);
        return true;
      case 'quit':
        return true;
      case 'help':
        for (const line of SFTP_HELP) this.print(line);
        return true;
      case 'version':
        this.print(`SFTP protocol version ${this.wire.version}`);
        return true;
      case 'progress':
        this.showProgress = !this.showProgress;
        this.print(this.showProgress ? 'Progress meter enabled' : 'Progress meter disabled');
        return true;
      default:
        return true;
    }
  }

  private async dispatch(command: SftpParsedCommand, abort: boolean): Promise<boolean> {
    if (command.verb === 'lls') return this.runLocal(this.host.listCommand(command.rest));
    if (command.verb === 'shell') return command.rest.trim() === '' ? true : this.runLocal(command.rest);
    return this.dispatchSync(command, abort);
  }

  executeSync(line: string): string {
    const parsed = parseSftpLine(line, this.host.local.windowsStyle);
    if (parsed.kind === 'invalid') this.diagnostics.error(parsed.diagnostic);
    else if (parsed.kind === 'command') this.dispatchSync(parsed.command, false);
    return '';
  }

  private async runLocal(commandLine: string | null): Promise<boolean> {
    const result = await this.host.runShell(commandLine);
    if (result.output !== '') this.emit(result.output.endsWith('\n') ? result.output : `${result.output}\n`);
    if (result.exitCode !== 0) {
      this.diagnostics.error(`Shell exited with status ${result.exitCode}`);
    }
    return true;
  }

  async start(first: string | null, second: string | null): Promise<'enter-loop' | 'done' | 'failed'> {
    if (first === null) return 'enter-loop';
    const directory = this.absolute(first);
    if (this.remoteIsDirectory(directory) && second === null) {
      if (!this.flags.quiet) this.print(`Changing to: ${directory}`);
      return (await this.runLine(`cd "${directory}"`, true, false)) === 'abort' ? 'failed' : 'enter-loop';
    }
    const outcome = await this.runLine(
      `get${this.flags.resumeAll ? ' -a' : ''} ${directory}${second === null ? '' : ` ${second}`}`, true, false);
    return outcome === 'abort' ? 'failed' : 'done';
  }
}
