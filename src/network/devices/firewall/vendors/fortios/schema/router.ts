import {
  address, addressMask, choice, count, enable, reference, refList, text,
  type FortiTableSpec,
} from './types';
import { FortiMessages } from '../FortiMessages';
import { parseIpv6Prefix } from './system';

export const ROUTER_STATIC6: FortiTableSpec = {
  path: ['router', 'static6'],
  kind: 'table',
  keyType: 'integer',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 221,
  help: 'Configure IPv6 static routing tables.',
  attributes: [
    {
      name: 'seq-num', help: 'Sequence number.', readOnly: true, quoted: false,
      parts: [{ name: 'seq-num', type: 'INT', description: 'Sequence number.' }],
    },
    {
      name: 'dst', help: 'Destination IPv6 prefix.', quoted: false,
      parts: [{
        name: 'prefix', type: 'WORD',
        description: 'IPv6 address and prefix length, <address>/<0-128>.',
      }],
      defaultValue: ['::/0'],
      acceptsValue: (value) => parseIpv6Prefix(value) !== null,
      expectedValue: 'an IPv6 prefix such as `2001:db8::/64`.',
    },
    {
      name: 'gateway', help: 'IPv6 address of the gateway.', quoted: false,
      parts: [{ name: 'gateway', type: 'WORD', description: 'IPv6 address.' }],
      defaultValue: ['::'],
      acceptsValue: (value) => parseIpv6Prefix(`${value}/128`) !== null,
      expectedValue: 'an IPv6 address such as `2001:db8::254`.',
    },
    reference('device', 'Gateway out interface or tunnel.', ['system interface']),
    count('distance', 'Administrative distance.', 1, 255, 10),
    enable('status', 'Enable/disable this static route.', true),
    text('comment', 'Optional comments.'),
  ],
  onCommit(object, context) {
    const destination = parseIpv6Prefix(object.effective('dst')[0] ?? '::/0');
    if (!destination) return FortiMessages.valueError(object.effective('dst')[0] ?? '');
    context.device.applyIpv6StaticRoute({
      id: object.key,
      destination: destination.address,
      prefixLength: destination.prefixLength,
      gateway: object.effective('gateway')[0] ?? '::',
      iface: object.effective('device')[0] ?? '',
      distance: Number.parseInt(object.effective('distance')[0] ?? '10', 10) || 10,
      enabled: object.effective('status')[0] !== 'disable',
    });
  },
  onDelete(key, context) {
    context.device.removeIpv6StaticRoute(key);
  },
};

export const ROUTER_STATIC: FortiTableSpec = {
  path: ['router', 'static'],
  kind: 'table',
  keyType: 'integer',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 220,
  help: 'Configure IPv4 static routing tables.',
  attributes: [
    {
      name: 'seq-num', help: 'Sequence number.', readOnly: true, quoted: false,
      parts: [{ name: 'seq-num', type: 'INT', description: 'Sequence number.' }],
    },
    addressMask('dst', 'Destination IP and mask for this route.', ['0.0.0.0', '0.0.0.0']),
    address('gateway', 'Gateway IP for this route.', '0.0.0.0'),
    reference('device', 'Gateway out interface, tunnel, or SD-WAN zone.',
      ['system interface', 'system sdwan zone']),
    count('distance', 'Administrative distance.', 1, 255, 10),
    count('priority', 'Administrative priority.', 0, 65535, 0),
    count('weight', 'Administrative weight.', 0, 255, 0),
    enable('blackhole', 'Enable/disable black hole.'),
    enable('status', 'Enable/disable this static route.', true),
    text('comment', 'Optional comments.'),
  ],
  onCommit(object, context) {
    const destination = object.effective('dst');
    context.device.applyStaticRoute({
      id: object.key,
      destination: destination[0] ?? '0.0.0.0',
      mask: destination[1] ?? '0.0.0.0',
      gateway: object.effective('gateway')[0] ?? '0.0.0.0',
      iface: object.effective('device')[0] ?? '',
      distance: Number.parseInt(object.effective('distance')[0] ?? '10', 10),
      priority: Number.parseInt(object.effective('priority')[0] ?? '0', 10),
      blackhole: object.effective('blackhole')[0] === 'enable',
      enabled: object.effective('status')[0] !== 'disable',
    });
  },
  onDelete(key, context) {
    context.device.removeStaticRoute(key);
  },
};

const PREFIX_PART = {
  type: 'WORD' as const,
  literal: 'A.B.C.D/M',
  description: 'IPv4 prefix.',
};

export const ROUTER_POLICY: FortiTableSpec = {
  path: ['router', 'policy'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 230,
  help: 'Configure IPv4 routing policies.',
  attributes: [
    {
      name: 'seq-num', help: 'Sequence number.', readOnly: true, quoted: false,
      parts: [{ name: 'seq-num', type: 'INT', description: 'Sequence number.' }],
    },
    refList('input-device', 'Incoming interface name.', ['system interface']),
    {
      name: 'src', help: 'Source IP and mask.', quoted: true, multiValue: true,
      parts: [{ ...PREFIX_PART, name: 'src' }],
      defaultValue: [],
    },
    {
      name: 'dst', help: 'Destination IP and mask.', quoted: true, multiValue: true,
      parts: [{ ...PREFIX_PART, name: 'dst' }],
      defaultValue: [],
    },
    reference('output-device', 'Outgoing interface name.', ['system interface']),
    address('gateway', 'IP address of the gateway.', '0.0.0.0'),
    choice('action', 'Action of the policy route.', [
      { keyword: 'deny', description: 'Deny policy routing, use the routing table.' },
      { keyword: 'permit', description: 'Permit policy routing.' },
    ], 'permit'),
    count('protocol', 'Protocol number (0 - 255).', 0, 255, 0),
    count('start-port', 'Start destination port number (0 - 65535).', 0, 65535, 0),
    count('end-port', 'End destination port number (0 - 65535).', 0, 65535, 65535),
    count('start-source-port', 'Start source port number (0 - 65535).', 0, 65535, 0),
    count('end-source-port', 'End source port number (0 - 65535).', 0, 65535, 65535),
    enable('status', 'Enable/disable this policy route.', true),
    text('comments', 'Optional comments.'),
  ],
  onCommit(object, context) {
    const gateway = object.effective('gateway')[0];
    const device = object.effective('output-device')[0];

    context.device.applyPolicyRoute({
      id: object.key,
      position: context.position,
      enabled: object.effective('status')[0] !== 'disable',
      action: object.effective('action')[0] === 'deny' ? 'deny' : 'permit',
      inputDevices: [...object.effective('input-device')],
      sources: [...object.effective('src')],
      destinations: [...object.effective('dst')],
      outputDevice: device || undefined,
      gateway: gateway && gateway !== '0.0.0.0' ? gateway : undefined,
      protocol: integer(object.effective('protocol')[0], 0),
      startPort: integer(object.effective('start-port')[0], 0),
      endPort: integer(object.effective('end-port')[0], 65535),
      startSourcePort: integer(object.effective('start-source-port')[0], 0),
      endSourcePort: integer(object.effective('end-source-port')[0], 65535),
      comment: object.effective('comments')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removePolicyRoute(key);
  },
};

function integer(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const ROUTER_SPECS: readonly FortiTableSpec[] = Object.freeze([
  ROUTER_STATIC, ROUTER_STATIC6, ROUTER_POLICY,
]);
