import type { CommandTrie } from '../CommandTrie';
import type { Router } from '../../Router';
import type { NqaService, NqaTestInstance, NqaTestType } from '../../../nqa/NqaService';
import { NQA_TEST_TYPES, NQA_UNSUPPORTED_TYPES } from '../../../nqa/NqaService';
import { applyTypeDefaults } from '../../../ipsla/types';
import { looksLikeIPv6 } from '../cisco/ciscoPing';

export interface HuaweiNqaShellCtx {
  r(): Router;
  setMode(mode: 'nqa-test' | 'system'): void;
  setSelectedNqa(admin: string | null, name: string | null): void;
  getSelectedNqa(): { admin: string; name: string } | null;
}

const INCOMPLETE = 'Error: Incomplete command.';

const WRONG_PARAM = 'Error: Wrong parameter found at \'^\' position.';

function service(ctx: HuaweiNqaShellCtx): NqaService {
  return ctx.r().getNqaService();
}

function current(ctx: HuaweiNqaShellCtx): NqaTestInstance | null {
  const selected = ctx.getSelectedNqa();
  if (!selected) return null;
  return service(ctx).get(selected.admin, selected.name) ?? null;
}

function positiveInt(token: string | undefined): number | null {
  if (token === undefined || !/^\d+$/.test(token)) return null;
  return parseInt(token, 10);
}

function parseClock(token: string | undefined): number | null {
  if (!token) return null;
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(token);
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = match[3] ? parseInt(match[3], 10) : 0;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function buildHuaweiNqaSystemCommands(trie: CommandTrie, ctx: HuaweiNqaShellCtx): void {
  trie.registerGreedy('nqa test-instance', 'Enter the NQA test instance view', (args) => {
    if (args.length < 2) return INCOMPLETE;
    service(ctx).upsert(args[0], args[1]);
    ctx.setSelectedNqa(args[0], args[1]);
    ctx.setMode('nqa-test');
    return '';
  });

  trie.registerGreedy('undo nqa test-instance', 'Delete an NQA test instance', (args) => {
    if (args.length < 2) return INCOMPLETE;
    return service(ctx).remove(args[0], args[1])
      ? ''
      : `Error: The test instance ${args[0]} ${args[1]} does not exist.`;
  });

  trie.registerGreedy('nqa-server', 'Configure the NQA server', (args) => {
    const kind = args[0];
    if (kind !== 'udpecho' && kind !== 'tcpconnect') return WRONG_PARAM;
    const address = args[1];
    const port = positiveInt(args[2]);
    if (!address || port === null) return INCOMPLETE;
    const responder = ctx.r().getIpSlaEngine().getResponder();
    responder.setEnabled(true);
    responder.openPermanentPort(kind === 'udpecho' ? 'udp-echo' : 'tcp-connect', port, address);
    return '';
  });

  trie.registerGreedy('undo nqa-server', 'Remove an NQA server binding', (args) => {
    const port = positiveInt(args[2]) ?? positiveInt(args[1]);
    if (port === null) return INCOMPLETE;
    ctx.r().getIpSlaEngine().getResponder().closePermanentPort(port);
    return '';
  });
}

export function buildHuaweiNqaTestView(trie: CommandTrie, ctx: HuaweiNqaShellCtx): void {
  const runtime = () => {
    const test = current(ctx);
    return test ? service(ctx).runtimeOf(test) : undefined;
  };

  trie.registerGreedy('test-type', 'Set the test type', (args) => {
    const test = current(ctx);
    const config = runtime()?.config;
    if (!test || !config) return '';
    const requested = args[0];
    if (!requested) return INCOMPLETE;
    const unsupported = NQA_UNSUPPORTED_TYPES[requested];
    if (unsupported) {
      return `Error: The test type ${requested} is not supported in this simulator `
        + `(${unsupported}).`;
    }
    if (!(requested in NQA_TEST_TYPES)) return WRONG_PARAM;
    const testType = requested as NqaTestType;

    const previousProbeCount = config.aggregateProbes;
    const previousFrequency = config.frequencySeconds;
    const previousInterval = config.intervalMs;
    const previousTimeout = config.timeoutMs;
    applyTypeDefaults(config, NQA_TEST_TYPES[testType]);
    config.aggregateProbes = previousProbeCount;
    config.frequencySeconds = previousFrequency;
    config.intervalMs = previousInterval;
    config.timeoutMs = previousTimeout;
    config.thresholdMs = Number.MAX_SAFE_INTEGER;
    config.controlEnabled = false;
    config.type = NQA_TEST_TYPES[testType];
    if (testType === 'jitter' || testType === 'icmpjitter') config.numPackets = 10;
    test.testType = testType;
    return '';
  });

  trie.registerGreedy('destination-address', 'Set the destination address', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    // `destination-address ipv6 <addr>` was refused because a router
    // had no ICMPv6 sender. It has one now, so the refusal was the only
    // thing left standing. Only an `icmp` test can measure over IPv6
    // today, and the others say which brick is missing rather than
    // accepting an address they cannot reach.
    const famille = args[0] === 'ipv6' || args[0] === 'ipv4' ? args[0] : null;
    const address = famille ? args[1] : args[0];
    if (!address) return INCOMPLETE;
    if (famille === 'ipv6' || looksLikeIPv6(address)) {
      if (!looksLikeIPv6(address)) return WRONG_PARAM;
      const type = current(ctx)?.testType;
      if (type !== undefined && type !== 'icmp') {
        return `Error: an IPv6 destination is only measurable by a test-type icmp `
          + `(no IPv6 transport for ${type} in this simulator).`;
      }
    }
    config.target = address;
    config.dns.nameServer = address;
    return '';
  });

  trie.registerGreedy('destination-port', 'Set the destination port', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    const port = positiveInt(args[0]);
    if (port === null) return INCOMPLETE;
    config.targetPort = port;
    return '';
  });

  trie.registerGreedy('source-address', 'Set the source address', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    const address = args[0] === 'ipv4' ? args[1] : args[0];
    if (!address) return INCOMPLETE;
    config.sourceIp = address;
    return '';
  });

  trie.registerGreedy('source-interface', 'Set the source interface', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    if (!args[0]) return INCOMPLETE;
    config.sourceInterface = args[0];
    return '';
  });

  trie.registerGreedy('frequency', 'Set the interval between two tests', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    const seconds = positiveInt(args[0]);
    if (seconds === null) return INCOMPLETE;
    config.frequencySeconds = seconds;
    return '';
  });

  trie.registerGreedy('probe-count', 'Set the number of probes per test', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    const count = positiveInt(args[0]);
    if (count === null || count < 1) return INCOMPLETE;
    config.aggregateProbes = count;
    return '';
  });

  trie.registerGreedy('interval', 'Set the interval between two probes', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    if (args[0] === 'seconds') {
      const seconds = positiveInt(args[1]);
      if (seconds === null) return INCOMPLETE;
      config.intervalMs = seconds * 1000;
      return '';
    }
    if (args[0] === 'milliseconds') {
      const millis = positiveInt(args[1]);
      if (millis === null) return INCOMPLETE;
      config.intervalMs = millis;
      return '';
    }
    return WRONG_PARAM;
  });

  trie.registerGreedy('timeout', 'Set the probe timeout in seconds', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    const seconds = positiveInt(args[0]);
    if (seconds === null) return INCOMPLETE;
    config.timeoutMs = seconds * 1000;
    return '';
  });

  trie.registerGreedy('fail-percent', 'Set the failure threshold percentage', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    const percent = positiveInt(args[0]);
    if (percent === null || percent > 100) return WRONG_PARAM;
    config.failPercent = percent;
    return '';
  });

  trie.registerGreedy('threshold', 'Set a threshold', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    if (args[0] !== 'rtd') return WRONG_PARAM;
    const millis = positiveInt(args[1]);
    if (millis === null) return INCOMPLETE;
    config.thresholdMs = millis;
    return '';
  });

  trie.registerGreedy('ttl', 'Set the TTL', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    const ttl = positiveInt(args[0]);
    if (ttl === null) return INCOMPLETE;
    config.maxHops = ttl;
    return '';
  });

  trie.registerGreedy('tos', 'Set the ToS byte', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    const tos = positiveInt(args[0]);
    if (tos === null) return INCOMPLETE;
    config.tos = tos;
    return '';
  });

  trie.registerGreedy('datasize', 'Set the payload size', (args) => {
    const config = runtime()?.config;
    if (!config) return '';
    const size = positiveInt(args[0]);
    if (size === null) return INCOMPLETE;
    config.requestDataSize = size;
    return '';
  });

  trie.registerGreedy('description', 'Describe the test instance', (args) => {
    const test = current(ctx);
    if (test) test.description = args.join(' ') || null;
    return '';
  });

  trie.registerGreedy('records', 'Set the number of records kept', (args) => {
    const test = current(ctx);
    if (!test) return '';
    const count = positiveInt(args[1]);
    if (count === null) return INCOMPLETE;
    if (args[0] === 'history') test.historyLimit = count;
    else if (args[0] === 'result') test.resultLimit = count;
    else return WRONG_PARAM;
    return '';
  });

  trie.registerGreedy('vpn-instance', 'Bind the test to a VPN instance', () =>
    'Error: VPN-instance-aware NQA is not supported in this simulator '
    + '(no per-VRF forwarding plane).');

  trie.registerGreedy('start', 'Start the test instance', (args) => {
    const test = current(ctx);
    if (!test) return '';
    test.startAtSecondsOfDay = null;
    test.startDelaySeconds = null;
    if (args[0] === 'at') {
      const at = parseClock(args[1]);
      if (at === null) return WRONG_PARAM;
      test.startAtSecondsOfDay = at;
    } else if (args[0] === 'delay') {
      const unitIndex = args[2] === 'seconds' || args[2] === 'milliseconds' ? 2 : -1;
      const value = positiveInt(args[1]);
      if (value === null) return INCOMPLETE;
      test.startDelaySeconds = unitIndex >= 0 && args[unitIndex] === 'milliseconds'
        ? Math.ceil(value / 1000)
        : value;
    } else if (args[0] !== 'now') {
      return WRONG_PARAM;
    }
    const result = service(ctx).start(test);
    return result.ok ? '' : (result.error ?? 'Error: The test instance cannot be started.');
  });

  trie.registerGreedy('stop', 'Stop the test instance', () => {
    const test = current(ctx);
    if (test) service(ctx).stop(test);
    return '';
  });
}

function formatVrpTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
    + `.${Math.floor(date.getUTCMilliseconds() / 100)}`;
}

export function renderNqaResults(service: NqaService, test: NqaTestInstance): string {
  const stats = service.summary(test);
  const runtime = service.runtimeOf(test);
  const lines: string[] = [];
  lines.push(`NQA entry(${test.admin}, ${test.name}) :testflag is ${test.testFlag} `
    + `,testtype is ${test.testType ?? 'icmp'}`);
  if (test.attempts === 0) {
    lines.push('  No result.');
    return lines.join('\n');
  }
  lines.push(`  1 . Test ${test.attempts} result   `
    + `${test.finished ? 'The test is finished' : 'The test is in progress'}`);
  lines.push(`    Send operation times: ${test.sent}`
    + `              Receive response times: ${test.received}`);
  lines.push(`    Completion:${test.completion}`
    + `                   RTD OverThresholds number: ${test.overThreshold}`);
  lines.push(`    Attempts number:${test.attempts}`
    + `                    Drop operation number:${test.sent - test.received}`);
  lines.push('    Disconnect operation number:0        '
    + `Operation timeout number:${test.sent - test.received}`);
  lines.push('    System busy operation number:0       Connection fail number:0');
  lines.push('    Operation sequence errors number:0   RTT Status errors number:0');
  lines.push(`    Destination ip address:${runtime?.config.target ?? '0.0.0.0'}`);
  lines.push(`    Min/Max/Average completion time: ${stats.min}/${stats.max}/${stats.average}`);
  lines.push(`    Sum/Square-Sum completion time: ${stats.sum}/${stats.squareSum}`);
  lines.push(`    Last complete time: ${test.lastCompleteEpochMs === null
    ? '-' : formatVrpTimestamp(test.lastCompleteEpochMs)}`);
  return lines.join('\n');
}

export function registerHuaweiNqaDisplayCommands(
  trie: CommandTrie,
  getRouter: () => Router,
): void {
  const nqa = () => getRouter().getNqaService();

  trie.registerGreedy('display nqa results test-instance', 'Display NQA results', (args) => {
    if (args.length < 2) return INCOMPLETE;
    const test = nqa().get(args[0], args[1]);
    if (!test) return `Info: The test instance ${args[0]} ${args[1]} does not exist.`;
    return renderNqaResults(nqa(), test);
  });

  trie.register('display nqa results', 'Display all NQA results', () => {
    const tests = nqa().list();
    if (tests.length === 0) return 'Info: No NQA test instance is configured.';
    return tests.map((test) => renderNqaResults(nqa(), test)).join('\n\n');
  });

  trie.registerGreedy('display nqa history test-instance', 'Display NQA history', (args) => {
    if (args.length < 2) return INCOMPLETE;
    const test = nqa().get(args[0], args[1]);
    if (!test) return `Info: The test instance ${args[0]} ${args[1]} does not exist.`;
    if (test.history.length === 0) return 'Info: No history record.';
    const lines = [`NQA entry(${test.admin}, ${test.name}) history record:`,
      '  Index    Response     Status           LastRC  Time'];
    for (const record of test.history) {
      lines.push(`  ${String(record.index).padEnd(9)}`
        + `${String(record.rttMs === null ? 0 : Math.round(record.rttMs)).padEnd(13)}`
        + `${(record.success ? 'success' : 'timeout').padEnd(17)}`
        + `${(record.success ? '0' : '1').padEnd(8)}`
        + `${formatVrpTimestamp(record.sampleEpochMs)}`);
    }
    return lines.join('\n');
  });

  trie.register('display nqa-server', 'Display the NQA server status', () => {
    const responder = getRouter().getIpSlaEngine().getResponder();
    const ports = responder.listPorts().filter((entry) => entry.permanent);
    const lines = [`NQA server status: ${responder.isEnabled() ? 'enabled' : 'disabled'}`];
    if (ports.length === 0) {
      lines.push('  No server is configured.');
      return lines.join('\n');
    }
    for (const entry of ports) {
      lines.push(`  ${entry.protocol === 'tcp-connect' ? 'tcpconnect' : 'udpecho'} server: `
        + `${entry.address ?? '0.0.0.0'} port: ${entry.port}`);
    }
    return lines.join('\n');
  });
}

export function resolveVrpTrack(router: Router, track: string): boolean {
  const tokens = track.trim().split(/\s+/);
  if (tokens[0] !== 'nqa') return true;
  const admin = tokens[1];
  const name = tokens[2];
  if (!admin || !name) return true;
  return router.getNqaService().isTrackUp(admin, name);
}

export function nqaRunningConfigLines(router: Router): string[] {
  const service = router.getNqaService();
  const lines: string[] = [];

  const responder = router.getIpSlaEngine().getResponder();
  for (const entry of responder.listPorts()) {
    if (!entry.permanent) continue;
    lines.push(`nqa-server ${entry.protocol === 'tcp-connect' ? 'tcpconnect' : 'udpecho'} `
      + `${entry.address ?? '0.0.0.0'} ${entry.port}`);
  }

  for (const test of service.list()) {
    const runtime = service.runtimeOf(test);
    if (!runtime) continue;
    const config = runtime.config;
    lines.push(`nqa test-instance ${test.admin} ${test.name}`);
    if (test.testType) lines.push(` test-type ${test.testType}`);
    if (test.description) lines.push(` description ${test.description}`);
    if (config.target) lines.push(` destination-address ipv4 ${config.target}`);
    if (config.targetPort !== null) lines.push(` destination-port ${config.targetPort}`);
    if (config.sourceIp) lines.push(` source-address ipv4 ${config.sourceIp}`);
    if (config.sourceInterface) lines.push(` source-interface ${config.sourceInterface}`);
    if (config.frequencySeconds !== 0) lines.push(` frequency ${config.frequencySeconds}`);
    if (config.aggregateProbes !== 3) lines.push(` probe-count ${config.aggregateProbes}`);
    if (config.intervalMs !== 4000) {
      lines.push(config.intervalMs % 1000 === 0
        ? ` interval seconds ${config.intervalMs / 1000}`
        : ` interval milliseconds ${config.intervalMs}`);
    }
    if (config.timeoutMs !== 3000) lines.push(` timeout ${Math.round(config.timeoutMs / 1000)}`);
    if (config.failPercent !== 100) lines.push(` fail-percent ${config.failPercent}`);
    if (config.thresholdMs !== Number.MAX_SAFE_INTEGER) {
      lines.push(` threshold rtd ${config.thresholdMs}`);
    }
    if (config.tos !== 0) lines.push(` tos ${config.tos}`);
    if (config.requestDataSize !== 56) lines.push(` datasize ${config.requestDataSize}`);
    if (test.historyLimit !== 50) lines.push(` records history ${test.historyLimit}`);
    if (test.resultLimit !== 5) lines.push(` records result ${test.resultLimit}`);
    if (test.testFlag === 'active') lines.push(' start now');
    lines.push(' #');
  }
  return lines;
}
