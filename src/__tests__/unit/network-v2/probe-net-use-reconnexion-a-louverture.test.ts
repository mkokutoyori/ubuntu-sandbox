/**
 * Sonde — un mappage persistant revient a l'ouverture de session.
 *
 * Le lot « net use dans ses formes reelles » a mis les mappages
 * persistants la ou Windows les range — `HKCU\Network\<lettre>` avec son
 * `RemotePath` — et n'a JAMAIS relu cette cle. Ecrire un mappage
 * persistant que rien ne restaure, c'est stocker un critere que rien
 * n'evalue (regle 6), et le defaut est de moi : je l'ai introduit en
 * fermant le precedent.
 *
 * Ce qu'un vrai Windows fait : `/persistent:yes` veut dire « remonte-le a
 * ma prochaine ouverture de session ». Le redirecteur relit ces cles au
 * logon et retablit les connexions ; `/persistent:no` ne laisse rien
 * derriere lui. La reconnexion elle-meme est DIFFEREE — comme la
 * deconnexion, le redirecteur agit au premier usage plutot qu'a
 * l'instant du logon.
 *
 * Les attentes sont ecrites d'apres ce comportement, pas d'apres ce que
 * rend ce simulateur.
 *
 * PREMIERE MESURE, ET CE QU'ELLE A CORRIGE DANS LA SONDE. Un seul cas sur
 * six est tombe. Les mappages « survivaient » a l'ouverture de session —
 * mais pour une raison qui n'est pas celle qu'on veut : `setCurrentUser`
 * ne vide RIEN, si bien qu'un mappage reste la faute d'avoir ete
 * enleve. Trois cas passaient donc a vide. Ce que ce lot doit prouver
 * n'est pas qu'un mappage reste, c'est qu'il est RECONSTRUIT depuis le
 * registre — d'ou le cas qui inscrit une cle a la main avant d'ouvrir la
 * session, et celui qui exige qu'un mappage non persistant disparaisse.
 *
 * Discrimination `git stash` : 2 des 7 cas tombent — « reconstruit depuis
 * le registre » et « ne remonte PAS un mappage non persistant ». Les cinq
 * autres passent des deux cotes, et il faut le dire : « inscrit le
 * mappage » et « oublie la cle » mesurent le lot PRECEDENT, qui ecrivait
 * deja ces cles ; « le remonte a la prochaine ouverture » et « le rend
 * utilisable des le premier acces » passaient a vide avant, faute de
 * remise a zero au logon, et mesurent apres ; « le mappage marche dans la
 * session ou il a ete fait » est le TEMOIN, qui garantit que vider la
 * table au logon n'a pas casse l'usage courant.
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

async function lab(): Promise<{ srv: WindowsServer; client: WindowsPC }> {
  const srv = new WindowsServer('SRV1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  for (const d of [srv, client, sw]) d.powerOn();
  new Cable('c-srv').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  srv.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.10.20'), mask);
  client.addHostsEntry('192.168.10.10', 'SRV1');
  srv.setCurrentUser('Administrator');
  client.setCurrentUser('bob');
  await run(ps(srv), 'Install-WindowsFeature FS-FileServer');
  await srv.executeCommand('mkdir C:\\Shares\\Data');
  await srv.executeCommand('echo hello > C:\\Shares\\Data\\doc.txt');
  await run(ps(srv), 'New-SmbShare -Name Data -Path C:\\Shares\\Data -FullAccess bob');
  return { srv, client };
}

describe('Sonde — le mappage persistant survit a l ouverture de session', () => {
  it('inscrit le mappage persistant la ou Windows le range', async () => {
    const { client } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:bob /persistent:yes');
    const cle = await client.executeCommand('reg query "HKCU\\Network\\Z"');
    expect(cle).toMatch(/RemotePath/i);
    expect(cle).toMatch(/\\\\SRV1\\Data/);
  }, 60_000);

  it('reconstruit depuis le registre une connexion qu il n a pas lui-meme ouverte', async () => {
    const { client } = await lab();
    await client.executeCommand('reg add "HKCU\\Network\\Y" /v RemotePath /d "\\\\SRV1\\Data" /f');
    client.setCurrentUser('bob');
    expect(await client.executeCommand('net use')).toMatch(/Y:\s+\\\\SRV1\\Data/);
  }, 60_000);

  it('le remonte a la prochaine ouverture de session', async () => {
    const { client } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:bob /persistent:yes');
    client.setCurrentUser('bob');
    expect(await client.executeCommand('net use')).toMatch(/Z:\s+\\\\SRV1\\Data/);
  }, 60_000);

  it('le rend utilisable des le premier acces apres la session', async () => {
    const { client } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:bob /persistent:yes');
    client.setCurrentUser('bob');
    expect(await client.executeCommand('dir Z:\\')).toMatch(/doc\.txt/i);
  }, 60_000);

  it('ne remonte PAS un mappage declare non persistant', async () => {
    const { client } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:bob /persistent:no');
    client.setCurrentUser('bob');
    expect(await client.executeCommand('net use')).not.toMatch(/Z:/);
  }, 60_000);

  it('oublie la cle quand le mappage est supprime', async () => {
    const { client } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:bob /persistent:yes');
    await client.executeCommand('net use Z: /delete');
    expect(await client.executeCommand('reg query "HKCU\\Network\\Z"')).not.toMatch(/RemotePath/i);
  }, 60_000);

  it('TEMOIN : le mappage marche dans la session ou il a ete fait', async () => {
    const { client } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:bob /persistent:yes');
    expect(await client.executeCommand('dir Z:\\')).toMatch(/doc\.txt/i);
  }, 60_000);
});
