import type { CommandSpec } from '../../CommandTable';

export interface EtherChannelLimitHost {
  selectedPortChannelIds(): number[];
  setPortChannelMinLinks(groupId: number, value: number): void;
  setPortChannelMaxBundle(groupId: number, value: number): void;
}

function host(device: unknown): EtherChannelLimitHost | null {
  const candidate = device as EtherChannelLimitHost | null;
  return typeof candidate?.selectedPortChannelIds === 'function' ? candidate : null;
}

const CONFIG_IF = Object.freeze(['config-if']);

function apply(
  device: unknown, value: number,
  set: (h: EtherChannelLimitHost, id: number) => void,
): string {
  const target = host(device);
  if (!target) return '';
  const ids = target.selectedPortChannelIds();
  if (ids.length === 0) return '% Invalid input detected at \'^\' marker.';
  if (value < 1 || value > 8) return '% Invalid value, valid range is 1 to 8.';
  for (const id of ids) set(target, id);
  return '';
}

export function etherChannelLimitFamily(): CommandSpec[] {
  return [
    {
      id: 'port-channel-min-links',
      path: ['port-channel', 'min-links', {
        name: 'min', type: 'INT', range: [1, 8], rangeIsAdvisory: true,
        description: 'Minimum number of bundled ports',
      }],
      description: 'Minimum number of bundled ports before the channel comes up',
      modes: CONFIG_IF, minPrivilege: 15,
      run: (session, args) => apply(session.device, Number(args.min),
        (h, id) => h.setPortChannelMinLinks(id, Number(args.min))),
    },
    {
      id: 'lacp-max-bundle',
      path: ['lacp', 'max-bundle', {
        name: 'max', type: 'INT', range: [1, 8], rangeIsAdvisory: true,
        description: 'Maximum number of bundled ports',
      }],
      description: 'Maximum number of bundled ports; the rest wait in hot-standby',
      modes: CONFIG_IF, minPrivilege: 15,
      run: (session, args) => apply(session.device, Number(args.max),
        (h, id) => h.setPortChannelMaxBundle(id, Number(args.max))),
    },
  ];
}
