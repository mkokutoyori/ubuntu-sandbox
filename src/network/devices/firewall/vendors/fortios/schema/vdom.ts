import {
  choice, count, enable, refList, text, word,
  type FortiTableSpec,
} from './types';

export const SYSTEM_VDOM: FortiTableSpec = {
  path: ['vdom'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 5,
  help: 'Configure virtual domain.',
  predefined: ['root'],
  scopeOnly: true,
  attributes: [
    { ...word('name', 'VDOM name.'), readOnly: true },
    { ...count('short-name', 'VDOM short name.', 0, 0, 0), readOnly: true },
  ],
  maxEntries(context) {
    return context.device.maxVirtualDomains();
  },
  onCommit(object, context) {
    context.device.applyVdom(object.key);
  },
  onDelete(key, context) {
    context.device.removeVdom(key);
  },
};

export const SYSTEM_VDOM_LINK: FortiTableSpec = {
  path: ['system', 'vdom-link'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 45,
  help: 'Configure VDOM links.',
  attributes: [
    { ...word('name', 'VDOM link name.'), readOnly: true },
    choice('vcluster', 'Virtual cluster.', [
      { keyword: 'vcluster1', description: 'Virtual cluster 1.' },
      { keyword: 'vcluster2', description: 'Virtual cluster 2.' },
    ], 'vcluster1'),
    enable('type', 'VDOM link type.'),
  ],
  onCommit(object, context) {
    context.device.applyVdomLink(object.key);
  },
  onDelete(key, context) {
    context.device.removeVdomLink(key);
  },
};

export const SYSTEM_SWITCH_INTERFACE: FortiTableSpec = {
  path: ['system', 'switch-interface'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 46,
  help: 'Configure software switch interfaces by grouping physical interfaces.',
  attributes: [
    { ...word('name', 'Interface name.'), readOnly: true },
    word('vdom', 'VDOM that the software switch belongs to.', 'root'),
    refList('member', 'Names of the interfaces that belong to the software switch.',
      ['system interface']),
    choice('type', 'Type of switch based on functionality.', [
      { keyword: 'switch', description: 'Basic layer 2 switch.' },
      { keyword: 'hub', description: 'Hub with no MAC learning.' },
    ], 'switch'),
    enable('intra-switch-policy', 'Allow or deny traffic between switch members.'),
    text('span-dest-port', 'SPAN destination port name.'),
  ],
  onCommit(object, context) {
    context.device.applySwitchInterface(object.key, object.effective('member'));
  },
  onDelete(key, context) {
    context.device.removeSwitchInterface(key);
  },
};

export const VDOM_SPECS: readonly FortiTableSpec[] = Object.freeze([
  SYSTEM_VDOM,
  SYSTEM_VDOM_LINK,
  SYSTEM_SWITCH_INTERFACE,
]);
