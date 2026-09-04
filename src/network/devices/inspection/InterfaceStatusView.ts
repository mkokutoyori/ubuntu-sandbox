import type { Port } from '@/network/hardware/Port';

export type IosLineStatus = 'up' | 'down' | 'administratively down';

export interface IosInterfaceStatus {
  readonly status: IosLineStatus;
  readonly protocol: 'up' | 'down';
  readonly adminUp: boolean;
  readonly lineUp: boolean;
  readonly carrierUp: boolean;
  readonly virtual: boolean;
}

const VIRTUAL_INTERFACE =
  /^(Tunnel|Loopback|Vlan|BVI|Port-channel|Bundle-Ether|Null|Nve|Virtual-Template|Dialer)/i;

export function isVirtualInterface(name: string): boolean {
  return VIRTUAL_INTERFACE.test(name);
}

let carrierAssumedOnUncabledPorts = false;

export function __assumeCarrierOnUncabledPorts(on: boolean): void {
  carrierAssumedOnUncabledPorts = on;
}

let legacyRouterPortCount: number | null = null;

/**
 * Le nombre d'interfaces d'un routeur est une propriété du CHÂSSIS — un
 * ISR 2911 en porte trois. Les suites antérieures à l'itération 3 en
 * supposent quatre ; elles récupèrent ce compte ici plutôt que d'être
 * migrées d'un bloc.
 */
export function __setLegacyRouterPortCount(count: number | null): void {
  legacyRouterPortCount = count;
}

export function routerPortCountOverride(): number | null {
  return legacyRouterPortCount;
}

let interfacesBootShutdownEnabled = true;

export function __setInterfacesBootShutdown(on: boolean): void {
  interfacesBootShutdownEnabled = on;
}

export function interfacesBootShutdown(): boolean {
  return interfacesBootShutdownEnabled;
}

export function carrierBearer(
  name: string,
  port: Port,
  ports?: ReadonlyMap<string, Port>,
): Port {
  const dot = name.indexOf('.');
  if (dot <= 0 || !ports) return port;
  return ports.get(name.slice(0, dot)) ?? port;
}

export function iosInterfaceStatus(
  port: Port,
  name = port.getName(),
  ports?: ReadonlyMap<string, Port>,
): IosInterfaceStatus {
  const virtual = isVirtualInterface(name);
  const adminUp = !port.isAdminDown();
  const lineUp = port.getIsUp();
  const bearer = carrierBearer(name, port, ports);
  const carrierUp = virtual
    || (bearer.wasEverCabled() ? bearer.hasCarrier() : carrierAssumedOnUncabledPorts);
  const bearerAdminUp = bearer === port || !bearer.isAdminDown();

  if (!adminUp) {
    return {
      status: 'administratively down', protocol: 'down',
      adminUp, lineUp, carrierUp, virtual,
    };
  }
  const up = lineUp && carrierUp && bearerAdminUp;
  return {
    status: up ? 'up' : 'down',
    protocol: up ? 'up' : 'down',
    adminUp, lineUp, carrierUp, virtual,
  };
}

export function iosInterfaceUsable(
  port: Port,
  name = port.getName(),
  ports?: ReadonlyMap<string, Port>,
): boolean {
  return iosInterfaceStatus(port, name, ports).protocol === 'up';
}

export function iosShortInterfaceName(name: string): string {
  const m = /^([A-Za-z-]+)(.*)$/.exec(name);
  if (!m) return name;
  const [, family, rest] = m;
  const compact = family.startsWith('Port-channel') ? 'Po'
    : family.startsWith('TenGigabit') ? 'Te'
    : family.slice(0, 2);
  return `${compact}${rest}`;
}

export function iosSviName(name: string): string {
  return name.replace(/^Vlanif/, 'Vlan');
}

export function iosAddressMethod(port: Port): 'manual' | 'unset' | 'DHCP' {
  if (port.isDhcpClient()) return 'DHCP';
  return port.getIPAddress() ? 'manual' : 'unset';
}
