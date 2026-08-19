import {
  address, addressMask, choice, count, enable, reference, text, word,
  type FortiTableSpec,
} from './types';

const BGP_NOTE = 'BGP has a real engine in this simulator, but it runs over a '
  + 'TCP session this firewall does not open for it yet; RIP and OSPF are '
  + 'available on this platform.';

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
  ],
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
    enable('distribute-list-in', 'Filter incoming routes.'),
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
      })),
      redistributeConnected: false,
      redistributeStatic: false,
    });
  },
};

export const ROUTER_BGP: FortiTableSpec = {
  path: ['router', 'bgp'],
  kind: 'object',
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 236,
  help: `Configure BGP. ${BGP_NOTE}`,
  unavailable: BGP_NOTE,
  attributes: [
    { ...word('as', 'Local autonomous system number.'), unimplemented: BGP_NOTE },
  ],
};

export const ROUTER_DYNAMIC_SPECS: readonly FortiTableSpec[] =
  Object.freeze([ROUTER_RIP, ROUTER_OSPF, ROUTER_BGP]);
