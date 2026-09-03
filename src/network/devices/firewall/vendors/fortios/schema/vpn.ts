import { implementedIkeGroups } from '../../../../../ipsec/IkeKeyExchange';
import { parseProposal, SUPPORTED_CIPHERS } from '../../../vpn/IpsecProposals';
import {
  address, addressMask, choice, count, enable, reference, refList, text, word,
  type FortiAttributeSpec, type FortiObjectView, type FortiTableSpec,
} from './types';
import { passwordPolicyRefusal } from './passwordPolicy';

const POLICY_BASED_HINT = 'policy-based IPsec (`config vpn ipsec phase1`, '
  + 'without `-interface`) is the legacy mode: the tunnel is not an interface, '
  + 'so it cannot carry a route and cannot be named in `srcintf`/`dstintf`. '
  + 'Fortinet recommends the route-based mode (`phase1-interface`), which this '
  + 'build implements fully.';

function proposalAttribute(help: string): FortiAttributeSpec {
  return {
    name: 'proposal',
    help,
    quoted: false,
    multiValue: true,
    parts: [{
      name: 'proposal', type: 'WORD',
      description: `A cipher and an integrity algorithm, as in aes256-sha256. `
        + `Ciphers: ${SUPPORTED_CIPHERS.join(', ')}.`,
    }],
    defaultValue: ['aes128-sha256', 'aes256-sha256'],
  };
}

function dhGroupAttribute(): FortiAttributeSpec {
  return {
    name: 'dhgrp',
    help: 'Diffie-Hellman groups, in order of preference.',
    quoted: false,
    multiValue: true,
    parts: [{
      name: 'dhgrp', type: 'ENUM',
      description: 'Diffie-Hellman group this build computes for real.',
      values: implementedIkeGroups().map(group => ({
        keyword: String(group),
        description: `Group ${group}.`,
      })),
    }],
    defaultValue: ['14', '5'],
  };
}

export const VPN_PHASE1_INTERFACE: FortiTableSpec = {
  path: ['vpn', 'ipsec', 'phase1-interface'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'vpngrp',
  renderOrder: 600,
  help: 'Configure VPN remote gateway.',
  attributes: [
    { ...word('name', 'IPsec remote gateway name.'), readOnly: true },
    reference('interface', 'Local physical, aggregate, or VLAN outgoing interface.',
      ['system interface']),
    choice('ike-version', 'IKE protocol version.', [
      { keyword: '1', description: 'IKEv1.' },
      { keyword: '2', description: 'IKEv2.' },
    ], '1'),
    choice('type', 'Remote gateway type.', [
      { keyword: 'static', description: 'Remote gateway has a fixed address.' },
      { keyword: 'dynamic', description: 'Remote gateway dials in.' },
      { keyword: 'ddns', description: 'Remote gateway is named by dynamic DNS.' },
    ], 'static'),
    address('remote-gw', 'Remote VPN gateway address.', '0.0.0.0'),
    choice('peertype', 'Accept this peer type.', [
      { keyword: 'any', description: 'Accept any peer.' },
      { keyword: 'one', description: 'Accept one named peer.' },
      { keyword: 'dialup', description: 'Accept dial-up peers.' },
    ], 'any'),
    choice('authmethod', 'Authentication method.', [
      { keyword: 'psk', description: 'Pre-shared key.' },
      { keyword: 'signature', description: 'Certificate signature.' },
    ], 'psk'),
    {
      ...text('psksecret', 'Pre-shared secret for PSK authentication.'),
      quoted: true, secret: true,
      valueRefusal: (value, env) =>
        passwordPolicyRefusal(value, env, 'ipsec-preshared-key'),
    },
    reference('certificate', 'Local certificate presented for signature authentication.',
      ['vpn certificate local']),
    proposalAttribute('Phase 1 proposals.'),
    dhGroupAttribute(),
    count('keylife', 'Phase 1 key life in seconds.', 120, 172800, 86400),
    choice('dpd', 'Dead peer detection mode.', [
      { keyword: 'disable', description: 'Do not detect a dead peer.' },
      { keyword: 'on-idle', description: 'Probe when the link is idle.' },
      { keyword: 'on-demand', description: 'Probe when traffic has no reply.' },
    ], 'on-demand'),
    count('dpd-retryinterval', 'Seconds between dead peer probes.', 1, 60, 15),
    count('dpd-retrycount', 'Unanswered probes before the peer is declared dead.',
      0, 10, 3),
    choice('nattraversal', 'Enable/disable NAT traversal.', [
      { keyword: 'enable', description: 'Use NAT-T when a NAT is detected.' },
      { keyword: 'disable', description: 'Never use NAT-T.' },
      { keyword: 'forced', description: 'Always use NAT-T.' },
    ], 'enable'),
    enable('net-device', 'Enable/disable a per-tunnel device.'),
    enable('mode-cfg', 'Enable/disable the IKE configuration method.'),
    {
      ...reference('authusrgrp', 'User group allowed to dial in.', ['user group']),
      availableWhen: (view) => view.effective('type')[0] === 'dynamic',
    },
    {
      ...address('ipv4-start-ip', 'First address of the client pool.'),
      availableWhen: (view) => view.effective('mode-cfg')[0] === 'enable',
    },
    {
      ...address('ipv4-end-ip', 'Last address of the client pool.'),
      availableWhen: (view) => view.effective('mode-cfg')[0] === 'enable',
    },
    {
      ...address('ipv4-netmask', 'Mask handed to the client.', '255.255.255.255'),
      availableWhen: (view) => view.effective('mode-cfg')[0] === 'enable',
    },
    {
      ...reference('ipv4-split-include', 'Subnets routed through the tunnel.',
        ['firewall address', 'firewall addrgrp']),
      availableWhen: (view) => view.effective('mode-cfg')[0] === 'enable',
    },
    {
      ...address('ipv4-dns-server1', 'First DNS server handed to the client.'),
      availableWhen: (view) => view.effective('mode-cfg')[0] === 'enable',
    },
    {
      ...address('ipv4-dns-server2', 'Second DNS server handed to the client.'),
      availableWhen: (view) => view.effective('mode-cfg')[0] === 'enable',
    },
    choice('xauthtype', 'Extended authentication mode.', [
      { keyword: 'disable', description: 'No extended authentication.' },
      { keyword: 'client', description: 'This unit authenticates as a client.' },
      { keyword: 'auto', description: 'Server side, any supported method.' },
      { keyword: 'pap', description: 'Server side, PAP.' },
    ], 'disable'),
    {
      ...word('authusr', 'User name presented to the dial-up server.'),
      availableWhen: (view) => view.effective('xauthtype')[0] === 'client',
    },
    {
      ...text('authpasswd', 'Password presented to the dial-up server.'),
      quoted: true, secret: true,
      availableWhen: (view) => view.effective('xauthtype')[0] === 'client',
    },
    text('comments', 'Comment.'),
  ],
  onCommit(object, context) {
    if (object.effective('authmethod')[0] === 'signature'
      && (object.effective('certificate')[0] ?? '') === '') {
      return 'a signature phase 1 needs `set certificate <local-certificate>`.';
    }
    const poolFault = poolProblem(object);
    if (poolFault) return poolFault;
    context.device.applyPhase1({
      name: object.key,
      boundInterface: object.effective('interface')[0] ?? '',
      ikeVersion: object.effective('ike-version')[0] === '2' ? 2 : 1,
      type: object.effective('type')[0] ?? 'static',
      remoteGateway: object.effective('remote-gw')[0] ?? '0.0.0.0',
      proposals: [...object.effective('proposal')],
      dhGroups: numbers(object, 'dhgrp'),
      presharedKey: object.effective('psksecret')[0] ?? '',
      keyLifeSeconds: Number.parseInt(object.effective('keylife')[0] ?? '86400', 10),
      authMethod: object.effective('authmethod')[0] === 'signature' ? 'signature' : 'psk',
      certificate: object.effective('certificate')[0] ?? '',
      dpd: object.effective('dpd')[0] ?? 'on-demand',
      dpdRetryIntervalSeconds:
        Number.parseInt(object.effective('dpd-retryinterval')[0] ?? '15', 10),
      dpdRetryCount: Number.parseInt(object.effective('dpd-retrycount')[0] ?? '3', 10),
      natTraversal: object.effective('nattraversal')[0] ?? 'enable',
      policyBased: false,
      modeCfg: object.effective('mode-cfg')[0] === 'enable',
      authUserGroup: object.effective('authusrgrp')[0] || undefined,
      poolStart: object.effective('ipv4-start-ip')[0] || undefined,
      poolEnd: object.effective('ipv4-end-ip')[0] || undefined,
      poolNetmask: object.effective('ipv4-netmask')[0] || undefined,
      splitInclude: object.effective('ipv4-split-include')[0] || undefined,
      xauthType: object.effective('xauthtype')[0] ?? 'disable',
      authUser: object.effective('authusr')[0] || undefined,
      authPassword: object.effective('authpasswd')[0] || undefined,
      dnsServers: [
        object.effective('ipv4-dns-server1')[0] || '',
        object.effective('ipv4-dns-server2')[0] || '',
      ].filter(entry => entry.length > 0),
      comments: object.effective('comments')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removePhase1(key);
  },
};

function poolProblem(object: FortiObjectView): string | undefined {
  if (object.effective('mode-cfg')[0] !== 'enable') return undefined;
  const start = object.effective('ipv4-start-ip')[0] ?? '';
  const end = object.effective('ipv4-end-ip')[0] ?? '';
  if (start.length === 0 || end.length === 0) return undefined;
  if (addressToNumber(end) < addressToNumber(start)) {
    return `\`ipv4-end-ip\` (${end}) is below \`ipv4-start-ip\` (${start}).`;
  }
  return undefined;
}

function addressToNumber(address: string): number {
  return address.split('.')
    .reduce((total, part) => total * 256 + Number.parseInt(part, 10), 0);
}

export const VPN_PHASE2_INTERFACE: FortiTableSpec = {
  path: ['vpn', 'ipsec', 'phase2-interface'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'vpngrp',
  renderOrder: 610,
  help: 'Configure VPN autokey tunnel.',
  attributes: [
    { ...word('name', 'IPsec tunnel name.'), readOnly: true },
    reference('phase1name', 'Phase 1 determines the options required for phase 2.',
      ['vpn ipsec phase1-interface']),
    proposalAttribute('Phase 2 proposals.'),
    addressMask('src-subnet', 'Local IP and mask carried by the tunnel.',
      ['0.0.0.0', '0.0.0.0']),
    addressMask('dst-subnet', 'Remote IP and mask carried by the tunnel.',
      ['0.0.0.0', '0.0.0.0']),
    enable('pfs', 'Enable/disable perfect forward secrecy.', true),
    dhGroupAttribute(),
    count('keylifeseconds', 'Phase 2 key life in seconds.', 120, 172800, 43200),
    enable('auto-negotiate', 'Enable/disable automatic initiation.'),
  ],
  onCommit(object, context) {
    context.device.applyPhase2({
      name: object.key,
      phase1Name: object.effective('phase1name')[0] ?? '',
      proposals: [...object.effective('proposal')],
      sourceSubnet: object.effective('src-subnet')[0] ?? '0.0.0.0',
      sourceMask: object.effective('src-subnet')[1] ?? '0.0.0.0',
      destinationSubnet: object.effective('dst-subnet')[0] ?? '0.0.0.0',
      destinationMask: object.effective('dst-subnet')[1] ?? '0.0.0.0',
      pfs: object.effective('pfs')[0] !== 'disable',
      dhGroups: numbers(object, 'dhgrp'),
      keyLifeSeconds: Number.parseInt(object.effective('keylifeseconds')[0] ?? '43200', 10),
      autoNegotiate: object.effective('auto-negotiate')[0] === 'enable',
    });
  },
  onDelete(key, context) {
    context.device.removePhase2(key);
  },
};

export const VPN_PHASE1_POLICY: FortiTableSpec = {
  path: ['vpn', 'ipsec', 'phase1'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'vpngrp',
  renderOrder: 620,
  help: `Configure VPN remote gateway, policy-based. ${POLICY_BASED_HINT}`,
  attributes: [
    { ...word('name', 'IPsec remote gateway name.'), readOnly: true },
    reference('interface', 'Local outgoing interface.', ['system interface']),
    address('remote-gw', 'Remote VPN gateway address.', '0.0.0.0'),
    {
      ...text('psksecret', 'Pre-shared secret.'),
      quoted: true, secret: true,
      valueRefusal: (value, env) =>
        passwordPolicyRefusal(value, env, 'ipsec-preshared-key'),
    },
    proposalAttribute('Phase 1 proposals.'),
    dhGroupAttribute(),
  ],
  onCommit(object, context) {
    if (object.effective('authmethod')[0] === 'signature'
      && (object.effective('certificate')[0] ?? '') === '') {
      return 'a signature phase 1 needs `set certificate <local-certificate>`.';
    }
    const poolFault = poolProblem(object);
    if (poolFault) return poolFault;
    context.device.applyPhase1({
      name: object.key,
      boundInterface: object.effective('interface')[0] ?? '',
      ikeVersion: 1,
      type: 'static',
      remoteGateway: object.effective('remote-gw')[0] ?? '0.0.0.0',
      proposals: [...object.effective('proposal')],
      dhGroups: numbers(object, 'dhgrp'),
      presharedKey: object.effective('psksecret')[0] ?? '',
      keyLifeSeconds: 86400,
      authMethod: object.effective('authmethod')[0] === 'signature' ? 'signature' : 'psk',
      certificate: object.effective('certificate')[0] ?? '',
      dpd: 'on-demand',
      dpdRetryIntervalSeconds: 15,
      dpdRetryCount: 3,
      natTraversal: 'enable',
      policyBased: true,
    });
  },
  onDelete(key, context) {
    context.device.removePhase1(key);
  },
};

function numbers(object: FortiObjectView, attribute: string): number[] {
  return object.effective(attribute)
    .map(value => Number.parseInt(value, 10))
    .filter(Number.isFinite);
}

export function validateProposals(values: readonly string[]): string | null {
  for (const value of values) {
    const verdict = parseProposal(value);
    if (verdict.ok === false) return verdict.reason;
  }
  return null;
}

export const VPN_CERTIFICATE_LOCAL: FortiTableSpec = {
  path: ['vpn', 'certificate', 'local'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'vpngrp',
  renderOrder: 118,
  help: 'Local keys and certificates.',
  attributes: [
    { ...word('name', 'Name of the certificate.'), readOnly: true },
    { ...text('certificate', 'PEM-encoded certificate.'), quoted: true },
    { ...text('private-key', 'PEM-encoded private key.'), quoted: true },
    text('comments', 'Optional comments.'),
    choice('range', 'Scope this certificate is visible in.', [
      { keyword: 'global', description: 'Visible to every VDOM.' },
      { keyword: 'vdom', description: 'Visible to this VDOM only.' },
    ], 'vdom'),
    choice('source', 'Where this certificate came from.', [
      { keyword: 'factory', description: 'Shipped with the unit.' },
      { keyword: 'user', description: 'Imported by an operator.' },
      { keyword: 'bundle', description: 'Part of a bundle.' },
    ], 'user'),
  ],
  onCommit(object, context) {
    const refusal = context.device.applyLocalCertificate({
      name: object.key,
      certificatePem: object.effective('certificate')[0] ?? '',
      privateKeyPem: object.effective('private-key')[0] ?? '',
      comments: object.effective('comments')[0] || undefined,
    });
    if (refusal) return refusal;
  },
  onDelete(key, context) {
    context.device.removeLocalCertificate(key);
  },
};

export const VPN_CERTIFICATE_CA: FortiTableSpec = {
  path: ['vpn', 'certificate', 'ca'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'vpngrp',
  renderOrder: 117,
  help: 'CA certificate.',
  attributes: [
    { ...word('name', 'Name of the CA certificate.'), readOnly: true },
    { ...text('ca', 'PEM-encoded CA certificate.'), quoted: true },
    { ...text('certificate', 'PEM-encoded CA certificate.'), quoted: true },
    enable('trusted', 'Enable/disable as a trusted CA.', true),
    choice('range', 'Scope this certificate is visible in.', [
      { keyword: 'global', description: 'Visible to every VDOM.' },
      { keyword: 'vdom', description: 'Visible to this VDOM only.' },
    ], 'vdom'),
    choice('source', 'Where this certificate came from.', [
      { keyword: 'factory', description: 'Shipped with the unit.' },
      { keyword: 'user', description: 'Imported by an operator.' },
      { keyword: 'bundle', description: 'Part of a bundle.' },
    ], 'user'),
  ],
  onCommit(object, context) {
    const refusal = context.device.applyCaCertificate({
      name: object.key,
      certificatePem: object.effective('certificate')[0] || object.effective('ca')[0] || '',
      trusted: object.effective('trusted')[0] !== 'disable',
    });
    if (refusal) return refusal;
  },
  onDelete(key, context) {
    context.device.removeCaCertificate(key);
  },
};

export const VPN_SSL_WEB_PORTAL: FortiTableSpec = {
  path: ['vpn', 'ssl', 'web', 'portal'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'vpngrp',
  renderOrder: 630,
  help: 'Portal.',
  attributes: [
    { ...word('name', 'Portal name.'), readOnly: true },
    enable('web-mode', 'Enable/disable the web portal.', true),
    {
      ...enable('tunnel-mode', 'Enable/disable the IPsec-over-SSL tunnel.'),
      unimplementedValues: {
        enable: 'tunnel mode needs a FortiClient-shaped VPN client, which this '
          + 'build does not have; the web portal is served for real.',
      },
    },
    text('ip-pools', 'Address range this portal hands to tunnel-mode clients.'),
  ],
};

export const VPN_SSL_SETTINGS: FortiTableSpec = {
  path: ['vpn', 'ssl', 'settings'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'vpngrp',
  renderOrder: 640,
  help: 'Configure SSL-VPN.',
  attributes: [
    enable('status', 'Enable/disable the SSL-VPN portal.'),
    count('port', 'Port the portal listens on.', 1, 65535, 10443),
    reference('servercert', 'Certificate the portal presents.',
      ['vpn certificate local']),
    refList('source-interface', 'Interfaces the portal listens on.',
      ['system interface']),
    count('login-timeout', 'Seconds a login may take.', 10, 180, 30),
    count('idle-timeout', 'Seconds an idle connection is kept, 0 for no limit.',
      0, 259200, 300),
  ],
  children: [{
    path: ['vpn', 'ssl', 'settings', 'authentication-rule'],
    kind: 'table',
    keyType: 'integer',
    ordered: true,
    scope: 'vdom',
    accessGroup: 'vpngrp',
    renderOrder: 1,
    help: 'Authentication rule.',
    attributes: [
      { ...word('id', 'Rule identifier.'), readOnly: true },
      refList('groups', 'User groups this rule admits.', ['user group']),
      refList('users', 'Users this rule admits.', ['user local']),
      reference('portal', 'Portal these users land on.', ['vpn ssl web portal']),
    ],
  }],
  onCommit(object, context) {
    const rules = object.childEntries('authentication-rule').map(rule => ({
      id: rule.key,
      groups: [...rule.effective('groups')],
      users: [...rule.effective('users')],
      portal: rule.effective('portal')[0] ?? '',
    }));

    return context.device.applySslVpnSettings({
      enabled: object.effective('status')[0] === 'enable',
      port: Number.parseInt(object.effective('port')[0] ?? '10443', 10),
      serverCertificate: object.effective('servercert')[0] ?? '',
      sourceInterfaces: [...object.effective('source-interface')],
      idleTimeout: Number.parseInt(object.effective('idle-timeout')[0] ?? '300', 10),
      rules,
    });
  },
};

export const VPN_SPECS: readonly FortiTableSpec[] = Object.freeze([
  VPN_SSL_WEB_PORTAL,
  VPN_SSL_SETTINGS,
  VPN_CERTIFICATE_CA,
  VPN_CERTIFICATE_LOCAL,
  VPN_PHASE1_INTERFACE,
  VPN_PHASE2_INTERFACE,
  VPN_PHASE1_POLICY,
]);

export { POLICY_BASED_HINT };
