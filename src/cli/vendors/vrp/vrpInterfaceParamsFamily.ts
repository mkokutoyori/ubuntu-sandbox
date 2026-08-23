import type { CommandSpec } from '../../CommandTable';

export const VRP_MTU_MIN = 68;
export const VRP_MTU_MAX = 9216;
export const VRP_MTU_DEFAUT = 1500;
export const VRP_BANDWIDTH_MIN = 1;
export const VRP_BANDWIDTH_MAX = 4294967295;

export interface VrpInterfaceParamsHost {
  vrpSelectedInterface(): string | null;
  vrpSetInterfaceMtu(iface: string, mtu: number): string;
  vrpSetInterfaceBandwidth(iface: string, kbps: number): string;
}

function host(device: unknown): VrpInterfaceParamsHost | null {
  const candidate = device as VrpInterfaceParamsHost | null;
  return typeof candidate?.vrpSetInterfaceMtu === 'function' ? candidate : null;
}

const INTERFACE = Object.freeze(['interface']);

function surInterface(
  device: unknown,
  agir: (target: VrpInterfaceParamsHost, iface: string) => string,
): string {
  const target = host(device);
  const iface = target?.vrpSelectedInterface();
  if (!target || !iface) return 'Error: No interface selected';
  return agir(target, iface);
}

export function vrpMtuFamily(): CommandSpec[] {
  return [
    {
      id: 'vrp-mtu',
      path: ['mtu', {
        name: 'octets', type: 'INT' as const,
        range: [VRP_MTU_MIN, VRP_MTU_MAX] as const,
        description: 'Maximum transmission unit, in bytes',
      }],
      description: 'Set interface MTU',
      modes: INTERFACE, minPrivilege: 1,
      run: (session, args) => surInterface(session.device,
        (target, iface) => target.vrpSetInterfaceMtu(iface, Number(args.octets))),
    },
    {
      id: 'vrp-mtu-undo',
      path: ['mtu'],
      description: 'Set interface MTU',
      modes: INTERFACE, minPrivilege: 1,
      existsOnlyNegated: true,
      run: () => '',
      undo: (session) => surInterface(session.device,
        (target, iface) => target.vrpSetInterfaceMtu(iface, VRP_MTU_DEFAUT)),
    },
  ];
}

export function vrpBandwidthFamily(): CommandSpec[] {
  return [
    {
      id: 'vrp-bandwidth',
      path: ['bandwidth', {
        name: 'kbps', type: 'INT' as const,
        range: [VRP_BANDWIDTH_MIN, VRP_BANDWIDTH_MAX] as const,
        description: 'Bandwidth in kbit/s',
      }],
      description: 'Set interface bandwidth',
      modes: INTERFACE, minPrivilege: 1,
      run: (session, args) => surInterface(session.device,
        (target, iface) => target.vrpSetInterfaceBandwidth(iface, Number(args.kbps))),
    },
    {
      id: 'vrp-bandwidth-undo',
      path: ['bandwidth'],
      description: 'Set interface bandwidth',
      modes: INTERFACE, minPrivilege: 1,
      existsOnlyNegated: true,
      run: () => '',
      undo: (session) => surInterface(session.device,
        (target, iface) => target.vrpSetInterfaceBandwidth(iface, 0)),
    },
  ];
}
