import {
  choice, count, enable, reference, refList, text, word,
  type FortiObjectView, type FortiTableSpec,
} from './types';

const ADDRESS_TARGETS = ['firewall address', 'firewall addrgrp', 'firewall vip'];
const INTERFACE_TARGETS = ['system interface', 'system zone'];
const SERVICE_TARGETS = ['firewall service custom', 'firewall service group'];
const SCHEDULE_TARGETS = ['firewall schedule recurring', 'firewall schedule onetime'];

function centralNatEnabled(object: FortiObjectView): boolean {
  return object.setting('system settings', 'central-nat')[0] === 'enable';
}

function policyOwnsNat(object: FortiObjectView): boolean {
  return !centralNatEnabled(object);
}

function usesIpPool(object: FortiObjectView): boolean {
  return policyOwnsNat(object) && object.effective('ippool')[0] === 'enable';
}

function denies(object: FortiObjectView): boolean {
  return object.effective('action')[0] === 'deny';
}

export const FIREWALL_POLICY: FortiTableSpec = {
  path: ['firewall', 'policy'],
  kind: 'table',
  keyType: 'integer',
  ordered: true,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 240,
  help: 'Configure IPv4/IPv6 policies.',
  attributes: [
    {
      name: 'policyid', help: 'Policy ID.', readOnly: true, quoted: false,
      parts: [{ name: 'policyid', type: 'INT', description: 'Policy ID.' }],
    },
    word('name', 'Policy name.'),
    {
      name: 'uuid', help: 'Universally Unique Identifier.', readOnly: true, quoted: false,
      parts: [{ name: 'uuid', type: 'WORD', description: 'UUID.' }],
    },
    refList('srcintf', 'Incoming (ingress) interface.', INTERFACE_TARGETS),
    refList('dstintf', 'Outgoing (egress) interface.', INTERFACE_TARGETS),
    refList('srcaddr', 'Source address and address group names.', ADDRESS_TARGETS),
    refList('dstaddr', 'Destination address and address group names.', ADDRESS_TARGETS),
    enable('srcaddr-negate', 'When enabled srcaddr specifies what the source address must NOT be.'),
    enable('dstaddr-negate', 'When enabled dstaddr specifies what the destination address must NOT be.'),
    refList('service', 'Service and service group names.', SERVICE_TARGETS),
    enable('service-negate', 'When enabled service specifies what the service must NOT be.'),
    reference('schedule', 'Schedule name.', SCHEDULE_TARGETS, 'always'),
    choice('action', 'Policy action.', [
      { keyword: 'accept', description: 'Allow session that match this policy.' },
      { keyword: 'deny', description: 'Deny or block sessions that match this policy.' },
      { keyword: 'ipsec', description: 'Allow and encrypt IPsec sessions (policy-based VPN).' },
    ], 'deny'),
    enable('status', 'Enable or disable this policy.', true),
    {
      ...enable('nat', 'Enable/disable source NAT.'),
      availableWhen: policyOwnsNat,
    },
    {
      ...enable('ippool', 'Enable to use IP Pools for source NAT.'),
      availableWhen: policyOwnsNat,
    },
    {
      ...refList('poolname', 'IP Pool names.', ['firewall ippool']),
      availableWhen: usesIpPool,
    },
    {
      ...enable('fixedport',
        'Enable to prevent source NAT from changing a session source port.'),
      availableWhen: policyOwnsNat,
    },
    {
      ...enable('match-vip',
        'Enable to match packets that have had their destination addresses changed '
        + 'by a VIP.', true),
      availableWhen: denies,
    },
    choice('logtraffic', 'Enable or disable logging.', [
      { keyword: 'all', description: 'Log all sessions accepted or denied by this policy.' },
      { keyword: 'utm', description: 'Log traffic that has a security profile applied to it.' },
      { keyword: 'disable', description: 'Disable all logging for this policy.' },
    ], 'utm'),
    enable('logtraffic-start', 'Record logs when a session starts.'),
    enable('capture-packet', 'Enable/disable capture packets.'),
    enable('utm-status', 'Enable to add one or more security profiles.'),
    choice('inspection-mode', 'Policy inspection mode.', [
      { keyword: 'proxy', description: 'Proxy based inspection.' },
      { keyword: 'flow', description: 'Flow based inspection.' },
    ], 'flow'),
    count('session-ttl', 'TTL in seconds for sessions accepted by this policy.',
      0, 2764800, 0),
    choice('tcp-session-without-syn',
      'Enable/disable creation of TCP session without SYN flag.', [
        { keyword: 'all', description: 'Enable TCP session without SYN.' },
        { keyword: 'data-only', description: 'Enable TCP session data only.' },
        { keyword: 'disable', description: 'Disable TCP session without SYN.' },
      ], 'disable'),
    text('comments', 'Comment.'),
    {
      ...enable('auto-asic-offload', 'Enable/disable policy traffic ASIC offloading.'),
      unimplemented: 'this simulator has no hardware acceleration model, '
        + 'so the setting would have no measurable effect.',
    },
    {
      name: 'application', help: 'Application ID list.', multiValue: true, quoted: false,
      parts: [{ name: 'application', type: 'INT', description: 'Application ID.' }],
      unimplemented: 'application identification needs a FortiGuard signature '
        + 'database; accepting this attribute would install a rule that could '
        + 'never match.',
    },
    {
      ...reference('av-profile', 'Name of an existing Antivirus profile.',
        ['antivirus profile']),
      unimplemented: 'security profiles are not implemented yet.',
    },
  ],
  onCommit(object, context) {
    const action = object.effective('action')[0] === 'deny' ? 'deny' : 'allow';
    const comment = object.effective('comments')[0];
    const name = object.effective('name')[0];

    context.policy.remove(object.key);
    const insertion = context.position < 0 ? Number.MAX_SAFE_INTEGER : context.position;
    context.policy.insertAt(insertion, {
      id: object.key,
      name: name === '' ? undefined : name,
      from: listOrAny(object.effective('srcintf')),
      to: listOrAny(object.effective('dstintf')),
      source: normaliseAny(object.effective('srcaddr')),
      destination: normaliseAny(object.effective('dstaddr')),
      service: normaliseAny(object.effective('service')),
      sourceNegated: object.effective('srcaddr-negate')[0] === 'enable',
      destinationNegated: object.effective('dstaddr-negate')[0] === 'enable',
      serviceNegated: object.effective('service-negate')[0] === 'enable',
      schedule: timeRestriction(object.effective('schedule')[0]),
      action,
      enabled: object.effective('status')[0] !== 'disable',
      natEnabled: object.effective('nat')[0] === 'enable',
      natPool: usesIpPool(object) ? object.effective('poolname')[0] : undefined,
      fixedPort: object.effective('fixedport')[0] === 'enable',
      matchTranslatedDestination: action === 'deny'
        ? object.effective('match-vip')[0] !== 'disable'
        : undefined,
      logStart: object.effective('logtraffic-start')[0] === 'enable',
      logEnd: object.effective('logtraffic')[0] === 'all',
      sessionTimeoutOverrideSec: sessionTtl(object.effective('session-ttl')[0]),
      comment: comment === '' ? undefined : comment,
    });
  },
  onDelete(key, context) {
    context.policy.remove(key);
  },
};

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

function sessionTtl(raw: string | undefined): number | undefined {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
