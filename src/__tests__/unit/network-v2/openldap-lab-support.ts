import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

export const SAFE_MODE = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';
export const DC_ADDRESS = '10.0.0.10';
export const ADMIN_UPN = 'Administrator@corp.local';
export const ADMIN_PASSWORD = 'P@ssw0rd!';

export async function buildLab(): Promise<{ workstation: LinuxPC; controller: WindowsServer; hub: GenericSwitch }> {
  const workstation = new LinuxPC('linux-pc', 'PC1');
  const controller = new WindowsServer('DC01');
  const hub = new GenericSwitch('switch-generic', 'SW1');
  workstation.powerOn();
  controller.powerOn();
  new Cable('c-pc').connect(workstation.getPort('eth0') as never, hub.getPorts()[0]);
  new Cable('c-dc').connect(controller.getPort('eth0') as never, hub.getPorts()[1]);
  await workstation.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await workstation.executeCommand('ip link set eth0 up');
  await controller.executeCommand(`netsh interface ip set address "Ethernet0" static ${DC_ADDRESS} 255.255.255.0`);
  const shell = PowerShellSubShell.create(controller as never).subShell;
  await shell.processLine('Install-WindowsFeature -Name AD-Domain-Services');
  await shell.processLine(`Install-ADDSForest -DomainName "corp.local" -Force ${SAFE_MODE}`);
  return { workstation, controller, hub };
}
