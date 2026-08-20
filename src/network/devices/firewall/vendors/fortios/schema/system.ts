import {
  address, addressMask, choice, count, enable, reference, refList, text, word,
  type FortiObjectView, type FortiTableSpec,
} from './types';
import {
  MANAGEMENT_SERVICES, type ManagementService,
} from '../../../mgmt/ManagementAccess';
import { resolveFortiTimezone } from './timezones';

const ACCESS_SERVICE_HELP: Readonly<Record<ManagementService, string>> = Object.freeze({
  ping: 'PING access.',
  https: 'HTTPS access.',
  http: 'HTTP access.',
  ssh: 'SSH access.',
  telnet: 'TELNET access.',
  snmp: 'SNMP access.',
});

const ACCESS_SERVICES = MANAGEMENT_SERVICES.map(service => ({
  keyword: service, description: ACCESS_SERVICE_HELP[service],
}));

function isStatic(object: FortiObjectView): boolean {
  return object.effective('mode')[0] === 'static' && isRouted(object);
}

function isRouted(object: FortiObjectView): boolean {
  return object.setting('system settings', 'opmode')[0] !== 'transparent';
}

function isTransparent(object: FortiObjectView): boolean {
  return object.effective('opmode')[0] === 'transparent';
}

export function interfaceType(object: FortiObjectView): string {
  if (object.isExplicit('type')) return object.effective('type')[0] ?? 'physical';
  return object.hasPhysicalKey() ? 'physical' : 'vlan';
}

function isVlan(object: FortiObjectView): boolean {
  return interfaceType(object) === 'vlan';
}

export const SYSTEM_GLOBAL: FortiTableSpec = {
  path: ['system', 'global'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 10,
  help: 'Configure global attributes.',
  attributes: [
    {
      ...word('hostname', 'FortiGate unit name.', 'FortiGate'),
      appliesImmediately: (values, context) => {
        context.device.applyHostname(values[0] ?? '');
      },
    },
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
    count('auth-http-port', 'Port the captive portal answers HTTP on.', 1, 65535, 1000),
    count('auth-https-port', 'Port the captive portal answers HTTPS on.', 1, 65535, 1003),
    {
      name: 'timezone',
      help: 'Time zone.',
      quoted: false,
      parts: [{
        name: 'timezone', type: 'WORD',
        description: 'Time zone index or IANA name.',
      }],
      defaultValue: ['4'],
      acceptsValue: (value) => resolveFortiTimezone(value) !== null,
      expectedValue: 'a time zone index <0-86> or an IANA name such as `Europe/Paris`.',
    },
    enable('simulator-hints',
      '[simulator] Add a diagnostic line to refusals.', true),
    {
      ...enable('auto-asic-offload', 'Enable/disable ASIC offloading.'),
      unimplemented: 'this simulator has no hardware acceleration model.',
    },
  ],
  onCommit(object, context) {
    const number = (name: string, fallback: number) =>
      Number.parseInt(object.effective(name)[0] ?? '', 10) || fallback;

    context.device.applyGlobalSettings({
      hostname: object.isExplicit('hostname')
        ? object.effective('hostname')[0] : undefined,
      multiVdom: object.effective('vdom-mode')[0] !== 'no-vdom',
      authHttpPort: number('auth-http-port', 1000),
      authHttpsPort: number('auth-https-port', 1003),
      adminSshPort: number('admin-ssh-port', 22),
      adminTelnetPort: number('admin-telnet-port', 23),
      adminHttpPort: number('admin-port', 80),
      adminHttpsPort: number('admin-sport', 443),
      adminTimeoutMin: number('admintimeout', 5),
      timezone: object.isExplicit('timezone')
        ? object.effective('timezone')[0] : undefined,
      adminLockoutThreshold: number('admin-lockout-threshold', 3),
      adminLockoutDurationSec: number('admin-lockout-duration', 60),
    });
  },
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
    { ...enable('central-nat', 'Enable/disable central NAT.'),
      availableWhen: (object) => !isTransparent(object) },
    { ...addressMask('manageip', 'Transparent mode management IP address and mask.'),
      availableWhen: isTransparent },
    { ...address('gateway', 'Transparent mode default gateway.'),
      availableWhen: isTransparent },
  ],
  onCommit(object, context) {
    const management = object.effective('manageip');
    context.device.applyVdomSettings({
      centralNat: object.effective('central-nat')[0] === 'enable',
      opmode: object.effective('opmode')[0] === 'transparent' ? 'transparent' : 'nat',
      manageIP: management[0],
      manageMask: management[1],
      gateway: object.effective('gateway')[0] || undefined,
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
    { ...word('vdom', 'Interface is in this virtual domain.', 'root'),
      referenceTo: ['vdom'] },
    word('alias', 'Alias will be displayed with the interface name.'),
    text('description', 'Description.'),
    choice('role', 'Interface role.', [
      { keyword: 'lan', description: 'Connected to a local network of endpoints.' },
      { keyword: 'wan', description: 'Connected to the Internet.' },
      { keyword: 'dmz', description: 'Connected to a server network.' },
      { keyword: 'undefined', description: 'No specific role.' },
    ], 'undefined'),
    {
      ...choice('type', 'Interface type.', [
        { keyword: 'physical', description: 'Physical interface.' },
        { keyword: 'vlan', description: 'VLAN sub-interface.' },
        { keyword: 'loopback', description: 'Loopback interface.' },
        { keyword: 'aggregate', description: 'Link aggregate interface.' },
      ], 'physical'),
      availableWhen: (object) => !object.hasPhysicalKey(),
    },
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
    choice('security-mode', 'Turn on the captive portal for this interface.', [
      { keyword: 'none', description: 'No captive portal.' },
      { keyword: 'captive-portal', description: 'Capture unauthenticated HTTP.' },
    ], 'none'),
    enable('mtu-override', 'Enable to set a custom MTU for this interface.'),
    count('mtu', 'MTU value for this interface.', 68, 9216, 1500),
  ],
  onCommit(object, context) {
    const mode = object.effective('mode')[0];
    const ip = mode === 'static' && isRouted(object) ? object.effective('ip') : [];
    context.device.applyInterface(object.key, {
      vdom: object.effective('vdom')[0],
      ip: ip[0],
      mask: ip[1],
      up: object.effective('status')[0] !== 'down',
      allowAccess: object.effective('allowaccess'),
      type: interfaceType(object),
      parent: object.effective('interface')[0],
      vlanId: Number.parseInt(object.effective('vlanid')[0] ?? '', 10) || undefined,
    });
    if (mode === 'dhcp') context.device.acquireDhcpLease(object.key);
    context.device.setCaptivePortalInterface(object.key,
      object.effective('security-mode')[0] === 'captive-portal');
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
  onCommit(object, context) {
    context.device.applyDnsSettings({
      primary: object.effective('primary')[0] ?? '',
      secondary: object.effective('secondary')[0] ?? '',
      domain: object.effective('domain')[0] ?? '',
    });
  },
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
    {
      name: 'id', help: 'ID.', quoted: false, readOnly: true,
      parts: [{ name: 'id', type: 'INT', description: 'ID.', range: [0, 65535] }],
    },
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
        { ...word('id', 'Range identifier.'), readOnly: true },
        address('start-ip', 'Start of IP range.'),
        address('end-ip', 'End of IP range.'),
      ],
    },
  ],
  onCommit(object, context) {
    context.device.applyDhcpScope({
      id: object.key,
      enabled: object.effective('status')[0] !== 'disable',
      iface: object.effective('interface')[0] ?? '',
      defaultGateway: object.effective('default-gateway')[0] ?? '0.0.0.0',
      netmask: object.effective('netmask')[0] ?? '0.0.0.0',
      dnsServers: [object.effective('dns-server1')[0] ?? '']
        .filter(server => server.length > 0 && server !== '0.0.0.0'),
      domain: object.effective('domain')[0] ?? '',
      leaseTimeSec: Number.parseInt(object.effective('lease-time')[0] ?? '604800', 10),
      ranges: object.childEntries('ip-range').map(range => ({
        startIp: range.effective('start-ip')[0] ?? '0.0.0.0',
        endIp: range.effective('end-ip')[0] ?? '0.0.0.0',
      })),
    });
  },
  onDelete(key, context) {
    context.device.removeDhcpScope(key);
  },
};

export const SYSTEM_NTP: FortiTableSpec = {
  path: ['system', 'ntp'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 75,
  help: 'Configure system NTP information.',
  attributes: [
    enable('ntpsync', 'Enable/disable setting the FortiGate clock by NTP.'),
    choice('type', 'Use FortiGuard or a custom NTP server.', [
      { keyword: 'fortiguard', description: 'Use the FortiGuard NTP servers.' },
      { keyword: 'custom', description: 'Use the servers configured below.' },
    ], 'fortiguard'),
    count('syncinterval', 'NTP synchronization interval, in minutes.', 1, 1440, 60),
    reference('source-ip-interface', 'Interface the NTP requests leave by.',
      ['system interface']),
  ],
  children: [
    {
      path: ['ntpserver'],
      kind: 'table',
      keyType: 'integer',
      ordered: false,
      scope: 'global',
      accessGroup: 'sysgrp',
      renderOrder: 76,
      help: 'Configure the NTP servers.',
      attributes: [
        { ...word('id', 'NTP server ID.'), readOnly: true },
        word('server', 'IP address or hostname of the NTP server.'),
      ],
    },
  ],
  onCommit(object, context) {
    const servers = object.childEntries('ntpserver')
      .map(entry => entry.effective('server')[0] ?? '')
      .filter(server => server.length > 0);
    const enabled = object.effective('ntpsync')[0] === 'enable';

    if (enabled && object.effective('type')[0] === 'custom' && servers.length === 0) {
      return 'a custom NTP configuration needs at least one server.';
    }

    return context.device.applyNtp({
      enabled,
      servers,
      syncIntervalMin: Number.parseInt(object.effective('syncinterval')[0] ?? '60', 10),
      sourceInterface: object.effective('source-ip-interface')[0] ?? '',
    });
  },
};

export const SYSTEM_SPECS: readonly FortiTableSpec[] = Object.freeze([
  SYSTEM_GLOBAL,
  SYSTEM_SETTINGS,
  SYSTEM_INTERFACE,
  SYSTEM_ZONE,
  SYSTEM_DNS,
  SYSTEM_DHCP_SERVER,
  SYSTEM_NTP,
]);
