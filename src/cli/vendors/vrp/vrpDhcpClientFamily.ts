import type { CommandSpec } from '../../CommandTable';

export interface VrpDhcpLeaseView {
  iface: string;
  displayName: string;
  ipAddress: string;
  subnetMask: string;
  defaultGateway: string | null;
  serverIdentifier: string;
  leaseDuration: number;
  renewalTime: number;
  rebindingTime: number;
}

export interface VrpDhcpClientHost {
  vrpSelectedInterface(): string | null;
  vrpDhcpEnabledElsewhere(iface: string): boolean;
  vrpDhcpEnable(iface: string): void;
  vrpDhcpDisable(iface: string): void;
  vrpDhcpLeases(): VrpDhcpLeaseView[];
}

function host(device: unknown): VrpDhcpClientHost | null {
  const candidate = device as VrpDhcpClientHost | null;
  return typeof candidate?.vrpDhcpEnable === 'function' ? candidate : null;
}

export function formatDisplayDhcpClient(
  leases: readonly VrpDhcpLeaseView[], filter: string | null,
): string {
  const cible = filter === null ? null : filter.replace(/\s+/g, '').toLowerCase();
  const retenus = leases.filter(l => cible === null
    || l.iface.toLowerCase() === cible
    || l.displayName.toLowerCase() === cible);
  if (retenus.length === 0) return 'Info: The DHCP client is not enabled on any interface.';
  const out: string[] = [];
  for (const l of retenus) {
    out.push(`DHCP client lease information on interface ${l.displayName} :`);
    out.push('  Current machine state          : Bound');
    out.push('  Internet address assigned via  : DHCP');
    out.push(`  IP address                     : ${l.ipAddress}`);
    out.push(`  Subnet mask                    : ${l.subnetMask}`);
    out.push(`  Gateway ip address             : ${l.defaultGateway ?? '-'}`);
    out.push(`  DHCP server                    : ${l.serverIdentifier}`);
    out.push(`  Lease                          : ${l.leaseDuration} seconds`);
    out.push(`  T1                             : ${l.renewalTime} seconds`);
    out.push(`  T2                             : ${l.rebindingTime} seconds`);
  }
  return out.join('\n');
}

const INTERFACE = Object.freeze(['interface']);
const LECTURE = Object.freeze(['user', 'system', 'interface']);

export function vrpDhcpClientFamily(): CommandSpec[] {
  return [
    {
      id: 'vrp-ip-address-dhcp-alloc',
      path: ['ip', 'address', 'dhcp-alloc'],
      description: 'Obtain an IP address through DHCP',
      modes: INTERFACE, minPrivilege: 1,
      run: (session) => {
        const target = host(session.device);
        const iface = target?.vrpSelectedInterface();
        if (!target || !iface) return 'Error: No interface selected';
        if (target.vrpDhcpEnabledElsewhere(iface)) {
          return 'Error: The DHCP client function has been enabled on another interface.';
        }
        target.vrpDhcpEnable(iface);
        return '';
      },
      undo: (session) => {
        const target = host(session.device);
        const iface = target?.vrpSelectedInterface();
        if (!target || !iface) return 'Error: No interface selected';
        target.vrpDhcpDisable(iface);
        return '';
      },
    },
    {
      id: 'vrp-display-dhcp-client',
      path: ['display', 'dhcp', 'client',
        { name: 'iface', type: 'REST' as const, optional: true, description: 'Interface name' }],
      description: 'Display DHCP client status',
      modes: LECTURE, minPrivilege: 1,
      run: (session, args) => {
        const target = host(session.device);
        if (!target) return 'Info: The DHCP client is not enabled on any interface.';
        const filtre = args.iface ? String(args.iface) : null;
        return formatDisplayDhcpClient(target.vrpDhcpLeases(), filtre);
      },
    },
  ];
}
