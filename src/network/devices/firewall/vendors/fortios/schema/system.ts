import {
  address, addressMask, choice, count, enable, reference, refList, text, word,
  type FortiObjectView, type FortiTableSpec,
} from './types';
import {
  MANAGEMENT_SERVICES, type ManagementService,
} from '../../../mgmt/ManagementAccess';
import { resolveFortiTimezone } from './timezones';
import { IPv6Address } from '../../../../../core/types';
import { CONSOLE_BAUD_RATES } from '../../../mgmt/ConsoleSettings';
import { ADMIN_DISCLAIMER_MESSAGES } from '../../../mgmt/LoginBanners';
import {
  CONSERVE_THRESHOLD_MIN, CONSERVE_THRESHOLD_MAX, DEFAULT_CONSERVE_THRESHOLDS,
} from '../../../health/SystemLoad';
import {
  DEFAULT_FRAGMENT_MEM_MB, MIN_FRAGMENT_MEM_MB, MAX_FRAGMENT_MEM_MB,
} from '../../../l3/FragmentReassembly';
import {
  DEFAULT_REUSE_PASSWORD_LIMIT, MIN_REUSE_PASSWORD_LIMIT, MAX_REUSE_PASSWORD_LIMIT,
  DEFAULT_PASSWORD_HISTORY_THRESHOLD, MIN_PASSWORD_HISTORY_THRESHOLD,
  MAX_PASSWORD_HISTORY_THRESHOLD,
} from '../../../identity/PasswordHistory';

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

export function parseIpv6Prefix(
  value: string,
): { address: string; prefixLength: number } | null {
  const [address, length] = value.split('/');
  if (address === undefined || length === undefined) return null;
  const prefixLength = Number.parseInt(length, 10);
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 128) return null;
  try {
    return { address: new IPv6Address(address).toString(), prefixLength };
  } catch {
    return null;
  }
}

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
    enable('admin-https-redirect',
      'Redirect HTTP administrative access to HTTPS.', true),
    reference('admin-server-cert',
      'Server certificate that the HTTPS administrative access presents.',
      ['vpn certificate local'], 'self-sign'),
    enable('revision-backup-on-logout',
      'Enable/disable back-up of the configuration to a revision when an'
      + ' administrator logs out.'),
    {
      ...choice('vdom-mode', 'Virtual domain mode.', [
        { keyword: 'no-vdom', description: 'Disable virtual domains.' },
        { keyword: 'multi-vdom', description: 'Enable multiple virtual domains.' },
        { keyword: 'split-vdom', description: 'Enable split-task virtual domains.' },
      ], 'no-vdom'),
      hidden: true,
    },
    choice('firewall-session-dirty', 'Select how to manage sessions when a policy changes.', [
      { keyword: 'check-all', description: 'Flush all current sessions and re-evaluate.' },
      { keyword: 'check-new', description: 'Keep existing sessions, check new ones.' },
      { keyword: 'check-policy-option', description: 'Use the policy setting.' },
    ], 'check-all'),
    count('memory-use-threshold-extreme',
      'Threshold at which memory usage is considered extreme and new sessions'
      + ' are dropped, in percent of total RAM.',
      CONSERVE_THRESHOLD_MIN, CONSERVE_THRESHOLD_MAX,
      DEFAULT_CONSERVE_THRESHOLDS.extremePercent),
    count('memory-use-threshold-red',
      'Threshold at which memory usage forces the FortiGate to enter conserve'
      + ' mode, in percent of total RAM.',
      CONSERVE_THRESHOLD_MIN, CONSERVE_THRESHOLD_MAX,
      DEFAULT_CONSERVE_THRESHOLDS.redPercent),
    count('memory-use-threshold-green',
      'Threshold at which memory usage forces the FortiGate to leave conserve'
      + ' mode, in percent of total RAM.',
      CONSERVE_THRESHOLD_MIN, CONSERVE_THRESHOLD_MAX,
      DEFAULT_CONSERVE_THRESHOLDS.greenPercent),
    choice('av-failopen', 'Action to take when the antivirus proxy runs low on memory.', [
      { keyword: 'pass', description: 'Bypass the antivirus proxy and let traffic through.' },
      { keyword: 'off', description: 'Block new sessions that need the antivirus proxy.' },
      { keyword: 'one-shot', description: 'Bypass, and keep bypassing after conserve mode ends.' },
    ], 'pass'),
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
    enable('pre-login-banner',
      'Enable/disable the disclaimer shown before the login prompt.'),
    enable('post-login-banner',
      'Enable/disable the disclaimer shown after a successful login.'),
    count('user-history-password-threshold',
      'Number of previous passwords kept for each administrator.',
      MIN_PASSWORD_HISTORY_THRESHOLD, MAX_PASSWORD_HISTORY_THRESHOLD,
      DEFAULT_PASSWORD_HISTORY_THRESHOLD),
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
      adminHttpsRedirect: object.effective('admin-https-redirect')[0] !== 'disable',
      adminServerCertificate: object.effective('admin-server-cert')[0] ?? 'self-sign',
      preLoginBanner: object.effective('pre-login-banner')[0] === 'enable',
      postLoginBanner: object.effective('post-login-banner')[0] === 'enable',
      conserveThresholds: {
        extremePercent: number('memory-use-threshold-extreme',
          DEFAULT_CONSERVE_THRESHOLDS.extremePercent),
        redPercent: number('memory-use-threshold-red',
          DEFAULT_CONSERVE_THRESHOLDS.redPercent),
        greenPercent: number('memory-use-threshold-green',
          DEFAULT_CONSERVE_THRESHOLDS.greenPercent),
      },
      avFailopen: object.effective('av-failopen')[0] ?? 'pass',
      revisionOnLogout:
        object.effective('revision-backup-on-logout')[0] === 'enable',
    });
  },
};

export const SYSTEM_REPLACEMSG_ADMIN: FortiTableSpec = {
  path: ['system', 'replacemsg', 'admin'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 13,
  keyOnConfigLine: true,
  help: 'Replacement messages shown to administrators.',
  predefined: [
    ADMIN_DISCLAIMER_MESSAGES.pre,
    ADMIN_DISCLAIMER_MESSAGES.post,
  ],
  attributes: [
    { ...word('msg-type', 'Message type.'), readOnly: true },
    text('buffer', 'Message text.'),
    choice('header', 'Header type.', [
      { keyword: 'none', description: 'No header.' },
      { keyword: 'http', description: 'HTTP header.' },
      { keyword: '8bit', description: '8-bit header.' },
    ], 'none'),
    choice('format', 'Format flag.', [
      { keyword: 'none', description: 'No format.' },
      { keyword: 'text', description: 'Plain text.' },
      { keyword: 'html', description: 'HTML.' },
    ], 'none'),
  ],
  onCommit(object, context) {
    context.device.applyReplacementMessage(object.key, object.effective('buffer')[0] ?? '');
  },
  onDelete(key, context) {
    context.device.applyReplacementMessage(key, '');
  },
};

export const SYSTEM_PASSWORD_POLICY: FortiTableSpec = {
  path: ['system', 'password-policy'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 12,
  help: 'Configure password policy for locally defined administrator passwords '
    + 'and IPsec pre-shared keys.',
  attributes: [
    enable('status', 'Enable/disable the password policy.'),
    {
      name: 'apply-to',
      help: 'Where the password policy applies.',
      quoted: false,
      multiValue: true,
      defaultValue: ['admin-password'],
      parts: [{
        name: 'apply-to', type: 'ENUM', description: 'Where the policy applies.',
        values: [
          { keyword: 'admin-password', description: 'Administrator passwords.' },
          { keyword: 'ipsec-preshared-key', description: 'IPsec pre-shared keys.' },
        ],
      }],
    },
    count('minimum-length', 'Minimum password length.', 8, 128, 8),
    count('min-lower-case-letter', 'Minimum number of lowercase characters.', 0, 128, 0),
    count('min-upper-case-letter', 'Minimum number of uppercase characters.', 0, 128, 0),
    count('min-non-alphanumeric', 'Minimum number of non-alphanumeric characters.',
      0, 128, 0),
    count('min-number', 'Minimum number of digits.', 0, 128, 0),
    count('min-change-characters',
      'Minimum number of characters that must differ from the old password.', 0, 128, 0),
    enable('expire-status', 'Enable/disable password expiration.'),
    count('expire-day', 'Number of days before an administrator password expires.',
      1, 999, 90),
    enable('reuse-password', 'Enable/disable reuse of a previous password.', true),
    count('reuse-password-limit',
      'Number of the kept passwords that may still be reused.',
      MIN_REUSE_PASSWORD_LIMIT, MAX_REUSE_PASSWORD_LIMIT,
      DEFAULT_REUSE_PASSWORD_LIMIT),
  ],
  onCommit(object, context) {
    const limit = Number.parseInt(object.effective('reuse-password-limit')[0] ?? '', 10);
    if (Number.isNaN(limit)) return;
    return context.device.refuseReuseLimit(limit) ?? undefined;
  },
};

export const SYSTEM_CONSOLE: FortiTableSpec = {
  path: ['system', 'console'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 15,
  help: 'Configure console.',
  attributes: [
    choice('mode', 'Console mode.', [
      { keyword: 'batch', description: 'Batch mode.' },
      { keyword: 'line', description: 'Line mode.' },
    ], 'line'),
    choice('baudrate', 'Console baud rate.',
      CONSOLE_BAUD_RATES.map(rate => ({
        keyword: String(rate), description: `${rate} baud.`,
      })), '9600'),
    choice('output', 'Console output mode.', [
      { keyword: 'standard', description: 'No pause.' },
      { keyword: 'more', description: 'Pause after each screenful.' },
    ], 'more'),
    enable('login', 'Enable/disable login for the console.', true),
    {
      ...enable('fortiexplorer', 'Enable/disable FortiExplorer.'),
      unimplemented: 'this simulator has no USB management port.',
    },
  ],
  onCommit(object, context) {
    context.device.applyConsoleSettings({
      output: object.effective('output')[0] === 'standard' ? 'standard' : 'more',
      mode: object.effective('mode')[0] === 'batch' ? 'batch' : 'line',
      baudrate: Number.parseInt(object.effective('baudrate')[0] ?? '9600', 10),
      login: object.effective('login')[0] !== 'disable',
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
    count('ip-fragment-mem-thresholds',
      'Maximum memory (MB) used to reassemble IPv4/IPv6 fragments.',
      MIN_FRAGMENT_MEM_MB, MAX_FRAGMENT_MEM_MB, DEFAULT_FRAGMENT_MEM_MB),
    { ...addressMask('manageip', 'Transparent mode management IP address and mask.'),
      availableWhen: isTransparent },
    { ...address('gateway', 'Transparent mode default gateway.'),
      availableWhen: isTransparent },
  ],
  onCommit(object, context) {
    const management = object.effective('manageip');
    context.device.applyFragmentMemoryThreshold(Number.parseInt(
      object.effective('ip-fragment-mem-thresholds')[0]
      ?? String(DEFAULT_FRAGMENT_MEM_MB), 10));
    context.device.applyVdomSettings({
      centralNat: object.effective('central-nat')[0] === 'enable',
      opmode: object.effective('opmode')[0] === 'transparent' ? 'transparent' : 'nat',
      manageIP: management[0],
      manageMask: management[1],
      gateway: object.effective('gateway')[0] || undefined,
    });
  },
};

const SYSTEM_INTERFACE_IPV6: FortiTableSpec = {
  path: ['ipv6'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'netgrp',
  renderOrder: 41,
  help: 'IPv6 of interface.',
  attributes: [
    {
      name: 'ip6-address', help: 'Primary IPv6 address prefix of the interface.',
      quoted: false,
      parts: [{
        name: 'prefix', type: 'WORD',
        description: 'IPv6 address and prefix length, <address>/<0-128>.',
      }],
      defaultValue: ['::/0'],
      acceptsValue: (value) => parseIpv6Prefix(value) !== null,
      expectedValue: 'an IPv6 address and prefix length such as `2001:db8::1/64`.',
    },
    {
      name: 'ip6-allowaccess',
      help: 'Allowed management access to the interface over IPv6.',
      quoted: false,
      multiValue: true,
      parts: [{
        name: 'ip6-allowaccess', type: 'ENUM',
        description: 'Permitted types of management access.',
        values: ACCESS_SERVICES,
      }],
      defaultValue: [],
    },
    enable('ip6-send-adv', 'Enable/disable sending router advertisements.'),
    enable('ip6-manage-flag',
      'Enable/disable the managed address configuration flag.'),
    enable('ip6-other-flag', 'Enable/disable the other configuration flag.'),
  ],
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
  children: [SYSTEM_INTERFACE_IPV6],
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
      mtu: object.effective('mtu-override')[0] === 'enable'
        ? Number.parseInt(object.effective('mtu')[0] ?? '', 10) || undefined
        : undefined,
    });
    if (mode === 'dhcp') context.device.acquireDhcpLease(object.key);
    context.device.setCaptivePortalInterface(object.key,
      object.effective('security-mode')[0] === 'captive-portal');

    const prefix = parseIpv6Prefix(object.childSetting('ipv6', 'ip6-address')[0] ?? '');
    if (prefix) {
      context.device.applyIpv6Address(object.key, prefix.address, prefix.prefixLength);
    }
    context.device.applyIpv6AllowAccess(
      object.key, object.childSetting('ipv6', 'ip6-allowaccess'));
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
    for (const iface of object.effective('interface')) {
      const refusal = context.device.refuseBoundInterface(iface, 'system.zone');
      if (refusal) return refusal;
    }
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

export const SYSTEM_DNS_SERVER: FortiTableSpec = {
  path: ['system', 'dns-server'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'sysgrp',
  renderOrder: 61,
  help: 'Configure DNS servers.',
  attributes: [
    {
      ...reference('name', 'DNS server name.', ['system interface']),
      readOnly: true,
    },
    choice('mode', 'DNS server mode.', [
      { keyword: 'recursive', description: 'Answer from the local zones, then recurse.' },
      { keyword: 'non-recursive', description: 'Answer from the local zones only.' },
      { keyword: 'forward-only', description: 'Forward what the local zones do not hold.' },
    ], 'recursive'),
    enable('dnsfilter-profile', 'Enable/disable the DNS filter profile.', false),
  ],
  onCommit(object, context) {
    context.device.applyDnsServerInterface({
      iface: object.key,
      mode: object.effective('mode')[0] ?? 'recursive',
    });
  },
  onDelete(key, context) {
    context.device.removeDnsServerInterface(key);
  },
};

export const SYSTEM_DNS_DATABASE: FortiTableSpec = {
  path: ['system', 'dns-database'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'sysgrp',
  renderOrder: 62,
  help: 'Configure DNS databases.',
  attributes: [
    { ...word('name', 'Zone name.'), readOnly: true },
    enable('status', 'Enable/disable this DNS zone.', true),
    word('domain', 'Domain name.'),
    choice('type', 'Zone type.', [
      { keyword: 'primary', description: 'Primary zone.' },
      { keyword: 'secondary', description: 'Secondary zone.' },
    ], 'primary'),
    choice('view', 'Zone view.', [
      { keyword: 'shadow', description: 'Answer only clients of this FortiGate.' },
      { keyword: 'public', description: 'Answer any client.' },
    ], 'shadow'),
    enable('authoritative', 'Enable/disable authoritative answers.', true),
    address('ip-primary', 'IP address of the primary DNS server.'),
    word('primary-name', 'Domain name of the default DNS server for this zone.'),
    word('contact', 'Email address of the administrator for this zone.'),
  ],
  children: [
    {
      path: ['dns-entry'],
      kind: 'table',
      keyType: 'integer',
      ordered: false,
      scope: 'vdom',
      accessGroup: 'sysgrp',
      renderOrder: 63,
      help: 'DNS entry.',
      attributes: [
        { ...word('id', 'Entry identifier.'), readOnly: true },
        enable('status', 'Enable/disable this entry.', true),
        choice('type', 'Resource record type.', [
          { keyword: 'A', description: 'IPv4 address record.' },
          { keyword: 'AAAA', description: 'IPv6 address record.' },
          { keyword: 'CNAME', description: 'Canonical name record.' },
          { keyword: 'MX', description: 'Mail exchange record.' },
          { keyword: 'NS', description: 'Name server record.' },
        ], 'A'),
        word('hostname', 'Name of the host.'),
        address('ip', 'IPv4 address of the host.'),
        count('ttl', 'Time-to-live in seconds.', 0, 2147483647, 0),
      ],
    },
  ],
  onCommit(object, context) {
    context.device.applyDnsZone({
      name: object.key,
      domain: object.effective('domain')[0] ?? '',
      type: object.effective('type')[0] ?? 'primary',
      authoritative: object.effective('authoritative')[0] !== 'disable',
      primaryName: object.effective('primary-name')[0] ?? '',
      contact: object.effective('contact')[0] ?? '',
      entries: object.childEntries('dns-entry')
        .filter(entry => entry.effective('status')[0] !== 'disable'
          && (entry.effective('type')[0] ?? 'A') === 'A')
        .map(entry => ({
          hostname: entry.effective('hostname')[0] ?? '',
          ip: entry.effective('ip')[0] ?? '0.0.0.0',
          ttl: Number(entry.effective('ttl')[0] ?? '0'),
        })),
    });
  },
  onDelete(key, context) {
    context.device.removeDnsZone(key);
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
    choice('dns-service', 'Options for assigning DNS servers to DHCP clients.', [
      { keyword: 'local', description: 'Use the FortiGate as the DNS server.' },
      { keyword: 'default', description: 'Use the system DNS servers.' },
      { keyword: 'specify', description: 'Use the servers named below.' },
    ], 'specify'),
    address('dns-server1', 'DNS server 1.'),
    address('dns-server2', 'DNS server 2.'),
    word('domain', 'Domain name suffix for the IP addresses that the DHCP server assigns.'),
  ],
  children: [
    {
      path: ['reserved-address'],
      kind: 'table',
      keyType: 'integer',
      ordered: false,
      scope: 'vdom',
      accessGroup: 'sysgrp',
      renderOrder: 72,
      help: 'Options for the DHCP server to assign IP settings to specific MAC addresses.',
      attributes: [
        { ...word('id', 'Reservation identifier.'), readOnly: true },
        address('ip', 'IP address to be reserved for the MAC address.'),
        {
          name: 'mac', help: 'MAC address of the client that will get the reserved IP.',
          quoted: false,
          parts: [{
            name: 'mac', type: 'MAC_ADDR',
            description: 'MAC address of the client.',
          }],
        },
        text('description', 'Description.'),
      ],
    },
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
      dnsService: object.effective('dns-service')[0] ?? 'specify',
      dnsServers: [
        object.effective('dns-server1')[0] ?? '',
        object.effective('dns-server2')[0] ?? '',
      ].filter(server => server.length > 0 && server !== '0.0.0.0'),
      reservations: object.childEntries('reserved-address').map(entry => ({
        ip: entry.effective('ip')[0] ?? '0.0.0.0',
        mac: entry.effective('mac')[0] ?? '',
        description: entry.effective('description')[0] ?? '',
      })),
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
  SYSTEM_PASSWORD_POLICY,
  SYSTEM_REPLACEMSG_ADMIN,
  SYSTEM_CONSOLE,
  SYSTEM_SETTINGS,
  SYSTEM_INTERFACE,
  SYSTEM_ZONE,
  SYSTEM_DNS,
  SYSTEM_DNS_SERVER,
  SYSTEM_DNS_DATABASE,
  SYSTEM_DHCP_SERVER,
  SYSTEM_NTP,
]);
