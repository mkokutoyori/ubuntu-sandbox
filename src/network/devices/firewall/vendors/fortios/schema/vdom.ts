import {
  choice, count, enable, reference, refList, text, word,
  type FortiAttributeSpec, type FortiTableSpec,
} from './types';
import { VDOM_RESOURCES, type VdomResource, type VdomResourceLimits } from '../../../vdom/VdomLimits';
import type {
  IntraSwitchPolicy, SpanDirection, SwitchGroupType,
} from '../../../l3/SwitchGroupTable';

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

function resourceLimit(name: VdomResource, help: string): FortiAttributeSpec {
  return {
    name, help, quoted: false, optionalParts: 1, defaultValue: [],
    parts: [
      { name: 'maximum', type: 'INT', description: 'Maximum number (0 = not specified).', range: [0, 4294967295] },
      { name: 'guaranteed', type: 'INT', optional: true, description: 'Guaranteed number.', range: [0, 4294967295] },
    ],
  };
}

const RESOURCE_HELP: Readonly<Record<VdomResource, string>> = {
  session: 'Maximum guaranteed number of sessions.',
  'firewall-policy': 'Maximum guaranteed number of firewall policies (policy, DoS-policy4, DoS-policy6, multicast).',
  'firewall-address': 'Maximum guaranteed number of firewall addresses (IPv4, IPv6, multicast).',
  'firewall-addrgrp': 'Maximum guaranteed number of firewall address groups (IPv4, IPv6).',
  'custom-service': 'Maximum guaranteed number of firewall custom services.',
  'service-group': 'Maximum guaranteed number of firewall service groups.',
  'onetime-schedule': 'Maximum guaranteed number of firewall one-time schedules.',
  'recurring-schedule': 'Maximum guaranteed number of firewall recurring schedules.',
  user: 'Maximum guaranteed number of local users.',
  'user-group': 'Maximum guaranteed number of user groups.',
  'ipsec-phase1-interface': 'Maximum guaranteed number of VPN IPsec phase1 interface tunnels.',
  'ipsec-phase2-interface': 'Maximum guaranteed number of VPN IPsec phase2 interface tunnels.',
};

export const SYSTEM_VDOM_PROPERTY: FortiTableSpec = {
  path: ['system', 'vdom-property'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 6,
  help: 'Configure VDOM property.',
  attributes: [
    { ...word('name', 'VDOM name.'), readOnly: true },
    text('description', 'Description.'),
    ...VDOM_RESOURCES.map(resource => resourceLimit(resource, RESOURCE_HELP[resource])),
  ],
  onCommit(object, context) {
    const limits: Record<string, { maximum: number; guaranteed: number }> = {};
    for (const resource of VDOM_RESOURCES) {
      const declared = object.effective(resource);
      if (declared.length === 0) continue;
      const maximum = Number.parseInt(declared[0], 10);
      const guaranteed = Number.parseInt(declared[1] ?? '0', 10);
      if (maximum > 0 && guaranteed > maximum) return `${resource}: the guaranteed number exceeds the maximum.`;
      limits[resource] = { maximum, guaranteed };
    }
    return context.device.applyVdomProperty(object.key, limits as VdomResourceLimits);
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
      { keyword: 'switch', description: 'Switch for normal switch functionality.' },
      { keyword: 'hub', description: 'Hub to duplicate packets to all member ports.' },
    ], 'switch'),
    choice('intra-switch-policy',
      'Allow any traffic between switch members or require firewall policies.', [
        { keyword: 'implicit', description: 'Traffic between switch members is implicitly allowed.' },
        { keyword: 'explicit', description: 'Traffic between switch members must match firewall policies.' },
      ], 'implicit'),
    enable('span', 'Enable/disable port spanning.'),
    reference('span-dest-port', 'SPAN destination port name.', ['system interface']),
    choice('span-direction', 'The direction in which the SPAN port operates.', [
      { keyword: 'rx', description: 'Copies only received packets.' },
      { keyword: 'tx', description: 'Copies only transmitted packets.' },
      { keyword: 'both', description: 'Copies both received and transmitted packets.' },
    ], 'both'),
  ],
  children: [
    {
      path: ['span-source-port'],
      kind: 'table',
      keyType: 'name',
      ordered: false,
      scope: 'vdom',
      accessGroup: 'netgrp',
      renderOrder: 47,
      help: 'Physical interface name.',
      attributes: [
        {
          ...reference('interface-name', 'Physical interface name.', ['system interface']),
          readOnly: true,
        },
      ],
    },
  ],
  onCommit(object, context) {
    return context.device.applySwitchInterface(object.key, {
      members: [...object.effective('member')],
      type: (object.effective('type')[0] ?? 'switch') as SwitchGroupType,
      intraSwitchPolicy:
        (object.effective('intra-switch-policy')[0] ?? 'implicit') as IntraSwitchPolicy,
      span: object.effective('span')[0] === 'enable',
      spanDestination: object.effective('span-dest-port')[0] ?? '',
      spanSources: object.childEntries('span-source-port').map(entry => entry.key),
      spanDirection: (object.effective('span-direction')[0] ?? 'both') as SpanDirection,
    });
  },
  onDelete(key, context) {
    context.device.removeSwitchInterface(key);
  },
};

export const VDOM_SPECS: readonly FortiTableSpec[] = Object.freeze([
  SYSTEM_VDOM_PROPERTY,
  SYSTEM_VDOM,
  SYSTEM_VDOM_LINK,
  SYSTEM_SWITCH_INTERFACE,
]);
