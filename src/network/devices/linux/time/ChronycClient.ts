import { simulationNowMs } from '@/network/core/SystemClock';
import { isValidIPv4, tryIpToUint32 } from '../../../core/ip';
import { IPAddress } from '../../../core/types';
import type { NtpAssociation } from '../../../ntp/types';
import { CHRONYC_HELP, CHRONYC_USAGE } from './ChronycHelp';
import { printHeader, printReport, ReportTime, type ReportValue } from './ChronycFormat';
import type { ChronyViewPort } from './ChronyDaemonView';
import { NO_ELAPSED } from './ChronyDaemonView';
import { ChronyCommandClient, RemoteChronyView, statusLine, type CommandTransport, type FetchOutcome } from './ChronyRemote';
import { CMDMON_PORT, STT } from './ChronyCmdmon';
import { parseChronySource } from './ChronyConfig';
import { parseChronySubnet, formatChronySubnet } from './ChronyAccess';
import { genererCleChrony } from './ChronyKeys';
import type { LinuxChronyService } from './LinuxChronyService';
import { padToWidth } from '@/network/devices/shells/cli/TextTable';

export const CHRONYC_VERSION_LINE = 'chronyc (chrony) version 4.5 (+READLINE +SECHASH +IPV6 -DEBUG)';
const SOCKET_PATH = '/run/chrony/chronyd.sock';
const OPEN_ERROR = '506 Cannot talk to daemon';

export interface ChronycHost {
  readonly service: LinuxChronyService | null;
  readonly view: ChronyViewPort | null;
  readonly transport?: CommandTransport;
  readonly privileged: boolean;
  readonly programName: string;
  readonly localAddresses: readonly string[];
  readonly hostsFile: () => string;
  readonly wait: (seconds: number) => Promise<void>;
}

export interface ChronycResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

type StatusName = 'success' | 'failed' | 'unauthorised' | 'nosuchsource' | 'notenabled' | 'allowed' | 'denied'
| 'alreadyknown' | 'badsample' | 'nortc' | 'invalidname';

const STATUS_TEXT: Readonly<Record<Exclude<StatusName, 'success'>, string>> = {
  failed: '500 Failure',
  unauthorised: '501 Not authorised',
  nosuchsource: '503 No such source',
  notenabled: '505 Facility not enabled in daemon',
  allowed: '208 Access allowed',
  denied: '209 Access denied',
  alreadyknown: '511 Source already present',
  badsample: '516 Sample index out of range',
  nortc: '513 RTC driver not running',
  invalidname: '521 Invalid name',
};

function splitWord(line: string): [string, string] {
  const space = line.indexOf(' ');
  return space < 0 ? [line, ''] : [line.slice(0, space), line.slice(space + 1).replace(/^ +/, '')];
}

function normalizeLine(line: string): string {
  const collapsed = line.replace(/\s+/g, ' ').replace(/^ /, '').replace(/ $/, '');
  return collapsed !== '' && '!;#%'.includes(collapsed[0]) ? '' : collapsed;
}

function toTime(epochSeconds: number): ReportTime {
  return new ReportTime(epochSeconds);
}

function scanDouble(text: string): number | null {
  const match = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text);
  return match === null ? null : Number(match[0]);
}

function scanInteger(text: string): number | null {
  const match = /^\s*[+-]?\d+/.exec(text);
  return match === null ? null : Number(match[0]);
}

function logForm(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

function parseDate(text: string, nowMs: number): number | null {
  const trimmed = text.trim();
  if (trimmed === 'now') return Math.floor(nowMs / 1000);
  const today = new Date(nowMs);
  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (clock) {
    return Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(),
      Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0)) / 1000;
  }
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +(iso[6] ?? 0)) / 1000;
  const named = /^([A-Za-z]{3})[a-z]* (\d{1,2}),? (\d{4}) (\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
  if (named) {
    const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(named[1].toLowerCase());
    if (month >= 0) return Date.UTC(+named[3], month, +named[2], +named[4], +named[5], +(named[6] ?? 0)) / 1000;
  }
  return null;
}

class Streams {
  stdout = '';
  stderr = '';
  out(text: string): void { this.stdout += text; }
  err(text: string): void { this.stderr += `${text}\n`; }
}

export class ChronycSession {
  private readonly io = new Streams();
  private csv = false;
  private endDot = false;
  private noDns = false;
  private sourceNames = false;
  private quit = false;
  private commandPort = CMDMON_PORT;
  private remoteViews: RemoteChronyView[] = [];
  private remoteIndex = 0;
  private remoteDenied = false;
  private remoteTimeoutMs = 1000;
  private remoteRetries = 2;

  constructor(private readonly host: ChronycHost) {}

  async run(argv: readonly string[], stdin?: string): Promise<ChronycResult> {
    const parsed = this.parseOptions(argv);
    if (typeof parsed === 'number') return this.finish(parsed);
    const { rest, multi, target } = parsed;
    if (target !== null && !this.isUnixTarget(target)) {
      if (!this.connectRemote(target)) {
        this.io.out(`${OPEN_ERROR}\n`);
        return this.finish(1);
      }
    }
    let ok = 1;
    if (rest.length > 0) {
      if (multi) {
        for (const word of rest) {
          ok = (await this.processLine(word)) ? 1 : 0;
          if (!ok || this.quit) break;
        }
      } else {
        ok = (await this.processLine(rest.join(' '))) ? 1 : 0;
      }
    } else if (stdin !== undefined) {
      for (const line of stdin.split('\n')) {
        if (this.quit) break;
        ok = (await this.processLine(line)) ? 1 : 0;
      }
    }
    return this.finish(ok ? 0 : 1);
  }

  private finish(exitCode: number): ChronycResult {
    return { stdout: this.io.stdout, stderr: this.io.stderr, exitCode };
  }

  private isUnixTarget(target: string): boolean {
    return target.split(',').every((entry) => entry === SOCKET_PATH);
  }

  private connectRemote(target: string): boolean {
    const transport = this.host.transport;
    if (transport === undefined) return false;
    this.remoteViews = [];
    for (const entry of target.split(',')) {
      const address = this.resolveAddress(entry);
      if (address === null) continue;
      const client = new ChronyCommandClient(transport, address, this.commandPort, this.host.wait);
      this.remoteViews.push(new RemoteChronyView(client));
    }
    return this.remoteViews.length > 0;
  }

  private get remote(): RemoteChronyView | null {
    return this.remoteViews.length === 0 ? null : this.remoteViews[Math.min(this.remoteIndex, this.remoteViews.length - 1)];
  }

  private parseOptions(argv: readonly string[]):
    { rest: string[]; multi: boolean; target: string | null } | number {
    for (const word of argv) {
      if (word === '--help') { this.printUsage(); return 0; }
      if (word === '--version') { this.io.out(`${CHRONYC_VERSION_LINE}\n`); return 0; }
    }
    let multi = false;
    let target: string | null = null;
    let index = 0;
    this.commandPort = CMDMON_PORT;
    while (index < argv.length && argv[index].length > 1 && argv[index][0] === '-') {
      const cluster = argv[index];
      index++;
      for (let position = 1; position < cluster.length; position++) {
        const flag = cluster[position];
        if ('46acdef:h:mnNp:v'.includes(flag) && flag !== ':') {
          const takesArgument = 'fhp'.includes(flag);
          if (takesArgument) {
            let value = cluster.slice(position + 1);
            if (value === '') {
              if (index >= argv.length) {
                this.io.err(`${this.host.programName}: option requires an argument -- '${flag}'`);
                this.printUsage();
                return 1;
              }
              value = argv[index++];
            }
            if (flag === 'h') target = value;
            if (flag === 'p') this.commandPort = Number.parseInt(value, 10) || CMDMON_PORT;
            break;
          }
          if (flag === 'c') this.csv = true;
          else if (flag === 'e') this.endDot = true;
          else if (flag === 'm') multi = true;
          else if (flag === 'n') this.noDns = true;
          else if (flag === 'N') this.sourceNames = true;
          else if (flag === 'v') { this.io.out(`${CHRONYC_VERSION_LINE}\n`); return 0; }
        } else {
          this.io.err(`${this.host.programName}: invalid option -- '${flag}'`);
          this.printUsage();
          return 1;
        }
      }
    }
    return { rest: argv.slice(index) as string[], multi, target };
  }

  private printUsage(): void {
    this.io.out(`${CHRONYC_USAGE.map((line) => line.replace('%PROGRAM%', this.host.programName)).join('\n')}\n`);
  }

  private resolveAddress(word: string): string | null {
    if (isValidIPv4(word)) return word;
    if (word === 'localhost') return '127.0.0.1';
    for (const line of this.host.hostsFile().split('\n')) {
      const fields = line.replace(/#.*$/, '').trim().split(/\s+/);
      if (fields.length > 1 && isValidIPv4(fields[0]) && fields.slice(1).includes(word)) return fields[0];
    }
    return null;
  }

  private reverseName(ip: string): string {
    if (this.noDns || this.csv) return ip;
    for (const line of this.host.hostsFile().split('\n')) {
      const fields = line.replace(/#.*$/, '').trim().split(/\s+/);
      if (fields.length > 1 && fields[0] === ip) return fields[1];
    }
    return ip;
  }

  private formatName(ip: string, truncate: number, source: boolean): string {
    let name = source && this.sourceNames ? ip : this.reverseName(ip);
    if (truncate > 0 && name.length > truncate) name = `${name.slice(0, truncate - 1)}>`;
    return name;
  }

  private report(template: string, values: readonly ReportValue[]): void {
    this.io.out(printReport(template, values, this.csv));
  }

  private header(text: string): void {
    this.io.out(printHeader(text, this.csv));
  }

  private status(name: StatusName, verbose: boolean): boolean {
    if (name === 'success') {
      if (verbose) this.io.out('200 OK\n');
      return true;
    }
    this.io.out(`${STATUS_TEXT[name]}\n`);
    return name === 'allowed' || name === 'denied';
  }

  private unavailable(): boolean {
    this.io.out(`${OPEN_ERROR}\n`);
    return false;
  }

  private authorised(open: boolean): boolean {
    if (open || (this.host.privileged && this.remote === null)) return true;
    if (this.remote !== null) {
      this.remoteDenied = true;
      return false;
    }
    this.io.out('501 Not authorised\n');
    return false;
  }

  private async processLine(rawLine: string): Promise<boolean> {
    const line = normalizeLine(rawLine);
    if (line === '') return true;
    const [command, rest] = splitWord(line);
    let result: boolean;
    const service = this.host.service;
    const view = this.host.view;
    const local = ['help', 'exit', 'quit', 'keygen', 'dns', 'timeout', 'retries', 'authhash', 'password'];
    if (this.remote !== null && !local.includes(command)) {
      result = await this.processRemote(command, rest);
    } else if (!local.includes(command) && (service === null || view === null || !service.isRunning())) {
      if (!this.knownCommands().has(command)) {
        this.io.err('Unrecognized command');
        result = false;
      } else {
        result = this.unavailable();
      }
    } else {
      if (!local.includes(command)) service!.countCommandPacket();
      result = await this.dispatch(command, rest, service!, view!);
    }
    if (this.endDot) this.io.out('.\n');
    return result;
  }

  private async remoteFetch(command: string, line: string): Promise<FetchOutcome> {
    for (; this.remoteIndex < this.remoteViews.length; this.remoteIndex++) {
      const view = this.remoteViews[this.remoteIndex];
      view.configure(this.remoteTimeoutMs, this.remoteRetries);
      const outcome = await view.fetch(command, line);
      if (outcome.ok || outcome.text !== null) return outcome;
    }
    this.remoteIndex = 0;
    return { ok: false, text: null };
  }

  private async freshTracking(): Promise<boolean> {
    if (this.remote === null) return true;
    const outcome = await this.remoteFetch('tracking', '');
    if (outcome.ok) return true;
    this.io.out(`${outcome.text ?? OPEN_ERROR}\n`);
    return false;
  }

  private async processRemote(command: string, rest: string): Promise<boolean> {
    if (!this.knownCommands().has(command)) {
      this.io.err('Unrecognized command');
      return false;
    }
    const remote = this.remote!;
    const stub = null as unknown as LinuxChronyService;
    const fetched = command === 'manual' ? (rest.startsWith('list') ? 'manual' : null)
      : ['tracking', 'sources', 'sourcestats', 'activity', 'smoothing', 'rtcdata', 'sourcename'].includes(command) ? command : null;
    if (fetched !== null) {
      const address = command === 'sourcename' ? this.resolveAddress(rest) : '';
      if (address !== null) {
        const outcome = await this.remoteFetch(fetched, command === 'sourcename' ? address : rest);
        if (!outcome.ok) {
          this.io.out(`${outcome.text ?? OPEN_ERROR}\n`);
          return false;
        }
      }
      return this.dispatch(command, rest, stub, remote);
    }
    if (['selectdata', 'authdata'].includes(command) || (command === 'ntpdata' && rest === '')) {
      const outcome = await this.remoteFetch('count', '');
      if (!outcome.ok) {
        this.io.out(`${outcome.text ?? OPEN_ERROR}\n`);
        return false;
      }
    }
    this.remoteDenied = false;
    let result = await this.dispatch(command, rest, stub, remote);
    if (this.remoteDenied) {
      this.remoteDenied = false;
      const denial = await this.remoteDenial(command, rest);
      if (denial === null) this.io.out(`${OPEN_ERROR}\n`);
      else if (denial !== STT.SUCCESS) this.io.out(`${statusLine(denial)}\n`);
      result = denial === STT.SUCCESS;
    }
    return result;
  }

  private async remoteDenial(command: string, line: string): Promise<number | null> {
    for (; this.remoteIndex < this.remoteViews.length; this.remoteIndex++) {
      const view = this.remoteViews[this.remoteIndex];
      view.configure(this.remoteTimeoutMs, this.remoteRetries);
      const denial = await view.denied(command, line);
      if (denial !== null) return denial.status;
    }
    this.remoteIndex = 0;
    return null;
  }

  private knownCommands(): Set<string> {
    return new Set([
      'accheck', 'activity', 'add', 'allow', 'authdata', 'burst', 'clients', 'cmdaccheck', 'cmdallow', 'cmddeny',
      'cyclelogs', 'delete', 'deny', 'dump', 'local', 'makestep', 'manual', 'maxdelay', 'maxdelaydevratio',
      'maxdelayratio', 'maxpoll', 'maxupdateskew', 'minpoll', 'minstratum', 'ntpdata', 'offline', 'online',
      'onoffline', 'polltarget', 'refresh', 'rekey', 'reload', 'reselect', 'reselectdist', 'reset', 'rtcdata',
      'selectdata', 'selectopts', 'serverstats', 'settime', 'shutdown', 'smoothing', 'smoothtime', 'sourcename',
      'sources', 'sourcestats', 'tracking', 'trimrtc', 'waitsync', 'writertc',
    ]);
  }

  private async dispatch(command: string, line: string, service: LinuxChronyService, view: ChronyViewPort): Promise<boolean> {
    switch (command) {
      case 'accheck': return this.accessCheck(line, service, 'ntp');
      case 'cmdaccheck': return this.accessCheck(line, service, 'cmd');
      case 'activity': return this.activity(view);
      case 'add': return this.addSource(line, service);
      case 'allow': return this.allowDeny(line, service, 'allow');
      case 'deny': return this.allowDeny(line, service, 'deny');
      case 'cmdallow': return this.allowDeny(line, service, 'cmdallow');
      case 'cmddeny': return this.allowDeny(line, service, 'cmddeny');
      case 'authdata': return this.authData(line, view);
      case 'burst': return this.burst(line, view);
      case 'clients': return this.clients(line, view);
      case 'dump': return this.dump(service);
      case 'cyclelogs':
      case 'refresh': return this.privilegedOk();
      case 'delete': return this.deleteSource(line, service);
      case 'dns': return this.dns(line);
      case 'exit':
      case 'quit': this.quit = true; return true;
      case 'help': this.io.out(`${CHRONYC_HELP.join('\n')}\n`); return true;
      case 'keygen': return this.keygen(line);
      case 'local': return this.local(line, service);
      case 'makestep': return this.makestep(line, service);
      case 'manual': return this.manual(line, service);
      case 'maxdelay': return this.sourceValue(line, view, 'double', (a, v) => view.setCriteria(a, { maxDelayMs: v * 1000 }));
      case 'maxdelayratio': return this.sourceValue(line, view, 'double', (a, v) => view.setCriteria(a, { maxDelayRatio: v }));
      case 'maxdelaydevratio': return this.sourceValue(line, view, 'double', (a, v) => view.setCriteria(a, { maxDelayDevRatio: v }));
      case 'minstratum': return this.sourceValue(line, view, 'integer', (a, v) => view.setCriteria(a, { minStratum: v }));
      case 'polltarget': return this.sourceValue(line, view, 'integer', (a, v) => view.setCriteria(a, { pollTarget: v }));
      case 'minpoll': return this.sourceValue(line, view, 'integer', (a, v) => view.setCriteria(a, v >= -6 && v <= 24 ? { minpoll: v } : {}));
      case 'maxpoll': return this.sourceValue(line, view, 'integer', (a, v) => view.setCriteria(a, v >= -6 && v <= 24 ? { maxpoll: v } : {}));
      case 'maxupdateskew': return this.maxUpdateSkew(line, view);
      case 'ntpdata': return this.ntpData(line, view);
      case 'offline': return this.connectivity(line, view, false);
      case 'online': return this.connectivity(line, view, true);
      case 'onoffline': return this.onOffline(view);
      case 'rekey': return this.rekey(service);
      case 'reload': return this.reload(line);
      case 'reselect': return this.reselect(view);
      case 'reselectdist': return this.reselectDistance(line, view);
      case 'reset': return this.resetSources(line, view);
      case 'retries': return this.retries(line);
      case 'rtcdata': return this.status('nortc', false);
      case 'trimrtc':
      case 'writertc': return this.authorised(false) && this.status('nortc', false);
      case 'selectdata': return this.selectData(line, view);
      case 'selectopts': return this.selectOptions(line, view);
      case 'serverstats': return this.serverStats(view);
      case 'settime': return this.setTime(line, service);
      case 'shutdown': return this.shutdown(service);
      case 'smoothing': return this.smoothing(view);
      case 'smoothtime': return this.smoothTime(line, view);
      case 'sourcename': return this.sourceName(line, view);
      case 'sources': return this.sources(line, view);
      case 'sourcestats': return this.sourcestats(line, view);
      case 'timeout': return this.timeout(line);
      case 'tracking': return this.tracking(view);
      case 'waitsync': return this.waitSync(line, view);
      case 'authhash':
      case 'password': this.io.err('Authentication is no longer supported'); return true;
      default:
        this.io.err('Unrecognized command');
        return false;
    }
  }

  private privilegedOk(): boolean {
    return this.authorised(false) && this.status('success', true);
  }

  private parseSourcesOptions(line: string): { all: boolean; verbose: boolean } {
    let all = false;
    let verbose = false;
    for (const word of line.split(' ')) {
      if (word === '-a') all = true;
      else if (word === '-v') verbose = !this.csv;
    }
    return { all, verbose };
  }

  private readMaskAddress(line: string): { mask: number | null; address: string | null } | null {
    if (line === '') return { mask: null, address: null };
    const slash = line.indexOf('/');
    if (slash < 0) {
      const address = this.resolveAddress(line);
      if (address === null) {
        this.io.err('Could not get address for hostname');
        return null;
      }
      return { mask: 0xffffffff, address };
    }
    const first = line.slice(0, slash);
    const second = line.slice(slash + 1);
    if (isValidIPv4(first)) {
      if (isValidIPv4(second)) return { mask: tryIpToUint32(first), address: second };
      const bits = scanInteger(second);
      if (bits !== null) {
        const prefix = Math.max(0, Math.min(32, bits));
        return { mask: prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0, address: first };
      }
    }
    this.io.err('Invalid syntax for mask/address');
    return null;
  }

  private connectivity(line: string, view: ChronyViewPort, online: boolean): boolean {
    const target = this.readMaskAddress(line);
    if (target === null) return false;
    if (!this.authorised(false)) return false;
    const matches = view.matching(target.address, target.mask);
    if (matches.length === 0) return this.status('nosuchsource', true);
    for (const a of matches) view.setOnline(a, online);
    return this.status('success', true);
  }

  private onOffline(view: ChronyViewPort): boolean {
    if (!this.authorised(false)) return false;
    for (const a of view.matching(null, null)) view.setOnline(a, true);
    return this.status('success', true);
  }

  private burst(line: string, view: ChronyViewPort): boolean {
    const [first, remainder] = splitWord(line);
    const match = /^(-?\d+)\/(-?\d+)/.exec(first);
    if (match === null) {
      this.io.err('Invalid syntax for burst command');
      return false;
    }
    const target = remainder === '' ? { mask: null, address: null } : this.readMaskAddress(splitWord(remainder)[0]);
    if (target === null) return false;
    if (!this.authorised(false)) return false;
    const matches = view.matching(target.address, target.mask);
    if (matches.length === 0) return this.status('nosuchsource', true);
    for (const a of matches) view.startBurst(a, Number(match[1]), Number(match[2]));
    return this.status('success', true);
  }

  private sourceValue(
    line: string, view: ChronyViewPort, kind: 'double' | 'integer',
    apply: (association: NtpAssociation, value: number) => void,
  ): boolean {
    const [hostname, rest] = splitWord(line);
    const value = kind === 'double' ? scanDouble(rest) : scanInteger(rest);
    if (value === null) {
      this.io.err('Invalid syntax for address value');
      return false;
    }
    const address = this.resolveAddress(hostname);
    if (address === null) {
      this.io.err('Could not get address for hostname');
      return false;
    }
    if (!this.authorised(false)) return false;
    const association = view.findSource(address);
    if (association === undefined) return this.status('nosuchsource', true);
    apply(association, value);
    return this.status('success', true);
  }

  private accessCheck(line: string, service: LinuxChronyService, table: 'ntp' | 'cmd'): boolean {
    const address = this.resolveAddress(line);
    if (address === null) {
      this.io.err('Could not read address');
      return false;
    }
    if (!this.authorised(false)) return false;
    const parsed = new IPAddress(address);
    const allowed = table === 'ntp' ? service.isNtpClientAllowed(parsed) : service.isCommandClientAllowed(parsed);
    return this.status(allowed ? 'allowed' : 'denied', true);
  }

  private allowDeny(line: string, service: LinuxChronyService, kind: 'allow' | 'deny' | 'cmdallow' | 'cmddeny'): boolean {
    const [first, afterFirst] = splitWord(line);
    const all = first === 'all';
    const [net, extra] = all ? splitWord(afterFirst) : [first, afterFirst];
    const subnet = extra === '' ? parseChronySubnet(net) : null;
    if (subnet === null) {
      this.io.err('Could not read address');
      return false;
    }
    if (!this.authorised(false)) return false;
    service.applyAccess(kind, subnet, all);
    return this.status('success', true);
  }

  private addSource(line: string, service: LinuxChronyService): boolean {
    const [kindWord, rest] = splitWord(line);
    const kind = kindWord.toLowerCase();
    if (kind !== 'server' && kind !== 'peer' && kind !== 'pool') {
      this.io.err('Invalid syntax for add command');
      return false;
    }
    const words = rest === '' ? [] : rest.split(' ');
    const source = parseChronySource(kind, words);
    if (source === null) {
      this.io.err('Invalid syntax for add command');
      return false;
    }
    const address = this.resolveAddress(source.hote);
    if (address === null) {
      this.io.err('Invalid host/IP address');
      return false;
    }
    if (!this.authorised(false)) return false;
    const result = service.addSource(kind, address, words.slice(1));
    if (result.ok === false) {
      return result.status === 'already' ? this.status('alreadyknown', true) : this.fail(result.status);
    }
    return this.status('success', true);
  }

  private fail(message: string): boolean {
    this.io.err(message);
    return false;
  }

  private deleteSource(line: string, service: LinuxChronyService): boolean {
    const [hostname] = splitWord(line);
    if (hostname === '') {
      this.io.err('Invalid syntax for address');
      return false;
    }
    const address = this.resolveAddress(hostname);
    if (address === null) {
      this.io.err('Could not get address for hostname');
      return false;
    }
    if (!this.authorised(false)) return false;
    return service.removeSource(address) ? this.status('success', true) : this.status('nosuchsource', true);
  }

  private dns(line: string): boolean {
    if (line === '-n') this.noDns = true;
    else if (line === '+n') this.noDns = false;
    else if (line === '-46' || line === '-4' || line === '-6') return true;
    else {
      this.io.err('Unrecognized dns command');
      return false;
    }
    return true;
  }

  private keygen(line: string): boolean {
    const [idWord, afterId] = splitWord(line);
    const [typeWord, afterType] = splitWord(afterId);
    const id = idWord === '' ? undefined : Number(idWord);
    const bits = afterType === '' ? undefined : Number(afterType);
    const result = genererCleChrony(id, typeWord === '' ? undefined : typeWord, bits);
    if (result.ok === true) {
      this.io.out(`${result.ligne}\n`);
      return true;
    }
    return this.fail(result.erreur);
  }

  private maxUpdateSkew(line: string, view: ChronyViewPort): boolean {
    const value = scanDouble(line);
    if (value === null) return false;
    if (!this.authorised(false)) return false;
    view.setMaxUpdateSkew(value);
    return this.status('success', true);
  }

  private reselectDistance(line: string, view: ChronyViewPort): boolean {
    const value = scanDouble(line);
    if (value === null) return false;
    if (!this.authorised(false)) return false;
    view.setReselectDistance(value);
    return this.status('success', true);
  }

  private local(line: string, service: LinuxChronyService): boolean {
    if (line === 'off') {
      if (!this.authorised(false)) return false;
      service.setLocal('off');
      return this.status('success', true);
    }
    let stratum = 10;
    let distance = 1.0;
    let orphan = false;
    const words = line === '' ? [] : line.split(' ');
    for (let i = 0; i < words.length; i++) {
      const word = words[i].toLowerCase();
      if (word === 'stratum') {
        const value = /^[+-]?\d+/.test(words[i + 1] ?? '') ? Number(words[i + 1]) : NaN;
        if (Number.isNaN(value) || value >= 16 || value <= 0) return this.fail('Invalid syntax for local command');
        stratum = value;
        i++;
      } else if (word === 'orphan') {
        orphan = true;
      } else if (word === 'distance') {
        const value = scanDouble(words[i + 1] ?? '');
        if (value === null) return this.fail('Invalid syntax for local command');
        distance = value;
        i++;
      } else {
        return this.fail('Invalid syntax for local command');
      }
    }
    if (!this.authorised(false)) return false;
    service.setLocal({ stratum, distance, orphan });
    return this.status('success', true);
  }

  private makestep(line: string, service: LinuxChronyService): boolean {
    if (line !== '') {
      const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s+([+-]?\d+)/.exec(line);
      if (match === null) return this.fail('Bad syntax for makestep command');
      if (!this.authorised(false)) return false;
      service.setMakestep(Number(match[1]), Number(match[2]));
      return this.status('success', true);
    }
    if (!this.authorised(false)) return false;
    return this.status(service.makestep().ok === true ? 'success' : 'failed', true);
  }

  private manual(line: string, service: LinuxChronyService): boolean {
    const [word] = splitWord(line);
    if (line.startsWith('list')) return this.manualList(service);
    if (line.startsWith('delete')) {
      const index = scanInteger(splitWord(line)[1]);
      if (index === null) return this.fail('Bad syntax for manual delete command');
      if (!this.authorised(false)) return false;
      return service.deleteManualSample(index) ? this.status('success', true) : this.status('badsample', true);
    }
    if (word !== 'on' && word !== 'off' && word !== 'reset') return this.fail('Invalid syntax for manual command');
    if (!this.authorised(false)) return false;
    if (word === 'reset') service.resetManual();
    else service.setManual(word === 'on');
    return this.status('success', true);
  }

  private manualList(service: LinuxChronyService): boolean {
    const samples = this.remote !== null ? this.remote.manualSamples : service.getManualSamples();
    if (!this.csv) this.io.out(`210 n_samples = ${samples.length}\n`);
    this.header('#    Date     Time(UTC)    Slewed   Original   Residual');
    samples.forEach((sample, index) => {
      this.report('%2d %s %10.2f %10.2f %10.2f\n', [index, logForm(sample.atMs / 1000), sample.slewed, sample.original, sample.residual]);
    });
    return true;
  }

  private dump(service: LinuxChronyService): boolean {
    if (!this.authorised(false)) return false;
    service.dumpAuthData();
    return this.status('success', true);
  }

  private rekey(service: LinuxChronyService): boolean {
    if (!this.authorised(false)) return false;
    service.reloadKeys();
    return this.status('success', true);
  }

  private reload(line: string): boolean {
    if (line !== 'sources') return this.fail('Invalid syntax for reload command');
    return this.privilegedOk();
  }

  private reselect(view: ChronyViewPort): boolean {
    if (!this.authorised(false)) return false;
    view.reselect();
    return this.status('success', true);
  }

  private resetSources(line: string, view: ChronyViewPort): boolean {
    if (line !== 'sources') return this.fail('Invalid syntax for reset command');
    if (!this.authorised(false)) return false;
    view.resetSources();
    return this.status('success', true);
  }

  private retries(line: string): boolean {
    const value = Number.parseInt(line, 10) || 0;
    if (value < 0 || value > 30) return this.fail('Invalid maximum number of retries');
    this.remoteRetries = value;
    return true;
  }

  private timeout(line: string): boolean {
    const value = Number.parseInt(line, 10) || 0;
    if (value < 100) return this.fail(`Timeout ${value} is too short`);
    this.remoteTimeoutMs = value;
    return true;
  }

  private shutdown(service: LinuxChronyService): boolean {
    if (!this.authorised(false)) return false;
    service.stop();
    return this.status('success', true);
  }

  private smoothTime(line: string, view: ChronyViewPort): boolean {
    if (line !== 'reset' && line !== 'activate') return this.fail('Invalid syntax for smoothtime command');
    if (!this.authorised(false)) return false;
    if (!view.smoothTime(line)) {
      this.status('notenabled', false);
      return false;
    }
    return this.status('success', true);
  }

  private smoothing(view: ChronyViewPort): boolean {
    const report = view.smoothingReport();
    if (report === null) {
      this.status('notenabled', false);
      return false;
    }
    this.report(
      'Active         : %B %s\nOffset         : %+.9f seconds\nFrequency      : %+.6f ppm\n'
      + 'Wander         : %+.6f ppm per second\nLast update    : %.1f seconds ago\nRemaining time : %.1f seconds\n',
      [report.active ? 1 : 0, report.leapOnly ? '(leap second only)' : '', report.offset, report.frequencyPpm,
        report.wanderPpm, report.lastUpdateAgo, report.remainingTime]);
    return true;
  }

  private setTime(line: string, service: LinuxChronyService): boolean {
    const target = parseDate(line, simulationNowMs());
    if (target === null) {
      this.io.out('510 - Could not parse date string\n');
      return false;
    }
    if (!this.authorised(false)) return false;
    const result = service.settime(target * 1000);
    if (result.ok === false) {
      this.io.out(`${result.status}\n`);
      return false;
    }
    this.io.out('200 OK\n');
    this.io.out(`Clock was ${(-result.deltaMs / 1000).toFixed(2)} seconds fast.  Frequency change = 0.00ppm, new frequency = 0.00ppm\n`);
    return true;
  }

  private sourceName(line: string, view: ChronyViewPort): boolean {
    const address = this.resolveAddress(line);
    if (address === null) return this.fail('Could not read address');
    if (view.findSource(address) === undefined) {
      this.status('nosuchsource', false);
      return false;
    }
    this.report('%s\n', [address]);
    return true;
  }

  private activity(view: ChronyViewPort): boolean {
    const report = view.activity();
    if (!this.csv) this.io.out('200 OK\n');
    this.report(
      '%U sources online\n%U sources offline\n%U sources doing burst (return to online)\n'
      + '%U sources doing burst (return to offline)\n%U sources with unknown address\n',
      [report.online, report.offline, report.burstOnline, report.burstOffline, report.unresolved]);
    return true;
  }

  private sources(line: string, view: ChronyViewPort): boolean {
    const { verbose } = this.parseSourcesOptions(line);
    if (verbose) {
      this.io.out('\n');
      this.io.out("  .-- Source mode  '^' = server, '=' = peer, '#' = local clock.\n");
      this.io.out(" / .- Source state '*' = current best, '+' = combined, '-' = not combined,\n");
      this.io.out("| /             'x' = may be in error, '~' = too variable, '?' = unusable.\n");
      this.io.out('||                                                 .- xxxx [ yyyy ] +/- zzzz\n');
      this.io.out('||      Reachability register (octal) -.           |  xxxx = adjusted offset,\n');
      this.io.out('||      Log2(Polling interval) --.      |          |  yyyy = measured offset,\n');
      this.io.out('||                                \\     |          |  zzzz = estimated error.\n');
      this.io.out('||                                 |    |           \\\n');
    }
    this.header('MS Name/IP address         Stratum Poll Reach LastRx Last sample               ');
    const stateChars = { selected: '*', nonselectable: '?', falseticker: 'x', jittery: '~', unselected: '+', selectable: '-' };
    for (const source of view.sources()) {
      this.report('%c%c %-27s  %2d  %2d   %3o  %I  %+S[%+S] +/- %S\n', [
        source.mode === 'peer' ? '=' : '^', stateChars[source.state], this.formatName(source.ip, 25, true),
        source.stratum, source.poll, source.reachability, source.sinceSample,
        source.latestMeasurement, source.originalLatestMeasurement, source.latestMeasurementError,
      ]);
    }
    return true;
  }

  private sourcestats(line: string, view: ChronyViewPort): boolean {
    const { verbose } = this.parseSourcesOptions(line);
    if (verbose) {
      this.io.out('                             .- Number of sample points in measurement set.\n');
      this.io.out('                            /    .- Number of residual runs with same sign.\n');
      this.io.out('                           |    /    .- Length of measurement set (time).\n');
      this.io.out('                           |   |    /      .- Est. clock freq error (ppm).\n');
      this.io.out('                           |   |   |      /           .- Est. error in freq.\n');
      this.io.out('                           |   |   |     |           /         .- Est. offset.\n');
      this.io.out('                           |   |   |     |          |          |   On the -.\n');
      this.io.out('                           |   |   |     |          |          |   samples. \\\n');
      this.io.out('                           |   |   |     |          |          |             |\n');
    }
    this.header('Name/IP Address            NP  NR  Span  Frequency  Freq Skew  Offset  Std Dev');
    for (const row of view.sourcestats()) {
      this.report('%-25s %3U %3U  %I %+P %P  %+S  %S\n', [
        this.formatName(row.ip, 25, true), row.samples, row.runs, row.spanSeconds,
        row.residualFrequencyPpm, row.skewPpm, row.estimatedOffset, row.standardDeviation,
      ]);
    }
    return true;
  }

  private tracking(view: ChronyViewPort): boolean {
    const t = view.tracking();
    this.report(
      'Reference ID    : %R (%s)\nStratum         : %u\nRef time (UTC)  : %T\nSystem time     : %.9O of NTP time\n'
      + 'Last offset     : %+.9f seconds\nRMS offset      : %.9f seconds\nFrequency       : %.3F\n'
      + 'Residual freq   : %+.3f ppm\nSkew            : %.3f ppm\nRoot delay      : %.9f seconds\n'
      + 'Root dispersion : %.9f seconds\nUpdate interval : %.1f seconds\nLeap status     : %L\n',
      [
        t.referenceId, t.referenceName, t.stratum, new ReportTime(t.referenceTime, t.referenceTimeNanoseconds), t.currentCorrection, t.lastOffset,
        t.rmsOffset, t.frequencyPpm, t.residualFrequencyPpm, t.skewPpm, t.rootDelay, t.rootDispersion,
        t.updateInterval, t.leap,
      ]);
    return true;
  }

  private selectData(line: string, view: ChronyViewPort): boolean {
    const { verbose } = this.parseSourcesOptions(line);
    if (verbose) {
      this.io.out('  . State: N - noselect, s - unsynchronised, M - missing samples,\n');
      this.io.out(' /         d/D - large distance, ~ - jittery, w/W - waits for others,\n');
      this.io.out('|          S - stale, O - orphan, T - not trusted, P - not preferred,\n');
      this.io.out('|          U - waits for update,, x - falseticker, + - combined, * - best.\n');
      this.io.out('|   Effective options   ---------.  (N - noselect, P - prefer\n');
      this.io.out('|   Configured options  ----.     \\  T - trust, R - require)\n');
      this.io.out('|   Auth. enabled (Y/N) -.   \\     \\     Offset interval --.\n');
      this.io.out('|                        |    |     |                       |\n');
    }
    this.header('S Name/IP Address        Auth COpts EOpts Last Score     Interval  Leap');
    const rows = view.selectData();
    if (rows.length > 0 && !this.authorised(false)) return false;
    for (const row of rows) {
      this.report('%c %-25s %c %c%c%c%c%c %c%c%c%c%c %I %5.1f %+S %+S  %1L\n', [
        row.stateChar, this.formatName(row.ip, 25, true), row.authenticated ? 'Y' : 'N',
        ...row.configuredOptions.split(''), ...row.effectiveOptions.split(''),
        row.lastSampleAgo, row.score, row.low, row.high, row.leap,
      ]);
    }
    return true;
  }

  private authData(line: string, view: ChronyViewPort): boolean {
    const { verbose } = this.parseSourcesOptions(line);
    if (verbose) {
      this.io.out('                             .- Auth. mechanism (NTS, SK - symmetric key)\n');
      this.io.out('                            |   Key length -.  Cookie length (bytes) -.\n');
      this.io.out('                            |       (bits)  |  Num. of cookies --.    |\n');
      this.io.out('                            |               |  Key est. attempts  |   |\n');
      this.io.out('                            |               |           |         |   |\n');
    }
    this.header('Name/IP address             Mode KeyID Type KLen Last Atmp  NAK Cook CLen');
    const rows = view.authData();
    if (rows.length > 0 && !this.authorised(false)) return false;
    for (const row of rows) {
      this.report('%-27s %4s %5U %4d %4d %I %4d %4d %4d %4d\n', [
        this.formatName(row.ip, 25, true), row.mode, row.keyId, row.keyType, row.keyLength, row.lastKeAgo, row.keAttempts,
        row.nak, row.cookies, row.cookieLength,
      ]);
    }
    return true;
  }

  private ntpData(line: string, view: ChronyViewPort): boolean {
    let targets: NtpAssociation[];
    const specified = line !== '';
    if (specified) {
      const address = this.resolveAddress(line);
      if (address === null) return this.fail('Could not get address for hostname');
      if (!this.authorised(false)) return false;
      const found = view.findSource(address);
      if (found === undefined) return this.status('nosuchsource', false);
      targets = [found];
    } else {
      targets = view.matching(null, null);
      if (targets.length > 0 && !this.authorised(false)) return false;
    }
    for (const a of targets) {
      const d = view.ntpData(a);
      if (!specified && !this.csv) this.io.out('\n');
      this.report(
        'Remote address  : %s (%R)\nRemote port     : %u\nLocal address   : %s (%R)\nLeap status     : %L\n'
        + 'Version         : %u\nMode            : %M\nStratum         : %u\nPoll interval   : %d (%.0f seconds)\n'
        + 'Precision       : %d (%.9f seconds)\nRoot delay      : %.6f seconds\nRoot dispersion : %.6f seconds\n'
        + 'Reference ID    : %R (%s)\nReference time  : %T\nOffset          : %+.9f seconds\n'
        + 'Peer delay      : %.9f seconds\nPeer dispersion : %.9f seconds\nResponse time   : %.9f seconds\n'
        + 'Jitter asymmetry: %+.2f\nNTP tests       : %.3b %.3b %.4b\nInterleaved     : %B\nAuthenticated   : %B\n'
        + 'TX timestamping : %N\nRX timestamping : %N\nTotal TX        : %U\nTotal RX        : %U\n'
        + 'Total valid RX  : %U\nTotal good RX   : %U\n',
        [
          d.remoteIp, tryIpToUint32(d.remoteIp) ?? 0, d.remotePort, d.localIp,
          tryIpToUint32(d.localIp) ?? 0, d.leap, d.version, d.mode, d.stratum, d.poll, 2 ** d.poll,
          d.precision, 2 ** d.precision, d.rootDelay, d.rootDispersion, d.referenceId, d.referenceName,
          toTime(d.referenceTime), d.offset, d.peerDelay, d.peerDispersion, d.responseTime, d.jitterAsymmetry,
          d.tests >> 7, d.tests >> 4, d.tests, d.interleaved ? 1 : 0, d.authenticated ? 1 : 0,
          d.transmitSource, d.receiveSource, d.totalTransmitted, d.totalReceived, d.totalValid, d.totalGood,
        ]);
    }
    return true;
  }

  private selectOptions(line: string, view: ChronyViewPort): boolean {
    const [source, rest] = splitWord(line);
    const address = isValidIPv4(source) ? source : null;
    if (address === null && !/^\S{1,4}$/.test(source)) return this.fail('Invalid syntax for selectopts command');
    const flags: Partial<Record<'noselect' | 'prefer' | 'require' | 'trust', boolean>> = {};
    for (const word of rest === '' ? [] : rest.split(' ')) {
      const option = word.slice(1).toLowerCase();
      if ((word[0] !== '+' && word[0] !== '-') || !['noselect', 'prefer', 'require', 'trust'].includes(option)) {
        return this.fail('Invalid syntax for selectopts command');
      }
      flags[option as 'noselect'] = word[0] === '+';
    }
    if (!this.authorised(false)) return false;
    const association = address === null ? undefined : view.findSource(address);
    if (association === undefined) return this.status('nosuchsource', true);
    view.setCriteria(association, flags);
    return this.status('success', true);
  }

  private serverStats(view: ChronyViewPort): boolean {
    if (!this.authorised(false)) return false;
    this.report(
      'NTP packets received       : %Q\nNTP packets dropped        : %Q\nCommand packets received   : %Q\n'
      + 'Command packets dropped    : %Q\nClient log records dropped : %Q\nNTS-KE connections accepted: %Q\n'
      + 'NTS-KE connections dropped : %Q\nAuthenticated NTP packets  : %Q\nInterleaved NTP packets    : %Q\n'
      + 'NTP timestamps held        : %Q\nNTP timestamp span         : %Q\nNTP daemon RX timestamps   : %Q\n'
      + 'NTP daemon TX timestamps   : %Q\nNTP kernel RX timestamps   : %Q\nNTP kernel TX timestamps   : %Q\n'
      + 'NTP hardware RX timestamps : %Q\nNTP hardware TX timestamps : %Q\n',
      view.serverStats().values);
    return true;
  }

  private clients(line: string, view: ChronyViewPort): boolean {
    let minimumHits = 0;
    let keyEstablishment = false;
    let reset = false;
    const words = line === '' ? [] : line.split(' ');
    for (let i = 0; i < words.length; i++) {
      if (words[i] === '-k') keyEstablishment = true;
      else if (words[i] === '-r') reset = true;
      else if (words[i] === '-p') {
        const value = /^\d+$/.test(words[i + 1] ?? '') ? Number(words[i + 1]) : null;
        if (value === null) return this.fail('Invalid syntax for clients command');
        minimumHits = value;
        i++;
      }
    }
    this.header(`Hostname                      NTP   Drop Int IntL Last  ${padToWidth(keyEstablishment ? 'NTS-KE' : 'Cmd', 6, 'right')}   Drop Int  Last`);
    if (!this.authorised(false)) return false;
    for (const client of view.clients(minimumHits)) {
      this.report('%-25s  %6U  %5U  %C  %C  %I  %6U  %5U  %C  %I\n', [
        this.formatName(client.ip, 25, false), client.ntpHits, client.ntpDrops, client.ntpInterval,
        client.ntpLimitedInterval, client.lastNtpAgo, keyEstablishment ? client.keHits : 0,
        keyEstablishment ? client.keDrops : 0, keyEstablishment ? client.keInterval : 127,
        keyEstablishment ? client.keLastAgo : NO_ELAPSED,
      ]);
    }
    if (reset) view.clearClients();
    return true;
  }

  private async waitSync(line: string, view: ChronyViewPort): Promise<boolean> {
    const numbers = line.split(' ').filter((word) => word !== '');
    const maxTries = Number.parseInt(numbers[0] ?? '', 10) || 0;
    const maxCorrection = Number.parseFloat(numbers[1] ?? '') || 0;
    const maxSkew = Number.parseFloat(numbers[2] ?? '') || 0;
    const interval = Math.max(0.1, Number.parseFloat(numbers[3] ?? '') || 10);
    for (let attempt = 1; ; attempt++) {
      if (!(await this.freshTracking())) return false;
      const t = view.tracking();
      const correction = Math.abs(t.currentCorrection);
      this.report('try: %d, refid: %R, correction: %.9f, skew: %.3f\n', [attempt, t.referenceId, correction, t.skewPpm]);
      const synchronised = t.referenceId !== 0 && t.referenceId !== 0x7f7f0101;
      if (synchronised && (maxCorrection === 0 || correction <= maxCorrection) && (maxSkew === 0 || t.skewPpm <= maxSkew)) return true;
      if (maxTries !== 0 && attempt >= maxTries) return false;
      await this.host.wait(interval);
    }
  }
}

export function describeSubnet(text: string): string {
  const parsed = parseChronySubnet(text);
  return parsed === null ? '' : formatChronySubnet(parsed);
}
