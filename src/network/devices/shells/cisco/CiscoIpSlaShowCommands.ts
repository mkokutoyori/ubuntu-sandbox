import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type { IpSlaEngine, SlaOperationRuntime } from '../../../ipsla/IpSlaEngine';
import { RETURN_CODE_LABEL, type SlaOperationType } from '../../../ipsla/types';
import type { SlaReaction } from '../../../ipsla/reactions';
import { averageJitter, averageOneWay, averageRtt, packetLossPercent } from '../../../ipsla/statistics';

export interface IpSlaShowContext {
  r(): Router;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatIosTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
    + ` UTC ${DAY_NAMES[date.getUTCDay()]} ${MONTH_NAMES[date.getUTCMonth()]}`
    + ` ${date.getUTCDate()} ${date.getUTCFullYear()}`;
}

export function formatElapsed(millis: number): string {
  const seconds = Math.floor(millis / 1000);
  if (seconds < 1) return 'never';
  if (seconds === 1) return '1 second ago';
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

function thresholdTypeLabel(reaction: SlaReaction): string {
  switch (reaction.thresholdType) {
    case 'consecutive': return `Consecutive (${reaction.consecutiveCount})`;
    case 'xOfy': return `XofY (${reaction.xOfyX} of ${reaction.xOfyY})`;
    case 'average': return `Average (${reaction.averageCount})`;
    case 'immediate': return 'Immediate';
    default: return 'Never';
  }
}

function displayType(type: SlaOperationType): string {
  return type === 'unknown' ? 'not configured' : type;
}

function scheduleStatus(runtime: SlaOperationRuntime): string {
  switch (runtime.state) {
    case 'active': return 'Active';
    case 'inactive': return 'Inactive';
    default: return 'Pending';
  }
}

function lifeText(runtime: SlaOperationRuntime, nowMs: number): string {
  const life = runtime.config.schedule.lifeSeconds;
  if (life === 'forever') return 'Forever';
  if (runtime.state !== 'active' || runtime.lifeEndsAtMs === null) return `${life}`;
  return `${Math.max(0, Math.ceil((runtime.lifeEndsAtMs - nowMs) / 1000))} sec`;
}

function renderConfiguration(runtime: SlaOperationRuntime): string[] {
  const config = runtime.config;
  const lines: string[] = [];
  lines.push(`Entry number: ${config.id}`);
  lines.push(`Owner: ${config.owner ?? ''}`);
  lines.push(`Tag: ${config.tag ?? ''}`);
  lines.push(`Operation timeout (milliseconds): ${config.timeoutMs}`);
  lines.push(`Type of operation to perform: ${displayType(config.type)}`);
  if (config.type === 'http') {
    lines.push(`Target address/Source address: ${config.target ?? ''}/${config.sourceIp ?? '0.0.0.0'}`);
    lines.push(`URL: ${config.http.url ?? ''}`);
    lines.push(`HTTP Operation: ${config.http.mode}`);
    lines.push(`HTTP Version: ${config.http.version}`);
  } else if (config.type === 'dns') {
    lines.push(`Target Address: ${config.dns.name ?? ''}`);
    lines.push(`Name Server: ${config.dns.nameServer ?? ''}`);
  } else {
    // `2001:db8::2/0.0.0.0` paired an IPv6 target with the IPv4 "unset"
    // literal — the unset source of an IPv6 operation is `::`.
    const unset = config.target && config.target.includes(':') ? '::' : '0.0.0.0';
    lines.push(`Target address/Source address: ${config.target ?? unset}/${config.sourceIp ?? unset}`);
  }
  if (config.targetPort !== null) {
    lines.push(`Target port/Source port: ${config.targetPort}/${config.sourcePort ?? 0}`);
  }
  if (config.type === 'udp-jitter' || config.type === 'icmp-jitter') {
    lines.push(`Number of packets: ${config.numPackets}`);
    lines.push(`Packet Interval (milliseconds): ${config.intervalMs}`);
    if (config.codec) {
      lines.push(`Codec Type: ${config.codec}`);
      lines.push(`Advantage Factor: ${config.advantageFactor}`);
    }
  }
  if (config.type === 'udp-echo' || config.type === 'udp-jitter') {
    lines.push(`Control Packets: ${config.controlEnabled ? 'enabled' : 'disabled'}`);
  }
  lines.push(`Type Of Service parameter: 0x${config.tos.toString(16).toUpperCase()}`);
  lines.push(`Request size (ARR data portion): ${config.requestDataSize}`);
  lines.push(`Verify data: ${config.verifyData ? 'Yes' : 'No'}`);
  lines.push('Vrf Name: ');
  lines.push('Schedule:');
  lines.push(`   Operation frequency (seconds): ${config.frequencySeconds}  (not considered if randomly scheduled)`);
  lines.push(`   Next Scheduled Start Time: ${
    runtime.state === 'active' ? 'Start Time already passed'
      : config.schedule.startPending ? 'Pending trigger'
        : config.schedule.configured ? 'Pending scheduled start'
          : 'Start Time not configured'}`);
  lines.push(`   Group Scheduled : ${config.schedule.groupName ? 'TRUE' : 'FALSE'}`);
  lines.push('   Randomly Scheduled : FALSE');
  lines.push(`   Life (seconds): ${config.schedule.lifeSeconds === 'forever' ? 'Forever' : config.schedule.lifeSeconds}`);
  lines.push(`   Entry Ageout (seconds): ${config.schedule.ageoutSeconds === 0 ? 'never' : config.schedule.ageoutSeconds}`);
  lines.push(`   Recurring (Starting Everyday): ${config.schedule.recurring ? 'TRUE' : 'FALSE'}`);
  lines.push(`   Status of entry (SNMP RowStatus): ${scheduleStatus(runtime)}`);
  lines.push(`Threshold (milliseconds): ${config.thresholdMs}`);
  lines.push('Distribution Statistics:');
  lines.push(`   Number of statistic hours kept: ${config.hoursOfStatisticsKept}`);
  lines.push(`   Number of statistic distribution buckets kept: ${config.distributionsKept}`);
  lines.push(`   Statistic distribution interval (milliseconds): ${config.distributionIntervalMs}`);
  lines.push('History Statistics:');
  lines.push(`   Number of history Lives kept: ${config.historyLivesKept}`);
  lines.push(`   Number of history Buckets kept: ${config.historyBucketsKept}`);
  lines.push(`   History Filter Type: ${config.historyFilter === 'none' ? 'None' : config.historyFilter}`);
  lines.push('Enhanced History:');
  return lines;
}

function renderJitterStatistics(runtime: SlaOperationRuntime): string[] {
  const jitter = runtime.jitter;
  const lines: string[] = [];
  const sd = jitter.sourceToDestination;
  const ds = jitter.destinationToSource;
  lines.push(`Number of SD Jitter Samples: ${sd.numSamples}`);
  lines.push(`Source to Destination Jitter Min/Avg/Max: ${sd.min ?? 0}/${Math.round(averageJitter(sd))}/${sd.max ?? 0} milliseconds`);
  lines.push(`Number of DS Jitter Samples: ${ds.numSamples}`);
  lines.push(`Destination to Source Jitter Min/Avg/Max: ${ds.min ?? 0}/${Math.round(averageJitter(ds))}/${ds.max ?? 0} milliseconds`);
  lines.push(`Source to Destination Positive Jitter Number/Sum/Min/Max: ${sd.numOfPositives}/${Math.round(sd.sumOfPositives)}/${sd.minPositive ?? 0}/${sd.maxPositive ?? 0}`);
  lines.push(`Source to Destination Negative Jitter Number/Sum/Min/Max: ${sd.numOfNegatives}/${Math.round(sd.sumOfNegatives)}/${sd.minNegative ?? 0}/${sd.maxNegative ?? 0}`);
  lines.push(`Destination to Source Positive Jitter Number/Sum/Min/Max: ${ds.numOfPositives}/${Math.round(ds.sumOfPositives)}/${ds.minPositive ?? 0}/${ds.maxPositive ?? 0}`);
  lines.push(`Destination to Source Negative Jitter Number/Sum/Min/Max: ${ds.numOfNegatives}/${Math.round(ds.sumOfNegatives)}/${ds.minNegative ?? 0}/${ds.maxNegative ?? 0}`);
  lines.push(`Interarrival jitterout: ${Math.round(sd.interarrival)}  Interarrival jitterin: ${Math.round(ds.interarrival)}`);
  lines.push('One Way Values:');
  lines.push(`   Number of SD Samples: ${jitter.oneWaySD.numSamples}`);
  lines.push(`   Source to Destination Latency one way Min/Avg/Max: ${jitter.oneWaySD.min ?? 0}/${Math.round(averageOneWay(jitter.oneWaySD))}/${jitter.oneWaySD.max ?? 0} milliseconds`);
  lines.push(`   Number of DS Samples: ${jitter.oneWayDS.numSamples}`);
  lines.push(`   Destination to Source Latency one way Min/Avg/Max: ${jitter.oneWayDS.min ?? 0}/${Math.round(averageOneWay(jitter.oneWayDS))}/${jitter.oneWayDS.max ?? 0} milliseconds`);
  lines.push('Packet Loss Values:');
  lines.push(`   Loss Source to Destination: ${jitter.packetLossSD}`);
  lines.push(`   Loss Destination to Source: ${jitter.packetLossDS}`);
  lines.push(`   Out Of Sequence: ${jitter.packetOutOfSequence}  Tail Drop: 0`);
  lines.push(`   Packet Late Arrival: ${jitter.packetLateArrival}  Packet Skipped: ${jitter.packetMIA}`);
  lines.push(`   Percent Packet Loss: ${packetLossPercent(jitter).toFixed(1)}%`);
  if (runtime.emodel) {
    lines.push('Voice Score Values:');
    lines.push(`   Calculated Planning Impairment Factor (ICPIF): ${runtime.emodel.icpif}`);
    lines.push(`   Mean Opinion Score (MOS): ${runtime.emodel.mos.toFixed(2)}`);
  }
  return lines;
}

function renderStatistics(
  runtime: SlaOperationRuntime,
  nowMs: number,
  detailed: boolean,
): string[] {
  const lines: string[] = [];
  lines.push(`IPSLA operation id: ${runtime.config.id}`);
  if (runtime.lastReturnCode === null) {
    lines.push('\tNo statistics gathered');
    lines.push(`Operational state of entry: ${scheduleStatus(runtime)}`);
    return lines;
  }
  lines.push(`\tLatest RTT: ${runtime.lastRttMs === null ? 'NoConnection/Busy/Timeout' : `${Math.round(runtime.lastRttMs)} milliseconds`}`);
  lines.push(`Latest operation start time: ${runtime.lastRunEpochMs === null ? '*' : formatIosTimestamp(runtime.lastRunEpochMs)}`);
  lines.push(`Latest operation return code: ${RETURN_CODE_LABEL[runtime.lastReturnCode]}`);
  if (runtime.config.type === 'udp-jitter' || runtime.config.type === 'icmp-jitter') {
    lines.push(...renderJitterStatistics(runtime));
  }
  if (detailed) {
    lines.push(`Over thresholds occurred: ${runtime.counters.overThresholds > 0 ? 'TRUE' : 'FALSE'}`);
    lines.push(`RTT Values: Number Of RTT: ${runtime.aggregate.numRtts}`
      + `  RTT Min/Avg/Max: ${runtime.aggregate.minRtt ?? 0}/${Math.round(averageRtt(runtime.aggregate))}/${runtime.aggregate.maxRtt ?? 0} milliseconds`);
  }
  lines.push(`Number of successes: ${runtime.counters.successes}`);
  lines.push(`Number of failures: ${runtime.counters.failures}`);
  lines.push(`Operation time to live: ${lifeText(runtime, nowMs)}`);
  if (detailed) {
    lines.push(`Operational state of entry: ${scheduleStatus(runtime)}`);
    lines.push(`Last time this entry was reset: ${runtime.resetEpochMs ? formatIosTimestamp(runtime.resetEpochMs) : 'Never'}`);
    if (runtime.lastDiagText) lines.push(`Diagnostic text: ${runtime.lastDiagText}`);
  }
  return lines;
}

function column(text: string, width: number): string {
  return text.length >= width ? `${text.slice(0, width - 1)} ` : text.padEnd(width);
}

function renderSummary(engine: IpSlaEngine, nowMs: number): string {
  const operations = engine.listOperations();
  const lines = [
    'IPSLAs Latest Operation Summary',
    'Codes: * active, ^ inactive, ~ pending',
    '',
    'ID           Type        Destination       Stats       Return      Last',
    '                                           (ms)        Code        Run',
    '-----------------------------------------------------------------------',
  ];
  for (const runtime of operations) {
    const marker = runtime.state === 'active' ? '*' : runtime.state === 'inactive' ? '^' : '~';
    const stats = runtime.lastRttMs === null ? '-' : `RTT=${Math.round(runtime.lastRttMs)}`;
    const code = runtime.lastReturnCode === null ? '-' : RETURN_CODE_LABEL[runtime.lastReturnCode];
    const last = runtime.lastRunAtMs === null ? 'never' : formatElapsed(nowMs - runtime.lastRunAtMs);
    lines.push(
      `${column(marker + runtime.config.id, 13)}${column(displayType(runtime.config.type), 12)}`
      + `${column(runtime.config.target ?? '-', 18)}${column(stats, 12)}`
      + `${column(code, 12)}${last}`,
    );
  }
  return lines.join('\n');
}

function renderApplication(engine: IpSlaEngine): string {
  const operations = engine.listOperations();
  const active = operations.filter((operation) => operation.state === 'active').length;
  const pending = operations.filter((operation) => operation.state === 'pending').length;
  const inactive = operations.filter((operation) => operation.state === 'inactive').length;
  return [
    'IP Service Level Agreements',
    'Version: 2.2.0 Round Trip Time MIB, Infrastructure Engine-III',
    '',
    'Supported Operation Types:',
    '\ticmpEcho, icmpJitter, pathEcho, udpEcho, udpJitter, tcpConnect',
    '\thttp, dns',
    'Supported Features:',
    '\tIPSLAs Event Publisher',
    '',
    `IP SLAs low memory water mark: ${engine.globalEnabled ? '21563' : '0'}`,
    'Estimated system max number of entries: 15801',
    '',
    'Estimated number of configurable operations: 15800',
    `Number of Entries configured  : ${operations.length}`,
    `Number of active Entries      : ${active}`,
    `Number of pending Entries     : ${pending}`,
    `Number of inactive Entries    : ${inactive}`,
    '',
    'Supported Hardware Timestamp Modes: None',
  ].join('\n');
}

function renderDistribution(runtime: SlaOperationRuntime): string[] {
  const lines: string[] = [];
  lines.push(`IPSLA operation id: ${runtime.config.id}`);
  for (const bucket of runtime.distribution) {
    const bound = bucket.upperBoundMs === null
      ? `${bucket.lowerBoundMs}-...`
      : `${bucket.lowerBoundMs}-${bucket.upperBoundMs - 1}`;
    lines.push(`\tBucket ${bound} ms: Completions ${bucket.count}`
      + `  Sum of RTT ${Math.round(bucket.sumRtt)}`);
  }
  return lines;
}

export function registerIpSlaDebugCommands(trie: CommandTrie, ctx: IpSlaShowContext): void {
  const service = () => ctx.r().getDebugService();
  const branches: Array<[string, 'ip.sla.trace' | 'ip.sla.error', string]> = [
    ['trace', 'ip.sla.trace', 'IP SLAs trace'],
    ['error', 'ip.sla.error', 'IP SLAs errors'],
  ];
  for (const [keyword, category, description] of branches) {
    trie.register(`debug ip sla ${keyword}`, description, () => service().enable(category));
    trie.register(`no debug ip sla ${keyword}`, description, () => service().disable(category));
  }
  trie.register('debug track', 'Tracking state changes', () => service().enable('track'));
  trie.register('no debug track', 'Tracking state changes', () => service().disable('track'));
}

export function registerIpSlaClearCommands(trie: CommandTrie, ctx: IpSlaShowContext): void {
  const engine = () => ctx.r().getIpSlaEngine();

  trie.registerGreedy('clear ip sla statistics', 'Clear IP SLAs statistics', (args) => {
    const idToken = args.find((token) => /^\d+$/.test(token));
    if (idToken === undefined) { engine().resetStatistics(); return ''; }
    const id = parseInt(idToken, 10);
    if (!engine().getOperation(id)) return `% IP SLAs entry ${id} does not exist`;
    engine().resetStatistics(id);
    return '';
  });

  trie.registerGreedy('clear ip sla enhanced-history', 'Clear IP SLAs enhanced history', (args) => {
    const idToken = args.find((token) => /^\d+$/.test(token));
    const targets = idToken === undefined
      ? engine().listOperations()
      : [engine().getOperation(parseInt(idToken, 10))];
    for (const runtime of targets) if (runtime) runtime.history = [];
    return '';
  });
}

export function registerIpSlaShowCommands(trie: CommandTrie, ctx: IpSlaShowContext): void {
  const engine = () => ctx.r().getIpSlaEngine();
  const now = () => ctx.r().getSystemClockMs();

  trie.registerGreedy('show ip sla configuration', 'IP SLAs configuration', (args) => {
    const operations = selectOperations(engine(), args[0]);
    if (operations === null) return '% Invalid operation number';
    const lines = ['IP SLAs Infrastructure Engine-III'];
    if (operations.length === 0) return lines.join('\n');
    for (const runtime of operations) lines.push(...renderConfiguration(runtime));
    return lines.join('\n');
  });

  trie.registerGreedy('show ip sla statistics', 'IP SLAs statistics', (args) => {
    const wantsDetails = args.includes('details');
    const aggregated = args.includes('aggregated');
    const idToken = args.find((token) => /^\d+$/.test(token));
    const operations = selectOperations(engine(), idToken);
    if (operations === null) return '% Invalid operation number';
    if (aggregated) {
      const lines = ['IPSLAs aggregated statistics', ''];
      for (const runtime of operations) {
        lines.push(`Round Trip Time (RTT) for       Index ${runtime.config.id}`);
        lines.push(`Type of operation: ${displayType(runtime.config.type)}`);
        lines.push('RTT Values:');
        lines.push(`\tNumber Of RTT: ${runtime.aggregate.numRtts}`
          + `\t\tRTT Min/Avg/Max: ${runtime.aggregate.minRtt ?? 0}/${Math.round(averageRtt(runtime.aggregate))}/${runtime.aggregate.maxRtt ?? 0} milliseconds`);
        lines.push(`Number of successes: ${runtime.counters.successes}`);
        lines.push(`Number of failures: ${runtime.counters.failures}`);
        lines.push(...renderDistribution(runtime));
      }
      return lines.join('\n');
    }
    const lines = ['IPSLAs Latest Operation Statistics', ''];
    if (operations.length === 0) {
      lines.push('No IP SLAs operations configured.');
      return lines.join('\n');
    }
    const nowMs = engine().nowMs();
    for (const runtime of operations) {
      lines.push(...renderStatistics(runtime, nowMs, wantsDetails));
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  });

  trie.registerGreedy('show ip sla summary', 'IP SLAs summary', () =>
    renderSummary(engine(), engine().nowMs()));

  trie.registerGreedy('show ip sla application', 'IP SLAs application', () =>
    renderApplication(engine()));

  trie.registerGreedy('show ip sla history', 'IP SLAs history', (args) => {
    const operations = selectOperations(engine(), args.find((token) => /^\d+$/.test(token)));
    if (operations === null) return '% Invalid operation number';
    const lines = ['Point by point History', '',
      'Entry = Entry Number', 'LifeI = Life Index', 'BucketI = Bucket Index',
      'SampleI = Sample Index', 'SampleT = Sample Start Time',
      'CompT = Completion Time (milliseconds)', 'Sense = Response Return Code',
      '', 'Entry  SampleT                        CompT  Sense'];
    for (const runtime of operations) {
      for (const entry of runtime.history) {
        lines.push(`${String(runtime.config.id).padEnd(7)}`
          + `${formatIosTimestamp(entry.sampleTimeMs).padEnd(31)}`
          + `${String(entry.rttMs === null ? 0 : Math.round(entry.rttMs)).padEnd(7)}`
          + `${RETURN_CODE_LABEL[entry.returnCode]}`);
      }
    }
    return lines.join('\n');
  });

  trie.registerGreedy('show ip sla reaction-configuration', 'IP SLAs reaction configuration', (args) => {
    const idToken = args.find((token) => /^\d+$/.test(token));
    const reactions = engine().listReactions(
      idToken === undefined ? undefined : parseInt(idToken, 10),
    );
    const lines = ['Entry Number: '];
    if (reactions.length === 0) return 'No reaction configured.';
    lines.length = 0;
    for (const reaction of reactions) {
      lines.push(`Entry number: ${reaction.operationId}`);
      lines.push(`Reaction Configuration:`);
      lines.push(`   Reaction: ${reaction.element}`);
      lines.push(`   Threshold Type: ${thresholdTypeLabel(reaction)}`);
      lines.push(`   Rising: ${reaction.thresholdUpper}  Falling: ${reaction.thresholdLower}`);
      lines.push(`   Threshold Count: ${reaction.consecutiveCount}  Threshold Count2: ${reaction.xOfyY}`);
      lines.push(`   Action Type: ${reaction.actionType}`);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('show ip sla reaction-trigger', 'IP SLAs reaction triggers', () => {
    const triggers = engine().listReactionTriggers();
    if (triggers.length === 0) return 'No reaction trigger configured.';
    const lines = ['Entry Number    Target Entry    Target Entry Status'];
    for (const trigger of triggers) {
      const target = engine().getOperation(trigger.target);
      lines.push(`${String(trigger.source).padEnd(16)}${String(trigger.target).padEnd(16)}`
        + `${target ? scheduleStatus(target) : 'Unknown'}`);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('show ip sla group schedule', 'IP SLAs group schedule', () => {
    const groups = new Map<string, number[]>();
    for (const runtime of engine().listOperations()) {
      const group = runtime.config.schedule.groupName;
      if (!group) continue;
      const members = groups.get(group) ?? [];
      members.push(runtime.config.id);
      groups.set(group, members);
    }
    if (groups.size === 0) return 'No IP SLAs group schedule configured.';
    const lines: string[] = [];
    for (const [group, members] of [...groups.entries()].sort()) {
      lines.push(`Group Entry Number: ${group}`);
      lines.push(`Probes to be scheduled: ${members.sort((a, b) => a - b).join(',')}`);
      lines.push(`Total number of probes: ${members.length}`);
      lines.push('Schedule period: 0');
      lines.push('Group operation frequency: Equals to schedule period');
      lines.push('Status of entry (SNMP RowStatus): Active');
    }
    return lines.join('\n');
  });

  trie.registerGreedy('show ip sla responder', 'IP SLAs Responder information', () => {
    const responder = engine().getResponder();
    const lines = [
      `IP SLAs Responder is: ${responder.isEnabled() ? 'Enabled' : 'Disabled'}`,
    ];
    const ports = responder.listPorts();
    if (ports.length === 0) {
      lines.push('Number of control message received: 0  Number of errors: 0');
      lines.push('Recent sources:');
      return lines.join('\n');
    }
    lines.push('Permanent Port:');
    for (const entry of ports.filter((port) => port.permanent)) {
      lines.push(`\t${entry.protocol} port ${entry.port}`
        + `${entry.address ? ` ipaddress ${entry.address}` : ''}`);
    }
    lines.push('Recent sources:');
    for (const entry of ports.filter((port) => !port.permanent)) {
      lines.push(`\t${entry.address ?? 'unknown'} port ${entry.port} (${entry.protocol})`);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('show ip sla monitor', 'Legacy IP SLAs Monitor (removed)', () =>
    '% Invalid input detected at \'^\' marker.');

  trie.registerGreedy('show ip sla', 'IP SLAs information', (args) =>
    args.length === 0 ? renderApplication(engine()) : '% Invalid input detected at \'^\' marker.');

  void now;
}

function selectOperations(
  engine: IpSlaEngine,
  idToken: string | undefined,
): SlaOperationRuntime[] | null {
  if (idToken === undefined) return engine.listOperations();
  if (!/^\d+$/.test(idToken)) return null;
  const runtime = engine.getOperation(parseInt(idToken, 10));
  return runtime ? [runtime] : [];
}
