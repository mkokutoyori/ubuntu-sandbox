import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { dialSmbShare, type SmbConnection } from '@/network/devices/windows/server/smb/SmbClient';

export const powershellOf = (machine: WindowsPC) => PowerShellSubShell.create(machine).subShell;

export const runPowershell = async (shell: ReturnType<typeof powershellOf>, line: string): Promise<string> =>
  (await shell.processLine(line)).output.join('\n');

export interface SmbLab {
  readonly server: WindowsServer;
  readonly client: WindowsPC;
  readonly clientCable: Cable;
  plugClientBack(): void;
  dial(share: string, username: string, password: string): SmbConnection;
}

export async function buildSmbLab(): Promise<SmbLab> {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  const server = new WindowsServer('SRV1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const switchBox = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-srv').connect(server.getPorts()[0], switchBox.getPorts()[0]);
  const clientCable = new Cable('c-client');
  clientCable.connect(client.getPorts()[0], switchBox.getPorts()[1]);
  const plugClientBack = (): void => { clientCable.connect(client.getPorts()[0], switchBox.getPorts()[1]); };
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.10.20'), mask);
  client.addHostsEntry('192.168.10.10', 'SRV1');
  server.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  await runPowershell(powershellOf(server), 'Install-WindowsFeature FS-FileServer');
  await server.executeCommand('mkdir C:\\Shares\\Data');
  await server.executeCommand('echo hello from srv1 > C:\\Shares\\Data\\doc.txt');
  await server.executeCommand('echo outside the share > C:\\Shares\\outside.txt');
  await runPowershell(powershellOf(server), 'New-SmbShare -Name Data -Path C:\\Shares\\Data -FullAccess bob -ReadAccess alice');
  return {
    server, client, clientCable, plugClientBack,
    dial(share, username, password) {
      const dialled = dialSmbShare({
        tcpStack: client.getTcpStack(), targetIp: '192.168.10.10', shareName: share, username, password,
      });
      if (!dialled.ok || !dialled.connection) throw new Error(`dial ${share} as ${username}: ${dialled.error}`);
      return dialled.connection;
    },
  };
}
