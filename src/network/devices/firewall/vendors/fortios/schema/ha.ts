import {
  choice, count, enable, reference, refList, text, word,
  type FortiAttributeSpec, type FortiTableSpec,
} from './types';
import type { HaMode } from '../../../ha/HaTypes';

function heartbeatDevices(): FortiAttributeSpec {
  return {
    name: 'hbdev',
    help: 'Heartbeat interfaces, each followed by its priority.',
    quoted: false,
    quoteValue: (value) => !/^\d+$/.test(value),
    multiValue: true,
    parts: [{
      name: 'interface', type: 'WORD',
      description: 'An interface name, then a priority from 0 to 512.',
    }],
    defaultValue: [],
  };
}

export const SYSTEM_HA: FortiTableSpec = {
  path: ['system', 'ha'],
  kind: 'object',
  scope: 'global',
  accessGroup: 'sysgrp',
  renderOrder: 30,
  help: 'Configure HA.',
  attributes: [
    { ...text('group-name', 'Cluster group name.'), quoted: true },
    count('group-id', 'Cluster group identifier.', 0, 255, 0),
    choice('mode', 'HA mode.', [
      { keyword: 'standalone', description: 'Not part of a cluster.' },
      { keyword: 'a-a', description: 'Active-active.' },
      { keyword: 'a-p', description: 'Active-passive.' },
    ], 'standalone'),
    { ...text('password', 'Cluster password.'), quoted: true, secret: true },
    heartbeatDevices(),
    count('priority', 'Election priority — the largest wins.', 0, 255, 128),
    enable('override', 'Enable/disable taking the primary role back.'),
    enable('session-pickup', 'Enable/disable synchronising the session table.'),
    refList('monitor', 'Interfaces whose failure triggers a failover.',
      ['system interface']),
    count('hb-interval', 'Heartbeat interval, in 100 ms units.', 1, 20, 2),
    count('hb-lost-threshold', 'Missed heartbeats before a peer is lost.', 1, 60, 6),
    enable('ha-mgmt-status',
      'Enable to reserve interfaces to manage individual cluster units.'),
    { ...word('unicast-hb', 'Use unicast heartbeats.'), unimplemented:
      'this build broadcasts the heartbeat on `hbdev`; a unicast heartbeat would '
      + 'need a heartbeat address plan the cluster does not carry yet.' },
  ],
  children: [
    {
      path: ['ha-mgmt-interfaces'],
      kind: 'table',
      keyType: 'integer',
      ordered: false,
      scope: 'global',
      accessGroup: 'sysgrp',
      renderOrder: 31,
      help: 'Reserve interfaces to manage individual cluster units.',
      attributes: [
        { ...word('id', 'Table identifier.'), readOnly: true },
        reference('interface', 'Interface to reserve for HA management.',
          ['system interface']),
      ],
    },
  ],
  onCommit(object, context) {
    const devices = parseHeartbeatDevices(object.effective('hbdev'));
    for (const device of devices) {
      if (!context.device.hasInterface(device.iface)) {
        return `\`${device.iface}\` is not an interface of this unit.`;
      }
    }

    return context.device.applyHa({
      mode: (object.effective('mode')[0] ?? 'standalone') as HaMode,
      groupId: Number.parseInt(object.effective('group-id')[0] ?? '0', 10),
      groupName: object.effective('group-name')[0] ?? '',
      password: object.effective('password')[0] ?? '',
      priority: Number.parseInt(object.effective('priority')[0] ?? '128', 10),
      override: object.effective('override')[0] === 'enable',
      sessionPickup: object.effective('session-pickup')[0] === 'enable',
      heartbeatDevices: devices,
      monitored: [...object.effective('monitor')],
      heartbeatIntervalTicks:
        Number.parseInt(object.effective('hb-interval')[0] ?? '2', 10),
      lostThreshold:
        Number.parseInt(object.effective('hb-lost-threshold')[0] ?? '6', 10),
      managementStatus: object.effective('ha-mgmt-status')[0] === 'enable',
      managementInterfaces: object.childEntries('ha-mgmt-interfaces')
        .map(entry => entry.effective('interface')[0] ?? '')
        .filter(name => name.length > 0),
    });
  },
};

function parseHeartbeatDevices(
  values: readonly string[],
): Array<{ iface: string; priority: number }> {
  const devices: Array<{ iface: string; priority: number }> = [];
  for (let index = 0; index < values.length; index++) {
    const parsed = Number.parseInt(values[index], 10);
    if (Number.isFinite(parsed) && devices.length > 0) {
      devices[devices.length - 1].priority = parsed;
      continue;
    }
    devices.push({ iface: values[index], priority: 50 });
  }
  return devices;
}

export const HA_SPECS: readonly FortiTableSpec[] = Object.freeze([SYSTEM_HA]);
