import {
  choice, enable, reference, refList, text,
  type FortiObjectView, type FortiTableSpec,
} from './types';

const ADDRESS_TARGETS = ['firewall address', 'firewall addrgrp'];
const INTERFACE_TARGETS = ['system interface', 'system zone'];
const SERVICE_TARGETS = ['firewall service custom', 'firewall service group'];
const SCHEDULE_TARGETS = [
  'firewall schedule recurring', 'firewall schedule onetime', 'firewall schedule group',
];

const LOCAL_IN_REQUIRES: ReadonlyArray<readonly string[]> = [
  ['srcaddr'], ['dstaddr'], ['service'],
];

function missingAttribute(object: FortiObjectView): string | undefined {
  for (const forms of LOCAL_IN_REQUIRES) {
    if (forms.some(name => object.effective(name).length > 0)) continue;
    return forms[0];
  }
  return undefined;
}

function listOrAny(values: readonly string[]): string[] {
  return values.length === 0 ? ['any'] : [...values];
}

function normaliseAny(values: readonly string[]): string[] {
  if (values.length === 0) return ['any'];
  return values.map(v => (v.toLowerCase() === 'all' ? 'any' : v));
}

function timeRestriction(name: string | undefined): string | undefined {
  return name === undefined || name === 'always' ? undefined : name;
}

const ACTION_CHOICES = [
  { keyword: 'accept', description: 'Allow traffic matching this policy.' },
  { keyword: 'deny', description: 'Deny or block traffic matching this policy.' },
];

function localInSpec(
  path: readonly string[], help: string, addressTargets: readonly string[],
  extra: readonly FortiTableSpec['attributes'][number][],
): FortiTableSpec {
  return {
    path: [...path],
    kind: 'table',
    keyType: 'integer',
    ordered: true,
    scope: 'vdom',
    accessGroup: 'fwgrp',
    renderOrder: 241,
    help,
    attributes: [
      {
        name: 'policyid', help: 'User defined local in policy ID.',
        readOnly: true, quoted: false,
        parts: [{ name: 'policyid', type: 'INT', description: 'Policy ID.' }],
      },
      ...extra,
      reference('intf', 'Incoming interface name from available options.',
        INTERFACE_TARGETS),
      refList('srcaddr', 'Source address object from available options.',
        addressTargets),
      refList('dstaddr', 'Destination address object from available options.',
        addressTargets),
      choice('action', 'Action performed on traffic matching the policy.',
        ACTION_CHOICES, 'deny'),
      refList('service', 'Service object from available options.', SERVICE_TARGETS),
      reference('schedule', 'Schedule object from available options.',
        SCHEDULE_TARGETS, 'always'),
      enable('status', 'Enable/disable this local-in policy.', true),
      text('comments', 'Comment.'),
    ],
    onCommit(object, context) {
      const absent = missingAttribute(object);
      if (absent !== undefined) return `entry not set for "${absent}".`;

      const action = object.effective('action')[0] === 'accept' ? 'allow' : 'deny';
      const comment = object.effective('comments')[0];
      const intf = object.effective('intf');

      context.localIn.remove(object.key);
      const insertion = context.position < 0 ? Number.MAX_SAFE_INTEGER : context.position;
      context.localIn.insertAt(insertion, {
        id: object.key,
        from: listOrAny(intf),
        to: ['any'],
        source: normaliseAny(object.effective('srcaddr')),
        destination: normaliseAny(object.effective('dstaddr')),
        service: normaliseAny(object.effective('service')),
        action,
        enabled: object.effective('status')[0] !== 'disable',
        schedule: timeRestriction(object.effective('schedule')[0]),
        comment: comment === '' ? undefined : comment,
      });
    },
    onDelete(key, context) {
      context.localIn.remove(key);
    },
  };
}

export const FIREWALL_LOCAL_IN_POLICY = localInSpec(
  ['firewall', 'local-in-policy'],
  'Configure user defined IPv4 local-in policies.',
  ADDRESS_TARGETS,
  [enable('ha-mgmt-intf-only',
    'Enable/disable dedicating the HA management interface only for local-in policy.')],
);
