import {
  choice, count, enable, reference, refList, text, word,
  type FortiCommitContext, type FortiObjectView, type FortiTableSpec,
} from './types';
import type { TcpSessionWithoutSyn } from '../../../model/SecurityRule';

const ADDRESS_TARGETS = ['firewall address', 'firewall addrgrp', 'firewall vip'];
const ADDRESS6_TARGETS = ['firewall address6', 'firewall addrgrp6'];
const INTERFACE_TARGETS = ['system interface', 'system zone', 'system sdwan zone'];
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

function usesUtm(object: FortiObjectView): boolean {
  return object.effective('utm-status')[0] === 'enable';
}

const POLITIQUE_EXIGE: ReadonlyArray<readonly string[]> = [
  ['srcintf'], ['dstintf'],
  ['srcaddr', 'srcaddr6'], ['dstaddr', 'dstaddr6'],
  ['service'],
];

function attributManquant(object: FortiObjectView): string | undefined {
  for (const formes of POLITIQUE_EXIGE) {
    if (formes.some(nom => object.effective(nom).length > 0)) continue;
    return formes[0];
  }
  return undefined;
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
    refList('srcaddr6', 'Source IPv6 address and address group names.',
      ADDRESS6_TARGETS),
    refList('dstaddr6', 'Destination IPv6 address and address group names.',
      ADDRESS6_TARGETS),
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
    refList('groups', 'Names of user groups that can authenticate with this policy.',
      ['user group']),
    refList('users', 'Names of individual users that can authenticate with this policy.',
      ['user local']),
    enable('utm-status', 'Enable to add one or more security profiles.'),
    {
      ...reference('av-profile', 'Name of an existing Antivirus profile.',
        ['antivirus profile']),
      availableWhen: usesUtm,
    },
    {
      ...reference('webfilter-profile', 'Name of an existing Web filter profile.',
        ['webfilter profile']),
      availableWhen: usesUtm,
    },
    {
      ...reference('dnsfilter-profile', 'Name of an existing DNS filter profile.',
        ['dnsfilter profile']),
      availableWhen: usesUtm,
    },
    {
      ...reference('file-filter-profile', 'Name of an existing file-filter profile.',
        ['file-filter profile']),
      availableWhen: usesUtm,
    },
    {
      ...reference('application-list', 'Name of an existing application list.',
        ['application list']),
      availableWhen: usesUtm,
    },
    {
      ...reference('ssl-ssh-profile', 'Name of an existing SSL SSH profile.',
        ['firewall ssl-ssh-profile']),
      availableWhen: usesUtm,
    },
    {
      ...reference('profile-protocol-options',
        'Name of an existing Protocol options profile.',
        ['firewall profile-protocol-options']),
      availableWhen: usesUtm,
    },
    choice('firewall-session-dirty',
      'How to handle sessions if the configuration of this policy changes.', [
        { keyword: 'check-all', description: 'Flush the sessions this policy accepted.' },
        { keyword: 'check-new', description: 'Continue to allow sessions already accepted.' },
      ], 'check-all'),
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
  ],
  onCommit(object, context) {
    const absent = attributManquant(object);
    if (absent !== undefined) {
      return `entry not set for "${absent}".`;
    }

    const mismatch = profileModeMismatch(object, context);
    if (mismatch) return mismatch;

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
      source6: [...object.effective('srcaddr6')],
      destination6: [...object.effective('dstaddr6')],
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
      utmEnabled: usesUtm(object),
      inspectionMode: object.effective('inspection-mode')[0] ?? 'flow',
      authGroups: [...object.effective('groups')],
      authUsers: [...object.effective('users')],
      antivirusProfile: named(object, 'av-profile'),
      webFilterProfile: named(object, 'webfilter-profile'),
      dnsFilterProfile: named(object, 'dnsfilter-profile'),
      fileFilterProfile: named(object, 'file-filter-profile'),
      applicationList: named(object, 'application-list'),
      sslSshProfile: named(object, 'ssl-ssh-profile'),
      protocolOptions: named(object, 'profile-protocol-options'),
      sessionTimeoutOverrideSec: sessionTtl(object.effective('session-ttl')[0]),
      tcpSessionWithoutSyn: tcpSessionWithoutSyn(
        object.effective('tcp-session-without-syn')[0]),
      comment: comment === '' ? undefined : comment,
    });
    context.device.onPolicyChanged(String(object.key),
      object.effective('firewall-session-dirty')[0] ?? 'check-all');
    context.device.refreshCaptivePortal();
  },
  onDelete(key, context) {
    context.policy.remove(key);
    context.device.onPolicyChanged(String(key), 'check-all');
    context.device.refreshCaptivePortal();
  },
};

function profileModeMismatch(
  object: FortiObjectView, context: FortiCommitContext,
): string | undefined {
  if (!usesUtm(object)) return undefined;

  const mode = object.effective('inspection-mode')[0] ?? 'flow';
  const profile = object.effective('webfilter-profile')[0];
  if (!profile) return undefined;

  const featureSet = context.device.webFilterFeatureSet(profile);
  if (featureSet === undefined || featureSet === mode) return undefined;

  return `webfilter profile ${profile} has feature-set ${featureSet},`
    + ` which does not apply to a policy in inspection-mode ${mode}.`;
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

function named(object: FortiObjectView, attribute: string): string | undefined {
  const value = object.effective(attribute)[0];
  return value === undefined || value === '' ? undefined : value;
}

function tcpSessionWithoutSyn(raw: string | undefined): TcpSessionWithoutSyn | undefined {
  if (raw === 'all' || raw === 'data-only' || raw === 'disable') return raw;
  return undefined;
}

function sessionTtl(raw: string | undefined): number | undefined {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
