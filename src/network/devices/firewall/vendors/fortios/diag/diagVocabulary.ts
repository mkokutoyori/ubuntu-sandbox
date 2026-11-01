import type { EnumValue } from '../../../../../../cli/ArgumentTypes';
import { DHCP_DEBUG_APPLICATIONS } from '../../../l3/DhcpDebug';

const ENABLE_OR_DISABLE = '`enable` or `disable`';

export const SESSION_FILTER_HELP: ReadonlyArray<readonly [string, string, string]> = Object.freeze([
  ['src', 'Source address.', '<address>'],
  ['dst', 'Destination address.', '<address>'],
  ['sport', 'Source port.', '<port>'],
  ['dport', 'Destination port.', '<port>'],
  ['proto', 'IP protocol number.', '<number>'],
  ['policy', 'Policy ID.', '<id>'],
  ['vd', 'Virtual domain index.', '<index>'],
]);

export const FLOW_FILTER_HELP: ReadonlyArray<readonly [string, string, string]> = Object.freeze([
  ['vd', 'Virtual domain index.', '<index>'],
  ['addr', 'Address, source or destination.', '<address>'],
  ['saddr', 'Source address.', '<address>'],
  ['daddr', 'Destination address.', '<address>'],
  ['port', 'Port, source or destination.', '<port>'],
  ['sport', 'Source port.', '<port>'],
  ['dport', 'Destination port.', '<port>'],
  ['proto', 'IP protocol number.', '<number>'],
]);

export const AUTH_FILTER_HELP: ReadonlyArray<readonly [string, string, string]> = Object.freeze([
  ['user', 'User name.', '<name>'],
  ['group', 'Group name.', '<name>'],
  ['policy', 'Policy ID.', '<id>'],
]);

function withValue(entries: ReadonlyArray<readonly [string, string, string]>): EnumValue[] {
  return entries.map(([keyword, description, thenWord]) => ({ keyword, description, thenWord }));
}

export function sessionFilterWords(): EnumValue[] {
  return [...withValue(SESSION_FILTER_HELP), { keyword: 'clear', description: 'Clear the filter.' }];
}

export function flowFilterWords(): EnumValue[] {
  return [...withValue(FLOW_FILTER_HELP), { keyword: 'clear', description: 'Clear the filter.' }];
}

export function authFilterWords(): EnumValue[] {
  return [...withValue(AUTH_FILTER_HELP), { keyword: 'clear', description: 'Clear the filter.' }];
}

export function flowTraceWords(): EnumValue[] {
  return [
    { keyword: 'start', description: 'Start tracing.', thenWord: '<count>' },
    { keyword: 'stop', description: 'Stop tracing.' },
  ];
}

export function flowShowWords(): EnumValue[] {
  return [
    { keyword: 'function-name', description: 'Show the function name in each line.', thenWord: ENABLE_OR_DISABLE },
    { keyword: 'console', description: 'Show the trace on the console.', thenWord: ENABLE_OR_DISABLE },
    { keyword: 'iprope', description: 'Show the policy lookup lines.', thenWord: ENABLE_OR_DISABLE },
  ];
}

export function debugConsoleWords(): EnumValue[] {
  return [{ keyword: 'timestamp', description: 'Prefix each debug line with a time stamp.', thenWord: ENABLE_OR_DISABLE }];
}

export function debugApplicationWords(): EnumValue[] {
  return DHCP_DEBUG_APPLICATIONS.map(name => ({
    keyword: name, description: 'Daemon.', thenWord: '<level>, -1 for every message, 0 for none',
  }));
}

export function synchronizeWords(): EnumValue[] {
  return [
    { keyword: 'start', description: 'Start a configuration synchronisation.' },
    { keyword: 'stop', description: 'Stop a configuration synchronisation.' },
  ];
}

export function gatewayClearWords(): EnumValue[] {
  return [{ keyword: 'name', description: 'Gateway to clear.', thenWord: '<gateway>' }];
}

export function testApplicationWords(): EnumValue[] {
  return [
    { keyword: 'dnsproxy', description: 'DNS proxy.', thenWord: '<level>' },
    { keyword: 'miglogd', description: 'Log daemon.', thenWord: '<level>, 54 for the IP conflict cache, 55 for its probes' },
  ];
}

export function logFilterWords(): EnumValue[] {
  return [
    { keyword: 'category', description: 'Restrict the display to one log category.', thenWord: '<category index>' },
    { keyword: 'field', description: 'Match one field of the records.', thenWord: '<field> [value]' },
    { keyword: 'view-lines', description: 'Number of lines displayed.', thenWord: '<count>' },
    { keyword: 'reset', description: 'Reset every criterion.' },
  ];
}
