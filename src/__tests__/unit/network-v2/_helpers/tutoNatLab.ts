import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';

export interface TutoNatLab {
  r: CiscoRouter;
  isp: CiscoRouter;
  win: WindowsPC;
  lin: LinuxPC;
  srv: LinuxServer;
  ext: LinuxServer;
}

export async function runLines(device: { executeCommand(c: string): Promise<string> }, lines: readonly string[]): Promise<string[]> {
  const answers: string[] = [];
  for (const line of lines) answers.push(await device.executeCommand(line));
  return answers;
}

export async function tutoNatLab(natLines: readonly string[] = []): Promise<TutoNatLab> {
  const lanSw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const ispSw = new GenericSwitch('switch-generic', 'ispsw', 8, 0, 0);
  const r = new CiscoRouter('R-AKWA', 0, 0);
  const isp = new CiscoRouter('ISP', 0, 0);
  const win = new WindowsPC('windows-pc', 'PC-WIN', 0, 0);
  const lin = new LinuxPC('linux-pc', 'PC-LINUX', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV-WEB', 0, 0);
  const ext = new LinuxServer('linux-server', 'EXT', 0, 0);
  const lan = new SubnetMask('255.255.255.0');
  const link = new SubnetMask('255.255.255.240');
  new Cable('1').connect(win.getPorts()[0], lanSw.getPorts()[0]);
  new Cable('2').connect(lin.getPorts()[0], lanSw.getPorts()[1]);
  new Cable('3').connect(srv.getPorts()[0], lanSw.getPorts()[2]);
  new Cable('4').connect(lanSw.getPorts()[7], r.getPort('GigabitEthernet0/0')!);
  new Cable('5').connect(r.getPort('GigabitEthernet0/1')!, ispSw.getPorts()[0]);
  new Cable('6').connect(ispSw.getPorts()[1], isp.getPort('GigabitEthernet0/0')!);
  new Cable('7').connect(ext.getPorts()[0], ispSw.getPorts()[2]);
  win.getPorts()[0].configureIP(new IPAddress('192.168.10.21'), lan);
  lin.getPorts()[0].configureIP(new IPAddress('192.168.10.22'), lan);
  srv.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), lan);
  ext.getPorts()[0].configureIP(new IPAddress('203.0.113.9'), link);
  for (const host of [win, lin, srv]) host.setDefaultGateway(new IPAddress('192.168.10.1'));
  ext.setDefaultGateway(new IPAddress('203.0.113.2'));
  await runLines(r, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.10.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 203.0.113.2 255.255.255.240', 'no shutdown', 'exit',
    'ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end',
  ]);
  await runLines(isp, [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 203.0.113.1 255.255.255.240', 'no shutdown', 'exit',
    'interface Loopback0', 'ip address 198.51.100.10 255.255.255.255', 'exit', 'ip http server', 'end',
  ]);
  await srv.executeCommand('systemctl start nginx');
  await ext.executeCommand('systemctl start nginx');
  await runLines(r, [
    'configure terminal',
    'interface GigabitEthernet0/0', 'ip nat inside', 'exit',
    'interface GigabitEthernet0/1', 'ip nat outside', 'exit',
    'access-list 1 permit 192.168.10.0 0.0.0.255',
    ...natLines, 'end',
  ]);
  return { r, isp, win, lin, srv, ext };
}
