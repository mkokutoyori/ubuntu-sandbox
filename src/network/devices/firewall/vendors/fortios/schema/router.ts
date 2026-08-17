import {
  address, addressMask, count, enable, reference, text,
  type FortiTableSpec,
} from './types';

export const ROUTER_STATIC: FortiTableSpec = {
  path: ['router', 'static'],
  kind: 'table',
  keyType: 'integer',
  ordered: false,
  scope: 'vdom',
  accessGroup: 'netgrp',
  renderOrder: 220,
  help: 'Configure IPv4 static routing tables.',
  attributes: [
    addressMask('dst', 'Destination IP and mask for this route.', ['0.0.0.0', '0.0.0.0']),
    address('gateway', 'Gateway IP for this route.', '0.0.0.0'),
    reference('device', 'Gateway out interface or tunnel.', ['system interface']),
    count('distance', 'Administrative distance.', 1, 255, 10),
    count('priority', 'Administrative priority.', 0, 65535, 0),
    count('weight', 'Administrative weight.', 0, 255, 0),
    enable('blackhole', 'Enable/disable black hole.'),
    enable('status', 'Enable/disable this static route.', true),
    text('comment', 'Optional comments.'),
  ],
  onCommit(object, context) {
    const destination = object.effective('dst');
    context.device.applyStaticRoute({
      id: object.key,
      destination: destination[0] ?? '0.0.0.0',
      mask: destination[1] ?? '0.0.0.0',
      gateway: object.effective('gateway')[0] ?? '0.0.0.0',
      iface: object.effective('device')[0] ?? '',
      distance: Number.parseInt(object.effective('distance')[0] ?? '10', 10),
      blackhole: object.effective('blackhole')[0] === 'enable',
      enabled: object.effective('status')[0] !== 'disable',
    });
  },
  onDelete(key, context) {
    context.device.removeStaticRoute(key);
  },
};

export const ROUTER_SPECS: readonly FortiTableSpec[] = Object.freeze([ROUTER_STATIC]);
