import type { FortiAttributeSpec, FortiTableSpec } from './types';

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
  attributes: [nat64Prefix],
  onCommit(object, context) {
    return context.device.applyNat64Prefix(object.effective('nat64-prefix')[0] ?? DEFAULT_PREFIX);
  },
};

export const NAT64_SPECS: readonly FortiTableSpec[] = Object.freeze([SYSTEM_NAT64]);
