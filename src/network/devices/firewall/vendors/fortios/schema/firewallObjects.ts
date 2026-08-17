import {
  choice, count, text,
  type FortiObjectView, type FortiTableSpec,
} from './types';

function isKind(kind: string) {
  return (object: FortiObjectView): boolean => object.effective('type')[0] === kind;
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
    { name: 'name', type: 'string', help: 'Address name.', readOnly: true, maxLength: 79 },
    { name: 'uuid', type: 'uuid', help: 'Universally Unique Identifier.', readOnly: true },
    choice('type', 'Type of address.', [
      { value: 'ipmask', help: 'Standard IPv4 address with subnet mask.' },
      { value: 'iprange', help: 'Range of IPv4 addresses between two specified addresses.' },
      { value: 'fqdn', help: 'Fully Qualified Domain Name address.' },
      { value: 'geography', help: 'IP addresses from a specified country.' },
      { value: 'wildcard', help: 'IPv4 address and wildcard netmask.' },
      { value: 'dynamic', help: 'SDN address.' },
      { value: 'interface-subnet', help: 'Subnet of an interface.' },
      { value: 'mac', help: 'MAC address range.' },
    ], 'ipmask'),
    {
      name: 'subnet',
      type: 'ipv4-address-mask',
      help: 'IP address and subnet mask of address.',
      defaultValue: ['0.0.0.0', '0.0.0.0'],
      availableWhen: isKind('ipmask'),
    },
    {
      name: 'start-ip',
      type: 'ipv4-address',
      help: 'First IP address (inclusive) in the range for the address.',
      availableWhen: isKind('iprange'),
    },
    {
      name: 'end-ip',
      type: 'ipv4-address',
      help: 'Final IP address (inclusive) in the range for the address.',
      availableWhen: isKind('iprange'),
    },
    {
      name: 'fqdn',
      type: 'string',
      help: 'Fully Qualified Domain Name address.',
      maxLength: 255,
      availableWhen: isKind('fqdn'),
    },
    {
      name: 'country',
      type: 'string',
      help: 'IP addresses associated to a specific country.',
      maxLength: 2,
      availableWhen: isKind('geography'),
    },
    {
      name: 'wildcard',
      type: 'ipv4-address-mask',
      help: 'IP address and wildcard netmask.',
      availableWhen: isKind('wildcard'),
    },
    {
      name: 'associated-interface',
      type: 'reference',
      help: 'Network interface associated with address.',
      referenceTo: ['system interface', 'system zone'],
    },
    text('comment', 'Comment.', 255),
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
  },
  onDelete(key, context) {
    context.objects.removeAddress(key);
  },
};
