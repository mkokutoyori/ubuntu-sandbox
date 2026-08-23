import {
  address, choice, count, enable, reference, refList, text, word,
  type FortiObjectView, type FortiTableSpec,
} from './types';

const INTERFACE_TARGETS = ['system interface', 'system zone'];
const ADDRESS_TARGETS = ['firewall address', 'firewall addrgrp'];

const NO_DNS_ALG = 'a dns-translation VIP rewrites the address inside a DNS reply '
  + 'crossing the firewall, which needs a DNS application-level gateway on the '
  + 'transit path. None exists here, so the type would be accepted and translate '
  + 'nothing.';

function isStaticNat(object: FortiObjectView): boolean {
  return object.effective('type')[0] === 'static-nat';
}

function isFqdnVip(object: FortiObjectView): boolean {
  return object.effective('type')[0] === 'fqdn';
}

function forwardsPorts(object: FortiObjectView): boolean {
  return isStaticNat(object) && object.effective('portforward')[0] === 'enable';
}

function isBlockPool(object: FortiObjectView): boolean {
  return object.effective('type')[0] === 'port-block-allocation';
}

function hasSourceRange(object: FortiObjectView): boolean {
  const type = object.effective('type')[0];
  return type === 'fixed-port-range' || type === 'one-to-one'
    || type === 'port-block-allocation';
}

function portNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function protocolNumber(name: string | undefined): number {
  if (name === 'tcp') return 6;
  if (name === 'udp') return 17;
  if (name === 'sctp') return 132;
  if (name === 'icmp') return 1;
  return 0;
}

export const FIREWALL_IPPOOL: FortiTableSpec = {
  path: ['firewall', 'ippool'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 140,
  help: 'Configure IPv4 IP pools.',
  attributes: [
    { ...word('name', 'IP pool name.'), readOnly: true },
    choice('type', 'IP pool type.', [
      { keyword: 'overload', description: 'Many-to-few with port translation.' },
      { keyword: 'one-to-one', description: 'One-to-one without port translation.' },
      { keyword: 'fixed-port-range', description: 'Fixed port range per internal address.' },
      {
        keyword: 'port-block-allocation',
        description: 'Port block allocation for carrier grade NAT.',
      },
    ], 'overload'),
    address('startip', 'First IPv4 address (inclusive) in the range.', '0.0.0.0'),
    address('endip', 'Final IPv4 address (inclusive) in the range.', '0.0.0.0'),
    {
      ...address('source-startip', 'First IPv4 address (inclusive) in the source range.',
        '0.0.0.0'),
      availableWhen: hasSourceRange,
    },
    {
      ...address('source-endip', 'Final IPv4 address (inclusive) in the source range.',
        '0.0.0.0'),
      availableWhen: hasSourceRange,
    },
    {
      ...count('block-size', 'Number of addresses in a block.', 64, 4096, 128),
      availableWhen: isBlockPool,
    },
    {
      ...count('num-blocks-per-user', 'Number of blocks a user can use.', 1, 128, 8),
      availableWhen: isBlockPool,
    },
    {
      ...count('pba-timeout', 'Port block allocation timeout in seconds.', 3, 300, 30),
      availableWhen: isBlockPool,
    },
    enable('permit-any-host', 'Enable/disable full cone NAT.'),
    enable('arp-reply', 'Enable/disable replying to ARP requests when an IP pool '
      + 'is added to a policy.', true),
    reference('arp-intf', 'Select an interface from available options that will reply '
      + 'to ARP requests.', INTERFACE_TARGETS),
    reference('associated-interface', 'Associated interface name.', INTERFACE_TARGETS),
    text('comments', 'Comment.'),
  ],
  onCommit(object, context) {
    const start = object.effective('startip')[0] ?? '0.0.0.0';
    if (start === '0.0.0.0') return;

    const end = object.effective('endip')[0] ?? start;
    const ranged = hasSourceRange(object);
    const sourceStart = object.effective('source-startip')[0];
    const sourceEnd = object.effective('source-endip')[0];

    context.device.applyIpPool({
      name: object.key,
      type: object.effective('type')[0] ?? 'overload',
      startIP: start,
      endIP: end === '0.0.0.0' ? start : end,
      sourceStartIP: ranged && sourceStart !== '0.0.0.0' ? sourceStart : undefined,
      sourceEndIP: ranged && sourceEnd !== '0.0.0.0' ? sourceEnd : undefined,
      blockSize: portNumber(object.effective('block-size')[0], 128),
      blocksPerUser: portNumber(object.effective('num-blocks-per-user')[0], 8),
      pbaTimeout: portNumber(object.effective('pba-timeout')[0], 30),
      permitAnyHost: object.effective('permit-any-host')[0] === 'enable',
      arpReply: object.effective('arp-reply')[0] !== 'disable',
      arpInterface: object.effective('arp-intf')[0] || undefined,
      associatedInterface: object.effective('associated-interface')[0] || undefined,
      comment: object.effective('comments')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeIpPool(key);
  },
};

export const FIREWALL_VIP: FortiTableSpec = {
  path: ['firewall', 'vip'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 150,
  help: 'Configure virtual IP for IPv4.',
  attributes: [
    { ...word('name', 'Virtual IP name.'), readOnly: true },
    { ...word('uuid', 'Universally Unique Identifier.'), readOnly: true },
    text('comment', 'Comment.'),
    {
      ...choice('type', 'Configure a static NAT or server load balance VIP.', [
        { keyword: 'static-nat', description: 'Static NAT.' },
        { keyword: 'dns-translation', description: 'DNS translation.' },
        { keyword: 'fqdn', description: 'FQDN translation.' },
      ], 'static-nat'),
      unimplementedValues: { 'dns-translation': NO_DNS_ALG },
    },
    {
      name: 'extip', help: 'IP address or address range on the external interface.',
      quoted: false,
      parts: [{
        name: 'extip', type: 'WORD', literal: 'A.B.C.D[-A.B.C.D]',
        description: 'External IP address or range.',
      }],
      defaultValue: ['0.0.0.0'],
    },
    {
      name: 'mappedip', help: 'IP address or address range on the destination network '
        + 'to which the external IP address is mapped.',
      quoted: true, multiValue: true,
      parts: [{
        name: 'mappedip', type: 'WORD', literal: 'A.B.C.D[-A.B.C.D]',
        description: 'Mapped IP address or range.',
      }],
      defaultValue: [],
    },
    {
      ...reference('mapped-addr', 'Mapped FQDN address object.', ADDRESS_TARGETS),
      availableWhen: isFqdnVip,
    },
    refList('extintf', 'Interface connected to the source network that receives the '
      + 'packets that will be forwarded to the destination network.', INTERFACE_TARGETS),
    refList('srcintf-filter', 'Interfaces to which the VIP applies.', INTERFACE_TARGETS),
    refList('srcfilter', 'Source address filter.', ADDRESS_TARGETS),
    enable('arp-reply', 'Enable to respond to ARP requests for this virtual IP address.',
      true),
    { ...enable('portforward', 'Enable/disable port forwarding.'), availableWhen: isStaticNat },
    {
      ...choice('protocol', 'Protocol to use when forwarding packets.', [
        { keyword: 'tcp', description: 'TCP.' },
        { keyword: 'udp', description: 'UDP.' },
        { keyword: 'sctp', description: 'SCTP.' },
        { keyword: 'icmp', description: 'ICMP.' },
      ], 'tcp'),
      availableWhen: forwardsPorts,
    },
    {
      name: 'extport', help: 'Incoming port number range that you want to map to a '
        + 'port number range on the destination network.',
      quoted: false,
      parts: [{
        name: 'extport', type: 'WORD', literal: '<port>[-<port>]',
        description: 'External port or port range.',
      }],
      defaultValue: ['0'],
      availableWhen: forwardsPorts,
    },
    {
      name: 'mappedport', help: 'Port number range on the destination network to which '
        + 'the external port number range is mapped.',
      quoted: false,
      parts: [{
        name: 'mappedport', type: 'WORD', literal: '<port>[-<port>]',
        description: 'Mapped port or port range.',
      }],
      defaultValue: ['0'],
      availableWhen: forwardsPorts,
    },
    enable('nat-source-vip', 'Enable to prevent unintended servers from using a virtual '
      + 'IP, forcing the source address of traffic to the external IP of the VIP.'),
    count('color', 'Color of icon on the GUI.', 0, 32, 0),
  ],
  onCommit(object, context) {
    const kind = object.effective('type')[0] ?? 'static-nat';
    const external = splitRange(object.effective('extip')[0] ?? '');
    if (external.from === '') return;

    if (kind === 'fqdn') {
      const mappedAddress = object.effective('mapped-addr')[0] ?? '';
      if (mappedAddress === '') return 'a fqdn VIP needs `set mapped-addr <object>`.';

      return context.device.applyFqdnVip({
        name: object.key,
        externalAddress: external.from,
        externalEndAddress: external.to,
        mappedAddressObject: mappedAddress,
        externalInterfaces: [...object.effective('extintf')],
        sourceFilters: [...object.effective('srcfilter')],
        arpReply: object.effective('arp-reply')[0] !== 'disable',
        comment: object.effective('comment')[0] || undefined,
      });
    }

    const mapped = splitRange(object.effective('mappedip')[0] ?? '');
    if (mapped.from === '') return;

    const forwarding = object.effective('portforward')[0] === 'enable';
    const protocol = protocolNumber(object.effective('protocol')[0]);
    const externalPorts = splitPortRange(object.effective('extport')[0]);
    const mappedPorts = splitPortRange(object.effective('mappedport')[0]);

    context.device.applyVip({
      name: object.key,
      externalAddress: external.from,
      externalEndAddress: external.to,
      mappedAddress: mapped.from,
      mappedEndAddress: mapped.to,
      externalInterfaces: [...object.effective('extintf')],
      sourceFilters: [...object.effective('srcfilter')],
      arpReply: object.effective('arp-reply')[0] !== 'disable',
      portForward: forwarding,
      protocol: forwarding ? protocol : 0,
      externalPortFrom: forwarding ? externalPorts.from : 0,
      externalPortTo: forwarding ? externalPorts.to : 0,
      mappedPort: forwarding
        ? (mappedPorts.from === 0 ? externalPorts.from : mappedPorts.from)
        : 0,
      natSourceVip: object.effective('nat-source-vip')[0] === 'enable',
      comment: object.effective('comment')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeVip(key);
  },
};

export const FIREWALL_CENTRAL_SNAT_MAP: FortiTableSpec = {
  path: ['firewall', 'central-snat-map'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 250,
  help: 'Configure IPv4 and IPv6 central SNAT policies.',
  attributes: [
    {
      name: 'policyid', help: 'Policy ID.', readOnly: true, quoted: false,
      parts: [{ name: 'policyid', type: 'INT', description: 'Policy ID.' }],
    },
    { ...word('uuid', 'Universally Unique Identifier.'), readOnly: true },
    enable('status', 'Enable/disable the active status of this policy.', true),
    choice('type', 'IPv4/IPv6 source NAT.', [
      { keyword: 'ipv4', description: 'IPv4 source NAT.' },
      { keyword: 'ipv6', description: 'IPv6 source NAT.' },
    ], 'ipv4'),
    refList('srcintf', 'Source interface name from available interfaces.',
      INTERFACE_TARGETS),
    refList('dstintf', 'Destination interface name from available interfaces.',
      INTERFACE_TARGETS),
    refList('orig-addr', 'Original address.', ADDRESS_TARGETS),
    refList('dst-addr', 'Destination address name from available addresses.',
      ADDRESS_TARGETS),
    count('protocol', 'Integer value for the protocol type (0 - 255).', 0, 255, 0),
    {
      name: 'orig-port', help: 'Original port.', quoted: false,
      parts: [{
        name: 'orig-port', type: 'WORD', literal: '<port>[-<port>]',
        description: 'Original port or port range.',
      }],
      defaultValue: ['0'],
    },
    enable('nat', 'Enable/disable source NAT.', true),
    refList('nat-ippool', 'Name of the IP pool to be used to translate the address.',
      ['firewall ippool']),
    {
      name: 'nat-port', help: 'Translated port or port range.', quoted: false,
      parts: [{
        name: 'nat-port', type: 'WORD', literal: '<port>[-<port>]',
        description: 'Translated port or port range.',
      }],
      defaultValue: ['0'],
    },
    text('comments', 'Comment.'),
  ],
  onCommit(object, context) {
    const pool = object.effective('nat-ippool')[0];
    const ports = splitPortRange(object.effective('orig-port')[0]);
    const translated = splitPortRange(object.effective('nat-port')[0]);
    const protocol = portNumber(object.effective('protocol')[0], 0);

    context.device.applyCentralSnat({
      id: object.key,
      position: context.position,
      enabled: object.effective('status')[0] !== 'disable',
      translate: object.effective('nat')[0] !== 'disable',
      sourceInterfaces: [...object.effective('srcintf')],
      destinationInterfaces: [...object.effective('dstintf')],
      originalAddresses: [...object.effective('orig-addr')],
      destinationAddresses: [...object.effective('dst-addr')],
      protocol,
      sourcePortFrom: ports.from,
      sourcePortTo: ports.to,
      translatedPortFrom: translated.from > 0 ? translated.from : undefined,
      translatedPortTo: translated.from > 0 ? translated.to : undefined,
      pool: pool || undefined,
      comment: object.effective('comments')[0] || undefined,
    });
  },
  onDelete(key, context) {
    context.device.removeCentralSnat(key);
  },
};

export function splitRange(raw: string): { from: string; to?: string } {
  const [from, to] = raw.split('-');
  return { from: (from ?? '').trim(), to: to === undefined ? undefined : to.trim() };
}

export function splitPortRange(raw: string | undefined): { from: number; to: number } {
  const [from, to] = (raw ?? '').split('-');
  const low = portNumber(from, 0);
  return { from: low, to: to === undefined ? low : portNumber(to, low) };
}

export const FIREWALL_NAT_SPECS: readonly FortiTableSpec[] = Object.freeze([
  FIREWALL_IPPOOL,
  FIREWALL_VIP,
  FIREWALL_CENTRAL_SNAT_MAP,
]);
