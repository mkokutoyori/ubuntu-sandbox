import {
  address, addressMask, choice, count, enable, reference, text, word,
  type FortiTableSpec,
} from './types';
import { AS_NUMBER_MAX } from '../../../routing/FirewallBgp';
import {
  maskPrefixLength, parseAccessListPrefix, type AccessListRule,
} from '../../../routing/AccessList';
import type { IpPrefixEntry } from '../../../../router/policy/IpPrefixList';
import { isValidIPv4, isValidSubnetMask } from '../../../../../core/ip';

const ACCESS_LIST_RULE: FortiTableSpec = {
  path: ['router', 'access-list', 'rule'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'Rule.',
  attributes: [
    { ...word('id', 'Rule ID.'), readOnly: true },
    choice('action', 'Permit or deny this IP address and netmask prefix.', [
      { keyword: 'permit', description: 'Permit or allow this prefix.' },
      { keyword: 'deny', description: 'Deny this prefix.' },
    ], 'permit'),
    {
      ...addressMask('prefix',
        'IPv4 prefix to define regular filter criteria, such as "any" or subnets.',
        ['any']),
      optionalParts: 1,
      acceptsValue: (value) =>
        value === 'any' || isValidIPv4(value) || isValidSubnetMask(value),
      expectedValue: 'either `any` or an address and a netmask, '
        + 'such as `10.1.0.0 255.255.0.0`.',
    },
    address('wildcard', 'Wildcard to define Cisco-style wildcard filter criteria.'),
    enable('exact-match', 'Enable/disable exact match.'),
  ],
};

export const ROUTER_ACCESS_LIST: FortiTableSpec = {
  path: ['router', 'access-list'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 229,
  help: 'Configure access lists.',
  attributes: [
    { ...word('name', 'Access list name.'), readOnly: true },
    text('comments', 'Comment.'),
  ],
  children: [ACCESS_LIST_RULE],
  onCommit(object, context) {
    const rules: AccessListRule[] = [];
    for (const entry of object.childEntries('rule')) {
      const prefix = parseAccessListPrefix(entry.effective('prefix'));
      if (!prefix) {
        return `rule ${entry.key} needs \`set prefix any\` or an address and a netmask.`;
      }
      const wildcard = entry.effective('wildcard')[0];
      rules.push({
        id: Number.parseInt(entry.key, 10),
        action: entry.effective('action')[0] === 'deny' ? 'deny' : 'permit',
        prefix,
        wildcard: wildcard && wildcard !== '0.0.0.0' ? wildcard : undefined,
        exactMatch: entry.effective('exact-match')[0] === 'enable',
      });
    }
    context.device.applyAccessList({
      name: object.key,
      comments: object.effective('comments')[0] || undefined,
      rules,
    });
  },
  onDelete(key, context) {
    context.device.removeAccessList(key);
  },
};

const PREFIX_LIST_RULE: FortiTableSpec = {
  path: ['router', 'prefix-list', 'rule'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'IPv4 prefix list rule.',
  attributes: [
    { ...word('id', 'Rule ID.'), readOnly: true },
    choice('action', 'Permit or deny this IP address and netmask prefix.', [
      { keyword: 'permit', description: 'Allow or permit packets that match this rule.' },
      { keyword: 'deny', description: 'Deny packets that match this rule.' },
    ], 'permit'),
    {
      ...addressMask('prefix',
        'IPv4 prefix to define regular filter criteria, such as "any" or subnets.',
        ['any']),
      optionalParts: 1,
      acceptsValue: (value) =>
        value === 'any' || isValidIPv4(value) || isValidSubnetMask(value),
      expectedValue: 'either `any` or an address and a netmask, '
        + 'such as `10.1.0.0 255.255.0.0`.',
    },
    count('ge', 'Minimum prefix length to be matched.', 0, 32, 0),
    count('le', 'Maximum prefix length to be matched.', 0, 32, 0),
  ],
};

export const ROUTER_PREFIX_LIST: FortiTableSpec = {
  path: ['router', 'prefix-list'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 228,
  help: 'Configure IPv4 prefix lists.',
  attributes: [
    { ...word('name', 'Prefix list name.'), readOnly: true },
    text('comments', 'Comment.'),
  ],
  children: [PREFIX_LIST_RULE],
  onCommit(object, context) {
    const rules: IpPrefixEntry[] = [];
    for (const entry of object.childEntries('rule')) {
      const prefix = parseAccessListPrefix(entry.effective('prefix'));
      if (!prefix) {
        return `rule ${entry.key} needs \`set prefix any\` or an address and a netmask.`;
      }
      rules.push({
        index: Number.parseInt(entry.key, 10),
        action: entry.effective('action')[0] === 'deny' ? 'deny' : 'permit',
        network: prefix.network,
        prefixLength: prefix.any ? 0 : maskPrefixLength(prefix.mask),
        greaterEqual: entry.isExplicit('ge')
          ? Number.parseInt(entry.effective('ge')[0] ?? '0', 10) : undefined,
        lessEqual: entry.isExplicit('le')
          ? Number.parseInt(entry.effective('le')[0] ?? '0', 10) : undefined,
      });
    }
    context.device.applyPrefixList({
      name: object.key,
      comments: object.effective('comments')[0] || undefined,
      rules,
    });
  },
  onDelete(key, context) {
    context.device.removePrefixList(key);
  },
};

const RIP_NETWORK: FortiTableSpec = {
  path: ['router', 'rip', 'network'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'Network table.',
  attributes: [
    { ...word('id', 'Entry identifier.'), readOnly: true },
    addressMask('prefix', 'Network prefix carried by RIP.', ['0.0.0.0', '0.0.0.0']),
  ],
};

const RIP_INTERFACE: FortiTableSpec = {
  path: ['router', 'rip', 'interface'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 2,
  help: 'RIP interface configuration.',
  attributes: [
    { ...word('name', 'Interface name.'), readOnly: true },
    choice('send-version', 'Version this interface sends.', [
      { keyword: '1', description: 'RIPv1.' },
      { keyword: '2', description: 'RIPv2.' },
    ], '2'),
    choice('receive-version', 'Version this interface accepts.', [
      { keyword: '1', description: 'RIPv1.' },
      { keyword: '2', description: 'RIPv2.' },
    ], '2'),
    choice('auth-mode', 'Authentication mode.', [
      { keyword: 'none', description: 'None.' },
      { keyword: 'text', description: 'Clear text authentication.' },
      { keyword: 'md5', description: 'Meticulous MD5 mode.' },
    ], 'none'),
    { ...text('auth-string', 'RIP authentication string (password).'), secret: true },
    reference('auth-keychain', 'Authentication key-chain name.', ['router key-chain']),
  ],
};

export const ROUTER_RIP: FortiTableSpec = {
  path: ['router', 'rip'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 232,
  help: 'Configure RIP.',
  attributes: [
    choice('version', 'RIP version this router speaks.', [
      { keyword: '1', description: 'RIPv1 — classful, broadcast.' },
      { keyword: '2', description: 'RIPv2 — classless, multicast 224.0.0.9.' },
    ], '2'),
    enable('default-information-originate', 'Advertise a default route.'),
    text('passive-interface', 'Interfaces that listen without advertising.'),
  ],
  children: [RIP_NETWORK, RIP_INTERFACE],
  onCommit(object, context) {
    return context.device.applyRip({
      enabled: object.childEntries('network').length > 0,
      version: object.effective('version')[0] === '1' ? 1 : 2,
      networks: object.childEntries('network').map(entry => ({
        id: entry.key,
        prefix: entry.effective('prefix')[0] ?? '0.0.0.0',
        mask: entry.effective('prefix')[1] ?? '0.0.0.0',
        area: '',
      })),
      passiveInterfaces: [...object.effective('passive-interface')],
      defaultInformationOriginate:
        object.effective('default-information-originate')[0] === 'enable',
      interfaces: object.childEntries('interface').map(entry => ({
        name: entry.key,
        sendVersion: entry.effective('send-version')[0] === '1' ? 1 : 2,
        receiveVersion: entry.effective('receive-version')[0] === '1' ? 1 : 2,
        authMode: entry.effective('auth-mode')[0] === 'text' ? 'text' as const
          : entry.effective('auth-mode')[0] === 'md5' ? 'md5' as const : undefined,
        authString: entry.effective('auth-string')[0],
        authKeychain: entry.effective('auth-keychain')[0] || undefined,
      })),
    });
  },
};

const OSPF_AREA: FortiTableSpec = {
  path: ['router', 'ospf', 'area'],
  kind: 'table',
  keyType: 'address',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'OSPF area configuration.',
  attributes: [
    { ...word('id', 'Area identifier, in dotted form.'), readOnly: true },
    choice('type', 'Area type.', [
      { keyword: 'regular', description: 'Ordinary area.' },
      { keyword: 'nssa', description: 'Not-so-stubby area.' },
      { keyword: 'stub', description: 'Stub area.' },
    ], 'regular'),
  ],
};

const OSPF_NETWORK: FortiTableSpec = {
  path: ['router', 'ospf', 'network'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 2,
  help: 'OSPF network configuration.',
  attributes: [
    { ...word('id', 'Entry identifier.'), readOnly: true },
    addressMask('prefix', 'Prefix whose interfaces join the area.',
      ['0.0.0.0', '0.0.0.0']),
    address('area', 'Area this prefix belongs to.', '0.0.0.0'),
  ],
};

const OSPF_MD5_KEYS: FortiTableSpec = {
  path: ['md5-keys'],
  kind: 'table',
  keyType: 'integer',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 4,
  help: 'MD5 key.',
  attributes: [
    { ...word('id', 'Key identifier.'), readOnly: true },
    { ...text('key-string', 'Password for the key.'), quoted: true, secret: true },
  ],
};

const OSPF_INTERFACE: FortiTableSpec = {
  path: ['router', 'ospf', 'ospf-interface'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 3,
  help: 'OSPF interface configuration.',
  attributes: [
    { ...word('name', 'Entry name.'), readOnly: true },
    reference('interface', 'Interface this entry configures.', ['system interface']),
    count('cost', 'Interface cost.', 0, 65535, 0),
    count('hello-interval', 'Hello interval, in seconds.', 1, 65535, 10),
    count('dead-interval', 'Dead interval, in seconds.', 1, 65535, 40),
    count('priority', 'Designated-router election priority.', 0, 255, 1),
    choice('network-type', 'Network type of this interface.', [
      { keyword: 'broadcast', description: 'Broadcast — elects a DR.' },
      { keyword: 'point-to-point', description: 'Point to point.' },
      { keyword: 'non-broadcast', description: 'Non-broadcast multi-access.' },
    ], 'broadcast'),
    choice('authentication', 'Authentication expected on this interface.', [
      { keyword: 'none', description: 'No authentication.' },
      { keyword: 'text', description: 'Cleartext password.' },
      { keyword: 'message-digest', description: 'Message digest (keyed MD5, RFC 2328 §D).' },
    ], 'none'),
    {
      ...text('authentication-key', 'Cleartext authentication password.'),
      quoted: true, secret: true,
      availableWhen: (view) => view.effective('authentication')[0] === 'text',
    },
    choice('bfd', 'Bidirectional Forwarding Detection (BFD).', [
      { keyword: 'global', description: 'Use the global BFD setting of the OSPF process.' },
      { keyword: 'enable', description: 'Enable BFD on this interface.' },
      { keyword: 'disable', description: 'Disable BFD on this interface.' },
    ], 'global'),
  ],
  children: [OSPF_MD5_KEYS],
};

export const ROUTER_OSPF: FortiTableSpec = {
  path: ['router', 'ospf'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 234,
  help: 'Configure OSPF.',
  attributes: [
    address('router-id', 'Router ID, in dotted form.', '0.0.0.0'),
    enable('bfd', 'Bidirectional Forwarding Detection (BFD).'),
    {
      ...text('passive-interface', 'Interfaces that listen without advertising.'),
      multiValue: true,
    },
    reference('distribute-list-in', 'Filter incoming routes.',
      ['router access-list', 'router prefix-list']),
  ],
  children: [OSPF_AREA, OSPF_NETWORK, OSPF_INTERFACE],
  onCommit(object, context) {
    if (object.isExplicit('router-id')
      && object.effective('router-id')[0] === '0.0.0.0') {
      return 'a router ID of 0.0.0.0 is invalid (RFC 2328 §C.1).';
    }

    return context.device.applyOspf({
      enabled: object.childEntries('network').length > 0,
      routerId: object.effective('router-id')[0] ?? '0.0.0.0',
      areas: object.childEntries('area').map(entry => ({
        id: entry.key,
        type: entry.effective('type')[0] ?? 'regular',
      })),
      networks: object.childEntries('network').map(entry => ({
        id: entry.key,
        prefix: entry.effective('prefix')[0] ?? '0.0.0.0',
        mask: entry.effective('prefix')[1] ?? '0.0.0.0',
        area: entry.effective('area')[0] ?? '0.0.0.0',
      })),
      interfaces: object.childEntries('ospf-interface').map(entry => ({
        name: entry.key,
        iface: entry.effective('interface')[0] ?? '',
        cost: Number.parseInt(entry.effective('cost')[0] ?? '0', 10),
        helloIntervalSec: Number.parseInt(entry.effective('hello-interval')[0] ?? '10', 10),
        deadIntervalSec: Number.parseInt(entry.effective('dead-interval')[0] ?? '40', 10),
        priority: Number.parseInt(entry.effective('priority')[0] ?? '1', 10),
        networkType: entry.effective('network-type')[0] ?? 'broadcast',
        authentication: entry.effective('authentication')[0] ?? 'none',
        bfd: (entry.effective('bfd')[0] ?? 'global') as 'global' | 'enable' | 'disable',
        md5Keys: entry.childEntries('md5-keys').map(key => ({
          id: Number.parseInt(key.key, 10),
          key: key.effective('key-string')[0] ?? '',
        })),
      })),
      bfd: object.effective('bfd')[0] === 'enable',
      passiveInterfaces: [...object.effective('passive-interface')],
      redistributeConnected: false,
      redistributeStatic: false,
      distributeListIn: object.effective('distribute-list-in')[0] || undefined,
    });
  },
};

const BGP_NEIGHBOR: FortiTableSpec = {
  path: ['router', 'bgp', 'neighbor'],
  kind: 'table',
  keyType: 'address',
  quotedKey: true,
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'BGP neighbor table.',
  attributes: [
    { ...word('ip', 'Neighbor address.'), readOnly: true },
    count('remote-as', 'Autonomous system of the neighbor.', 1, AS_NUMBER_MAX, 0),
    count('weight', 'Weight applied to routes learned from this neighbor.',
      0, 65535, 0),
    enable('shutdown', 'Enable/disable shutdown this neighbor.'),
    enable('bfd', 'Enable/disable BFD for this neighbor.'),
    reference('prefix-list-in', 'Inbound filter for updates from this neighbor.', ['router prefix-list']),
    reference('prefix-list-out', 'Outbound filter for updates to this neighbor.', ['router prefix-list']),
    reference('route-map-in', 'Inbound route map filter.', ['router route-map']),
    reference('route-map-out', 'Outbound route map filter.', ['router route-map']),
  ],
};

const BGP_LEAK_TARGET: FortiTableSpec = {
  path: ['router', 'bgp', 'vrf', 'leak-target'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'Target VRF table.',
  attributes: [
    { ...word('vrf', 'Target VRF ID (0 - 251).'), readOnly: true },
    reference('interface', 'Interface which is used to leak routes to target VRF.', ['system interface']),
    reference('route-map', 'Route map of VRF leaking.', ['router route-map']),
  ],
};

const RT_UNSUPPORTED = 'route targets, route distinguishers and import maps belong to MPLS/VPN VRFs; this build leaks between VRFs of the unit through `config leak-target`, which is built.';

const BGP_VRF: FortiTableSpec = {
  path: ['router', 'bgp', 'vrf'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 3,
  help: 'BGP VRF leaking table.',
  attributes: [
    { ...word('vrf', 'Origin VRF ID (0 - 251).'), readOnly: true },
    { ...word('export-rt', 'List of export route target.'), multiValue: true, unimplemented: RT_UNSUPPORTED },
    { ...word('import-rt', 'List of import route target.'), multiValue: true, unimplemented: RT_UNSUPPORTED },
    { ...word('import-route-map', 'Import route map.'), unimplemented: RT_UNSUPPORTED },
    { ...word('rd', 'Route Distinguisher: AA:NN|A.B.C.D:NN.'), unimplemented: RT_UNSUPPORTED },
    {
      ...choice('role', 'VRF role.', [
        { keyword: 'standalone', description: 'Stand-alone VRF.' },
        { keyword: 'ce', description: 'CE VRF.' },
        { keyword: 'pe', description: 'PE VRF.' },
      ], 'standalone'),
      unimplementedValues: { ce: RT_UNSUPPORTED, pe: RT_UNSUPPORTED },
    },
  ],
  children: [BGP_LEAK_TARGET],
};

const BGP_NETWORK: FortiTableSpec = {
  path: ['router', 'bgp', 'network'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 2,
  help: 'BGP network table.',
  attributes: [
    { ...word('id', 'Entry identifier.'), readOnly: true },
    addressMask('prefix', 'Prefix this router originates.', ['0.0.0.0', '0.0.0.0']),
  ],
};

export const ROUTER_BGP: FortiTableSpec = {
  path: ['router', 'bgp'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 236,
  help: 'Configure BGP.',
  attributes: [
    count('as', 'Local autonomous system number.', 0, AS_NUMBER_MAX, 0),
    address('router-id', 'Router ID, in dotted form.', '0.0.0.0'),
    count('default-local-preference', 'Default local preference.', 0, 4294967295, 100),
    enable('dampening', 'Enable/disable route-flap dampening.'),
    count('dampening-max-suppress-time', 'Maximum minutes a route can be suppressed.', 1, 255, 60),
    count('dampening-reachability-half-life', 'Reachability half-life time for penalty (min).', 1, 45, 15),
    count('dampening-reuse', 'Threshold to reuse routes.', 1, 20000, 750),
    count('dampening-suppress', 'Threshold to suppress routes.', 1, 20000, 2000),
    count('dampening-unreachability-half-life', 'Unreachability half-life time for penalty (min).', 1, 45, 15),
    { ...word('dampening-route-map', 'Criteria for dampening.'), unimplemented: 'dampening criteria select routes through route-map rules carrying set-dampening-* values, which the route-map evaluator here does not carry; dampening applies to every eBGP route.' },
    enable('graceful-restart', 'Enable/disable BGP graceful restart capabilities.'),
    count('graceful-restart-time', 'Time needed for neighbors to restart (sec).', 1, 3600, 120),
    count('graceful-stalepath-time', 'Time to hold stale paths of restarting neighbor (sec).', 1, 3600, 360),
    enable('graceful-end-on-timer', 'Enable/disable to exit graceful restart on timer only.'),
  ],
  children: [BGP_NEIGHBOR, BGP_NETWORK, BGP_VRF],
  onCommit(object, context) {
    const asn = Number.parseInt(object.effective('as')[0] ?? '0', 10);
    const leaks = object.childEntries('vrf').flatMap(origin => origin.childEntries('leak-target').map(target => ({
      origin: Number.parseInt(origin.key, 10),
      target: Number.parseInt(target.key, 10),
      iface: target.effective('interface')[0] ?? '',
      routeMap: target.effective('route-map')[0] || undefined,
    })));
    for (const leak of leaks) {
      if (leak.iface === '') return `leak-target ${leak.target} of vrf ${leak.origin} needs an interface.`;
      if (leak.origin === leak.target) return `vrf ${leak.origin} cannot leak into itself.`;
    }
    if (leaks.length > 0 && asn === 0) return 'VRF leaking is a BGP function: a local AS number is required.';
    context.device.applyVrfLeaks(leaks);
    const neighbours = object.childEntries('neighbor');

    if (neighbours.length > 0 && asn === 0) {
      return 'a local AS number is required before a neighbor can be configured.';
    }
    for (const entry of neighbours) {
      if (Number.parseInt(entry.effective('remote-as')[0] ?? '0', 10) === 0) {
        return `neighbor ${entry.key} has no remote-as.`;
      }
    }

    return context.device.applyBgp({
      enabled: asn > 0,
      asn,
      routerId: object.effective('router-id')[0] ?? '0.0.0.0',
      defaultLocalPreference: Number.parseInt(object.effective('default-local-preference')[0] ?? '100', 10),
      dampening: object.effective('dampening')[0] === 'enable'
        ? {
          suppressLimit: Number.parseInt(object.effective('dampening-suppress')[0] ?? '2000', 10),
          reuseLimit: Number.parseInt(object.effective('dampening-reuse')[0] ?? '750', 10),
          reachabilityHalfLifeMin: Number.parseInt(object.effective('dampening-reachability-half-life')[0] ?? '15', 10),
          unreachabilityHalfLifeMin: Number.parseInt(object.effective('dampening-unreachability-half-life')[0] ?? '15', 10),
          maxSuppressMin: Number.parseInt(object.effective('dampening-max-suppress-time')[0] ?? '60', 10),
        }
        : undefined,
      gracefulRestart: object.effective('graceful-restart')[0] === 'enable'
        ? {
          restartTimeSec: Number.parseInt(object.effective('graceful-restart-time')[0] ?? '120', 10),
          stalePathTimeSec: Number.parseInt(object.effective('graceful-stalepath-time')[0] ?? '360', 10),
          endOnTimerOnly: object.effective('graceful-end-on-timer')[0] === 'enable',
        }
        : undefined,
      neighbours: neighbours.map(entry => ({
        ip: entry.key,
        remoteAs: Number.parseInt(entry.effective('remote-as')[0] ?? '0', 10),
        weight: Number.parseInt(entry.effective('weight')[0] ?? '0', 10),
        shutdown: entry.effective('shutdown')[0] === 'enable',
        bfd: entry.effective('bfd')[0] === 'enable',
        prefixListIn: entry.effective('prefix-list-in')[0] || undefined,
        prefixListOut: entry.effective('prefix-list-out')[0] || undefined,
        routeMapIn: entry.effective('route-map-in')[0] || undefined,
        routeMapOut: entry.effective('route-map-out')[0] || undefined,
      })),
      networks: object.childEntries('network').map(entry => ({
        id: entry.key,
        prefix: entry.effective('prefix')[0] ?? '0.0.0.0',
        mask: entry.effective('prefix')[1] ?? '0.0.0.0',
        area: '',
      })),
    });
  },
};

function asPathNumbers(values: readonly string[]): number[] | null {
  const tokens = values.flatMap(value => value.split(/[\s,]+/)).filter(token => token !== '');
  const numbers = tokens.map(token => (/^\d+$/.test(token) ? Number.parseInt(token, 10) : Number.NaN));
  return tokens.length > 0 && numbers.every(n => n <= AS_NUMBER_MAX) ? numbers : null;
}

const ROUTE_MAP_RULE: FortiTableSpec = {
  path: ['router', 'route-map', 'rule'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'Rule.',
  attributes: [
    { ...word('id', 'Rule ID.'), readOnly: true },
    choice('action', 'Action.', [
      { keyword: 'permit', description: 'Permit.' },
      { keyword: 'deny', description: 'Deny.' },
    ], 'permit'),
    reference('match-as-path', 'Match BGP AS path list.', ['router aspath-list']),
    reference('match-community', 'Match BGP community list.', ['router community-list']),
    {
      name: 'set-community', help: 'BGP community attribute.', quoted: true, multiValue: true,
      parts: [{ name: 'set-community', type: 'WORD', description: 'Community.' }],
    },
    {
      ...text('set-aspath', 'Prepend BGP AS path attribute. AS number (0 - 4294967295). Use quotes for repeating numbers, For example, "1 1 2".'),
      defaultValue: [],
    },
    choice('set-aspath-action', 'Specify preferred action of set-aspath.', [
      { keyword: 'prepend', description: 'Prepend.' },
      { keyword: 'replace', description: 'Replace.' },
    ], 'prepend'),
    enable('set-community-additive', 'Enable/disable adding set-community to existing community.'),
    reference('match-ip-address', 'Match IP address permitted by access-list or prefix-list.', ['router prefix-list']),
    count('set-local-preference', 'BGP local preference path attribute.', 0, 4294967295, 0),
    count('set-metric', 'Metric value.', 0, 4294967295, 0),
    count('set-weight', 'BGP weight for routing table.', 0, 4294967295, 0),
  ],
};

const ASPATH_LIST_RULE: FortiTableSpec = {
  path: ['router', 'aspath-list', 'rule'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'AS path list rule.',
  attributes: [
    { ...word('id', 'ID.'), readOnly: true },
    choice('action', 'Permit or deny route-based operations, based on the route\'s AS_PATH attribute.', [
      { keyword: 'deny', description: 'Deny route-based operations.' },
      { keyword: 'permit', description: 'Permit route-based operations.' },
    ], 'deny'),
    text('regexp', 'Regular-expression to match the Border Gateway Protocol (BGP) AS paths.'),
  ],
};

export const ROUTER_ASPATH_LIST: FortiTableSpec = {
  path: ['router', 'aspath-list'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 230.2,
  help: 'Configure Autonomous System (AS) path lists.',
  attributes: [
    { ...word('name', 'AS path list name.'), readOnly: true },
  ],
  children: [ASPATH_LIST_RULE],
  onCommit(object, context) {
    context.device.applyAsPathList({
      name: object.key,
      rules: object.childEntries('rule').map(entry => ({
        id: Number.parseInt(entry.key, 10),
        action: entry.effective('action')[0] === 'permit' ? 'permit' as const : 'deny' as const,
        regexp: entry.effective('regexp')[0] ?? '',
      })),
    });
  },
  onDelete(key, context) {
    context.device.removeAsPathList(key);
  },
};

const COMMUNITY_LIST_RULE: FortiTableSpec = {
  path: ['router', 'community-list', 'rule'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'Community list rule.',
  attributes: [
    { ...word('id', 'ID.'), readOnly: true },
    choice('action', 'Permit or deny route-based operations, based on the route\'s COMMUNITY attribute.', [
      { keyword: 'deny', description: 'Deny route-based operations.' },
      { keyword: 'permit', description: 'Permit or allow route-based operations.' },
    ], 'deny'),
    text('match', 'Community specifications for matching a reserved community.'),
    text('regexp', 'Ordered list of COMMUNITY attributes as a regular expression.'),
  ],
};

export const ROUTER_COMMUNITY_LIST: FortiTableSpec = {
  path: ['router', 'community-list'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 230.4,
  help: 'Configure community lists.',
  attributes: [
    { ...word('name', 'Community list name.'), readOnly: true },
    choice('type', 'Community list type (standard or expanded).', [
      { keyword: 'standard', description: 'Standard community list type.' },
      { keyword: 'expanded', description: 'Expanded community list type.' },
    ], 'standard'),
  ],
  children: [COMMUNITY_LIST_RULE],
  onCommit(object, context) {
    context.device.applyCommunityList({
      name: object.key,
      kind: object.effective('type')[0] === 'expanded' ? 'expanded' : 'standard',
      rules: object.childEntries('rule').map(entry => ({
        id: Number.parseInt(entry.key, 10),
        action: entry.effective('action')[0] === 'permit' ? 'permit' as const : 'deny' as const,
        communities: (entry.effective('match')[0] ?? '').split(/\s+/).filter(word => word !== ''),
        regexp: entry.effective('regexp')[0] ?? '',
      })),
    });
  },
  onDelete(key, context) {
    context.device.removeCommunityList(key);
  },
};

const KEY_CHAIN_KEY: FortiTableSpec = {
  path: ['router', 'key-chain', 'key'],
  kind: 'table',
  keyType: 'integer',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'Configuration method to edit key settings.',
  attributes: [
    { ...word('id', 'Key ID (0 - 2147483647).'), readOnly: true },
    {
      ...choice('algorithm', 'Cryptographic algorithm.', [
        { keyword: 'md5', description: 'MD5.' },
      ], 'md5'),
    },
    { ...text('key-string', 'Password for the key (maximum = 64 characters).'), secret: true },
  ],
};

export const ROUTER_KEY_CHAIN: FortiTableSpec = {
  path: ['router', 'key-chain'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 244,
  help: 'Configure key-chain.',
  attributes: [
    { ...word('name', 'Key-chain name.'), readOnly: true },
  ],
  children: [KEY_CHAIN_KEY],
  onCommit(object, context) {
    context.device.applyKeyChain({
      name: object.key,
      keys: object.childEntries('key').map(entry => ({
        id: Number.parseInt(entry.key, 10),
        key: entry.effective('key-string')[0] ?? '',
      })),
    });
  },
  onDelete(key, context) {
    context.device.removeKeyChain(key);
  },
};

export const ROUTER_ROUTE_MAP: FortiTableSpec = {
  path: ['router', 'route-map'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 235,
  help: 'Configure route maps.',
  attributes: [
    { ...word('name', 'Name.'), readOnly: true },
    text('comments', 'Optional comments.'),
  ],
  children: [ROUTE_MAP_RULE],
  onCommit(object, context) {
    for (const entry of object.childEntries('rule')) {
      if (entry.isExplicit('set-aspath') && asPathNumbers(entry.effective('set-aspath')) === null) {
        return `value parse error: set-aspath must list AS numbers between 0 and ${AS_NUMBER_MAX}`;
      }
    }
    context.device.applyRouteMap({
      name: object.key,
      rules: object.childEntries('rule').map(entry => ({
        id: Number.parseInt(entry.key, 10),
        action: entry.effective('action')[0] === 'deny' ? 'deny' as const : 'permit' as const,
        matchPrefixList: entry.effective('match-ip-address')[0] || undefined,
        matchAsPath: entry.effective('match-as-path')[0] || undefined,
        matchCommunity: entry.effective('match-community')[0] || undefined,
        setCommunity: entry.isExplicit('set-community') ? [...entry.effective('set-community')] : undefined,
        setCommunityAdditive: entry.effective('set-community-additive')[0] === 'enable',
        setAsPath: entry.isExplicit('set-aspath')
          ? {
            action: entry.effective('set-aspath-action')[0] === 'replace' ? 'replace' as const : 'prepend' as const,
            asns: asPathNumbers(entry.effective('set-aspath')) ?? [],
          }
          : undefined,
        setLocalPreference: entry.isExplicit('set-local-preference')
          ? Number.parseInt(entry.effective('set-local-preference')[0] ?? '0', 10) : undefined,
        setMetric: entry.isExplicit('set-metric')
          ? Number.parseInt(entry.effective('set-metric')[0] ?? '0', 10) : undefined,
        setWeight: entry.isExplicit('set-weight')
          ? Number.parseInt(entry.effective('set-weight')[0] ?? '0', 10) : undefined,
      })),
    });
  },
  onDelete(key, context) {
    context.device.removeRouteMap(key);
  },
};

const BFD_NEIGHBOR: FortiTableSpec = {
  path: ['router', 'bfd', 'neighbor'],
  kind: 'table',
  keyType: 'address',
  quotedKey: true,
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 1,
  help: 'Neighbor.',
  attributes: [
    { ...word('ip', 'Neighbor address.'), readOnly: true },
    reference('interface', 'Interface the neighbor is reached on.', ['system interface']),
  ],
};

export const ROUTER_BFD: FortiTableSpec = {
  path: ['router', 'bfd'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 246,
  help: 'Configure BFD.',
  attributes: [],
  children: [BFD_NEIGHBOR],
  onCommit(object, context) {
    const neighbours = object.childEntries('neighbor');
    for (const entry of neighbours) {
      if ((entry.effective('interface')[0] ?? '') === '') return `neighbor ${entry.key} has no interface.`;
    }
    return context.device.applyBfdNeighbors(neighbours.map(entry => ({
      ip: entry.key, interface: entry.effective('interface')[0] ?? '',
    })));
  },
};

export const ROUTER_DYNAMIC_SPECS: readonly FortiTableSpec[] =
  Object.freeze([
    ROUTER_ACCESS_LIST, ROUTER_PREFIX_LIST, ROUTER_ASPATH_LIST, ROUTER_COMMUNITY_LIST, ROUTER_KEY_CHAIN, ROUTER_ROUTE_MAP, ROUTER_RIP, ROUTER_OSPF, ROUTER_BGP, ROUTER_BFD,
  ]);
