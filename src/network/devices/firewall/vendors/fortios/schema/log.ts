import {
  address, choice, count, enable, reference, word,
  type FortiTableSpec,
} from './types';
import { DEFAULT_LOG_FULL_THRESHOLDS } from '../../../logging/LogFullEvent';

const SEVERITIES = [
  { keyword: 'emergency', description: 'Emergency level.' },
  { keyword: 'alert', description: 'Alert level.' },
  { keyword: 'critical', description: 'Critical level.' },
  { keyword: 'error', description: 'Error level.' },
  { keyword: 'warning', description: 'Warning level.' },
  { keyword: 'notification', description: 'Notification level.' },
  { keyword: 'information', description: 'Information level.' },
  { keyword: 'debug', description: 'Debug level.' },
];

const NO_TLS_SYSLOG = 'the syslog agent opens plain TCP only, and the collectors here have no '
  + 'TLS syslog listener to answer a handshake.';

const NO_JSON_LOG = 'no JSON layout of a FortiOS log record is attested in the reference or in a '
  + 'captured transcript, and inventing the field order and typing would be a guess.';

const FACILITIES = [
  { keyword: 'kernel', description: 'Kernel messages.' },
  { keyword: 'user', description: 'Random user-level messages.' },
  { keyword: 'mail', description: 'Mail system.' },
  { keyword: 'daemon', description: 'System daemons.' },
  { keyword: 'auth', description: 'Security/authorization messages.' },
  { keyword: 'syslog', description: 'Messages generated internally by syslog.' },
  { keyword: 'lpr', description: 'Line printer subsystem.' },
  { keyword: 'news', description: 'Network news subsystem.' },
  { keyword: 'uucp', description: 'Network news subsystem.' },
  { keyword: 'cron', description: 'Clock daemon.' },
  { keyword: 'authpriv', description: 'Security/authorization messages (private).' },
  { keyword: 'ftp', description: 'FTP daemon.' },
  { keyword: 'ntp', description: 'NTP daemon.' },
  { keyword: 'audit', description: 'Log audit.' },
  { keyword: 'alert', description: 'Log alert.' },
  { keyword: 'clock', description: 'Clock daemon.' },
  ...[0, 1, 2, 3, 4, 5, 6, 7].map(index => ({ keyword: `local${index}`, description: 'Reserved for local use.' })),
];

const FORMATS = [
  { keyword: 'default', description: 'Syslog format in key=value pairs.' },
  { keyword: 'csv', description: 'Syslog format in comma separated values.' },
  { keyword: 'cef', description: 'Common Event Format.' },
  { keyword: 'rfc5424', description: 'RFC 5424 syslog format.' },
  { keyword: 'json', description: 'JSON (JavaScript Object Notation) format.' },
];

function syslogSetting(
  collector: string, renderOrder: number,
): FortiTableSpec {
  return {
    path: ['log', collector, 'setting'],
    kind: 'object',
    scope: 'vdom',
    accessGroup: 'loggrp',
    renderOrder,
    help: 'Global settings for remote syslog server.',
    attributes: [
      enable('status', 'Enable/disable remote syslog logging.'),
      word('server', 'Address of the remote syslog server.'),
      count('port', 'Server listen port.', 0, 65535, 514),
      choice('mode', 'Remote syslog logging over UDP/Reliable TCP.', [
        { keyword: 'udp', description: 'Enable syslogging over UDP.' },
        { keyword: 'legacy-reliable', description: 'Enable legacy reliable syslogging.' },
        { keyword: 'reliable', description: 'Enable reliable syslogging (RFC 6587).' },
      ], 'udp'),
      choice('facility', 'Remote syslog facility.', FACILITIES, 'local7'),
      { ...choice('format', 'Log format.', FORMATS, 'default'), unimplementedValues: { json: NO_JSON_LOG } },
      {
        ...address('source-ip', 'Source IP address of syslog.'),
        unimplemented: 'the syslog agent stamps the address of the egress or named interface; '
          + 'it has no per-collector source address, and a reliable (TCP) collector would ignore it.',
      },
      reference('interface', 'Specify outgoing interface to reach server.',
        ['system interface']),
      {
        ...choice('enc-algorithm', 'Enable/disable reliable syslogging with TLS encryption.', [
          { keyword: 'high-medium', description: 'SSL communication with high and medium encryption algorithms.' },
          { keyword: 'high', description: 'SSL communication with high encryption algorithms.' },
          { keyword: 'low', description: 'SSL communication with low encryption algorithms.' },
          { keyword: 'disable', description: 'Disable SSL communication.' },
        ], 'disable'),
        unimplementedValues: {
          'high-medium': NO_TLS_SYSLOG, high: NO_TLS_SYSLOG, low: NO_TLS_SYSLOG,
        },
      },
    ],
    onCommit(object, context) {
      return context.device.applySyslogCollector({
        collector,
        enabled: object.effective('status')[0] === 'enable',
        server: object.effective('server')[0] ?? '',
        port: Number.parseInt(object.effective('port')[0] ?? '514', 10),
        transport: object.effective('mode')[0] === 'udp' ? 'udp' : 'tcp',
        facility: object.effective('facility')[0] ?? 'local7',
        format: object.effective('format')[0] ?? 'default',
        sourceInterface: object.effective('interface')[0] ?? '',
      });
    },
  };
}

function syslogFilter(collector: string, renderOrder: number): FortiTableSpec {
  return {
    path: ['log', collector, 'filter'],
    kind: 'object',
    scope: 'vdom',
    accessGroup: 'loggrp',
    renderOrder,
    help: 'Filters for remote system server.',
    attributes: [
      choice('severity', 'Lowest severity level to log.', SEVERITIES, 'information'),
      enable('forward-traffic', 'Enable/disable forward traffic logging.', true),
      enable('local-traffic', 'Enable/disable local in or out traffic logging.'),
      enable('multicast-traffic', 'Enable/disable multicast traffic logging.', true),
      {
        ...enable('sniffer-traffic', 'Enable/disable sniffer traffic logging.', true),
        unimplemented: 'this simulator has no `config firewall sniffer`, so no '
          + 'sniffer log exists to filter',
      },
    ],
    onCommit(object, context) {
      return context.device.applySyslogFilter({
        collector,
        severity: object.effective('severity')[0] ?? 'information',
        forwardTraffic: object.effective('forward-traffic')[0] !== 'disable',
        localTraffic: object.effective('local-traffic')[0] === 'enable',
        multicastTraffic: object.effective('multicast-traffic')[0] !== 'disable',
      });
    },
  };
}

export const SYSLOG_COLLECTORS: readonly FortiTableSpec[] = Object.freeze([
  syslogSetting('syslogd', 300), syslogFilter('syslogd', 301),
  syslogSetting('syslogd2', 310), syslogFilter('syslogd2', 311),
  syslogSetting('syslogd3', 320), syslogFilter('syslogd3', 321),
  syslogSetting('syslogd4', 330), syslogFilter('syslogd4', 331),
]);

export const LOG_MEMORY_SETTING: FortiTableSpec = {
  path: ['log', 'memory', 'setting'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'loggrp',
  renderOrder: 340,
  help: 'Settings for memory buffer.',
  attributes: [
    enable('status', 'Enable/disable logging to the FortiGate memory.', true),
    count('diskfull', 'Action to take when memory is full.', 0, 1, 0),
  ],
  onCommit(object, context) {
    context.device.applyMemoryLog({
      enabled: object.effective('status')[0] !== 'disable',
    });
  },
};

export const LOG_MEMORY_GLOBAL_SETTING: FortiTableSpec = {
  path: ['log', 'memory', 'global-setting'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'loggrp',
  renderOrder: 350,
  help: 'Global settings for memory logging.',
  attributes: [
    count('max-size', 'Maximum memory used for logging, in bytes.',
      0, 4294967295, 98304),
    count('full-first-warning-threshold',
      'Log full first warning threshold as a percentage.', 1, 98, 75),
    count('full-second-warning-threshold',
      'Log full second warning threshold as a percentage.', 2, 99, 90),
    count('full-final-warning-threshold',
      'Log full final warning threshold as a percentage.', 3, 100, 95),
  ],
  onCommit(object, context) {
    const bytes = Number.parseInt(object.effective('max-size')[0] ?? '', 10);
    const percent = (name: string, byDefault: number): number => {
      const value = Number.parseInt(object.effective(name)[0] ?? '', 10);
      return Number.isFinite(value) ? value : byDefault;
    };
    context.device.applyMemoryLog({
      maxBytes: Number.isFinite(bytes) ? bytes : undefined,
      fullThresholds: {
        first: percent('full-first-warning-threshold',
          DEFAULT_LOG_FULL_THRESHOLDS.first),
        second: percent('full-second-warning-threshold',
          DEFAULT_LOG_FULL_THRESHOLDS.second),
        final: percent('full-final-warning-threshold',
          DEFAULT_LOG_FULL_THRESHOLDS.final),
      },
    });
  },
};

export const LOG_DISK_SETTING: FortiTableSpec = {
  path: ['log', 'disk', 'setting'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'loggrp',
  renderOrder: 355,
  help: 'Settings for local disk logging.',
  attributes: [
    count('max-policy-packet-capture-size',
      'Maximum size of policy sniffer in MB, 0 for unlimited.',
      0, 4294967295, 0),
  ],
  onCommit(object, context) {
    context.device.applyPolicyCaptureSize(Number.parseInt(
      object.effective('max-policy-packet-capture-size')[0] ?? '0', 10));
  },
};

export const LOG_SETTING: FortiTableSpec = {
  path: ['log', 'setting'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'loggrp',
  renderOrder: 360,
  help: 'Configure general log settings.',
  attributes: [
    enable('fwpolicy-implicit-log',
      'Enable/disable implicit firewall policy logging.'),
    enable('local-in-allow', 'Enable/disable local-in-allow logging.'),
    enable('local-in-deny-unicast', 'Enable/disable local-in-deny-unicast logging.'),
    enable('local-in-deny-broadcast', 'Enable/disable local-in-deny-broadcast logging.'),
    enable('local-out', 'Enable/disable local-out logging.'),
    enable('log-invalid-packet', 'Enable/disable invalid packet traffic logging.'),
    {
      ...enable('resolve-ip',
        'Enable/disable adding resolved domain names to traffic logs.'),
      unimplemented: 'this simulator resolves names forward only, so a traffic '
        + 'log has no name to add to an address',
    },
  ],
  onCommit(object, context) {
    context.device.applyLogSettings({
      implicitPolicyLog: object.effective('fwpolicy-implicit-log')[0] === 'enable',
      invalidPacket: object.effective('log-invalid-packet')[0] === 'enable',
      localInAllow: object.effective('local-in-allow')[0] === 'enable',
      localInDenyUnicast: object.effective('local-in-deny-unicast')[0] === 'enable',
      localInDenyBroadcast: object.effective('local-in-deny-broadcast')[0] === 'enable',
      localOut: object.effective('local-out')[0] === 'enable',
    });
  },
};

export const LOG_SPECS: readonly FortiTableSpec[] = Object.freeze([
  ...SYSLOG_COLLECTORS,
  LOG_DISK_SETTING,
  LOG_MEMORY_SETTING,
  LOG_MEMORY_GLOBAL_SETTING,
  LOG_SETTING,
]);
