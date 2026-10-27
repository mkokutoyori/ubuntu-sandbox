import { strerror } from '../../../../../core/Errno';
import { ExitSignal, ToolOutput } from '../../../audit/tools/AuditToolHost';
import {
  isFailure, type FuserHost, type FuserStat, type ResolvedAddress,
} from './FuserHost';
import { listSignals, signalNumber } from './FuserSignals';

const ACCESS_CWD = 1;
const ACCESS_EXE = 2;
const ACCESS_FILE = 4;
const ACCESS_ROOT = 8;
const ACCESS_MMAP = 16;
const ACCESS_FILEWR = 32;

const OPT_VERBOSE = 1;
const OPT_ALLFILES = 2;
const OPT_MOUNTS = 4;
const OPT_KILL = 8;
const OPT_INTERACTIVE = 16;
const OPT_SILENT = 32;
const OPT_USER = 64;
const OPT_ISMOUNTPOINT = 128;
const OPT_WRITE = 256;
const OPT_ALWAYSSTAT = 512;

const NAME_FIELD = 20;
const COMM_LEN = 64;
const SIGKILL = 9;
const PORT_MASK = 0xffff;
const KNFSD_EXPORTS = '/proc/fs/nfs/exports';
const PROC_MOUNTS = '/proc/mounts';
const PROC_SWAPS = '/proc/swaps';

type Space = 'file' | 'tcp' | 'udp';
type ProcessKind = 'normal' | 'mount' | 'knfsd' | 'swap';

interface MatchedProcess {
  readonly pid: number;
  readonly uid: number;
  access: number;
  readonly kind: ProcessKind;
  readonly command: string | null;
}

interface NameEntry {
  filename: string;
  readonly space: Space;
  stat: FuserStat | null;
  readonly matched: MatchedProcess[];
}

interface InodeMatch {
  readonly name: NameEntry;
  readonly device: number;
  readonly inode: number;
}

interface DeviceMatch {
  readonly name: NameEntry;
  readonly device: number;
}

interface Connection {
  readonly name: NameEntry;
  readonly localPort: number;
  readonly remotePort: number;
  readonly remoteAddress: string | null;
}

interface UnixSocket {
  readonly device: number;
  readonly inode: number;
  readonly netInode: number;
}

const USAGE = [
  'Usage: fuser [-fIMuvw] [-a|-s] [-4|-6] [-c|-m|-n SPACE]',
  '             [-k [-i] [-SIGNAL]] NAME...',
  '       fuser -l',
  '       fuser -V',
  'Show which processes use the named files, sockets, or filesystems.',
  '',
  '  -a,--all              display unused files too',
  '  -i,--interactive      ask before killing (ignored without -k)',
  '  -I,--inode            use always inodes to compare files',
  '  -k,--kill             kill processes accessing the named file',
  '  -l,--list-signals     list available signal names',
  '  -m,--mount            show all processes using the named filesystems or',
  '                        block device',
  '  -M,--ismountpoint     fulfill request only if NAME is a mount point',
  '  -n,--namespace SPACE  search in this name space (file, udp, or tcp)',
  '  -s,--silent           silent operation',
  '  -SIGNAL               send this signal instead of SIGKILL',
  '  -u,--user             display user IDs',
  '  -v,--verbose          verbose output',
  '  -w,--writeonly        kill only processes with write access',
  '  -V,--version          display version information',
  '  -4,--ipv4             search IPv4 sockets only',
  '  -6,--ipv6             search IPv6 sockets only',
  '  udp/tcp names: [local_port][,[rmt_host][,[rmt_port]]]',
  '',
  '',
].join('\n');

const VERSION = [
  'fuser (PSmisc) 23.7',
  'Copyright (C) 1993-2024 Werner Almesberger and Craig Small',
  '',
  'PSmisc comes with ABSOLUTELY NO WARRANTY.',
  'This is free software, and you are welcome to redistribute it under',
  'the terms of the GNU General Public License.',
  'For more information about these matters, see the files named COPYING.',
  '',
].join('\n');

const LONG_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['all', 'a'], ['kill', 'k'], ['interactive', 'i'], ['inode', 'I'], ['list-signals', 'l'], ['mount', 'm'], ['ismountpoint', 'M'],
  ['namespace', 'n'], ['silent', 's'], ['user', 'u'], ['verbose', 'v'], ['writeonly', 'w'], ['version', 'V'], ['ipv4', '4'], ['ipv6', '6'],
]);

function printableCommand(raw: string): string {
  let command = '';
  for (const character of raw.slice(0, COMM_LEN)) {
    if (command.length >= COMM_LEN) break;
    const code = character.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) command += character;
    else if (command.length < COMM_LEN - 4) command += `\\${code.toString(8).padStart(3, '0')}`;
  }
  return command;
}

function reverseBytes(hex: string): string {
  const bytes = hex.match(/../g) ?? [];
  return bytes.reverse().join('');
}

function ipv4FromProc(hex: string): string {
  const bytes = reverseBytes(hex).match(/../g) ?? [];
  return bytes.map((byte) => Number.parseInt(byte, 16)).join('.');
}

function ipv6FromProc(hex: string): string {
  const groups = hex.match(/.{8}/g) ?? [];
  const bytes = groups.flatMap((group) => (reverseBytes(group).match(/../g) ?? []));
  return bytes.join('').toLowerCase();
}

function ipv6Bytes(address: string): string | null {
  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): string[] | null => {
    if (part === '') return [];
    const groups: string[] = [];
    for (const group of part.split(':')) {
      if (group.includes('.')) {
        const quad = group.split('.').map(Number);
        if (quad.length !== 4 || quad.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return null;
        groups.push(((quad[0] << 8) | quad[1]).toString(16).padStart(4, '0'), ((quad[2] << 8) | quad[3]).toString(16).padStart(4, '0'));
      } else if (/^[0-9a-fA-F]{1,4}$/.test(group)) groups.push(group.toLowerCase().padStart(4, '0'));
      else return null;
    }
    return groups;
  };
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  if (head === null || tail === null) return null;
  if (halves.length === 1) return head.length === 8 ? head.join('') : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array<string>(fill).fill('0000'), ...tail].join('');
}

class FuserRun {
  private opts = 0;
  private signal = SIGKILL;
  private defaultSpace: Space = 'file';
  private ipv4Only = false;
  private ipv6Only = false;
  private readonly names: NameEntry[] = [];
  private readonly inodes: InodeMatch[] = [];
  private readonly devices: DeviceMatch[] = [];
  private readonly connections: Record<'tcp' | 'udp', { v4: Connection[]; v6: Connection[] }> = {
    tcp: { v4: [], v6: [] }, udp: { v4: [], v6: [] },
  };
  private unixSockets: UnixSocket[] = [];
  private readonly netDevice: number;

  constructor(private readonly host: FuserHost, private readonly out: ToolOutput) {
    this.netDevice = host.socketDevice();
  }

  private usage(message: string | null): never {
    if (message !== null) this.out.eprintf(`${message}\n`);
    this.out.eprintf(USAGE);
    throw new ExitSignal(1);
  }

  run(args: readonly string[]): number {
    this.fillUnixCache();
    this.parseArguments(args);
    if (this.names.length === 0) this.usage('No process specification given');
    if ((this.opts & OPT_ISMOUNTPOINT) !== 0) this.checkMountPoints();
    if ((this.opts & OPT_SILENT) !== 0) {
      this.opts &= ~OPT_VERBOSE;
      this.opts &= ~OPT_USER;
      if ((this.opts & OPT_ALLFILES) !== 0) this.usage('all option cannot be used with silent option.');
    }
    if (this.ipv4Only && this.ipv6Only) this.usage('You cannot search for only IPv4 and only IPv6 sockets at the same time');
    if (!this.ipv6Only) {
      if (this.connections.tcp.v4.length > 0) this.findNetSockets('tcp', false);
      if (this.connections.udp.v4.length > 0) this.findNetSockets('udp', false);
    }
    if (!this.ipv4Only) {
      if (this.connections.tcp.v6.length > 0) this.findNetSockets('tcp', true);
      if (this.connections.udp.v6.length > 0) this.findNetSockets('udp', true);
    }
    this.scanProcesses();
    this.scanSpecial(KNFSD_EXPORTS, 'knfsd', (line) => {
      if (line.startsWith('#')) return null;
      const space = line.search(/[ \t]/);
      return space < 0 ? null : line.slice(0, space);
    });
    this.scanSpecial(PROC_MOUNTS, 'mount', (line) => {
      const first = line.indexOf(' ');
      if (first < 0) return null;
      const rest = line.slice(first + 1);
      const second = rest.indexOf(' ');
      return second < 0 ? null : rest.slice(0, second);
    });
    this.scanSpecial(PROC_SWAPS, 'swap', (line) => {
      const space = line.indexOf(' ');
      return space < 0 ? null : line.slice(0, space);
    });
    return this.printMatches();
  }

  private parseArguments(args: readonly string[]): void {
    for (let index = 0; index < args.length; index++) {
      const current = args[index];
      if (current.startsWith('-') && current.length >= 1) {
        let cluster: string;
        if (current.startsWith('--')) {
          if (current === '--') break;
          const mapped = LONG_OPTIONS.get(current.slice(2));
          if (mapped === undefined) {
            this.out.eprintf(`fuser: Invalid option ${current}\n`);
            this.usage(null);
          }
          cluster = `-${mapped}`;
        } else cluster = current;
        let skip = false;
        for (let position = 1; position < cluster.length && !skip; position++) {
          const letter = cluster[position];
          switch (letter) {
            case '4': this.ipv4Only = true; break;
            case '6': this.ipv6Only = true; break;
            case 'a': this.opts |= OPT_ALLFILES; break;
            case 'c': this.opts |= OPT_MOUNTS; break;
            case 'f': break;
            case 'h': this.usage(null); break;
            case 'i': this.opts |= OPT_INTERACTIVE; break;
            case 'I': this.opts |= OPT_ALWAYSSTAT; break;
            case 'k': this.opts |= OPT_KILL; break;
            case 'l': this.out.printf(listSignals()); throw new ExitSignal(0);
            case 'm': this.opts |= OPT_MOUNTS; break;
            case 'M': this.opts |= OPT_ISMOUNTPOINT; break;
            case 'n': {
              index++;
              if (index >= args.length) this.usage('Namespace option requires an argument.');
              skip = true;
              const space = args[index];
              if (space === 'tcp' || space === 'udp' || space === 'file') this.defaultSpace = space;
              else this.usage('Invalid namespace name');
              break;
            }
            case 's': this.opts |= OPT_SILENT; break;
            case 'u': this.opts |= OPT_USER; break;
            case 'v': this.opts |= OPT_VERBOSE; break;
            case 'w': this.opts |= OPT_WRITE; break;
            case 'V': this.out.eprintf(VERSION); throw new ExitSignal(0);
            default:
              if (/[A-Z0-9]/.test(letter)) {
                const name = current.slice(1);
                const number = signalNumber(name);
                if (number === null) {
                  this.out.eprintf(`${name}: unknown signal; fuser -l lists signals.\n`);
                  throw new ExitSignal(1);
                }
                this.signal = number;
                skip = true;
                break;
              }
              this.out.eprintf(`fuser: Invalid option ${letter}\n`);
              this.usage(null);
          }
        }
        continue;
      }
      this.addName(current);
    }
  }

  private addName(argument: string): void {
    let space = this.defaultSpace;
    let spec = argument;
    const slash = argument.indexOf('/');
    if (slash > 0) {
      const suffix = argument.slice(slash + 1);
      if (suffix === 'tcp' || suffix === 'udp' || suffix === 'file') {
        space = suffix;
        spec = argument.slice(0, slash);
      }
    }
    const entry: NameEntry = { filename: spec, space, stat: null, matched: [] };
    if ((this.opts & (OPT_MOUNTS | OPT_ISMOUNTPOINT)) !== 0 && space !== 'file') {
      this.usage('You can only use files with mountpoint options');
    }
    if (space === 'tcp' || space === 'udp') {
      entry.filename = `${spec}/${space}`;
      this.parseInet(entry, space);
    } else if (this.parseFile(entry) === 0) {
      if ((this.opts & OPT_MOUNTS) !== 0) this.parseMounts(entry);
      else this.parseUnixSockets(entry);
    }
    this.names.push(entry);
  }

  private expandPath(path: string): string | null {
    if (path === '') return null;
    let current = path;
    let destination: string[];
    if (!path.startsWith('/')) destination = this.host.currentDirectory().split('/').filter((part) => part !== '');
    else destination = [];
    let budget = 40;
    let remaining = current;
    for (;;) {
      const trimmed = remaining.replace(/^\/+/, '');
      if (trimmed === '') break;
      const slash = trimmed.indexOf('/');
      const part = slash < 0 ? trimmed : trimmed.slice(0, slash);
      remaining = slash < 0 ? '' : trimmed.slice(slash);
      if (part === '.') continue;
      if (part === '..') {
        destination.pop();
        continue;
      }
      destination.push(part);
      if (budget-- < 0) return null;
      const link = this.host.readLink(`/${destination.join('/')}`);
      if (isFailure(link)) {
        budget = 40;
        if (link.errno === 'EINVAL') continue;
        return null;
      }
      if (link.startsWith('/')) destination = [];
      else destination.pop();
      remaining = `${link}${remaining}`;
    }
    current = `/${destination.join('/')}`;
    return current;
  }

  private parseFile(entry: NameEntry): number {
    const expanded = this.expandPath(entry.filename);
    if (expanded !== null) entry.filename = expanded;
    const result = this.host.stat(entry.filename);
    if (isFailure(result)) {
      if (result.errno === 'ENOENT') this.out.eprintf(`Specified filename ${entry.filename} does not exist.\n`);
      else this.out.eprintf(`Cannot stat ${entry.filename}: ${strerror(result.errno)}\n`);
      return -1;
    }
    entry.stat = result;
    this.inodes.push({ name: entry, device: result.device, inode: result.inode });
    return 0;
  }

  private parseUnixSockets(entry: NameEntry): void {
    const stat = entry.stat;
    if (stat === null) return;
    for (const socket of this.unixSockets) {
      if (socket.device === stat.device && socket.inode === stat.inode) {
        this.inodes.push({ name: entry, device: this.netDevice, inode: socket.netInode });
        return;
      }
    }
  }

  private parseMounts(entry: NameEntry): void {
    const stat = entry.stat;
    if (stat === null) return;
    this.devices.push({ name: entry, device: stat.kind === 'block' ? stat.rdev : stat.device });
  }

  private resolvePort(text: string, space: 'tcp' | 'udp'): number | null {
    if (/^[0-9]+$/.test(text)) return Number(BigInt(text) & BigInt(PORT_MASK));
    return this.host.lookupService(text, space);
  }

  private parseInet(entry: NameEntry, space: 'tcp' | 'udp'): void {
    const hostSpec = entry.filename.slice(0, entry.filename.indexOf('/'));
    let localText: string | null;
    let remoteHost: string | null = null;
    let remotePort: string | null = null;
    const comma = hostSpec.indexOf(',');
    if (comma < 0) localText = hostSpec;
    else {
      localText = comma === 0 ? null : hostSpec.slice(0, comma);
      const afterFirst = hostSpec.slice(comma + 1);
      if (afterFirst !== '') {
        const second = afterFirst.indexOf(',');
        if (second < 0) remoteHost = afterFirst;
        else {
          remoteHost = second === 0 ? null : afterFirst.slice(0, second);
          const afterSecond = afterFirst.slice(second + 1);
          if (afterSecond !== '') remotePort = afterSecond;
        }
      }
    }
    let localPort = 0;
    if (localText !== null) {
      const resolved = this.resolvePort(localText, space);
      if (resolved === null) {
        this.out.eprintf(`Cannot resolve local port ${localText}: Servname not supported for ai_socktype\n`);
        return;
      }
      localPort = resolved;
    }
    const table = this.connections[space];
    if (remoteHost === null && remotePort === null) {
      table.v4.push({ name: entry, localPort, remotePort: 0, remoteAddress: null });
      table.v6.push({ name: entry, localPort, remotePort: 0, remoteAddress: null });
      return;
    }
    let port = 0;
    if (remotePort !== null) {
      const resolved = this.resolvePort(remotePort, space);
      if (resolved === null) return;
      port = resolved;
    }
    const addresses = remoteHost === null ? this.loopbackAddresses() : this.resolveRemote(remoteHost);
    if (addresses === null) return;
    for (const resolved of addresses) {
      if (this.ipv6Only && resolved.family !== 6) continue;
      if (this.ipv4Only && resolved.family !== 4) continue;
      const remote = remoteHost === null ? null : resolved.address;
      if (resolved.family === 4) table.v4.push({ name: entry, localPort, remotePort: port, remoteAddress: remote });
      else table.v6.push({ name: entry, localPort, remotePort: port, remoteAddress: remote });
    }
  }

  private loopbackAddresses(): readonly ResolvedAddress[] {
    return [{ family: 6, address: '::1' }, { family: 4, address: '127.0.0.1' }];
  }

  private resolveRemote(host: string): readonly ResolvedAddress[] | null {
    if (/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/.test(host)) {
      const octets = host.split('.').map(Number);
      return octets.every((octet) => octet <= 255) ? [{ family: 4, address: host }] : null;
    }
    if (host.includes(':')) return ipv6Bytes(host) === null ? null : [{ family: 6, address: host }];
    return this.host.lookupHost(host);
  }

  private findNetSockets(space: 'tcp' | 'udp', sixth: boolean): void {
    const content = this.host.readFile(`/proc/net/${space}${sixth ? '6' : ''}`);
    if (content === null) {
      if (!sixth) this.out.eprintf(`Cannot open protocol file "/proc/net/${space}": ${strerror('ENOENT')}\n`);
      return;
    }
    const table = sixth ? this.connections[space].v6 : this.connections[space].v4;
    const pattern = sixth
      ? /^\s*\d+:\s+[0-9a-fA-F]+:([0-9a-fA-F]+)\s+([0-9a-fA-F]{32}):([0-9a-fA-F]+)\s+\S+\s+\S+:\S+\s+\S+:\S+\s+\S+\s+\d+\s+\d+\s+(\d+)/
      : /^\s*\d+:\s+[0-9a-fA-F]+:([0-9a-fA-F]+)\s+([0-9a-fA-F]{8}):([0-9a-fA-F]+)\s+\S+\s+\S+:\S+\s+\S+:\S+\s+\S+\s+\d+\s+\d+\s+(\d+)/;
    for (const line of content.split('\n')) {
      const match = pattern.exec(line);
      if (match === null) continue;
      const localPort = Number.parseInt(match[1], 16);
      const remotePort = Number.parseInt(match[3], 16);
      const inode = Number(match[4]);
      const remoteAddress = sixth ? ipv6FromProc(match[2]) : ipv4FromProc(match[2]);
      for (const connection of table) {
        const wanted = connection.remoteAddress === null ? null
          : sixth ? ipv6Bytes(connection.remoteAddress) : connection.remoteAddress;
        if ((connection.localPort === 0 || connection.localPort === localPort)
          && (connection.remotePort === 0 || connection.remotePort === remotePort)
          && (wanted === null || wanted === remoteAddress)) {
          this.inodes.push({ name: connection.name, device: this.netDevice, inode });
        }
      }
    }
  }

  private fillUnixCache(): void {
    const content = this.host.readFile('/proc/net/unix');
    if (content === null) {
      this.out.eprintf(`Cannot open /proc/net/unix: ${strerror('ENOENT')}\n`);
      return;
    }
    for (const line of content.split('\n')) {
      const match = /^\s*[0-9a-fA-F]+:\s+[0-9a-fA-F]+\s+[0-9a-fA-F]+\s+[0-9a-fA-F]+\s+[0-9a-fA-F]+\s+-?\d+\s+(\d+)\s+(\S+)/.exec(line);
      if (match === null) continue;
      const path = match[2].startsWith('@') ? match[2].slice(1) : match[2];
      const stat = this.host.stat(path);
      if (isFailure(stat)) continue;
      this.unixSockets.unshift({ device: stat.device, inode: stat.inode, netInode: Number(match[1]) });
    }
  }

  private readMountPoints(): string[] {
    const content = this.host.readFile(PROC_MOUNTS);
    if (content === null) {
      this.out.eprintf(`Cannot open ${PROC_MOUNTS}\n`);
      return [];
    }
    const points: string[] = [];
    for (const line of content.split('\n')) {
      const first = line.indexOf(' ');
      if (first < 0) continue;
      const rest = line.slice(first + 1);
      const second = rest.indexOf(' ');
      if (second < 0) continue;
      points.unshift(rest.slice(0, second));
    }
    return points;
  }

  private checkMountPoints(): void {
    const points = this.readMountPoints();
    for (let index = 0; index < this.names.length;) {
      const name = this.names[index];
      if (name.space === 'file' && !this.isMountPoint(points, name.filename)) {
        this.out.eprintf(`Specified filename ${name.filename} is not a mountpoint.\n`);
        this.names.splice(index, 1);
      } else index++;
    }
  }

  private isMountPoint(points: readonly string[], argument: string): boolean {
    if (argument === '') return false;
    let trimmed = argument;
    while (trimmed.length > 1 && trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
    return points.includes(trimmed);
  }

  private addMatchedProcess(name: NameEntry, pid: number, uid: number, access: number): void {
    const existing = name.matched.find((candidate) => candidate.pid === pid && candidate.kind === 'normal');
    if (existing !== undefined) {
      existing.access |= access;
      return;
    }
    const stat = this.host.readFile(`/proc/${pid}/stat`);
    const comm = stat === null ? null : /^\d+ \(([^)]{0,100})/.exec(stat);
    name.matched.push({ pid, uid, access, kind: 'normal', command: comm === null ? null : printableCommand(comm[1]) });
  }

  private addSpecialProcess(name: NameEntry, kind: ProcessKind, command: string): void {
    if (name.matched.some((candidate) => candidate.kind === kind)) return;
    name.matched.unshift({ pid: 0, uid: 0, access: 0, kind, command });
  }

  private ownerOf(pid: number): number {
    const stat = this.host.stat(`/proc/${pid}`);
    return isFailure(stat) ? 0 : stat.uid;
  }

  private scanProcesses(): void {
    if (this.inodes.length === 0 && this.devices.length === 0) return;
    const entries = this.host.listDirectory('/proc');
    if (entries === null) {
      this.out.eprintf(`Cannot open /proc directory: ${strerror('ENOENT')}\n`);
      throw new ExitSignal(1);
    }
    for (const entry of entries) {
      if (!/^[0-9]/.test(entry)) continue;
      const pid = Number.parseInt(entry, 10);
      if (pid === this.host.selfPid) continue;
      const uid = this.ownerOf(pid);
      const links: ReadonlyArray<readonly [string, number]> = [['exe', ACCESS_EXE], ['root', ACCESS_ROOT], ['cwd', ACCESS_CWD]];
      for (const [link, access] of links) {
        const stat = this.host.stat(`/proc/${pid}/${link}`);
        const device = isFailure(stat) ? 0 : stat.device;
        for (const match of this.devices) if (device === match.device) this.addMatchedProcess(match.name, pid, uid, access);
        for (const match of this.inodes) {
          if (!isFailure(stat) && device === match.device && stat.inode === match.inode) this.addMatchedProcess(match.name, pid, uid, access);
        }
      }
      this.checkDescriptors(pid, uid);
    }
  }

  private checkDescriptors(pid: number, uid: number): void {
    const directory = `/proc/${pid}/fd`;
    const entries = this.host.listDirectory(directory);
    if (entries === null) return;
    for (const entry of entries) {
      if (!/^[0-9]/.test(entry)) continue;
      const path = `${directory}/${entry}`;
      const resolved = this.host.stat(path);
      if (isFailure(resolved)) {
        if (resolved.errno !== 'ENOENT' && resolved.errno !== 'ENOTDIR' && resolved.errno !== 'EACCES') {
          this.out.eprintf(`Cannot stat file ${path}: ${strerror(resolved.errno)}\n`);
        }
        continue;
      }
      let device = resolved.device;
      let inode = resolved.inode;
      if (device === this.netDevice) {
        const unix = this.unixSockets.find((socket) => socket.netInode === inode);
        if (unix !== undefined) {
          inode = unix.inode;
          device = unix.device;
        }
      }
      const writable = this.writableLink(path);
      const access = writable ? ACCESS_FILEWR | ACCESS_FILE : ACCESS_FILE;
      for (const match of this.devices) {
        if (device !== match.device) continue;
        if (match.name.stat?.kind !== 'block' && resolved.kind !== 'socket') {
          const target = this.host.readLink(path);
          const real = isFailure(target) ? path : target;
          if (!real.startsWith(match.name.filename)) continue;
        }
        this.addMatchedProcess(match.name, pid, uid, access);
      }
      for (const match of this.inodes) {
        if (device === match.device && inode === match.inode) this.addMatchedProcess(match.name, pid, uid, access);
      }
    }
  }

  private writableLink(path: string): boolean {
    const link = this.host.lstat(path);
    return !isFailure(link) && link.ownerWritable;
  }

  private scanSpecial(source: string, kind: ProcessKind, pathOf: (line: string) => string | null): void {
    if (this.inodes.length === 0 && this.devices.length === 0) return;
    const content = this.host.readFile(source);
    if (content === null) {
      if (kind === 'mount') this.out.eprintf(`Cannot open ${source}\n`);
      return;
    }
    for (const line of content.split('\n')) {
      const path = pathOf(line);
      if (path === null || path === '') continue;
      const stat = this.host.stat(path);
      if (isFailure(stat)) continue;
      for (const match of this.devices) if (stat.device === match.device) this.addSpecialProcess(match.name, kind, path);
      for (const match of this.inodes) {
        if (stat.device === match.device && stat.inode === match.inode) this.addSpecialProcess(match.name, kind, path);
      }
    }
  }

  private printMatches(): number {
    let header = false;
    let haveMatch = false;
    let haveKill = false;
    let hasProcesses = false;
    let userUid = -1;
    let userName: string | null = null;
    for (const name of this.names) {
      if ((this.opts & OPT_SILENT) !== 0) {
        if (name.matched.some((process) => process.kind === 'normal')) haveMatch = true;
      } else {
        if ((this.opts & OPT_ALLFILES) === 0) {
          hasProcesses = (this.opts & OPT_VERBOSE) !== 0
            ? name.matched.length > 0
            : name.matched.some((process) => process.kind === 'normal');
        }
        let length = 0;
        if (hasProcesses || (this.opts & OPT_ALLFILES) !== 0) {
          if (!header && (this.opts & OPT_VERBOSE) !== 0) {
            this.out.eprintf(`${' '.repeat(NAME_FIELD)} USER        PID ACCESS COMMAND\n`);
            header = true;
          }
          this.out.eprintf(`${name.filename}:`);
          length = name.filename.length + 1;
        }
        let first = true;
        for (const process of name.matched) {
          if ((this.opts & OPT_VERBOSE) === 0 && process.kind !== 'normal') continue;
          haveMatch = true;
          if ((this.opts & (OPT_VERBOSE | OPT_USER)) !== 0 && (userUid !== process.uid)) {
            userUid = process.uid;
            userName = this.host.userName(process.uid);
          }
          if (length > NAME_FIELD && (this.opts & OPT_VERBOSE) !== 0) {
            this.out.eprintf('\n');
            length = 0;
          }
          if ((this.opts & OPT_VERBOSE) !== 0 || first) {
            if (length < NAME_FIELD) this.out.eprintf(' '.repeat(NAME_FIELD - length));
            length = Math.max(length, NAME_FIELD);
          }
          if ((this.opts & OPT_VERBOSE) !== 0) this.out.eprintf(` ${(userName ?? '(unknown)').padEnd(8)} `);
          if (process.kind === 'normal') this.out.printf(` ${String(process.pid).padStart(5)}`);
          else this.out.printf('kernel');
          if ((this.opts & OPT_VERBOSE) !== 0) {
            switch (process.kind) {
              case 'knfsd': this.out.eprintf(' knfsd '); break;
              case 'mount': this.out.eprintf(' mount '); break;
              case 'swap': this.out.eprintf(' swap  '); break;
              default:
                this.out.eprintf(` ${[
                  (process.access & ACCESS_FILE) !== 0 ? ((process.access & ACCESS_FILEWR) !== 0 ? 'F' : 'f') : '.',
                  (process.access & ACCESS_ROOT) !== 0 ? 'r' : '.',
                  (process.access & ACCESS_CWD) !== 0 ? 'c' : '.',
                  (process.access & ACCESS_EXE) !== 0 ? 'e' : '.',
                  (process.access & ACCESS_MMAP) !== 0 && (process.access & ACCESS_EXE) === 0 ? 'm' : '.',
                ].join('')} `);
            }
          } else {
            if ((process.access & ACCESS_ROOT) !== 0) this.out.eprintf('r');
            if ((process.access & ACCESS_CWD) !== 0) this.out.eprintf('c');
            if ((process.access & ACCESS_EXE) !== 0) this.out.eprintf('e');
            else if ((process.access & ACCESS_MMAP) !== 0) this.out.eprintf('m');
          }
          if ((this.opts & OPT_USER) !== 0) {
            if (userName === null) this.out.eprintf(` ${'(unknown)'.padEnd(8)} `);
            else this.out.eprintf(`(${userName})`);
          }
          if ((this.opts & OPT_VERBOSE) !== 0) this.out.eprintf(`${process.command ?? '???'}\n`);
          length = 0;
          first = false;
        }
        if ((this.opts & OPT_VERBOSE) !== 0) {
          if (name.matched.length === 0 && (this.opts & OPT_ALLFILES) !== 0) this.out.eprintf('\n');
        } else if (hasProcesses || (this.opts & OPT_ALLFILES) !== 0) this.out.eprintf('\n');
      }
      if ((this.opts & OPT_KILL) !== 0 && this.killMatched(name.matched)) haveKill = true;
    }
    if ((this.opts & OPT_KILL) !== 0) return haveKill ? 0 : 1;
    return haveMatch ? 0 : 1;
  }

  private ask(pid: number): boolean {
    for (;;) {
      this.out.eprintf(`Kill process ${pid} ? (y/N) `);
      const line = this.host.readAnswer();
      if (line === null) return false;
      if (line === '') return false;
      if (/^[yY]/.test(line)) return true;
      if (/^[nN]/.test(line)) return false;
    }
  }

  private killMatched(processes: readonly MatchedProcess[]): boolean {
    let killed = false;
    for (const process of processes) {
      if (process.pid === this.host.selfPid) continue;
      if (process.kind !== 'normal') continue;
      if ((this.opts & OPT_WRITE) !== 0 && (process.access & ACCESS_FILEWR) === 0) continue;
      if ((this.opts & OPT_INTERACTIVE) !== 0 && !this.ask(process.pid)) continue;
      const failure = this.host.kill(process.pid, this.signal);
      if (failure !== null) {
        this.out.eprintf(`Could not kill process ${process.pid}: ${strerror(failure)}\n`);
        continue;
      }
      killed = true;
    }
    return killed;
  }
}

export interface FuserOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly interleaved: string;
  readonly exitCode: number;
}

export function runFuser(host: FuserHost, args: readonly string[]): FuserOutcome {
  const out = new ToolOutput();
  let exitCode: number;
  try {
    exitCode = new FuserRun(host, out).run(args);
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error;
    exitCode = error.code;
  }
  return { stdout: out.stdout, stderr: out.stderr, interleaved: out.interleaved, exitCode };
}
