import {
  address, addressMask, choice, count, reference, text, word,
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
  },
  onDelete(key, context) {
    context.objects.removeAddress(key);
  },
};
