import type { AsaMode } from './AsaShell';

export const ASA_VOCABULARY: Readonly<Record<AsaMode, readonly string[]>> = Object.freeze({
  exec: Object.freeze(['enable', 'exit']),
  privileged: Object.freeze([
    'clear', 'configure terminal', 'disable', 'exit', 'packet-tracer',
    'show access-list', 'show conn', 'show nameif', 'show nat',
    'show logging', 'show running-config', 'show version', 'show xlate',
  ]),
  config: Object.freeze([
    'access-group', 'access-list', 'end', 'exit', 'hostname', 'interface', 'logging',
    'object network', 'object-group network', 'same-security-traffic',
  ]),
  'config-if': Object.freeze([
    'end', 'exit', 'ip address', 'nameif', 'security-level', 'shutdown',
  ]),
  'config-object': Object.freeze(['end', 'exit', 'host', 'nat', 'range', 'subnet']),
  'config-group': Object.freeze(['end', 'exit', 'network-object object']),
});

export const ASA_COMMAND_HELP: Readonly<Record<string, string>> = Object.freeze({
  'access-group': 'Bind an access list to an interface',
  'access-list': 'Add an access list entry',
  clear: 'Reset connection, translation or counter tables',
  logging: 'Configure syslog',
  'show logging': 'Display the syslog buffer and settings',
  'configure terminal': 'Enter configuration mode',
  disable: 'Return to user EXEC mode',
  enable: 'Enter privileged EXEC mode',
  end: 'Return to privileged EXEC mode',
  exit: 'Leave the current mode',
  host: 'Define the object as a single address',
  hostname: 'Set the device name',
  interface: 'Enter interface configuration mode',
  'ip address': 'Set the interface address and mask',
  nameif: 'Name the interface and set its default security level',
  nat: 'Translate this object',
  'network-object object': 'Add a network object to this group',
  'object network': 'Create or edit a network object',
  'object-group network': 'Create or edit a network object group',
  'packet-tracer': 'Trace a simulated packet through the policy',
  range: 'Define the object as an address range',
  'same-security-traffic': 'Permit traffic between same-security interfaces',
  'security-level': 'Set the interface security level (0-100)',
  'show access-list': 'Display access lists and their hit counts',
  'show conn': 'Display the connection table',
  'show nameif': 'Display interface names and security levels',
  'show nat': 'Display NAT policies in evaluation order',
  'show running-config': 'Display the running configuration',
  'show version': 'Display software version',
  'show xlate': 'Display the translation table',
  shutdown: 'Take the interface down',
  subnet: 'Define the object as a subnet',
});
