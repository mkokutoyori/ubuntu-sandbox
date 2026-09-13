import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

export interface RmanLab {
  readonly prod: LinuxServer;
  readonly dr: LinuxServer;
  readonly router: CiscoRouter;
  readonly firewall: FortiGate;
  readonly prodIp: string;
  readonly drIp: string;
  sh(device: LinuxServer, command: string): string;
  sql(device: LinuxServer, statement: string): string;
  rman(device: LinuxServer, script: string): string;
}

export const RMAN_LAB_PROD_IP = '10.10.10.10';
export const RMAN_LAB_DR_IP   = '10.10.20.20';

async function run(device: { executeCommand(c: string): Promise<string> }, lines: string[]): Promise<string> {
  let out = '';
  for (const line of lines) out = await device.executeCommand(line);
  return out;
}

export async function buildRmanLab(): Promise<RmanLab> {
  const prod     = new LinuxServer('linux-server', 'ORA-PROD', -300, 0);
  const dr       = new LinuxServer('linux-server', 'ORA-DR', 300, 0);
  const router   = new CiscoRouter('R-CORE');
  const firewall = new FortiGate('firewall-fortinet', 'FGT-DC', 0, 0);

  new Cable('lan-prod').connect(prod.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
  new Cable('transit').connect(router.getPort('GigabitEthernet0/1')!, firewall.getPort('port1')!);
  new Cable('lan-dr').connect(firewall.getPort('port2')!, dr.getPort('eth0')!);

  router.getPort('GigabitEthernet0/0')!
    .configureIP(new IPAddress('10.10.10.1'), new SubnetMask('255.255.255.0'));
  router.getPort('GigabitEthernet0/1')!
    .configureIP(new IPAddress('10.10.30.1'), new SubnetMask('255.255.255.0'));
  await run(router, [
    'enable', 'configure terminal',
    'ip route 10.10.20.0 255.255.255.0 10.10.30.2',
    'end',
  ]);

  await run(firewall, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 10.10.30.2 255.255.255.0',
    'set allowaccess ping', 'next',
    'edit port2', 'set mode static', 'set ip 10.10.20.1 255.255.255.0',
    'set allowaccess ping', 'next', 'end',
    'config router static',
    'edit 1', 'set dst 10.10.10.0 255.255.255.0', 'set gateway 10.10.30.1',
    'set device "port1"', 'next', 'end',
    'config firewall policy',
    'edit 1',
    'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next',
    'edit 2',
    'set srcintf "port2"', 'set dstintf "port1"',
    'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"',
    'next', 'end',
  ]);

  const sh = (device: LinuxServer, command: string): string =>
    device.executeShellCommandSync(command);

  sh(prod, `ip addr add ${RMAN_LAB_PROD_IP}/24 dev eth0`);
  sh(prod, 'ip link set eth0 up');
  sh(prod, 'ip route add default via 10.10.10.1');
  sh(dr, `ip addr add ${RMAN_LAB_DR_IP}/24 dev eth0`);
  sh(dr, 'ip link set eth0 up');
  sh(dr, 'ip route add default via 10.10.20.1');

  SqlPlusSubShell.create(prod, ['/', 'as', 'sysdba']).subShell.dispose();
  SqlPlusSubShell.create(dr, ['/', 'as', 'sysdba']).subShell.dispose();

  const sql = (device: LinuxServer, statement: string): string => {
    const session = SqlPlusSubShell.create(device, ['/', 'as', 'sysdba']).subShell;
    const out = session.processLine(statement).output.join('\n').trim();
    session.dispose();
    return out;
  };

  const rman = (device: LinuxServer, script: string): string =>
    sh(device, `echo "${script}" | rman`);

  return {
    prod, dr, router, firewall,
    prodIp: RMAN_LAB_PROD_IP, drIp: RMAN_LAB_DR_IP,
    sh, sql, rman,
  };
}
