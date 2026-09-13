/**
 * Sonde — la colonne `Status` de `net use` dit l'etat REEL du lien.
 *
 * `NetUseEntry.status` declare trois etats — `OK`, `Disconnected`,
 * `Unavailable` — et n'en a jamais porte qu'un : `OK`, pose a la
 * creation et plus jamais relu. La colonne que `net use` imprime ne
 * pouvait donc pas se tromper, parce qu'elle ne disait rien : un partage
 * dont le serveur a disparu restait affiche « OK ». C'est un critere
 * stocke que rien n'evalue (regle 6), et il se voit a l'oeil nu.
 *
 * Sur un vrai Windows, un lecteur mappe dont le serveur devient
 * injoignable passe a `Disconnected` — c'est ce que l'operateur regarde
 * pour savoir si le partage repond encore.
 *
 * QUAND, exactement : pas a l'instant ou le cable tombe. TCP reste
 * `established` tant qu'il n'a pas expire, et le redirecteur d'un vrai
 * Windows l'apprend au PROCHAIN USAGE, quand sa demande ne trouve plus
 * de reponse. Une premiere version de cette sonde attendait le
 * changement des la coupure : c'etait une premisse plus forte que la
 * realite, et c'est la sonde qui avait tort.
 *
 * Le laboratoire coupe le CABLE : rien n'est simule a la main, la
 * session SMB meurt parce que plus rien ne repond.
 *
 * Discrimination `git stash` : 2 des 3 cas tombent. Le troisieme est le
 * TEMOIN — « tant que le lien tient, l'etat reste OK » : il passait deja
 * et doit continuer, sans quoi ce lot aurait remplace un « OK » toujours
 * faux par un « Disconnected » toujours faux. Il a d'ailleurs servi :
 * une erreur d'echappement dans un `dir` l'a fait tomber a la premiere
 * execution, et c'est lui qui l'a signalee.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

const ps = (d: WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function lab(): Promise<{ srv: WindowsServer; client: WindowsPC; lien: Cable }> {
  const srv = new WindowsServer('SRV1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  for (const d of [srv, client, sw]) d.powerOn();
  const lien = new Cable('c-srv');
  lien.connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  srv.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.10.20'), mask);
  client.addHostsEntry('192.168.10.10', 'SRV1');
  srv.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  await run(ps(srv), 'Install-WindowsFeature FS-FileServer');
  await srv.executeCommand('mkdir C:\\Shares\\Data');
  await srv.executeCommand('echo hello > C:\\Shares\\Data\\doc.txt');
  await run(ps(srv), 'New-SmbShare -Name Data -Path C:\\Shares\\Data -FullAccess bob');
  return { srv, client, lien };
}

describe('Sonde — net use rapporte l etat reel du lien', () => {
  it('passe a Disconnected quand le cable du serveur tombe', async () => {
    const { client, lien } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:SRV1\\bob');
    expect(await client.executeCommand('net use')).toMatch(/OK\s+Z:/);
    lien.disconnect();
    expect(await client.executeCommand('dir Z:\\')).not.toMatch(/doc\.txt/i);
    expect(await client.executeCommand('net use')).toMatch(/Disconnected\s+Z:/);
  }, 60_000);

  it('le detail d une connexion morte dit Disconnected lui aussi', async () => {
    const { client, lien } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:SRV1\\bob');
    lien.disconnect();
    await client.executeCommand('dir Z:\\');
    expect(await client.executeCommand('net use Z:')).toMatch(/Status\s+Disconnected/);
  }, 60_000);

  it('TEMOIN : tant que le lien tient, l etat reste OK', async () => {
    const { client } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:SRV1\\bob');
    expect(await client.executeCommand('net use Z:')).toMatch(/Status\s+OK/);
    expect(await client.executeCommand('dir Z:\\')).toMatch(/doc\.txt/i);
  }, 60_000);
});
