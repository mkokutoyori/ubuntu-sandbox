import { simulationNowMs } from '@/network/core/SystemClock';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import type { LivenessView } from '../../../radius/ServerLiveness';
import { emptyPhase, type PhaseCounters, type ServerCounters } from '../../../radius/ServerCounters';
import type { DeadCriteria } from '../../../radius/ServerLiveness';
import { DEFAULT_DEAD_CRITERIA } from '../../../radius/ServerLiveness';
import {
  radiusAcctPort, radiusAuthPort,
  type CiscoSecurityConfig, type RadiusServer,
} from '../../router/security/CiscoSecurityConfig';

export interface AaaShowHost {
  security(): CiscoSecurityConfig;
  counters(): ServerCounters;
}

const EXEC = ['user', 'privileged'] as const;
const PRIVILEGED = ['privileged'] as const;

const SCOPE: ArgumentSpec = {
  name: 'scope', type: 'ENUM', optional: true,
  values: [
    { keyword: 'private', description: 'Private AAA servers only' },
    { keyword: 'public', description: 'Public AAA servers only' },
  ],
};

const PROTOCOL: ArgumentSpec = {
  name: 'protocol', type: 'ENUM',
  values: [{ keyword: 'radius', description: 'RADIUS server' }],
};

const ADDRESS: ArgumentSpec = { name: 'address', type: 'IP_ADDR', description: 'IP address of the AAA server' };
const GROUP: ArgumentSpec = { name: 'group', type: 'WORD', optional: true, description: 'Server group name' };
const PORT = (name: string, description: string): ArgumentSpec => ({
  name, type: 'INT', range: [0, 65535], description,
});

const GROUP_NAME: ArgumentSpec = {
  name: 'name', type: 'WORD', description: 'Server group name',
  alternatives: [{ keyword: 'all', description: 'All server groups' }],
};

const METHOD_SCOPE: ArgumentSpec = {
  name: 'scope', type: 'ENUM',
  values: [
    { keyword: 'accounting', description: 'Method lists defined for accounting services' },
    { keyword: 'all', description: 'Method lists defined for all services' },
    { keyword: 'authentication', description: 'Method lists defined for authentication services' },
    { keyword: 'authorization', description: 'Method lists defined for authorization services' },
  ],
};

type MethodPhase = 'authentication' | 'authorization' | 'accounting';

const METHOD_QUEUES: Readonly<Record<MethodPhase, { label: string; queues: ReadonlyArray<readonly [string, string | null]> }>> = {
  authentication: {
    label: 'authen',
    queues: [
      ['AAA_ML_AUTHEN_LOGIN', 'login'], ['AAA_ML_AUTHEN_ENABLE', 'enable'], ['AAA_ML_AUTHEN_PPP', 'ppp'],
      ['AAA_ML_AUTHEN_SGBP', null], ['AAA_ML_AUTHEN_ARAP', null], ['AAA_ML_AUTHEN_DOT1X', null],
      ['AAA_ML_AUTHEN_EAPOUDP', null], ['AAA_ML_AUTHEN_8021X', null],
    ],
  },
  authorization: {
    label: 'author',
    queues: [
      ['AAA_ML_AUTHOR_SHELL', 'exec'], ['AAA_ML_AUTHOR_NET', 'network'], ['AAA_ML_AUTHOR_COMMAND', 'commands'],
    ],
  },
  accounting: {
    label: 'acct',
    queues: [
      ['AAA_ML_ACCT_SHELL', 'exec'], ['AAA_ML_ACCT_NET', 'network'], ['AAA_ML_ACCT_COMMAND', 'commands'],
      ['AAA_ML_ACCT_CONN', 'connection'], ['AAA_ML_ACCT_SYSTEM', 'system'],
    ],
  },
};

const PERMANENT_LISTS: Readonly<Record<MethodPhase, readonly string[]>> = {
  authentication: [
    'name=Permanent Enable None valid=TRUE id=0 :state=ALIVE : ENABLE NONE',
    'name=Permanent Enable valid=TRUE id=0 :state=ALIVE : ENABLE',
    'name=Permanent None valid=TRUE id=0 :state=ALIVE : NONE',
    'name=Permanent Local valid=TRUE id=0 :state=ALIVE : LOCAL',
  ],
  authorization: [],
  accounting: [],
};

const METHOD_WORDS: Readonly<Record<string, string>> = {
  local: 'LOCAL', 'local-case': 'LOCAL_CASE', enable: 'ENABLE', none: 'NONE', line: 'LINE', krb5: 'KRB5',
};

function groupIsDead(sec: CiscoSecurityConfig, group: string, now: number): boolean {
  const members = group === 'radius' && !sec.aaaGroups.has('radius')
    ? [...sec.radiusServers.values()]
    : (sec.aaaGroups.get(group)?.members ?? [])
      .map((name) => sec.radiusServers.get(name))
      .filter((server): server is RadiusServer => server !== undefined);
  const addressed = members.filter((server) => !!server.address);
  return addressed.length > 0 && addressed.every((server) => sec.radiusLiveness.isDead(server.address as string, now));
}

function methodWords(methods: readonly string[]): string[] {
  const words: string[] = [];
  for (let index = 0; index < methods.length; index++) {
    if (methods[index] === 'group') {
      words.push(`SERVER_GROUP ${methods[index + 1]}`);
      index++;
    } else {
      words.push(METHOD_WORDS[methods[index]] ?? methods[index].toUpperCase());
    }
  }
  return words;
}

function recordAction(recordType: string | undefined): string {
  if (recordType === 'start-stop') return 'START STOP';
  if (recordType === 'stop-only') return 'STOP';
  if (recordType === 'wait-start') return 'WAIT START';
  return 'NONE';
}

export function renderMethodLists(host: AaaShowHost, scope: string): string {
  const sec = host.security();
  const now = simulationNowMs();
  const phases: MethodPhase[] = scope === 'all' ? ['authentication', 'authorization', 'accounting'] : [scope as MethodPhase];
  const lines: string[] = [];
  let ordinal = 0;
  for (const phase of phases) {
    const { label, queues } = METHOD_QUEUES[phase];
    for (const [queue, service] of queues) {
      lines.push(`${label} queue=${queue}`);
      if (service === null) continue;
      for (const entry of sec.aaaMethods.filter((candidate) => candidate.phase === phase && candidate.service === service)) {
        ordinal += 1;
        const id = entry.listName === 'default' ? '0' : ordinal.toString(16).toUpperCase().padStart(8, '0');
        const dead = entry.methods.some((token, index) => entry.methods[index - 1] === 'group' && groupIsDead(sec, token, now));
        const action = phase === 'accounting' ? ` Action=${recordAction(entry.recordType)}` : '';
        const level = entry.privilegeLevel !== undefined && entry.service === 'commands' ? ` level=${entry.privilegeLevel}` : '';
        lines.push(`name=${entry.listName}${level} valid=TRUE id=${id}${action} :state=${dead ? 'DEAD' : 'ALIVE'} : ${methodWords(entry.methods).join(' ')}`.trimEnd());
      }
    }
    if (PERMANENT_LISTS[phase].length > 0) {
      lines.push('permanent lists');
      lines.push(...PERMANENT_LISTS[phase]);
    }
  }
  return lines.join('\n');
}

function elapsed(ms: number): string {
  const total = Math.floor(ms / 60000);
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  return `${days}d${hours}h${minutes}m`;
}

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

function criteriaOf(sec: CiscoSecurityConfig): DeadCriteria {
  return {
    timeSec: sec.radiusDefaults.deadCriteriaTimeSec ?? DEFAULT_DEAD_CRITERIA.timeSec,
    tries: sec.radiusDefaults.deadCriteriaTries ?? DEFAULT_DEAD_CRITERIA.tries,
  };
}

function outstandingOf(sec: CiscoSecurityConfig, address: string): { current: number; peak: number } {
  return {
    current: sec.radiusSelector.outstandingOf(address),
    peak: sec.radiusSelector.peakOutstandingOf(address),
  };
}

function priorityOf(sec: CiscoSecurityConfig, server: RadiusServer): number {
  for (const group of sec.aaaGroups.values()) {
    if (group.kind !== 'radius') continue;
    const index = group.members.indexOf(server.name);
    if (index >= 0) return index + 1;
  }
  return 1;
}

function phaseLines(label: string, c: PhaseCounters, accounting: boolean): string[] {
  const lines = [
    `     ${label}: request ${c.requests}, timeouts ${c.timeouts}, failover ${c.failovers}, retransmission ${c.retransmissions}`,
  ];
  if (accounting) {
    lines.push(`             Request: start ${c.starts}, interim ${c.interims}, stop ${c.stops}`);
    lines.push(`             Response: start ${c.startResponses}, interim ${c.interimResponses}, stop ${c.stopResponses}`);
  } else {
    lines.push(`             Response: accept ${c.accepts}, reject ${c.rejects}, challenge ${c.challenges}`);
  }
  lines.push(
    `             Response: unexpected ${c.unexpected}, server error ${c.serverErrors}, incorrect ${c.incorrect}, time ${c.lastResponseMs}ms`,
    `             Transaction: success ${c.transactionSuccess}, failure ${c.transactionFailure}`,
    '             Throttled: transaction 0, timeout 0, failure 0',
  );
  return lines;
}

export function renderAaaServers(host: AaaShowHost, scope: string | undefined): string {
  if (scope === 'private') return '';
  const sec = host.security();
  const counters = host.counters();
  const now = simulationNowMs();
  const lines: string[] = [];
  for (const server of sec.radiusServers.values()) {
    if (!server.address) continue;
    const view: LivenessView = sec.radiusLiveness.view(server.address, now, server.configuredAtMs);
    const snapshot = counters.snapshot(server.address);
    const flight = outstandingOf(sec, server.address);
    lines.push(`RADIUS: id ${server.serverId}, priority ${priorityOf(sec, server)}, host ${server.address}`
      + `, auth-port ${radiusAuthPort(server, sec.radiusDefaults)}, acct-port ${radiusAcctPort(server, sec.radiusDefaults)}`);
    lines.push(`     State: current ${view.alive ? 'UP' : 'DEAD'}, duration ${seconds(view.durationMs)}s, previous duration ${seconds(view.previousDurationMs)}s`);
    lines.push(`     Dead: total time ${seconds(view.deadTotalMs)}s, count ${view.deadCount}`);
    lines.push('     Quarantined: No');
    lines.push(...phaseLines('Authen', snapshot.authentication, false));
    lines.push(...phaseLines('Author', emptyPhase(), false));
    lines.push(...phaseLines('Account', snapshot.accounting, true));
    lines.push(`     Elapsed time since counters last cleared: ${elapsed(now - snapshot.clearedAtMs)}`);
    lines.push(`     Estimated Outstanding Access Transactions: ${flight.current}`);
    lines.push('     Estimated Outstanding Accounting Transactions: 0');
    lines.push('     Estimated Throttled Access Transactions: 0');
    lines.push('     Estimated Throttled Accounting Transactions: 0');
    lines.push('     Maximum Throttled Transactions: access 0, accounting 0');
  }
  return lines.join('\n');
}

interface DeadCriteriaQuery {
  address: string;
  authPort?: number;
  acctPort?: number;
  group?: string;
}

export function renderDeadCriteria(host: AaaShowHost, query: DeadCriteriaQuery): string {
  const sec = host.security();
  const groupName = query.group ?? 'radius';
  const members = groupName === 'radius' && !sec.aaaGroups.has('radius')
    ? [...sec.radiusServers.values()]
    : (sec.aaaGroups.get(groupName)?.members ?? [])
      .map((name) => sec.radiusServers.get(name))
      .filter((server): server is RadiusServer => server !== undefined);
  const server = members.find((candidate) =>
    candidate.address === query.address
    && radiusAuthPort(candidate, sec.radiusDefaults) === (query.authPort ?? radiusAuthPort(candidate, sec.radiusDefaults))
    && radiusAcctPort(candidate, sec.radiusDefaults) === (query.acctPort ?? radiusAcctPort(candidate, sec.radiusDefaults)));
  if (!server) return '';
  const criteria = criteriaOf(sec);
  const view = sec.radiusLiveness.view(server.address as string, simulationNowMs(), server.configuredAtMs);
  const flight = outstandingOf(sec, server.address as string);
  const timeout = server.timeoutSec ?? sec.radiusDefaults.timeoutSec ?? 5;
  const retransmit = server.retransmit ?? sec.radiusDefaults.retransmit ?? 3;
  return [
    'RADIUS Server Dead Critieria:',
    '=============================',
    'Server Details:',
    `    Address       : ${server.address}`,
    `    Auth Port     : ${radiusAuthPort(server, sec.radiusDefaults)}`,
    `    Acct Port     : ${radiusAcctPort(server, sec.radiusDefaults)}`,
    `    Server Group  : ${groupName}`,
    'Dead Criteria Details:',
    `    Configured Retransmits         : ${retransmit}`,
    `    Configured Timeout             : ${timeout}`,
    `    Estimated Outstanding Transactions: ${flight.current}`,
    `    Dead Detect Time               : ${criteria.timeSec}s`,
    `    Computed Retransmit Tries      : ${criteria.tries}`,
    'Statistics Gathered Since Last Successful Transaction',
    '=====================================================',
    `Max Computed Outstanding Transactions: ${flight.peak}`,
    `Max Computed Dead Detect Time: ${criteria.timeSec}s`,
    `Max Computed Retransmits     : ${Math.max(view.consecutiveTransmissions, 0)}`,
  ].join('\n');
}

function serverGroupLines(sec: CiscoSecurityConfig, name: string): string[] {
  const sharecount = sec.aaaMethods.filter((entry) =>
    entry.methods.some((token, index) => entry.methods[index - 1] === 'group' && token === name)).length;
  return [
    `Server group ${name}`,
    `    Sharecount = ${sharecount}  sg_unconfigured = FALSE`,
    '    Type = standard',
  ];
}

export function renderRadiusServerGroups(host: AaaShowHost, name: string): string {
  const sec = host.security();
  const radiusGroups = [...sec.aaaGroups.values()].filter((group) => group.kind === 'radius').map((group) => group.name);
  const known = sec.aaaGroups.has('radius') ? radiusGroups : ['radius', ...radiusGroups];
  if (name === 'all') return known.flatMap((group) => serverGroupLines(sec, group)).join('\n');
  if (!known.includes(name)) throw new CliInvalidInput({ token: name });
  return serverGroupLines(sec, name).join('\n');
}

interface StatisticsColumn {
  responses: number;
  without: number;
  rejects: number;
  delayTotal: number;
  delayCount: number;
  delayMax: number;
  timeouts: number;
  incorrect: number;
}

function statisticsColumn(counters: ServerCounters, addresses: readonly string[], phase: 'authentication' | 'accounting'): StatisticsColumn {
  const column: StatisticsColumn = {
    responses: 0, without: 0, rejects: 0, delayTotal: 0, delayCount: 0, delayMax: 0, timeouts: 0, incorrect: 0,
  };
  for (const address of addresses) {
    const c = counters.snapshot(address)[phase];
    column.responses += phase === 'authentication' ? c.accepts + c.rejects + c.challenges : c.startResponses + c.interimResponses + c.stopResponses;
    column.without += c.transactionFailure;
    column.rejects += c.rejects;
    column.delayTotal += c.lastResponseMs * c.transactionSuccess;
    column.delayCount += c.transactionSuccess;
    column.delayMax = Math.max(column.delayMax, c.lastResponseMs);
    column.timeouts += c.timeouts;
    column.incorrect += c.incorrect;
  }
  return column;
}

export function renderRadiusStatistics(host: AaaShowHost): string {
  const sec = host.security();
  const counters = host.counters();
  const addresses = [...sec.radiusServers.values()].flatMap((server) => (server.address ? [server.address] : []));
  const auth = statisticsColumn(counters, addresses, 'authentication');
  const acct = statisticsColumn(counters, addresses, 'accounting');
  const both: StatisticsColumn = {
    responses: auth.responses + acct.responses,
    without: auth.without + acct.without,
    rejects: auth.rejects + acct.rejects,
    delayTotal: auth.delayTotal + acct.delayTotal,
    delayCount: auth.delayCount + acct.delayCount,
    delayMax: Math.max(auth.delayMax, acct.delayMax),
    timeouts: auth.timeouts + acct.timeouts,
    incorrect: auth.incorrect + acct.incorrect,
  };
  const average = (c: StatisticsColumn) => (c.delayCount > 0 ? Math.round(c.delayTotal / c.delayCount) : 0);
  const row = (label: string, values: readonly number[]) =>
    `${label.padEnd(28)}${values.map((value) => String(value).padEnd(11)).join('').trimEnd()}`;
  return [
    '                            Auth.      Acct.      Both',
    row('Total responses seen:', [auth.responses, acct.responses, both.responses]),
    row('Packets with responses:', [auth.responses, acct.responses, both.responses]),
    row('Packets without responses:', [auth.without, acct.without, both.without]),
    `Access Rejects            : ${auth.rejects}`,
    row('Average response delay(ms):', [average(auth), average(acct), average(both)]),
    row('Maximum response delay(ms):', [auth.delayMax, acct.delayMax, both.delayMax]),
    row('Number of Radius timeouts:', [auth.timeouts, acct.timeouts, both.timeouts]),
    row('Bad Authenticators     :', [auth.incorrect, acct.incorrect, both.incorrect]),
  ].join('\n');
}

export function clearCounters(host: AaaShowHost, target: 'all' | { id: number | 'all' } | { group: string }): string {
  const counters = host.counters();
  const sec = host.security();
  if (target === 'all') {
    counters.clear();
    return '';
  }
  if ('id' in target) {
    if (target.id === 'all') {
      counters.clear();
      return '';
    }
    const server = [...sec.radiusServers.values()].find((candidate) => candidate.serverId === target.id);
    if (!server?.address) throw new CliInvalidInput({ token: String(target.id) });
    counters.clear(server.address);
    return '';
  }
  const group = sec.aaaGroups.get(target.group);
  if (!group || group.kind !== 'radius') throw new CliInvalidInput({ token: target.group });
  for (const member of group.members) {
    const address = sec.radiusServers.get(member)?.address;
    if (address) counters.clear(address);
  }
  return '';
}

function deadCriteriaSpec(
  id: string, middle: Array<string | ArgumentSpec>,
  host: () => AaaShowHost,
): CommandSpec {
  return {
    id,
    path: ['show', 'aaa', 'dead-criteria', PROTOCOL, ADDRESS, ...middle, GROUP],
    description: 'AAA dead-criteria detection information',
    modes: PRIVILEGED, minPrivilege: 15,
    run: (_session, args) => renderDeadCriteria(host(), {
      address: args.address,
      authPort: args['auth-port'] === undefined ? undefined : Number(args['auth-port']),
      acctPort: args['acct-port'] === undefined ? undefined : Number(args['acct-port']),
      group: args.group,
    }),
  };
}

export function aaaShowSpecs(host: () => AaaShowHost): CommandSpec[] {
  const authPort = PORT('auth-port', 'Authentication port number');
  const acctPort = PORT('acct-port', 'Accounting port number');
  return [
    {
      id: 'show-aaa-servers',
      path: ['show', 'aaa', 'servers', SCOPE],
      description: 'Shows AAA server status and packet counters',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => renderAaaServers(host(), args.scope),
    },
    {
      id: 'show-aaa-method-lists',
      path: ['show', 'aaa', 'method-lists', METHOD_SCOPE],
      description: 'Show AAA method lists',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => renderMethodLists(host(), args.scope),
    },
    deadCriteriaSpec('show-aaa-dead-criteria', [], host),
    deadCriteriaSpec('show-aaa-dead-criteria-auth', ['auth-port', authPort], host),
    deadCriteriaSpec('show-aaa-dead-criteria-acct', ['acct-port', acctPort], host),
    deadCriteriaSpec('show-aaa-dead-criteria-auth-acct', ['auth-port', authPort, 'acct-port', acctPort], host),
    {
      id: 'show-radius-server-group',
      path: ['show', 'radius', 'server-group', GROUP_NAME],
      description: 'Show RADIUS server group properties',
      modes: EXEC, minPrivilege: 1,
      run: (_session, args) => renderRadiusServerGroups(host(), args.name),
    },
    {
      id: 'show-radius-statistics',
      path: ['show', 'radius', 'statistics'],
      description: 'RADIUS statistics',
      modes: EXEC, minPrivilege: 1,
      run: () => renderRadiusStatistics(host()),
    },
    {
      id: 'clear-aaa-counters-servers-all',
      path: ['clear', 'aaa', 'counters', 'servers', 'all'],
      description: 'Clear all AAA server information',
      modes: PRIVILEGED, minPrivilege: 15,
      run: () => clearCounters(host(), 'all'),
    },
    {
      id: 'clear-aaa-counters-servers-radius',
      path: ['clear', 'aaa', 'counters', 'servers', 'radius', {
        name: 'id', type: 'ENUM', range: [0, 2147483647], description: 'Server id shown by show aaa servers',
        values: [{ keyword: 'all', description: 'All RADIUS server ids' }],
      }],
      description: 'Clear RADIUS server information',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => clearCounters(host(), { id: args.id === 'all' ? 'all' : Number(args.id) }),
    },
    {
      id: 'clear-aaa-counters-servers-sg',
      path: ['clear', 'aaa', 'counters', 'servers', 'sg', { name: 'name', type: 'WORD', description: 'Server group name' }],
      description: 'Clear all servers in a server group',
      modes: PRIVILEGED, minPrivilege: 15,
      run: (_session, args) => clearCounters(host(), { group: args.name }),
    },
    {
      id: 'clear-radius',
      path: ['clear', 'radius', {
        name: 'what', type: 'ENUM', description: 'RADIUS information to clear',
        values: [
          { keyword: 'sg-stats', description: 'Clear RADIUS server group statistics' },
          { keyword: 'statistics', description: 'Clear RADIUS statistics' },
        ],
      }],
      description: 'Clear RADIUS server information',
      modes: PRIVILEGED, minPrivilege: 15,
      run: () => clearCounters(host(), 'all'),
    },
  ];
}
