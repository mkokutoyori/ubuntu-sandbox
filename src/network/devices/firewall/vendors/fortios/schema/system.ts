import {
  address, addressMask, choice, count, enable, reference, refList, text, word,
  type FortiObjectView, type FortiTableSpec,
} from './types';

const ACCESS_SERVICES = [
  { keyword: 'ping', description: 'PING access.' },
  { keyword: 'https', description: 'HTTPS access.' },
  { keyword: 'http', description: 'HTTP access.' },
  { keyword: 'ssh', description: 'SSH access.' },
  { keyword: 'telnet', description: 'TELNET access.' },
  { keyword: 'snmp', description: 'SNMP access.' },
];

function isStatic(object: FortiObjectView): boolean {
  return object.effective('mode')[0] === 'static';
}

function isVlan(object: FortiObjectView): boolean {
  return object.effective('type')[0] === 'vlan';
}

export const SYSTEM_GLOBAL: FortiTableSpec = {
  path: ['system', 'global'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 10,
  help: 'Configure global attributes.',
  attributes: [
    word('hostname', 'FortiGate unit name.', 'FortiGate'),
    word('alias', 'Alias for this FortiGate unit.'),
    count('admintimeout', 'Number of minutes before an idle administrator times out.',
      1, 480, 5),
    count('admin-sport', 'Administrative access port for HTTPS.', 1, 65535, 443),
    count('admin-ssh-port', 'Administrative access port for SSH.', 1, 65535, 22),
    count('admin-port', 'Administrative access port for HTTP.', 1, 65535, 80),
    count('admin-telnet-port', 'Administrative access port for TELNET.', 1, 65535, 23),
    count('admin-lockout-threshold', 'Number of failed login attempts before lockout.',
      1, 10, 3),
    count('admin-lockout-duration', 'Lockout duration in seconds.', 1, 2147483647, 60),
    choice('vdom-mode', 'Virtual domain mode.', [
      { keyword: 'no-vdom', description: 'Disable virtual domains.' },
      { keyword: 'multi-vdom', description: 'Enable multiple virtual domains.' },
      { keyword: 'split-vdom', description: 'Enable split-task virtual domains.' },
    ], 'no-vdom'),
    choice('firewall-session-dirty', 'Select how to manage sessions when a policy changes.', [
      { keyword: 'check-all', description: 'Flush all current sessions and re-evaluate.' },
      { keyword: 'check-new', description: 'Keep existing sessions, check new ones.' },
      { keyword: 'check-policy-option', description: 'Use the policy setting.' },
    ], 'check-all'),
    count('timezone', 'Time zone index.', 0, 86, 4),
    enable('simulator-hints',
      '[simulateur] Ajouter une ligne de diagnostic aux refus.', true),
    {
      ...enable('auto-asic-offload', 'Enable/disable ASIC offloading.'),
      unimplemented: 'ce simulateur n\'a aucun modele d\'acceleration materielle.',
    },
  ],
  onCommit() {},
};

export const SYSTEM_SETTINGS: FortiTableSpec = {
  path: ['system', 'settings'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'sysgrp',
  renderOrder: 20,
  help: 'Configure VDOM settings.',
  attributes: [
    choice('opmode', 'Operating mode.', [
      { keyword: 'nat', description: 'NAT/Route operating mode.' },
      { keyword: 'transparent', description: 'Transparent operating mode.' },
    ], 'nat'),
    choice('inspection-mode', 'Inspection mode for this VDOM.', [
      { keyword: 'proxy', description: 'Proxy based inspection.' },
      { keyword: 'flow', description: 'Flow based inspection.' },
    ], 'flow'),
    choice('ngfw-mode', 'Next Generation Firewall mode.', [
      { keyword: 'profile-based', description: 'Security profiles applied to policies.' },
      { keyword: 'policy-based', description: 'Application and URL are policy criteria.' },
    ], 'profile-based'),
    enable('central-nat', 'Enable/disable central NAT.'),
    address('manageip', 'Transparent mode management IP address.'),
    address('gateway', 'Transparent mode default gateway.'),
  ],
  onCommit(object, context) {
    context.device.applyVdomSettings({
      centralNat: object.effective('central-nat')[0] === 'enable',
    });
  },
};

export const SYSTEM_INTERFACE: FortiTableSpec = {
  path: ['system', 'interface'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'global',
  accessGroup: 'netgrp',
  renderOrder: 40,
  help: 'Configure interfaces.',
  attributes: [
    { ...word('name', 'Interface name.'), readOnly: true },
    word('vdom', 'Interface is in this virtual domain.', 'root'),
    word('alias', 'Alias will be displayed with the interface name.'),
    text('description', 'Description.'),
    choice('role', 'Interface role.', [
      { keyword: 'lan', description: 'Connected to a local network of endpoints.' },
      { keyword: 'wan', description: 'Connected to the Internet.' },
      { keyword: 'dmz', description: 'Connected to a server network.' },
      { keyword: 'undefined', description: 'No specific role.' },
    ], 'undefined'),
    choice('type', 'Interface type.', [
      { keyword: 'physical', description: 'Physical interface.' },
      { keyword: 'vlan', description: 'VLAN sub-interface.' },
      { keyword: 'loopback', description: 'Loopback interface.' },
      { keyword: 'aggregate', description: 'Link aggregate interface.' },
    ], 'physical'),
    { ...reference('interface', 'Parent interface name.', ['system interface']),
      availableWhen: isVlan },
    { ...count('vlanid', 'VLAN ID.', 1, 4094, 0), availableWhen: isVlan },
    choice('mode', 'Addressing mode.', [
      { keyword: 'static', description: 'Static addressing.' },
      { keyword: 'dhcp', description: 'DHCP client addressing.' },
      { keyword: 'pppoe', description: 'PPPoE addressing.' },
    ], 'static'),
    { ...addressMask('ip', 'Interface IPv4 address and subnet mask.',
      ['0.0.0.0', '0.0.0.0']), availableWhen: isStatic },
    {
      name: 'allowaccess',
      help: 'Permitted types of management access to this interface.',
      quoted: false,
      multiValue: true,
      parts: [{
        name: 'allowaccess', type: 'ENUM',
        description: 'Permitted types of management access.',
        values: ACCESS_SERVICES,
      }],
      defaultValue: [],
    },
    choice('status', 'Bring the interface up or shut it down.', [
      { keyword: 'up', description: 'Bring the interface up.' },
      { keyword: 'down', description: 'Shut down the interface.' },
    ], 'up'),
    enable('mtu-override', 'Enable to set a custom MTU for this interface.'),
    count('mtu', 'MTU value for this interface.', 68, 9216, 1500),
  ],
  onCommit(object, context) {
    const mode = object.effective('mode')[0];
    const ip = mode === 'static' ? object.effective('ip') : [];
    context.device.applyInterface(object.key, {
      ip: ip[0],
      mask: ip[1],
      up: object.effective('status')[0] !== 'down',
      allowAccess: object.effective('allowaccess'),
      type: object.effective('type')[0],
      parent: object.effective('interface')[0],
      vlanId: Number.parseInt(object.effective('vlanid')[0] ?? '', 10) || undefined,
    });
  },
};

export const SYSTEM_ZONE: FortiTableSpec = {
  path: ['system', 'zone'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 50,
  help: 'Configure zones to group two or more interfaces.',
  attributes: [
    { ...word('name', 'Zone name.'), readOnly: true },
    refList('interface', 'Add interfaces to this zone.', ['system interface']),
    choice('intrazone', 'Allow or deny traffic routing between interfaces of this zone.', [
      { keyword: 'allow', description: 'Allow intra-zone traffic.' },
      { keyword: 'deny', description: 'Deny intra-zone traffic.' },
    ], 'deny'),
    text('description', 'Description.'),
  ],
  onCommit(object, context) {
    context.device.applyZone(object.key, object.effective('interface'),
      object.effective('intrazone')[0]);
  },
  onDelete(key, context) {
    context.device.removeZone(key);
  },
};

export const SYSTEM_DNS: FortiTableSpec = {
  path: ['system', 'dns'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'sysgrp',
  renderOrder: 60,
  help: 'Configure DNS.',
  attributes: [
    address('primary', 'Primary DNS server IP address.', '96.45.45.45'),
    address('secondary', 'Secondary DNS server IP address.', '96.45.46.46'),
    word('domain', 'Search suffix list for hostname lookup.'),
  ],
  onCommit() {},
};

export const SYSTEM_DHCP_SERVER: FortiTableSpec = {
  path: ['system', 'dhcp', 'server'],
  kind: 'table',
  keyType: 'integer',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'sysgrp',
  renderOrder: 70,
  help: 'Configure DHCP servers.',
  attributes: [
    enable('status', 'Enable/disable this DHCP configuration.', true),
    reference('interface', 'DHCP server can assign IP configurations to clients '
      + 'connected to this interface.', ['system interface']),
    address('default-gateway', 'Default gateway IP address assigned by the DHCP server.'),
    address('netmask', 'Netmask assigned by the DHCP server.'),
    count('lease-time', 'Lease time in seconds, 0 means unlimited.', 0, 8640000, 604800),
    address('dns-server1', 'DNS server 1.'),
    word('domain', 'Domain name suffix for the IP addresses that the DHCP server assigns.'),
  ],
  children: [
    {
      path: ['ip-range'],
      kind: 'table',
      keyType: 'integer',
      ordered: false,
      scope: 'vdom',
      accessGroup: 'sysgrp',
      renderOrder: 71,
      help: 'DHCP IP range configuration.',
      attributes: [
        address('start-ip', 'Start of IP range.'),
        address('end-ip', 'End of IP range.'),
      ],
    },
  ],
  onCommit() {},
};

export const SYSTEM_SPECS: readonly FortiTableSpec[] = Object.freeze([
  SYSTEM_GLOBAL,
  SYSTEM_SETTINGS,
  SYSTEM_INTERFACE,
  SYSTEM_ZONE,
  SYSTEM_DNS,
  SYSTEM_DHCP_SERVER,
]);
