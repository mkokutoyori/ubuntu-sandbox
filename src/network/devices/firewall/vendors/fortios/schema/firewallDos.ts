import {
  choice, count, enable, reference, refList, text,
  type FortiObjectView, type FortiTableSpec,
} from './types';
import { ANOMALY_CATALOG, anomalySpec } from '../../../dos/AnomalyCatalog';
import type { AnomalyAction, AnomalySetting } from '../../../dos/DosSensor';

const ADDRESS_TARGETS = ['firewall address', 'firewall addrgrp'];
const INTERFACE_TARGETS = ['system interface', 'system zone'];
const SERVICE_TARGETS = ['firewall service custom', 'firewall service group'];

const PROXY_UNAVAILABLE = 'this build has no proxy-based flow control, so a '
  + 'proxied anomaly would be stored and never applied.';

const QUARANTINE_UNAVAILABLE = 'this build has no banned-user table, so an '
  + 'attacker address would be recorded and never blocked.';

const ANOMALY: FortiTableSpec = {
  path: ['anomaly'],
  kind: 'table',
  keyType: 'name',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'fwgrp',
  renderOrder: 236,
  help: 'Anomaly name.',
  fixedKeys: ANOMALY_CATALOG.map(entry => entry.name),
  attributes: [
    { ...text('name', 'Anomaly name.'), readOnly: true },
    enable('status', 'Enable/disable this anomaly.'),
    enable('log', 'Enable/disable anomaly logging.'),
    {
      ...choice('action', 'Action taken when the threshold is reached.', [
        { keyword: 'pass', description: 'Allow traffic but record a log message.' },
        { keyword: 'block', description: 'Block traffic if this anomaly is found.' },
        { keyword: 'proxy', description: 'Use a proxy to control the traffic flow.' },
      ], 'pass'),
      unimplementedValues: { proxy: PROXY_UNAVAILABLE },
    },
    {
      ...choice('quarantine', 'Quarantine method.', [
        { keyword: 'none', description: 'Quarantine is disabled.' },
        { keyword: 'attacker', description: "Block all traffic from the attacker's IP." },
      ], 'none'),
      unimplementedValues: { attacker: QUARANTINE_UNAVAILABLE },
    },
    count('threshold', 'Number of detected instances per second that triggers the '
      + 'anomaly action.', 1, 2147483647, 0),
  ],
};

function anomalySettings(object: FortiObjectView): AnomalySetting[] {
  const out: AnomalySetting[] = [];
  for (const entry of object.childEntries('anomaly')) {
    const spec = anomalySpec(String(entry.key));
    if (!spec) continue;
    const declared = Number.parseInt(entry.effective('threshold')[0] ?? '', 10);
    out.push({
      name: spec.name,
      enabled: entry.effective('status')[0] === 'enable',
      log: entry.effective('log')[0] === 'enable',
      action: (entry.effective('action')[0] === 'block' ? 'block' : 'pass') as AnomalyAction,
      threshold: Number.isFinite(declared) && declared > 0
        ? declared : spec.defaultThreshold,
    });
  }
  return out;
}

function listOrAny(values: readonly string[]): string[] {
  return values.length === 0 ? ['any'] : [...values];
}

function normaliseAny(values: readonly string[]): string[] {
  if (values.length === 0) return ['any'];
  return values.map(v => (v.toLowerCase() === 'all' ? 'any' : v));
}

interface DosFamily {
  readonly path: readonly string[];
  readonly help: string;
  readonly renderOrder: number;
  readonly addressTargets: readonly string[];
  readonly v6: boolean;
}

function dosSpec(family: DosFamily): FortiTableSpec {
  return {
    path: [...family.path],
    kind: 'table',
    keyType: 'integer',
    ordered: true,
    scope: 'vdom',
    accessGroup: 'fwgrp',
    renderOrder: family.renderOrder,
    help: family.help,
    children: [ANOMALY],
    attributes: [
      {
        name: 'policyid', help: 'Policy ID.', readOnly: true, quoted: false,
        parts: [{ name: 'policyid', type: 'INT', description: 'Policy ID.' }],
      },
      enable('status', 'Enable/disable this policy.', true),
      text('comments', 'Comment.'),
      reference('interface', 'Incoming interface name from available interfaces.',
        INTERFACE_TARGETS),
      refList('srcaddr', 'Source address name from available addresses.',
        family.addressTargets),
      refList('dstaddr', 'Destination address name from available addresses.',
        family.addressTargets),
      refList('service', 'Service object from available options.', SERVICE_TARGETS),
    ],
    onCommit(object, context) {
      const source = normaliseAny(object.effective('srcaddr'));
      const destination = normaliseAny(object.effective('dstaddr'));
      const comment = object.effective('comments')[0];

      context.dos.upsert({
        id: object.key,
        from: listOrAny(object.effective('interface')),
        to: ['any'],
        source: family.v6 ? [] : source,
        destination: family.v6 ? [] : destination,
        source6: family.v6 ? source : [],
        destination6: family.v6 ? destination : [],
        service: normaliseAny(object.effective('service')),
        action: 'allow',
        enabled: object.effective('status')[0] !== 'disable',
        comment: comment === '' ? undefined : comment,
      }, anomalySettings(object));
    },
    onDelete(key, context) {
      context.dos.remove(key);
    },
  };
}

export const FIREWALL_DOS_POLICY = dosSpec({
  path: ['firewall', 'DoS-policy'],
  help: 'Configure IPv4 DoS policies.',
  renderOrder: 235,
  addressTargets: ADDRESS_TARGETS,
  v6: false,
});

export const DOS_ANOMALY_NAMES: readonly string[] =
  Object.freeze(ANOMALY_CATALOG.map(entry => entry.name));
