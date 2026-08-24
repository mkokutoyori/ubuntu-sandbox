import {
  address, choice, count, enable, reference, refList, text, word,
  type FortiTableSpec,
} from './types';
import type {
  SdwanProtocol, SdwanServiceMode,
} from '../../../sdwan/SdwanTable';

const VIRTUAL_TIME_NOTE = 'this build delivers a frame synchronously, so the '
  + 'round trip is always 0 ms in virtual time — the threshold is stored and '
  + 'rendered, and is never crossed. The packet-loss threshold IS measured, '
  + 'because a cable carries a loss rate.';

const SDWAN_ZONE: FortiTableSpec = {
  path: ['system', 'sdwan', 'zone'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'Configure SD-WAN zones.',
  attributes: [
    { ...word('name', 'Zone name.'), readOnly: true },
    text('service-sla-tie-break', 'How a tie between members is broken.'),
  ],
};

const SDWAN_MEMBER: FortiTableSpec = {
  path: ['system', 'sdwan', 'members'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 2,
  help: 'FortiGate interfaces added to the SD-WAN.',
  attributes: [
    { ...word('seq-num', 'Sequence number.'), readOnly: true },
    reference('interface', 'Interface name.', ['system interface']),
    address('gateway', 'Gateway IP reached through this member.', '0.0.0.0'),
    count('priority', 'Administrative priority — lowest wins.', 0, 65535, 1),
    reference('zone', 'Zone this member belongs to.', ['system sdwan zone']),
    enable('status', 'Enable/disable this member.', true),
    text('comment', 'Comments.'),
  ],
};

const SDWAN_SLA: FortiTableSpec = {
  path: ['system', 'sdwan', 'health-check', 'sla'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'Service level agreement (SLA).',
  attributes: [
    { ...word('id', 'SLA identifier.'), readOnly: true },
    {
      ...count('latency-threshold', `Maximum latency in milliseconds. ${VIRTUAL_TIME_NOTE}`,
        0, 10000000, 5),
      unimplemented: undefined,
    },
    count('jitter-threshold', `Maximum jitter in milliseconds. ${VIRTUAL_TIME_NOTE}`,
      0, 10000000, 5),
    count('packetloss-threshold', 'Maximum packet loss, in percent.', 0, 100, 0),
  ],
};

const SDWAN_HEALTH_CHECK: FortiTableSpec = {
  path: ['system', 'sdwan', 'health-check'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 3,
  help: 'SD-WAN status checking or health checking.',
  attributes: [
    { ...word('name', 'Health check name.'), readOnly: true },
    {
      name: 'server',
      help: 'Servers this check probes; the next one is used when the previous '
        + 'does not answer.',
      quoted: true,
      multiValue: true,
      parts: [{
        name: 'server', type: 'IP_ADDR',
        description: 'IPv4 address of a server to probe.',
      }],
      defaultValue: [],
    },
    {
      ...choice('protocol', 'Protocol used to determine if the server is up.', [
        { keyword: 'ping', description: 'ICMP echo.' },
        { keyword: 'http', description: 'HTTP GET.' },
        { keyword: 'dns', description: 'DNS query.' },
      ], 'ping'),
      unimplementedValues: {
        http: 'only `ping` probes the server in this build; an HTTP probe would '
          + 'need a health-check target that serves HTTP.',
        dns: 'only `ping` probes the server in this build; a DNS probe would '
          + 'need a health-check target that answers queries.',
      },
    },
    count('port', 'Port the check connects to.', 0, 65535, 0),
    count('interval', 'Milliseconds between probes.', 20, 3600000, 500),
    count('probe-count', 'Probes sent per round.', 5, 30, 5),
    count('failtime', 'Consecutive failures before the member is dead.', 1, 3600, 5),
    count('recoverytime', 'Consecutive successes before it is alive again.', 1, 3600, 5),
    enable('update-static-route',
      'Withdraw the static route of a member the health check declares dead.', true),
    {
      name: 'members',
      help: 'Member sequence numbers this check watches.',
      quoted: false,
      multiValue: true,
      parts: [{
        name: 'seq-num', type: 'INT', range: [1, 512] as [number, number],
        description: 'Sequence number of a declared member.',
      }],
      defaultValue: [],
    },
  ],
  children: [SDWAN_SLA],
};

const SDWAN_SERVICE_SLA: FortiTableSpec = {
  path: ['system', 'sdwan', 'service', 'sla'],
  kind: 'table',
  keyType: 'name',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'Service level agreement (SLA).',
  attributes: [
    { ...word('health-check', 'Health check this rule reads.'), readOnly: true },
    count('id', 'SLA identifier within that health check.', 0, 4294967295, 0),
  ],
};

const SDWAN_SERVICE: FortiTableSpec = {
  path: ['system', 'sdwan', 'service'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 4,
  help: 'Create SD-WAN rules to steer traffic.',
  attributes: [
    { ...word('id', 'Rule identifier.'), readOnly: true },
    { ...text('name', 'Rule name.'), quoted: true },
    choice('mode', 'How the outgoing member is chosen.', [
      { keyword: 'auto', description: 'Lowest cost.' },
      { keyword: 'manual', description: 'The first priority member, health ignored.' },
      { keyword: 'priority', description: 'Best quality by priority order.' },
      { keyword: 'sla', description: 'First member meeting the SLA.' },
      { keyword: 'load-balance', description: 'Spread across members.' },
    ], 'auto'),
    refList('src', 'Source addresses this rule matches.', ['firewall address']),
    refList('dst', 'Destination addresses this rule matches.', ['firewall address']),
    {
      name: 'priority-members',
      help: 'Member sequence numbers, in order of preference.',
      quoted: false,
      multiValue: true,
      parts: [{
        name: 'seq-num', type: 'INT', range: [1, 512] as [number, number],
        description: 'Sequence number of a declared member.',
      }],
      defaultValue: [],
    },
  ],
  children: [SDWAN_SERVICE_SLA],
};

export const SYSTEM_SDWAN: FortiTableSpec = {
  path: ['system', 'sdwan'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 245,
  help: 'Configure redundant Internet connections with multiple outbound links.',
  attributes: [
    enable('status', 'Enable/disable SD-WAN.'),
    choice('load-balance-mode', 'How traffic is spread when several members serve.', [
      { keyword: 'source-ip-based', description: 'By source address.' },
      { keyword: 'weight-based', description: 'By weight.' },
      { keyword: 'usage-based', description: 'By spillover.' },
      { keyword: 'source-dest-ip-based', description: 'By source and destination.' },
    ], 'source-ip-based'),
    count('neighbor-hold-down-time', 'Seconds a neighbour is held down.', 0, 10000000, 0),
  ],
  children: [SDWAN_ZONE, SDWAN_MEMBER, SDWAN_HEALTH_CHECK, SDWAN_SERVICE],
  onCommit(object, context) {
    for (const member of object.childEntries('members')) {
      const refusal = context.device.refuseBoundInterface(
        member.effective('interface')[0] ?? '', 'system.sdwan');
      if (refusal) return refusal;
    }
    return context.device.applySdwan({
      enabled: object.effective('status')[0] === 'enable',
      zones: object.childEntries('zone').map(zone => zone.key),
      members: object.childEntries('members').map(member => ({
        sequence: Number.parseInt(member.key, 10),
        iface: member.effective('interface')[0] ?? '',
        gateway: member.effective('gateway')[0] ?? '0.0.0.0',
        priority: Number.parseInt(member.effective('priority')[0] ?? '1', 10),
        zone: member.effective('zone')[0] ?? '',
        enabled: member.effective('status')[0] !== 'disable',
      })),
      healthChecks: object.childEntries('health-check').map(check => ({
        name: check.key,
        servers: [...check.effective('server')],
        protocol: (check.effective('protocol')[0] ?? 'ping') as SdwanProtocol,
        port: Number.parseInt(check.effective('port')[0] ?? '0', 10),
        intervalMs: Number.parseInt(check.effective('interval')[0] ?? '500', 10),
        probeCount: Number.parseInt(check.effective('probe-count')[0] ?? '5', 10),
        failtime: Number.parseInt(check.effective('failtime')[0] ?? '5', 10),
        recoverytime: Number.parseInt(check.effective('recoverytime')[0] ?? '5', 10),
        updateStaticRoute: check.effective('update-static-route')[0] !== 'disable',
        members: check.effective('members')
          .map(value => Number.parseInt(value, 10)).filter(Number.isFinite),
        sla: check.childEntries('sla').map(sla => ({
          id: Number.parseInt(sla.key, 10),
          latencyThresholdMs:
            Number.parseInt(sla.effective('latency-threshold')[0] ?? '5', 10),
          jitterThresholdMs:
            Number.parseInt(sla.effective('jitter-threshold')[0] ?? '5', 10),
          packetLossThresholdPercent:
            Number.parseInt(sla.effective('packetloss-threshold')[0] ?? '0', 10),
        })),
      })),
      services: object.childEntries('service').map(service => ({
        id: service.key,
        name: service.effective('name')[0] ?? '',
        mode: (service.effective('mode')[0] ?? 'auto') as SdwanServiceMode,
        sources: [...service.effective('src')],
        destinations: [...service.effective('dst')],
        priorityMembers: service.effective('priority-members')
          .map(value => Number.parseInt(value, 10)).filter(Number.isFinite),
        healthCheck: service.childEntries('sla')[0]?.key ?? '',
        slaId: Number.parseInt(
          service.childEntries('sla')[0]?.effective('id')[0] ?? '0', 10),
      })),
    });
  },
};

export const SDWAN_SPECS: readonly FortiTableSpec[] = Object.freeze([SYSTEM_SDWAN]);
