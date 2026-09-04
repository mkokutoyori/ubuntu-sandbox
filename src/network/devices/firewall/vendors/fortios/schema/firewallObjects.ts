import {
  icmpService, ipProtocolService, makeService,
  type PortRange, type ServiceEntry,
} from '../../../model/ServiceObject';
import {
  address, addressMask, choice, clock, count, enable, moment, reference, refList, text, word,
  type FortiObjectView, type FortiTableSpec,
} from './types';
import { PREDEFINED_SERVICE_NAMES } from './predefined';
import { FortiMessages } from '../FortiMessages';
import { parseIpv6Prefix } from './system';
import { prefixAddress6, rangeAddress6 } from '../../../model/AddressObject';

function isKind(kind: string) {
  return (object: FortiObjectView): boolean => object.effective('type')[0] === kind;
}

function parseRanges(raw: readonly string[]): PortRange[] {
  const out: PortRange[] = [];
  for (const token of raw) {
    const destination = token.split(':')[0];
    const [from, to] = destination.split('-');
    const low = Number.parseInt(from, 10);
    if (!Number.isFinite(low)) continue;
    const high = to === undefined ? low : Number.parseInt(to, 10);
    out.push({ from: low, to: Number.isFinite(high) ? high : low });
  }
  return out;
}

export const FIREWALL_ADDRESS: FortiTableSpec = {
  path: ['firewall', 'address'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 90,
  help: 'Configure IPv4 addresses.',
  predefined: ['all'],
  attributes: [
    { ...word('name', 'Address name.'), readOnly: true },
    { ...word('uuid', 'Universally Unique Identifier.'), readOnly: true },
    choice('type', 'Type of address.', [
      { keyword: 'ipmask', description: 'Standard IPv4 address with subnet mask.' },
      { keyword: 'iprange', description: 'Range of IPv4 addresses between two addresses.' },
      { keyword: 'fqdn', description: 'Fully Qualified Domain Name address.' },
      { keyword: 'geography', description: 'IP addresses from a specified country.' },
      { keyword: 'wildcard', description: 'IPv4 address and wildcard netmask.' },
    ], 'ipmask'),
    {
      ...addressMask('subnet', 'IP address and subnet mask of address.',
        ['0.0.0.0', '0.0.0.0']),
      availableWhen: isKind('ipmask'),
    },
    {
      ...address('start-ip', 'First IP address (inclusive) in the range.'),
      availableWhen: isKind('iprange'),
    },
    {
      ...address('end-ip', 'Final IP address (inclusive) in the range.'),
      availableWhen: isKind('iprange'),
    },
    {
      ...word('fqdn', 'Fully Qualified Domain Name address.'),
      availableWhen: isKind('fqdn'),
    },
    {
      ...word('country', 'IP addresses associated to a specific country.'),
      availableWhen: isKind('geography'),
    },
    {
      ...addressMask('wildcard', 'IP address and wildcard netmask.'),
      availableWhen: isKind('wildcard'),
    },
    reference('associated-interface', 'Network interface associated with address.',
      ['system interface', 'system zone']),
    text('comment', 'Comment.'),
    count('color', 'Color of icon on the GUI.', 0, 32, 0),
  ],
  onCommit(object, context) {
    const kind = object.effective('type')[0];
    if (kind !== 'ipmask' && kind !== 'iprange' && kind !== 'fqdn' && kind !== 'wildcard') return;

    context.objects.removeAddress(object.key);
    if (kind === 'ipmask' || kind === 'wildcard') {
      const parts = object.effective(kind === 'ipmask' ? 'subnet' : 'wildcard');
      if (parts.length < 2) return;
      context.objects.addAddress({
        name: object.key,
        kind: kind === 'ipmask' ? 'subnet' : 'wildcard',
        family: 'ipv4',
        value: parts[0],
        careMask: parts[1],
        predefined: false,
        tags: [],
      });
      return;
    }
    if (kind === 'iprange') {
      const from = object.effective('start-ip')[0];
      const to = object.effective('end-ip')[0];
      if (!from || !to) return;
      context.objects.addAddress({
        name: object.key, kind: 'range', family: 'ipv4',
        value: from, endValue: to, predefined: false, tags: [],
      });
      return;
    }
    const fqdn = object.effective('fqdn')[0];
    if (!fqdn) return;
    context.objects.addAddress({
      name: object.key, kind: 'fqdn', family: 'ipv4',
      fqdn, predefined: false, tags: [],
    });
    context.device.resolveFqdnNow(fqdn);
  },
  onDelete(key, context) {
    context.objects.removeAddress(key);
  },
};

export const FIREWALL_ADDRESS6: FortiTableSpec = {
  path: ['firewall', 'address6'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 95,
  help: 'Configure IPv6 firewall addresses.',
  predefined: ['all6'],
  attributes: [
    { ...word('name', 'Address name.'), readOnly: true },
    { ...word('uuid', 'Universally Unique Identifier.'), readOnly: true },
    choice('type', 'Type of IPv6 address object.', [
      { keyword: 'ipprefix', description: 'IPv6 address prefix.' },
      { keyword: 'iprange', description: 'Range between two IPv6 addresses.' },
    ], 'ipprefix'),
    {
      name: 'ip6', help: 'IPv6 address prefix.', quoted: false,
      parts: [{
        name: 'prefix', type: 'WORD',
        description: 'IPv6 address and prefix length, <address>/<0-128>.',
      }],
      defaultValue: ['::/0'],
      availableWhen: isKind('ipprefix'),
      acceptsValue: (value) => parseIpv6Prefix(value) !== null,
      expectedValue: 'an IPv6 prefix such as `2001:db8::/64`.',
    },
    {
      name: 'start-ip', help: 'First IPv6 address (inclusive) in the range.',
      quoted: false,
      parts: [{ name: 'start-ip', type: 'WORD', description: 'IPv6 address.' }],
      defaultValue: ['::'],
      availableWhen: isKind('iprange'),
      acceptsValue: (value) => parseIpv6Prefix(`${value}/128`) !== null,
      expectedValue: 'an IPv6 address such as `2001:db8::10`.',
    },
    {
      name: 'end-ip', help: 'Final IPv6 address (inclusive) in the range.',
      quoted: false,
      parts: [{ name: 'end-ip', type: 'WORD', description: 'IPv6 address.' }],
      defaultValue: ['::'],
      availableWhen: isKind('iprange'),
      acceptsValue: (value) => parseIpv6Prefix(`${value}/128`) !== null,
      expectedValue: 'an IPv6 address such as `2001:db8::20`.',
    },
    text('comment', 'Comment.'),
  ],
  onCommit(object, context) {
    const comment = object.effective('comment')[0] || undefined;
    if (object.effective('type')[0] === 'iprange') {
      context.objects.addAddress(rangeAddress6(object.key,
        object.effective('start-ip')[0] ?? '::',
        object.effective('end-ip')[0] ?? '::', { comment }));
      return;
    }
    const prefix = parseIpv6Prefix(object.effective('ip6')[0] ?? '::/0');
    if (!prefix) return FortiMessages.valueError(object.effective('ip6')[0] ?? '');
    context.objects.addAddress(prefixAddress6(
      object.key, prefix.address, prefix.prefixLength, { comment }));
  },
  onDelete(key, context) {
    context.objects.removeAddress(key);
  },
};

export const FIREWALL_ADDRGRP6: FortiTableSpec = {
  path: ['firewall', 'addrgrp6'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 105,
  help: 'Configure IPv6 address groups.',
  attributes: [
    { ...word('name', 'Address group name.'), readOnly: true },
    refList('member', 'Address objects contained within the group.',
      ['firewall address6', 'firewall addrgrp6']),
    text('comment', 'Comment.'),
  ],
  onCommit(object, context) {
    context.objects.removeAddressGroup(object.key);
    const members = object.effective('member');
    if (members.length === 0) return;
    context.objects.addAddressGroup(object.key, members,
      object.effective('comment')[0] || undefined);
  },
  onDelete(key, context) {
    context.objects.removeAddressGroup(key);
  },
};

export const FIREWALL_ADDRGRP: FortiTableSpec = {
  path: ['firewall', 'addrgrp'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 100,
  help: 'Configure IPv4 address groups.',
  attributes: [
    { ...word('name', 'Address group name.'), readOnly: true },
    refList('member', 'Address objects contained within the group.',
      ['firewall address', 'firewall addrgrp']),
    enable('exclude', 'Enable/disable address exclusion.'),
    refList('exclude-member', 'Address exclusion member.', ['firewall address']),
    text('comment', 'Comment.'),
  ],
  onCommit(object, context) {
    context.objects.removeAddressGroup(object.key);
    const members = object.effective('member');
    if (members.length === 0) return;
    context.objects.addAddressGroup(object.key, members,
      object.effective('comment')[0] || undefined);
  },
  onDelete(key, context) {
    context.objects.removeAddressGroup(key);
  },
};

const SERVICE_SESSION_TTL_MIN = 300;

export const FIREWALL_SERVICE_CUSTOM: FortiTableSpec = {
  path: ['firewall', 'service', 'custom'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 110,
  help: 'Configure custom services.',
  predefined: PREDEFINED_SERVICE_NAMES,
  attributes: [
    { ...word('name', 'Custom service name.'), readOnly: true },
    choice('protocol', 'Protocol type based on IANA numbers.', [
      { keyword: 'TCP/UDP/SCTP', description: 'TCP, UDP and SCTP.' },
      { keyword: 'ICMP', description: 'ICMP.' },
      { keyword: 'IP', description: 'Other IP protocol.' },
    ], 'TCP/UDP/SCTP'),
    {
      name: 'tcp-portrange', help: 'Multiple TCP port ranges.', quoted: false,
      multiValue: true,
      parts: [{
        name: 'tcp-portrange', type: 'WORD', literal: 'dst[-dst]:src[-src]',
        description: 'TCP port range.',
      }],
    },
    {
      name: 'udp-portrange', help: 'Multiple UDP port ranges.', quoted: false,
      multiValue: true,
      parts: [{
        name: 'udp-portrange', type: 'WORD', literal: 'dst[-dst]:src[-src]',
        description: 'UDP port range.',
      }],
    },
    count('icmptype', 'ICMP type.', 0, 255, 0),
    count('icmpcode', 'ICMP code.', 0, 255, 0),
    count('protocol-number', 'IP protocol number.', 0, 254, 0),
    reference('category', 'Service category.', ['firewall service category']),
    {
      ...count('session-ttl',
        'Session TTL in seconds, 0 to use the policy or VDOM setting.',
        0, 604800, 0),
      availableWhen: (object) =>
        (object.effective('protocol')[0] ?? 'TCP/UDP/SCTP') === 'TCP/UDP/SCTP',
    },
    text('comment', 'Comment.'),
  ],
  onCommit(object, context) {
    const ttl = Number.parseInt(object.effective('session-ttl')[0] ?? '0', 10);
    if (ttl !== 0 && ttl < SERVICE_SESSION_TTL_MIN) {
      return `session-ttl must be 0 or at least ${SERVICE_SESSION_TTL_MIN} seconds.`;
    }

    const protocol = object.effective('protocol')[0];
    const options = { sessionTtlSec: ttl > 0 ? ttl : undefined };
    context.objects.removeService(object.key);

    if (protocol === 'ICMP') {
      const type = Number.parseInt(object.isExplicit('icmptype') ? object.effective('icmptype')[0] ?? '' : '', 10);
      context.objects.addService(icmpService(object.key,
        Number.isFinite(type) ? type : undefined));
      return;
    }
    if (protocol === 'IP') {
      const number = Number.parseInt(object.effective('protocol-number')[0] ?? '', 10);
      context.objects.addService(ipProtocolService(object.key,
        Number.isFinite(number) ? number : 0));
      return;
    }

    const entries: ServiceEntry[] = [];
    const tcp = parseRanges(object.effective('tcp-portrange'));
    const udp = parseRanges(object.effective('udp-portrange'));
    if (tcp.length > 0) entries.push({ protocol: 'tcp', destinationPorts: tcp });
    if (udp.length > 0) entries.push({ protocol: 'udp', destinationPorts: udp });
    if (entries.length === 0) return;
    context.objects.addService(makeService(object.key, entries, options));
  },
  onDelete(key, context) {
    context.objects.removeService(key);
  },
};

export const FIREWALL_SERVICE_CATEGORY: FortiTableSpec = {
  path: ['firewall', 'service', 'category'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 149,
  help: 'Configure service categories.',
  predefined: [
    'General', 'Web Access', 'File Access', 'Email', 'Network Services',
    'Authentication', 'Remote Access', 'Tunneling', 'VoIP, Messaging & Other Applications',
    'Web Proxy',
  ],
  attributes: [
    { ...word('name', 'Service category name.'), readOnly: true },
    text('comment', 'Comment.'),
  ],
  onCommit() {},
};

export const FIREWALL_SERVICE_GROUP: FortiTableSpec = {
  path: ['firewall', 'service', 'group'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 120,
  help: 'Configure service groups.',
  attributes: [
    { ...word('name', 'Service group name.'), readOnly: true },
    refList('member', 'Service objects contained within the group.',
      ['firewall service custom', 'firewall service group']),
    text('comment', 'Comment.'),
  ],
  onCommit(object, context) {
    context.objects.removeServiceGroup(object.key);
    const members = object.effective('member');
    if (members.length === 0) return;
    context.objects.addServiceGroup(object.key, members,
      object.effective('comment')[0] || undefined);
  },
  onDelete(key, context) {
    context.objects.removeServiceGroup(key);
  },
};

const DAYS = [
  { keyword: 'sunday', description: 'Sunday.' },
  { keyword: 'monday', description: 'Monday.' },
  { keyword: 'tuesday', description: 'Tuesday.' },
  { keyword: 'wednesday', description: 'Wednesday.' },
  { keyword: 'thursday', description: 'Thursday.' },
  { keyword: 'friday', description: 'Friday.' },
  { keyword: 'saturday', description: 'Saturday.' },
  { keyword: 'none', description: 'No day.' },
];

export const FIREWALL_SCHEDULE_RECURRING: FortiTableSpec = {
  path: ['firewall', 'schedule', 'recurring'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 130,
  help: 'Recurring schedule configuration.',
  predefined: ['always'],
  attributes: [
    { ...word('name', 'Recurring schedule name.'), readOnly: true },
    {
      name: 'day', help: 'One or more days of the week.', quoted: false,
      multiValue: true,
      parts: [{ name: 'day', type: 'ENUM', description: 'Day of the week.', values: DAYS }],
      defaultValue: ['none'],
    },
    clock('start', 'Time of day to start the schedule, format hh:mm.', '00:00'),
    clock('end', 'Time of day to end the schedule, format hh:mm.', '00:00'),
    count('color', 'Color of icon on the GUI.', 0, 32, 0),
  ],
  onCommit(object, context) {
    context.device.applySchedule({
      name: object.key,
      days: object.effective('day').filter(d => d !== 'none'),
      start: object.effective('start')[0] ?? '00:00',
      end: object.effective('end')[0] ?? '00:00',
      onetime: false,
    });
  },
  onDelete(key, context) {
    context.device.removeSchedule(key);
  },
};

export const FIREWALL_SCHEDULE_ONETIME: FortiTableSpec = {
  path: ['firewall', 'schedule', 'onetime'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 131,
  help: 'Onetime schedule configuration.',
  attributes: [
    { ...word('name', 'Onetime schedule name.'), readOnly: true },
    moment('start', 'Schedule start date and time, format hh:mm yyyy/mm/dd.'),
    moment('end', 'Schedule end date and time, format hh:mm yyyy/mm/dd.'),
    count('color', 'Color of icon on the GUI.', 0, 32, 0),
  ],
  onCommit(object, context) {
    const start = object.effective('start').join(' ');
    const end = object.effective('end').join(' ');
    return context.device.applyOnetimeSchedule({ name: object.key, start, end });
  },
  onDelete(key, context) {
    context.device.removeSchedule(key);
  },
};

export const FIREWALL_SCHEDULE_GROUP: FortiTableSpec = {
  path: ['firewall', 'schedule', 'group'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 132,
  help: 'Schedule group configuration.',
  attributes: [
    { ...word('name', 'Schedule group name.'), readOnly: true },
    refList('member', 'Schedules added to the schedule group.',
      ['firewall schedule recurring', 'firewall schedule onetime']),
    count('color', 'Color of icon on the GUI.', 0, 32, 0),
  ],
  onCommit(object, context) {
    return context.device.applyScheduleGroup({
      name: object.key,
      members: [...object.effective('member')],
    });
  },
  onDelete(key, context) {
    context.device.removeSchedule(key);
  },
};
