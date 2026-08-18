import { implementedIkeGroups } from '../../../../../ipsec/IkeKeyExchange';
import { parseProposal, SUPPORTED_CIPHERS } from '../../../vpn/IpsecProposals';
import {
  address, addressMask, choice, count, enable, reference, text, word,
  type FortiAttributeSpec, type FortiObjectView, type FortiTableSpec,
} from './types';

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
    { ...text('psksecret', 'Pre-shared secret for PSK authentication.'), quoted: true },
    proposalAttribute('Phase 1 proposals.'),
    dhGroupAttribute(),
    count('keylife', 'Phase 1 key life in seconds.', 120, 172800, 86400),
    choice('dpd', 'Dead peer detection mode.', [
      { keyword: 'disable', description: 'Do not detect a dead peer.' },
      { keyword: 'on-idle', description: 'Probe when the link is idle.' },
      { keyword: 'on-demand', description: 'Probe when traffic has no reply.' },
    ], 'on-demand'),
    choice('nattraversal', 'Enable/disable NAT traversal.', [
      { keyword: 'enable', description: 'Use NAT-T when a NAT is detected.' },
      { keyword: 'disable', description: 'Never use NAT-T.' },
      { keyword: 'forced', description: 'Always use NAT-T.' },
    ], 'enable'),
    enable('net-device', 'Enable/disable a per-tunnel device.'),
    text('comments', 'Comment.'),
  ],
  onCommit(object, context) {
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
      dpd: object.effective('dpd')[0] ?? 'on-demand',
      natTraversal: object.effective('nattraversal')[0] ?? 'enable',
      policyBased: false,
      comments: object.effective('comments')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removePhase1(key);
  },
};

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
    { ...text('psksecret', 'Pre-shared secret.'), quoted: true },
    proposalAttribute('Phase 1 proposals.'),
    dhGroupAttribute(),
  ],
  onCommit(object, context) {
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
      dpd: 'on-demand',
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

export const VPN_SPECS: readonly FortiTableSpec[] = Object.freeze([
  VPN_PHASE1_INTERFACE,
  VPN_PHASE2_INTERFACE,
  VPN_PHASE1_POLICY,
]);

export { POLICY_BASED_HINT };
