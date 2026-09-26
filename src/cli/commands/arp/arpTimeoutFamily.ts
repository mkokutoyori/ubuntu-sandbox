import type { CommandSpec } from '../../CommandTable';

export interface ArpTimeoutHost {
  selectedInterfaceName(): string | null;
  setInterfaceArpTimeout(iface: string, seconds: number | null): void;
}

function host(device: unknown): ArpTimeoutHost | null {
  const candidate = device as ArpTimeoutHost | null;
  return typeof candidate?.setInterfaceArpTimeout === 'function' ? candidate : null;
}

const CONFIG_IF = Object.freeze(['config-if', 'config-subif']);

function apply(device: unknown, seconds: number | null): string {
  const target = host(device);
  const iface = target?.selectedInterfaceName();
  if (!target || !iface) return '';
  target.setInterfaceArpTimeout(iface, seconds);
  return '';
}

export function arpTimeoutFamily(): CommandSpec[] {
  return [{
    id: 'arp-timeout',
    path: ['arp', 'timeout', {
      name: 'seconds', type: 'INT', range: [0, 2147483],
      description: 'Seconds an ARP cache entry stays valid',
    }],
    description: 'Set ARP cache timeout',
    modes: CONFIG_IF, minPrivilege: 15,
    run: (session, args) => apply(session.device, Number(args.seconds)),
    undoDescription: 'Restore the default ARP cache timeout',
    undoOmitsArguments: true,
    undo: (session) => apply(session.device, null),
  }];
}
