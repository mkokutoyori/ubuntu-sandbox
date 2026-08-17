import {
  choice, count, enable, refList, text,
  type FortiObjectView, type FortiTableSpec,
} from './types';

const ADDRESS_TARGETS = ['firewall address', 'firewall addrgrp', 'firewall vip'];
const INTERFACE_TARGETS = ['system interface', 'system zone'];
const SERVICE_TARGETS = ['firewall service custom', 'firewall service group'];

function usesIpPool(object: FortiObjectView): boolean {
  return object.effective('ippool')[0] === 'enable';
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
    { name: 'policyid', type: 'integer', help: 'Policy ID.', readOnly: true, min: 0 },
    text('name', 'Policy name.', 35),
    { name: 'uuid', type: 'uuid', help: 'Universally Unique Identifier.', readOnly: true },
    refList('srcintf', 'Incoming (ingress) interface.', INTERFACE_TARGETS),
    refList('dstintf', 'Outgoing (egress) interface.', INTERFACE_TARGETS),
    refList('srcaddr', 'Source address and address group names.', ADDRESS_TARGETS),
    refList('dstaddr', 'Destination address and address group names.', ADDRESS_TARGETS),
    enable('srcaddr-negate', 'When enabled srcaddr specifies what the source address must NOT be.'),
    enable('dstaddr-negate', 'When enabled dstaddr specifies what the destination address must NOT be.'),
    refList('service', 'Service and service group names.', SERVICE_TARGETS),
    enable('service-negate', 'When enabled service specifies what the service must NOT be.'),
    {
      name: 'schedule',
      type: 'reference',
      help: 'Schedule name.',
      referenceTo: ['firewall schedule recurring', 'firewall schedule onetime'],
      defaultValue: ['always'],
    },
    choice('action', 'Policy action.', [
      { value: 'accept', help: 'Allow session that match this policy.' },
      { value: 'deny', help: 'Deny or block sessions that match this policy.' },
      { value: 'ipsec', help: 'Allow and encrypt IPsec sessions (policy-based IPsec VPN).' },
    ], 'deny'),
    enable('status', 'Enable or disable this policy.', true),
    enable('nat', 'Enable/disable source NAT.'),
    enable('ippool', 'Enable to use IP Pools for source NAT.'),
    {
      name: 'poolname',
      type: 'reference',
      help: 'IP Pool names.',
      referenceTo: ['firewall ippool'],
      multiValue: true,
      availableWhen: usesIpPool,
    },
    enable('fixedport', 'Enable to prevent source NAT from changing a session source port.'),
    choice('logtraffic', 'Enable or disable logging.', [
      { value: 'all', help: 'Log all sessions accepted or denied by this policy.' },
      { value: 'utm', help: 'Log traffic that has a security profile applied to it.' },
      { value: 'disable', help: 'Disable all logging for this policy.' },
    ], 'utm'),
    enable('logtraffic-start', 'Record logs when a session starts.'),
    enable('capture-packet', 'Enable/disable capture packets.'),
    enable('utm-status', 'Enable to add one or more security profiles.'),
    choice('inspection-mode', 'Policy inspection mode.', [
      { value: 'proxy', help: 'Proxy based inspection.' },
      { value: 'flow', help: 'Flow based inspection.' },
    ], 'flow'),
    count('session-ttl', 'TTL in seconds for sessions accepted by this policy.', 0, 2764800, 0),
    choice('tcp-session-without-syn', 'Enable/disable creation of TCP session without SYN flag.', [
      { value: 'all', help: 'Enable TCP session without SYN.' },
      { value: 'data-only', help: 'Enable TCP session data only.' },
      { value: 'disable', help: 'Disable TCP session without SYN.' },
    ], 'disable'),
    text('comments', 'Comment.', 1023),
    {
      name: 'auto-asic-offload',
      type: 'boolean-enable',
      help: 'Enable/disable policy traffic ASIC offloading.',
      unimplemented: 'ce simulateur n\'a aucun modele d\'acceleration materielle, '
        + 'donc ce reglage n\'aurait aucun effet mesurable.',
    },
    {
      name: 'application',
      type: 'integer',
      help: 'Application ID list.',
      multiValue: true,
      unimplemented: "l'identification applicative demande une base de signatures "
        + 'FortiGuard ; accepter cet attribut installerait une regle qui ne '
        + 'correspondrait jamais.',
    },
    {
      name: 'av-profile',
      type: 'reference',
      help: 'Name of an existing Antivirus profile.',
      referenceTo: ['antivirus profile'],
      unimplemented: 'les profils de securite arrivent en phase 6.',
    },
  ],
  onCommit(object, context) {
    const action = object.effective('action')[0] === 'deny' ? 'deny' : 'allow';
    const nat = object.effective('nat')[0] === 'enable';
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
      natEnabled: nat,
      logStart: object.effective('logtraffic-start')[0] === 'enable',
      logEnd: object.effective('logtraffic')[0] !== 'disable',
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
