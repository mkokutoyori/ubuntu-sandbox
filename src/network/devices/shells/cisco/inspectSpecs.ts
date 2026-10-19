import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { CommandSpec } from '@/cli/CommandTable';
import type { OptionSpec } from '@/cli/OptionBag';
import type { CiscoSecurityConfig } from '../../router/security/CiscoSecurityConfig';
import { DEFAULT_INSPECT_SETTINGS, type InspectSettings } from '../../router/security/CbacFirewall';

export interface InspectHost {
  security(): CiscoSecurityConfig;
  selectedInterfaces(): string[];
}

const CONFIG = Object.freeze(['config']);
const INTERFACE = Object.freeze(['config-if', 'config-subif']);

const PROTOCOL_DESCRIPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['icmp', 'Internet Control Message Protocol'],
  ['tcp', 'Transmission Control Protocol'],
  ['udp', 'User Datagram Protocol'],
  ['dns', 'Domain Name Service'],
  ['ftp', 'File Transfer Protocol'],
  ['http', 'HTTP Protocol'],
  ['https', 'Secure HTTP Protocol'],
  ['imap', 'IMAP Protocol'],
  ['isakmp', 'Internet Key Exchange'],
  ['ldap', 'Lightweight Directory Access Protocol'],
  ['ntp', 'Network Time Protocol'],
  ['pop3', 'POP3 Protocol'],
  ['smtp', 'Simple Mail Transfer Protocol'],
  ['snmp', 'Simple Network Management Protocol'],
  ['ssh', 'Secure Shell'],
  ['syslog', 'System Logging Protocol'],
  ['telnet', 'Telnet Protocol'],
  ['tftp', 'Trivial File Transfer Protocol'],
];

const RULE_NAME: ArgumentSpec = {
  name: 'name', type: 'WORD', description: 'Name of the set of inspection rules',
};

const PROTOCOL: ArgumentSpec = {
  name: 'protocol', type: 'ENUM',
  values: PROTOCOL_DESCRIPTIONS.map(([keyword, description]) => ({ keyword, description })),
};

const SESSION_LIMIT: ArgumentSpec = {
  name: 'limit', type: 'INT', range: [1, 2147483647],
  description: 'Maximum number of established sessions the rule may create',
};

const SWITCH: ReadonlyArray<OptionSpec> = [
  { keyword: 'on', description: 'Turn on' },
  { keyword: 'off', description: 'Turn off' },
];

const RULE_OPTIONS: readonly OptionSpec[] = [
  { keyword: 'alert', description: 'Alert messages for this protocol', choices: SWITCH },
  { keyword: 'audit-trail', description: 'Audit trail for this protocol', choices: SWITCH },
  {
    keyword: 'timeout', description: 'Idle timeout for this protocol',
    argument: { name: 'seconds', type: 'INT', range: [1, 2147483], description: 'Idle timeout in seconds' },
  },
];

const SECONDS: ArgumentSpec = {
  name: 'seconds', type: 'INT', range: [1, 2147483], description: 'Timeout in seconds',
};

const SESSIONS: ArgumentSpec = {
  name: 'number', type: 'INT', range: [1, 2147483647], description: 'Number of half-open sessions',
};

const HOST_SESSIONS: ArgumentSpec = {
  name: 'number', type: 'INT', range: [1, 250], description: 'Half-open TCP sessions per host',
};

const BLOCK_MINUTES: ArgumentSpec = {
  name: 'minutes', type: 'INT', range: [0, 35791], description: 'Minutes new connections to the host stay blocked',
};

export function inspectSpecs(host: () => InspectHost): CommandSpec[] {
  const settings = (): InspectSettings => host().security().inspectSettings;
  const reset = <K extends keyof InspectSettings>(key: K) => () => {
    settings()[key] = DEFAULT_INSPECT_SETTINGS[key];
    return '';
  };
  const numeric = (
    id: string, path: Array<string | ArgumentSpec>, key: keyof InspectSettings,
    description: string, undoDescription: string,
  ): CommandSpec => ({
    id, path: ['ip', 'inspect', ...path], description, undoDescription,
    modes: CONFIG, minPrivilege: 15,
    run: (_session, args) => {
      (settings()[key] as number) = Number(args.seconds ?? args.number);
      return '';
    },
    undo: reset(key),
    undoOmitsArguments: true,
  });
  const flag = (
    id: string, path: string[], key: 'alertOff' | 'auditTrail' | 'logDropPkt',
    description: string, undoDescription: string,
  ): CommandSpec => ({
    id, path: ['ip', 'inspect', ...path], description, undoDescription,
    modes: CONFIG, minPrivilege: 15,
    run: () => { settings()[key] = true; return ''; },
    undo: () => { settings()[key] = false; return ''; },
  });
  const defineRule = (
    args: Readonly<Record<string, string>>, limit: number | undefined,
  ): string => {
    const rules = host().security().inspectRules;
    let rule = rules.get(args.name);
    if (!rule) {
      rule = { name: args.name, protocols: new Map() };
      rules.set(args.name, rule);
    }
    if (limit !== undefined) rule.maxSessions = limit;
    if (args.protocol === undefined) return '';
    const options: { alert?: boolean; auditTrail?: boolean; timeoutSec?: number } = {};
    if (args.alert !== undefined) options.alert = args.alert === 'on';
    if (args['audit-trail'] !== undefined) options.auditTrail = args['audit-trail'] === 'on';
    if (args.seconds !== undefined) options.timeoutSec = Number(args.seconds);
    rule.protocols.set(args.protocol, options);
    return '';
  };
  const removeRule = (args: Readonly<Record<string, string>>): string => {
    const rules = host().security().inspectRules;
    if (args.name === undefined) {
      rules.clear();
      return '';
    }
    const rule = rules.get(args.name);
    if (!rule) return '';
    if (args.protocol === undefined) rules.delete(args.name);
    else {
      rule.protocols.delete(args.protocol);
      if (rule.protocols.size === 0) rules.delete(args.name);
    }
    return '';
  };
  const applyInterface = (name: string | null, direction: 'in' | 'out'): string => {
    for (const iface of host().selectedInterfaces()) {
      const flags = host().security().ifaceFlags(iface);
      const field = direction === 'in' ? 'inspectIn' : 'inspectOut';
      if (name === null) delete flags[field];
      else flags[field] = name;
    }
    return '';
  };
  const interfaceBinding = (direction: 'in' | 'out'): CommandSpec => ({
    id: `ip-inspect-interface-${direction}`,
    path: ['ip', 'inspect', RULE_NAME, direction],
    description: direction === 'in'
      ? 'Apply inspection to traffic entering the interface'
      : 'Apply inspection to traffic leaving the interface',
    undoDescription: 'Remove inspection from the interface',
    modes: INTERFACE, minPrivilege: 15,
    run: (_session, args) => applyInterface(args.name, direction),
    undo: () => applyInterface(null, direction),
    undoOmitsArguments: true,
  });
  return [
    {
      id: 'ip-inspect-name',
      path: ['ip', 'inspect', 'name', RULE_NAME, PROTOCOL],
      description: 'Specify an inspection rule for a protocol',
      undoDescription: 'Remove an inspection rule',
      modes: CONFIG, minPrivilege: 15,
      options: RULE_OPTIONS,
      run: (_session, args) => defineRule(args, undefined),
      undo: (_session, args) => removeRule(args),
      undoOmitsArguments: true,
    },
    {
      id: 'ip-inspect-name-session-limit',
      path: ['ip', 'inspect', 'name', RULE_NAME, 'parameter', 'max-sessions', SESSION_LIMIT, PROTOCOL],
      description: 'Specify an inspection rule that limits its established sessions',
      modes: CONFIG, minPrivilege: 15,
      options: RULE_OPTIONS,
      run: (_session, args) => defineRule(args, Number(args.limit)),
    },
    {
      id: 'ip-inspect-name-session-limit-only',
      path: ['ip', 'inspect', 'name', RULE_NAME, 'parameter', 'max-sessions', SESSION_LIMIT],
      description: 'Limit the established sessions of an inspection rule',
      undoDescription: 'Remove the session limit of an inspection rule',
      modes: CONFIG, minPrivilege: 15,
      run: (_session, args) => defineRule(args, Number(args.limit)),
      undo: (_session, args) => {
        const rule = host().security().inspectRules.get(args.name);
        if (rule) delete rule.maxSessions;
        return '';
      },
      undoOmitsArguments: true,
    },
    interfaceBinding('in'),
    interfaceBinding('out'),
    flag('ip-inspect-alert-off', ['alert-off'], 'alertOff',
      'Disable CBAC alert messages', 'Enable CBAC alert messages'),
    flag('ip-inspect-audit-trail', ['audit-trail'], 'auditTrail',
      'Turn on CBAC audit trail messages', 'Turn off CBAC audit trail messages'),
    flag('ip-inspect-log-drop-pkt', ['log', 'drop-pkt'], 'logDropPkt',
      'Log the packets dropped by the firewall', 'Stop logging the packets dropped by the firewall'),
    numeric('ip-inspect-dns-timeout', ['dns-timeout', SECONDS], 'dnsTimeoutSec',
      'Specify the DNS idle timeout', 'Restore the DNS idle timeout of 5 seconds'),
    numeric('ip-inspect-tcp-idle-time', ['tcp', 'idle-time', SECONDS], 'tcpIdleSec',
      'Specify the TCP idle timeout', 'Restore the TCP idle timeout of 3600 seconds'),
    numeric('ip-inspect-tcp-synwait-time', ['tcp', 'synwait-time', SECONDS], 'tcpSynwaitSec',
      'Specify how long to wait for a TCP session to reach the established state',
      'Restore the TCP synwait time of 30 seconds'),
    numeric('ip-inspect-tcp-finwait-time', ['tcp', 'finwait-time', SECONDS], 'tcpFinwaitSec',
      'Specify how long a TCP session is managed after a FIN exchange',
      'Restore the TCP finwait time of 5 seconds'),
    numeric('ip-inspect-udp-idle-time', ['udp', 'idle-time', SECONDS], 'udpIdleSec',
      'Specify the UDP idle timeout', 'Restore the UDP idle timeout of 30 seconds'),
    numeric('ip-inspect-max-incomplete-high', ['max-incomplete', 'high', SESSIONS], 'maxIncompleteHigh',
      'Half-open sessions that start the deletion of half-open sessions',
      'Restore the high mark of 500 half-open sessions'),
    numeric('ip-inspect-max-incomplete-low', ['max-incomplete', 'low', SESSIONS], 'maxIncompleteLow',
      'Half-open sessions that stop the deletion of half-open sessions',
      'Restore the low mark of 400 half-open sessions'),
    numeric('ip-inspect-one-minute-high', ['one-minute', 'high', SESSIONS], 'oneMinuteHigh',
      'Session attempts per minute that start the deletion of half-open sessions',
      'Restore the high mark of 500 attempts per minute'),
    numeric('ip-inspect-one-minute-low', ['one-minute', 'low', SESSIONS], 'oneMinuteLow',
      'Session attempts per minute that stop the deletion of half-open sessions',
      'Restore the low mark of 400 attempts per minute'),
    {
      id: 'ip-inspect-tcp-max-incomplete-host',
      path: ['ip', 'inspect', 'tcp', 'max-incomplete', 'host', HOST_SESSIONS, 'block-time', BLOCK_MINUTES],
      description: 'Specify the half-open TCP threshold per host and the blocking time',
      undoDescription: 'Restore 50 half-open sessions per host and no blocking',
      modes: CONFIG, minPrivilege: 15,
      run: (_session, args) => {
        settings().hostMaxIncomplete = Number(args.number);
        settings().hostBlockMinutes = Number(args.minutes);
        return '';
      },
      undo: () => {
        settings().hostMaxIncomplete = DEFAULT_INSPECT_SETTINGS.hostMaxIncomplete;
        settings().hostBlockMinutes = DEFAULT_INSPECT_SETTINGS.hostBlockMinutes;
        return '';
      },
      undoOmitsArguments: true,
    },
  ];
}
