import { enable, reference, refList, text, word, type FortiTableSpec } from './types';

const ADDRESS_TARGETS = ['firewall address', 'firewall addrgrp', 'firewall vip', 'firewall vipgrp'];
const INTERFACE_TARGETS = ['system interface', 'system zone', 'system sdwan zone'];
const SERVICE_TARGETS = ['firewall service custom', 'firewall service group'];
const SHAPERS = ['firewall shaper traffic-shaper'];

function listOrAny(values: readonly string[]): string[] {
  return values.length === 0 ? ['any'] : values.map(value => (value.toLowerCase() === 'all' ? 'any' : value));
}

function named(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

export const FIREWALL_SHAPING_POLICY: FortiTableSpec = {
  path: ['firewall', 'shaping-policy'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 153,
  help: 'Configure shaping policies.',
  attributes: [
    { ...word('id', 'Shaping policy ID (0 - 4294967295).'), readOnly: true },
    word('name', 'Shaping policy name.'),
    enable('status', 'Enable/disable this traffic shaping policy.', true),
    text('comment', 'Comments.'),
    refList('srcintf', 'One or more incoming (ingress) interfaces.', INTERFACE_TARGETS),
    refList('dstintf', 'One or more outgoing (egress) interfaces.', INTERFACE_TARGETS),
    refList('srcaddr', 'IPv4 source address and address group names.', ADDRESS_TARGETS),
    refList('dstaddr', 'IPv4 destination address and address group names.', ADDRESS_TARGETS),
    refList('service', 'Service and service group names.', SERVICE_TARGETS),
    reference('traffic-shaper', 'Traffic shaper to apply to traffic forwarded by the firewall policy.', SHAPERS),
    reference('traffic-shaper-reverse', 'Traffic shaper to apply to response traffic received by the firewall policy.', SHAPERS),
  ],
  onCommit(object, context) {
    context.device.applyShapingPolicy({
      id: object.key,
      name: named(object.effective('name')[0]),
      from: listOrAny(object.effective('srcintf')),
      to: listOrAny(object.effective('dstintf')),
      source: listOrAny(object.effective('srcaddr')),
      destination: listOrAny(object.effective('dstaddr')),
      service: listOrAny(object.effective('service')),
      trafficShaper: named(object.effective('traffic-shaper')[0]),
      trafficShaperReverse: named(object.effective('traffic-shaper-reverse')[0]),
      enabled: object.effective('status')[0] !== 'disable',
    }, context.position);
  },
  onDelete(key, context) {
    context.device.removeShapingPolicy(key);
  },
};
