/**
 * Sonde — `net use` dans toutes ses formes reelles, sur le fil.
 *
 * Le depot porte deja un `net use` qui compose VRAIMENT : il resout le
 * nom, ouvre une connexion TCP/445 et negocie session-setup puis
 * tree-connect avant d'inscrire la moindre ligne. Ce qui manque n'est pas
 * le transport, ce sont les FORMES de la commande, et ce que Windows
 * repond quand elles echouent.
 *
 * Les attentes sont ecrites A L'AVEUGLE d'apres la documentation de
 * l'editeur et les articles de support qui donnent les libelles exacts :
 *
 *   NET USE [devicename | *] [\\computername\sharename[\volume] [password | *]]
 *           [/USER:[domainname\]username] [/SAVECRED]
 *           [[/DELETE] | [/PERSISTENT:{YES | NO}]]
 *
 *   - `net use <device>` seul rend le DETAIL d'une connexion :
 *     Local name / Remote name / Resource type / Status / # Opens /
 *     # Connections.
 *   - `*` a la place du peripherique fait choisir la prochaine lettre
 *     libre, et Windows annonce laquelle.
 *   - une UNC SANS lettre ouvre une connexion « sans peripherique »,
 *     qui n'est jamais persistante.
 *   - reutiliser une lettre deja prise : « System error 85 has occurred.
 *     The local device name is already in use. »
 *   - un partage inconnu sur un serveur joignable : « System error 67 has
 *     occurred. The network name cannot be found. » — distinct de
 *     l'erreur 53, qui dit que le CHEMIN reseau est introuvable.
 *   - deux identites differentes vers le meme serveur : « System error
 *     1219 has occurred. Multiple connections to a server or shared
 *     resource by the same user, using more than one user name, are not
 *     allowed. »
 *   - `/persistent:{yes|no}` gouverne l'en-tete du listing : « New
 *     connections will be remembered. » ou « will not be remembered. »
 *
 * Discrimination `git stash` : 7 des 9 cas tombent. Les deux qui passent
 * des deux cotes sont les TEMOINS, nommes plutot que laisses a
 * decouvrir : la distinction 67/53, qui prouve que le dialogue SMB
 * atteint vraiment le serveur et sait dire lequel des deux manque, et le
 * montage deja implante, qui prouve que le laboratoire monte bien un
 * partage. Sans eux, sept refus ne prouveraient rien.
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
  client.setCurrentUser('Administrator');
  await run(ps(srv), 'Install-WindowsFeature FS-FileServer');
  await srv.executeCommand('mkdir C:\\Shares\\Data');
  await srv.executeCommand('echo hello from srv1 > C:\\Shares\\Data\\doc.txt');
  await run(ps(srv), 'New-SmbShare -Name Data -Path C:\\Shares\\Data -FullAccess bob');
  await run(ps(srv), 'New-SmbShare -Name Public -Path C:\\Shares\\Data -FullAccess alice');
  return { srv, client };
}

const mount = (c: WindowsPC, drive: string, share = 'Data', who = 'bob') =>
  c.executeCommand(`net use ${drive} \\\\SRV1\\${share} ${who} /user:SRV1\\${who}`);

describe('Sonde — les formes reelles de net use', () => {
  it('rend le DETAIL d une connexion quand on ne nomme que le peripherique', async () => {
    const { client } = await lab();
    await mount(client, 'Z:');
    const out = await client.executeCommand('net use Z:');
    expect(out).toMatch(/Local name\s+Z:/);
    expect(out).toMatch(/Remote name\s+\\\\SRV1\\Data/);
    expect(out).toMatch(/Resource type\s+Disk/);
    expect(out).toMatch(/Status\s+OK/);
    expect(out).toMatch(/# Opens/);
    expect(out).toMatch(/# Connections/);
    expect(out).toMatch(/command completed successfully/i);
  }, 60_000);

  it('choisit la prochaine lettre libre pour `*` et annonce laquelle', async () => {
    const { client } = await lab();
    const out = await client.executeCommand('net use * \\\\SRV1\\Data bob /user:SRV1\\bob');
    expect(out).toMatch(/Drive [A-Z]: is now connected to \\\\SRV1\\Data/);
    expect(out).toMatch(/command completed successfully/i);
    expect(await client.executeCommand('net use')).toMatch(/\\\\SRV1\\Data/);
  }, 60_000);

  it('ouvre une connexion SANS peripherique pour une UNC seule', async () => {
    const { client } = await lab();
    const out = await client.executeCommand('net use \\\\SRV1\\Data bob /user:SRV1\\bob');
    expect(out).toMatch(/command completed successfully/i);
    const list = await client.executeCommand('net use');
    expect(list).toMatch(/\\\\SRV1\\Data/);
  }, 60_000);

  it('refuse une lettre deja prise avec l erreur 85', async () => {
    const { client } = await lab();
    expect(await mount(client, 'Z:')).toMatch(/command completed successfully/i);
    const out = await mount(client, 'Z:');
    expect(out).toMatch(/System error 85 has occurred/);
    expect(out).toMatch(/local device name is already in use/i);
  }, 60_000);

  it('distingue un partage inconnu (67) d un serveur injoignable (53)', async () => {
    const { client } = await lab();
    const inconnu = await client.executeCommand('net use Z: \\\\SRV1\\PasLa bob /user:SRV1\\bob');
    expect(inconnu).toMatch(/System error 67 has occurred/);
    expect(inconnu).toMatch(/network name cannot be found/i);

    const absent = await client.executeCommand('net use Y: \\\\SRV-FANTOME\\Data');
    expect(absent).toMatch(/System error 53 has occurred/);
    expect(absent).toMatch(/network path was not found/i);
  }, 60_000);

  it('refuse une seconde identite vers le meme serveur avec l erreur 1219', async () => {
    const { client } = await lab();
    await mount(client, 'Z:', 'Data', 'bob');
    const out = await client.executeCommand('net use Y: \\\\SRV1\\Public alice /user:SRV1\\alice');
    expect(out).toMatch(/System error 1219 has occurred/);
    expect(out).toMatch(/Multiple connections to a server or shared resource by the same user/i);
  }, 60_000);

  it('l en-tete du listing suit /persistent', async () => {
    const { client } = await lab();
    await client.executeCommand('net use /persistent:no');
    expect(await client.executeCommand('net use')).toMatch(/New connections will not be remembered/);
    await client.executeCommand('net use /persistent:yes');
    expect(await client.executeCommand('net use')).toMatch(/New connections will be remembered/);
  }, 60_000);

  it('supprime une connexion sans peripherique par son UNC', async () => {
    const { client } = await lab();
    await client.executeCommand('net use \\\\SRV1\\Data bob /user:SRV1\\bob');
    const out = await client.executeCommand('net use \\\\SRV1\\Data /delete');
    expect(out).toMatch(/deleted successfully|command completed successfully/i);
    expect(await client.executeCommand('net use')).not.toMatch(/\\\\SRV1\\Data/);
  }, 60_000);

  it('suit un renvoi DFS quand l UNC nomme un espace de noms, pas un partage', async () => {
    const { srv, client } = await lab();
    await run(ps(srv), 'Install-WindowsFeature -Name FS-DFS-Namespace -IncludeManagementTools');
    await run(ps(srv), 'New-DfsnRoot -Path "\\\\SRV1\\Pub" -Type Standalone -TargetPath "\\\\SRV1\\Data"');
    const out = await client.executeCommand('net use Z: \\\\SRV1\\Pub bob /user:SRV1\\bob');
    expect(out).toMatch(/command completed successfully/i);
    expect(await client.executeCommand('dir Z:\\')).toMatch(/doc\.txt/i);
  }, 60_000);

  it('refuse un espace de noms inconnu au lieu d inventer un renvoi', async () => {
    const { srv, client } = await lab();
    await run(ps(srv), 'Install-WindowsFeature -Name FS-DFS-Namespace -IncludeManagementTools');
    const out = await client.executeCommand('net use Z: \\\\SRV1\\PasUnEspace bob /user:SRV1\\bob');
    expect(out).toMatch(/System error 67 has occurred/);
  }, 60_000);

  it('TEMOIN : la forme deja implantee monte toujours le partage', async () => {
    const { client } = await lab();
    expect(await mount(client, 'Z:')).toMatch(/command completed successfully/i);
    expect(await client.executeCommand('dir Z:\\')).toMatch(/doc\.txt/i);
  }, 60_000);
});
