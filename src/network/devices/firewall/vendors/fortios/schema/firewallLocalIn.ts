import {
  choice, enable, reference, refList, text,
  type FortiObjectView, type FortiTableSpec,
} from './types';

const ADDRESS_TARGETS = ['firewall address', 'firewall addrgrp'];
const ADDRESS6_TARGETS = ['firewall address6', 'firewall addrgrp6'];
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

interface LocalInFamily {
  readonly path: readonly string[];
  readonly help: string;
  readonly renderOrder: number;
  readonly addressTargets: readonly string[];
  readonly store: 'localIn' | 'localIn6';
  readonly extra: readonly FortiTableSpec['attributes'][number][];
}

function localInSpec(family: LocalInFamily): FortiTableSpec {
  const { addressTargets, extra, store } = family;
  const v6 = store === 'localIn6';
  return {
    path: [...family.path],
    kind: 'table',
    keyType: 'integer',
    ordered: true,
    scope: 'vdom',
    accessGroup: 'fwgrp',
    renderOrder: family.renderOrder,
    help: family.help,
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

      const source = normaliseAny(object.effective('srcaddr'));
      const destination = normaliseAny(object.effective('dstaddr'));

      context[store].remove(object.key);
      const insertion = context.position < 0 ? Number.MAX_SAFE_INTEGER : context.position;
      context[store].insertAt(insertion, {
        id: object.key,
        from: listOrAny(intf),
        to: ['any'],
        source: v6 ? [] : source,
        destination: v6 ? [] : destination,
        source6: v6 ? source : [],
        destination6: v6 ? destination : [],
        service: normaliseAny(object.effective('service')),
        action,
        enabled: object.effective('status')[0] !== 'disable',
        schedule: timeRestriction(object.effective('schedule')[0]),
        comment: comment === '' ? undefined : comment,
        haMgmtInterfaceOnly:
          object.effective('ha-mgmt-intf-only')[0] === 'enable' ? true : undefined,
      });
    },
    onDelete(key, context) {
      context[store].remove(key);
    },
  };
}

export const FIREWALL_LOCAL_IN_POLICY = localInSpec({
  path: ['firewall', 'local-in-policy'],
  help: 'Configure user defined IPv4 local-in policies.',
  renderOrder: 241,
  addressTargets: ADDRESS_TARGETS,
  store: 'localIn',
  extra: [enable('ha-mgmt-intf-only',
    'Enable/disable dedicating the HA management interface only for local-in policy.')],
});

export const FIREWALL_LOCAL_IN_POLICY6 = localInSpec({
  path: ['firewall', 'local-in-policy6'],
  help: 'Configure user defined IPv6 local-in policies.',
  renderOrder: 242,
  addressTargets: ADDRESS6_TARGETS,
  store: 'localIn6',
  extra: [],
});
