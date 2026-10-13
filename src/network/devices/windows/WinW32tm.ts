import { simulationNowMs } from '@/network/core/SystemClock';
import { isValidIPv4, tryIpToUint32 } from '../../core/ip';
import type { NtpAgent } from '../../ntp/NtpAgent';
import type { NtpAssociation } from '../../ntp/types';
import {
  W32TIME_PARAMETERS_KEY, W32TIME_CONFIG_KEY, W32TIME_NTP_CLIENT_KEY, W32TIME_NTP_SERVER_KEY, W32TIME_KEY,
} from './W32TimeRegistry';
import type { W32TimeService, W32Peer } from './W32TimeService';

export interface W32tmContext {
  readonly service: W32TimeService;
  readonly agent: NtpAgent;
  readonly hostname: string;
  readonly timezone: string;
  readonly isAdministrator: boolean;
  readonly serviceRunning: boolean;
  readonly resolve: (name: string) => string | null;
  readonly wait: (seconds: number) => Promise<void>;
  readonly monitorTargets: (domain: string | undefined, computers: readonly string[]) => Array<{ readonly name: string; readonly address: string; readonly pdc: boolean }>;
  readonly remote: (computer: string, line: string) => { readonly ok: boolean; readonly output?: string; readonly error?: string };
  readonly timeZone: () => { readonly standardName: string; readonly daylightName: string; readonly standardBias: number; readonly daylightBias: number; readonly state: 'STANDARD' | 'DAYLIGHT' | 'UNUSED' };
  readonly register: () => void;
  readonly unregister: () => void;
}

const HELP = [
  'w32tm [/? | /register | /unregister ]',
  '      /query [/computer:<target>] {/source | /configuration | /peers | /status} [/verbose]',
  '      /config [/computer:<target>] [/update] [/manualpeerlist:<peers>]',
  '              [/syncfromflags:<source>] [/reliable:(YES|NO)] [/LocalClockDispersion:<seconds>]',
  '      /resync [/computer:<target>] [/nowait] [/rediscover] [/soft] [/force]',
  '      /stripchart /computer:<target> [/period:<refresh>] [/dataonly] [/samples:<count>]',
  '      /monitor [/domain:<domain>] [/computers:<name>[,<name>...]]',
  '      /dumpreg [/subkey:<key>] [/computer:<target>]',
].join('\n');

const COMPLETED = 'The command completed successfully.';
const ACCESS_DENIED = 'The following error occurred: Access is denied. (0x80070005)';
const NOT_STARTED = 'The following error occurred: The service has not been started. (0x80070426)';
const RPC_UNAVAILABLE = 'The following error occurred: The RPC server is unavailable. (0x800706BA)';
const STRIPCHART_WIDTH = 28;
const STRIPCHART_SECONDS_PER_CELL = 0.1;

function localDateTime(ms: number, timezone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true,
    }).formatToParts(new Date(ms));
  } catch {
    return localDateTime(ms, 'UTC');
  }
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('month')}/${get('day')}/${get('year')} ${get('hour')}:${get('minute')}:${get('second')} ${get('dayPeriod')}`;
}

function clockTime(ms: number, timezone: string): string {
  const full = localDateTime(ms, timezone);
  const [, time, period] = full.split(' ');
  const [hour, minute, second] = time.split(':').map(Number);
  const hour24 = (hour % 12) + (period === 'PM' ? 12 : 0);
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${two(hour24)}:${two(minute)}:${two(second)}`;
}

function seconds7(value: number): string {
  return `${value.toFixed(7)}s`;
}

function signedSeconds7(value: number): string {
  const sign = value < 0 || Object.is(value, -0) ? '-' : '+';
  const [whole, fraction] = Math.abs(value).toFixed(7).split('.');
  return `${sign}${whole.padStart(2, '0')}.${fraction}s`;
}

function pollText(seconds: number): string {
  return `${Math.round(Math.log2(Math.max(1, seconds)))} (${Math.round(seconds)}s)`;
}

function stratumText(stratum: number): string {
  if (stratum === 0 || stratum >= 16) return `${stratum >= 16 ? 0 : stratum} (unspecified)`;
  if (stratum === 1) return '1 (primary reference - syncd by radio clock)';
  return `${stratum} (secondary reference - syncd by (S)NTP)`;
}

function referenceIdText(reference: string): string {
  if (!reference || reference === '.INIT.') return '0x00000000 (unspecified)';
  if (isValidIPv4(reference)) {
    const hex = (tryIpToUint32(reference) ?? 0).toString(16).toUpperCase().padStart(8, '0');
    return `0x${hex} (source IP:  ${reference})`;
  }
  const hex = Array.from(reference.padEnd(4, '\0').slice(0, 4)).map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
  return `0x${hex} (source name:  ${reference})`;
}

interface Parsed {
  readonly command: string;
  readonly switches: Map<string, string>;
  readonly positional: string[];
}

function mergeQuoted(args: readonly string[]): string[] {
  const out: string[] = [];
  let pending: string | null = null;
  for (const arg of args) {
    if (pending !== null) {
      pending += ` ${arg}`;
      if ((pending.match(/"/g) ?? []).length % 2 === 0) { out.push(pending); pending = null; }
      continue;
    }
    if ((arg.match(/"/g) ?? []).length % 2 === 1) pending = arg;
    else out.push(arg);
  }
  if (pending !== null) out.push(pending);
  return out;
}

function parse(args: readonly string[]): Parsed {
  const merged = mergeQuoted(args);
  const switches = new Map<string, string>();
  const positional: string[] = [];
  let command = '';
  for (const token of merged) {
    if (!token.startsWith('/')) { positional.push(token); continue; }
    const colon = token.indexOf(':');
    const name = (colon < 0 ? token.slice(1) : token.slice(1, colon)).toLowerCase();
    const value = colon < 0 ? '' : token.slice(colon + 1).replace(/^"|"$/g, '');
    if (command === '' && ['query', 'config', 'resync', 'stripchart', 'monitor', 'dumpreg', 'ntte', 'ntpte', 'tz', 'register', 'unregister'].includes(name)) command = name;
    else switches.set(name, value);
  }
  return { command, switches, positional };
}

function isLocalTarget(target: string | undefined, context: W32tmContext): boolean {
  if (target === undefined || target === '') return true;
  const lower = target.toLowerCase();
  return lower === context.hostname.toLowerCase() || lower === 'localhost' || lower === '127.0.0.1' || lower === '.';
}

function leapText(leap: number): string {
  return ['0(no warning)', '1(last minute has 61 seconds)', '2(last minute has 59 seconds)', '3(not synchronized)'][leap] ?? `${leap}`;
}

function peerForAssociation(service: W32TimeService, association: NtpAssociation): W32Peer | undefined {
  return service.getPeers().find((peer) => peer.address === association.serverIp);
}

function statusLines(context: W32tmContext, verbose: boolean): string {
  const { agent, service } = context;
  const config = agent.getConfig();
  const synced = agent.isSynced() && service.currentPeer() !== undefined;
  const local = agent.isSynced() && !synced;
  const system = config.system;
  const peer = service.currentPeer();
  const association = peer?.address ? agent.getAssociation(peer.address) : undefined;
  const stratum = synced || local ? agent.getStratum() : 0;
  const pollSeconds = association?.pollSec ?? 2 ** service.registry.readNumber(W32TIME_CONFIG_KEY, 'MaxPollInterval', 10);
  const lines = [
    `Leap Indicator: ${leapText(synced || local ? system.leap : 3)}`,
    `Stratum: ${stratumText(stratum)}`,
    'Precision: -23 (119.209ns per tick)',
    `Root Delay: ${seconds7(synced ? system.rootDelayMs / 1000 : 0)}`,
    `Root Dispersion: ${seconds7(synced ? agent.getRootDispersionMs() / 1000 : 0)}`,
    `ReferenceId: ${synced || local ? referenceIdText(config.refIdentifier) : '0x00000000 (unspecified)'}`,
    `Last Successful Sync Time: ${config.lastSyncMs ? localDateTime(config.lastSyncMs, context.timezone) : 'unspecified'}`,
    `Source: ${service.sourceText()}`,
    `Poll Interval: ${pollText(pollSeconds)}`,
  ];
  if (!verbose) return lines.join('\n');
  const offset = association !== undefined && synced ? association.offsetMs / 1000 : 0;
  const decision = agent.getEtatHorloge().etat;
  const machine = decision === 'SYNC' ? '2 (Sync)' : decision === 'SPIK' ? '3 (Spike)' : '0 (Unset)';
  return [
    ...lines,
    '',
    `Phase Offset: ${offset.toFixed(7)}s`,
    'ClockRate: 0.0156250s',
    `State Machine: ${machine}`,
    `Time Source Flags: ${peer?.origin === 'domain' ? '1 (Authenticated)' : '0 (None)'}`,
    'Server Role: 0 (None)',
    'Last Sync Error: 0 (The command completed successfully.)',
    `Time since Last Good Sync Time: ${config.lastSyncMs ? seconds7((simulationNowMs() - config.lastSyncMs) / 1000) : 'unspecified'}`,
  ].join('\n');
}

function peersLines(context: W32tmContext, verbose: boolean): string {
  const { agent, service } = context;
  const peers = service.getPeers();
  if (peers.length === 0) return '#Peers: 0';
  const now = simulationNowMs();
  const blocks = peers.map((peer) => {
    const association = peer.address ? agent.getAssociation(peer.address) : undefined;
    const active = association !== undefined && association.reach !== 0;
    const remaining = association !== undefined ? Math.max(0, (association.nextdateMs - now) / 1000) : 0;
    const lines = [
      `Peer: ${peer.text}`,
      `State: ${active ? 'Active' : 'Pending'}`,
      `Time Remaining: ${seconds7(remaining)}`,
      `Mode: ${peer.mode === 'peer' ? '1 (Symmetric Active)' : '3 (Client)'}`,
      `Stratum: ${active ? stratumText(association!.stratum) : '0 (unspecified)'}`,
      `PeerPoll Interval: ${pollText(2 ** (association?.ppoll ?? 6))}`,
      `HostPoll Interval: ${pollText(association?.pollSec ?? 64)}`,
    ];
    return lines.join('\n');
  });
  void verbose;
  return [`#Peers: ${peers.length}`, '', ...blocks.flatMap((block, index) => (index === 0 ? [block] : ['', block]))].join('\n');
}

const CONFIG_ROWS: ReadonlyArray<readonly [name: string, fallback: number]> = [
  ['EventLogFlags', 2], ['AnnounceFlags', 10], ['TimeJumpAuditOffset', 28800], ['MinPollInterval', 6],
  ['MaxPollInterval', 10], ['MaxNegPhaseCorrection', 54000], ['MaxPosPhaseCorrection', 54000],
  ['MaxAllowedPhaseOffset', 1],
];
const CONFIG_ROWS_MORE: ReadonlyArray<readonly [name: string, fallback: number]> = [
  ['FrequencyCorrectRate', 4], ['PollAdjustFactor', 5], ['LargePhaseOffset', 50000000], ['SpikeWatchPeriod', 90],
  ['LocalClockDispersion', 10], ['HoldPeriod', 5], ['PhaseCorrectRate', 1], ['UpdateInterval', 100],
];
const CLIENT_ROWS: readonly string[] = [
  'DllName', 'Enabled', 'InputProvider', 'AllowNonstandardModeCombinations', 'ResolvePeerBackoffMinutes',
  'ResolvePeerBackoffMaxTimes', 'CompatibilityFlags', 'EventLogFlags', 'LargeSampleSkew', 'SpecialPollInterval',
];
const SERVER_ROWS: readonly string[] = ['DllName', 'Enabled', 'InputProvider', 'AllowNonstandardModeCombinations'];

function configurationLines(context: W32tmContext): string {
  const registry = context.service.registry;
  const row = (key: string, name: string): string => {
    const { value, origin } = registry.readEffective(key, name);
    const shown = name === 'DllName' && typeof value === 'string' ? value.replace('%systemroot%', 'C:\\Windows') : value;
    return `${name}: ${shown ?? ''} (${origin})`;
  };
  const configRow = (name: string): string => row(W32TIME_CONFIG_KEY, name);
  return [
    '[Configuration]',
    '',
    ...CONFIG_ROWS.map(([name]) => configRow(name)),
    '',
    ...CONFIG_ROWS_MORE.map(([name]) => configRow(name)),
    '',
    '',
    '[TimeProviders]',
    '',
    'NtpClient (Local)',
    ...CLIENT_ROWS.map((name) => row(W32TIME_NTP_CLIENT_KEY, name)),
    row(W32TIME_PARAMETERS_KEY, 'Type'),
    row(W32TIME_PARAMETERS_KEY, 'NtpServer'),
    '',
    'NtpServer (Local)',
    ...SERVER_ROWS.map((name) => row(W32TIME_NTP_SERVER_KEY, name)),
  ].join('\n');
}

function query(parsed: Parsed, context: W32tmContext): string {
  if (!isLocalTarget(parsed.switches.get('computer'), context)) return RPC_UNAVAILABLE;
  if (!context.serviceRunning) return NOT_STARTED;
  const verbose = parsed.switches.has('verbose');
  if (parsed.switches.has('source')) return context.service.sourceText();
  if (parsed.switches.has('configuration')) return configurationLines(context);
  if (parsed.switches.has('peers')) return peersLines(context, verbose);
  if (parsed.switches.has('status')) return statusLines(context, verbose);
  return HELP;
}

function config(parsed: Parsed, context: W32tmContext): string {
  if (!isLocalTarget(parsed.switches.get('computer'), context)) return RPC_UNAVAILABLE;
  if (!context.isAdministrator) return ACCESS_DENIED;
  const switches = new Map<string, string>();
  const known = new Set(['computer', 'update', 'manualpeerlist', 'syncfromflags', 'reliable']);
  for (const [name, value] of parsed.switches) if (!known.has(name)) switches.set(name, value);
  const result = context.service.configure({
    manualPeerList: parsed.switches.get('manualpeerlist'),
    syncFromFlags: parsed.switches.get('syncfromflags'),
    reliable: parsed.switches.get('reliable'),
    switches,
    update: parsed.switches.has('update'),
  });
  return result.ok ? COMPLETED : result.message;
}

function resync(parsed: Parsed, context: W32tmContext): string {
  const target = parsed.switches.get('computer');
  if (!isLocalTarget(target, context)) return RPC_UNAVAILABLE;
  if (!context.isAdministrator) return ACCESS_DENIED;
  const header = target === undefined ? 'Sending resync command to local computer' : `Sending resync command to ${target}`;
  const result = context.service.resync({ force: parsed.switches.has('force'), rediscover: parsed.switches.has('rediscover') });
  return result.ok ? `${header}\n${COMPLETED}` : `${header}\n${result.message}`;
}

function chart(offsetSeconds: number): string {
  const cells = Math.round(offsetSeconds / STRIPCHART_SECONDS_PER_CELL);
  const position = Math.max(-STRIPCHART_WIDTH, Math.min(STRIPCHART_WIDTH - 1, cells));
  const left = Array.from({ length: STRIPCHART_WIDTH }, () => ' ');
  const right = Array.from({ length: STRIPCHART_WIDTH }, () => ' ');
  if (position < 0) left[STRIPCHART_WIDTH + position] = '*';
  else right[position] = '*';
  return `[${left.join('')}|${right.join('')}]`;
}

async function stripchart(parsed: Parsed, context: W32tmContext): Promise<string> {
  const target = parsed.switches.get('computer');
  if (target === undefined || target === '') return 'The parameter is incorrect.';
  if (parsed.switches.has('packetinfo')) return 'The following option is not supported by this simulator: /packetinfo';
  const address = isValidIPv4(target) ? target : context.resolve(target);
  const samplesText = parsed.switches.get('samples');
  const samples = samplesText === undefined ? 5 : Number.parseInt(samplesText, 10);
  if (!Number.isFinite(samples) || samples < 1) return 'The parameter is incorrect.';
  const lines = [`Tracking ${target} [${address ?? target}:123].`];
  if (samplesText !== undefined) lines.push(`Collecting ${samples} samples.`);
  lines.push(`The current time is ${localDateTime(simulationNowMs(), context.timezone)}.`);
  const dataOnly = parsed.switches.has('dataonly');
  const agent = context.agent;
  const existing = address !== null && agent.getAssociation(address) !== undefined;
  let seen = existing ? agent.getAssociation(address!)!.received : 0;
  if (address !== null && !existing) agent.addServer(address);
  const period = Math.max(1, Number.parseFloat(parsed.switches.get('period') ?? '2') || 2);
  for (let i = 0; i < samples; i++) {
    if (i > 0) await context.wait(period);
    const time = clockTime(simulationNowMs(), context.timezone);
    let association = address === null ? undefined : agent.getAssociation(address);
    if (address !== null && (association?.received ?? 0) === seen) {
      agent.pollAll();
      association = agent.getAssociation(address);
    }
    if (association === undefined || association.received === seen || association.response === null) {
      lines.push(`${time}, error: 0x800705B4`);
      continue;
    }
    seen = association.received;
    const delay = association.response.delayMs / 1000;
    const offset = association.response.offsetMs / 1000;
    const text = `${time}, d:${signedSeconds7(delay)} o:${signedSeconds7(offset)}`;
    lines.push(dataOnly ? text : `${text}  ${chart(offset)}`);
  }
  if (address !== null && !existing) agent.removeServer(address);
  return lines.join('\n');
}

function monitor(parsed: Parsed, context: W32tmContext): string {
  const computers = (parsed.switches.get('computers') ?? '').split(',').map((name) => name.trim()).filter(Boolean);
  const targets = context.monitorTargets(parsed.switches.get('domain'), computers);
  if (targets.length === 0) return RPC_UNAVAILABLE;
  const lines: string[] = [];
  for (const target of targets) {
    lines.push(`${target.name}${target.pdc ? ' *** PDC ***' : ''}[${target.address}:123]:`);
    const sample = measure(context.agent, target.address);
    if (sample === null) {
      lines.push('    ICMP: error 0x800705B4 - This operation returned because the timeout period expired.');
      lines.push('    NTP: error 0x800705B4 - This operation returned because the timeout period expired.');
      continue;
    }
    lines.push(`    ICMP: ${Math.max(0, Math.round(sample.delayMs))}ms delay`);
    lines.push(`    NTP: ${sample.offsetMs >= 0 ? '+' : '-'}${Math.abs(sample.offsetMs / 1000).toFixed(7)}s offset from ${target.name}`);
    lines.push(`        RefID: ${monitorReference(sample.refId)}`);
    lines.push(`        Stratum: ${sample.stratum}`);
  }
  return lines.join('\n');
}

function monitorReference(refId: string): string {
  if (isValidIPv4(refId)) return `${refId} [0x${(tryIpToUint32(refId) ?? 0).toString(16).toUpperCase().padStart(8, '0')}]`;
  const hex = Array.from(refId.padEnd(4, '\0').slice(0, 4)).map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
  return `'${refId}' [0x${hex}]`;
}

interface Measurement {
  readonly offsetMs: number;
  readonly delayMs: number;
  readonly stratum: number;
  readonly refId: string;
}

function measure(agent: NtpAgent, address: string): Measurement | null {
  const existing = agent.getAssociation(address) !== undefined;
  const seen = existing ? agent.getAssociation(address)!.received : 0;
  if (!existing) agent.addServer(address);
  let association = agent.getAssociation(address);
  if (association !== undefined && association.received === seen) {
    agent.pollAll();
    association = agent.getAssociation(address);
  }
  const result: Measurement | null = association !== undefined && association.received > seen && association.response !== null
    ? { offsetMs: association.response.offsetMs, delayMs: association.response.delayMs, stratum: association.stratum, refId: association.refId }
    : null;
  if (!existing) agent.removeServer(address);
  return result;
}

const NT_EPOCH_SHIFT_MS = Date.UTC(1601, 0, 1);
const NTP_EPOCH_SHIFT_MS = Date.UTC(1900, 0, 1);

function convertEpoch(raw: string | undefined, originMs: number, perSecond: bigint, context: W32tmContext): string {
  if (raw === undefined || !/^\d+$/.test(raw)) return HELP;
  const units = BigInt(raw);
  const seconds = units / perSecond;
  const fraction = ((units % perSecond) * 10_000_000n) / perSecond;
  const days = seconds / 86_400n;
  const rest = Number(seconds % 86_400n);
  const two = (n: number): string => String(n).padStart(2, '0');
  const time = `${two(Math.floor(rest / 3600))}:${two(Math.floor((rest % 3600) / 60))}:${two(rest % 60)}.${String(fraction).padStart(7, '0')}`;
  return `${days} ${time} - ${localDateTime(originMs + Number(seconds) * 1000, context.timezone)}`;
}

function timeZoneLines(context: W32tmContext): string {
  const zone = context.timeZone();
  const bias = (minutes: number): string => `${minutes}min`;
  return [
    `Time zone: Current:TIME_ZONE_ID_${zone.state} Bias: ${bias(zone.state === 'DAYLIGHT' ? zone.daylightBias : zone.standardBias)} (UTC=LocalTime+Bias)`,
    `  [Standard Name:"${zone.standardName}" Bias:${bias(zone.standardBias)} Date:(unspecified)]`,
    `  [Daylight Name:"${zone.daylightName}" Bias:${bias(zone.daylightBias)} Date:(unspecified)]`,
  ].join('\n');
}

function registerService(context: W32tmContext): string {
  if (!context.isAdministrator) return ACCESS_DENIED;
  context.register();
  return 'W32Time successfully registered.';
}

function unregisterService(context: W32tmContext): string {
  if (!context.isAdministrator) return ACCESS_DENIED;
  context.unregister();
  return 'W32Time successfully unregistered.';
}

const TYPE_NAMES: Readonly<Record<string, string>> = { String: 'REG_SZ', ExpandString: 'REG_EXPAND_SZ', DWord: 'REG_DWORD' };

function dumpReg(parsed: Parsed, context: W32tmContext): string {
  if (!isLocalTarget(parsed.switches.get('computer'), context)) return RPC_UNAVAILABLE;
  if (!context.isAdministrator) return ACCESS_DENIED;
  const subkey = parsed.switches.get('subkey') ?? 'Parameters';
  const key = `${W32TIME_KEY}\\${subkey}`;
  const entries = context.service.registry.entries(key);
  if (entries.length === 0) return `The following error occurred: The system cannot find the file specified. (0x80070002)`;
  const lines = ['Value Name                Value Type          Value Data', '-'.repeat(56)];
  for (const [name, value] of entries) {
    const numeric = typeof value === 'number';
    const type = numeric ? 'REG_DWORD' : TYPE_NAMES.String;
    const data = numeric ? `0x${value.toString(16).padStart(8, '0')} (${value})` : String(value);
    lines.push(`${name.padEnd(26)}${type.padEnd(20)}${data}`);
  }
  return lines.join('\n');
}

function remoteTarget(parsed: Parsed, context: W32tmContext): string | undefined {
  const target = parsed.switches.get('computer');
  return parsed.command !== 'stripchart' && parsed.command !== 'monitor' && target !== undefined && !isLocalTarget(target, context)
    ? target : undefined;
}

function runRemote(args: readonly string[], target: string, context: W32tmContext): string {
  const forwarded = mergeQuoted(args).filter((token) => !token.toLowerCase().startsWith('/computer:'));
  const result = context.remote(target, `w32tm ${forwarded.join(' ')}`);
  if (result.ok) return result.output ?? '';
  const error = result.error ?? '';
  if (/could not be resolved/i.test(error)) return 'The following error occurred: No such host is known. (0x80072AF9)';
  if (/denied/i.test(error)) return ACCESS_DENIED;
  return RPC_UNAVAILABLE;
}

export async function runW32tm(args: readonly string[], context: W32tmContext): Promise<string> {
  const parsed = parse(args);
  const target = remoteTarget(parsed, context);
  if (target !== undefined) return runRemote(args, target, context);
  switch (parsed.command) {
    case 'query': return query(parsed, context);
    case 'config': return config(parsed, context);
    case 'resync': return resync(parsed, context);
    case 'stripchart': return await stripchart(parsed, context);
    case 'monitor': return monitor(parsed, context);
    case 'dumpreg': return dumpReg(parsed, context);
    case 'ntte': return convertEpoch(parsed.positional[0], NT_EPOCH_SHIFT_MS, 10_000_000n, context);
    case 'ntpte': return convertEpoch(parsed.positional[0], NTP_EPOCH_SHIFT_MS, 4_294_967_296n, context);
    case 'tz': return timeZoneLines(context);
    case 'register': return registerService(context);
    case 'unregister': return unregisterService(context);
    default: return HELP;
  }
}
