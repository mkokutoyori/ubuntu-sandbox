import type { CommandSpec } from '../../CommandTable';

export interface DhcpClientLeaseView {
  iface: string;
  ipAddress: string;
  subnetMask: string;
  serverIdentifier: string;
  leaseDuration: number;
  renewalTime: number;
  rebindingTime: number;
}

export interface DhcpClientHost {
  selectedInterfaceName(): string | null;
  dhcpClientEnable(iface: string, line: string): void;
  dhcpClientDisable(iface: string): boolean;
  dhcpClientRelease(iface: string): boolean;
  dhcpClientRenew(iface: string): boolean;
  dhcpClientLeases(): DhcpClientLeaseView[];
  dhcpClientResolveInterface(name: string): string | null;
}

function host(device: unknown): DhcpClientHost | null {
  const candidate = device as DhcpClientHost | null;
  return typeof candidate?.dhcpClientEnable === 'function' ? candidate : null;
}

export function formatDhcpLease(leases: readonly DhcpClientLeaseView[]): string {
  if (leases.length === 0) return 'No DHCP leases.';
  const out: string[] = [];
  for (const l of leases) {
    out.push(`Temp IP addr: ${l.ipAddress}  for peer on Interface: ${l.iface}`);
    out.push(`Temp  sub net mask: ${l.subnetMask}`);
    out.push(`   DHCP Lease server: ${l.serverIdentifier}, state: 3 Bound`);
    out.push(`   Lease: ${l.leaseDuration} secs,  Renewal: ${l.renewalTime} secs,  Rebind: ${l.rebindingTime} secs`);
    out.push(`Temp default-gateway addr: ${l.serverIdentifier}`);
    out.push(`   Next timer fires after: ${l.renewalTime} secs`);
    out.push(`   Retry count: 0   Client-ID: cisco-${l.iface}`);
  }
  return out.join('\n');
}

const CONFIG_IF = Object.freeze(['config-if', 'config-subif']);
const EXEC = Object.freeze(['privileged']);

export function dhcpClientFamily(): CommandSpec[] {
  const withIface = (device: unknown, run: (h: DhcpClientHost, iface: string) => string): string => {
    const target = host(device);
    const iface = target?.selectedInterfaceName();
    if (!target || !iface) return '';
    return run(target, iface);
  };
  const named = (device: unknown, name: string, run: (h: DhcpClientHost, iface: string) => string): string => {
    const target = host(device);
    if (!target) return '';
    const iface = target.dhcpClientResolveInterface(name);
    if (!iface) return "% Invalid input detected at '^' marker.";
    return run(target, iface);
  };

  return [
    {
      id: 'ip-address-dhcp',
      path: ['ip', 'address', 'dhcp'],
      description: 'IP Address negotiated via DHCP',
      modes: CONFIG_IF, minPrivilege: 15,
      run: (session) => withIface(session.device, (h, iface) => {
        h.dhcpClientEnable(iface, 'ip address dhcp');
        return '';
      }),
      /*
       * La negation est un `undo`, pas un chemin dont le premier mot
       * serait `no` : l'analyse retire `no` avant de marcher, donc un
       * chemin litteral `no ip address dhcp` n'etait atteignable par
       * personne. Il ne s'est vu que le jour ou `no ip address` a quitte
       * le trie, la forme longue tombant alors sur un `dhcp` que rien ne
       * savait defaire.
       */
      undoDescription: 'Stop the DHCP client on this interface',
      undo: (session) => withIface(session.device, (h, iface) => {
        h.dhcpClientDisable(iface);
        return '';
      }),
    },
    {
      id: 'release-dhcp',
      path: ['release', 'dhcp', { name: 'iface', type: 'WORD' as const, description: 'Interface name' }],
      description: 'Release a DHCP lease',
      modes: EXEC, minPrivilege: 15,
      run: (session, args) => named(session.device, String(args.iface), (h, iface) =>
        h.dhcpClientRelease(iface) ? '' : `% Interface ${iface} does not have a DHCP lease`),
    },
    {
      id: 'renew-dhcp',
      path: ['renew', 'dhcp', { name: 'iface', type: 'WORD' as const, description: 'Interface name' }],
      description: 'Renew a DHCP lease',
      modes: EXEC, minPrivilege: 15,
      run: (session, args) => named(session.device, String(args.iface), (h, iface) =>
        h.dhcpClientRenew(iface) ? '' : `% Interface ${iface} is not a DHCP client`),
    },
    {
      id: 'show-dhcp-lease',
      path: ['show', 'dhcp', 'lease'],
      description: 'DHCP client lease information',
      modes: Object.freeze(['user', 'privileged']), minPrivilege: 1,
      run: (session) => {
        const target = host(session.device);
        return target ? formatDhcpLease(target.dhcpClientLeases()) : 'No DHCP leases.';
      },
    },
  ];
}
