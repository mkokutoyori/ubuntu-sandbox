import { enable, word, type FortiAttributeSpec, type FortiTableSpec } from './types';

const DEFAULT_PREFIX = '64:ff9b::/96';

const nat64Prefix: FortiAttributeSpec = {
  name: 'nat64-prefix',
  help: 'NAT64 prefix must be ::/96 (default = 64:ff9b::/96).',
  quoted: false,
  parts: [{ name: 'nat64-prefix', type: 'WORD', description: 'An IPv6 prefix of length 96.' }],
  defaultValue: [DEFAULT_PREFIX],
};

export const SYSTEM_NAT64: FortiTableSpec = {
  path: ['system', 'nat64'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 32,
  help: 'Configure NAT64.',
  attributes: [
    nat64Prefix,
    enable('secondary-prefix-status', 'Enable/disable secondary NAT64 prefix.'),
  ],
  children: [{
    path: ['secondary-prefix'],
    kind: 'table',
    keyType: 'name',
    ordered: false,
    scope: 'global',
    accessGroup: 'sysgrp',
    renderOrder: 33,
    help: 'Secondary NAT64 prefix.',
    attributes: [
      { ...word('name', 'NAT64 prefix name.'), readOnly: true },
      { ...nat64Prefix, help: 'NAT64 prefix.', defaultValue: [''] },
    ],
    onCommit(object, context) {
      return context.device.applyNat64SecondaryPrefix(object.key, object.effective('nat64-prefix')[0] ?? '');
    },
    onDelete(key, context) {
      context.device.removeNat64SecondaryPrefix(key);
    },
  }],
  onCommit(object, context) {
    context.device.applyNat64SecondaryStatus(object.effective('secondary-prefix-status')[0] === 'enable');
    return context.device.applyNat64Prefix(object.effective('nat64-prefix')[0] ?? DEFAULT_PREFIX);
  },
};

export const NAT64_SPECS: readonly FortiTableSpec[] = Object.freeze([SYSTEM_NAT64]);
