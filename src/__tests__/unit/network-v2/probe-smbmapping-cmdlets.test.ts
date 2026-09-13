/**
 * Sonde — la famille `*-SmbMapping`, troisieme vue du MEME magasin.
 *
 * `Get-SmbMapping`, `New-SmbMapping` et `Remove-SmbMapping` sont les
 * cmdlets que l'editeur documente comme la contrepartie PowerShell de
 * `net use` : elles manquent entierement. Le depot porte maintenant une
 * seule table de lecteurs reseau, lue par `net use` et par
 * `New-PSDrive` ; ces trois cmdlets en sont la troisieme interface, et
 * elles doivent lire et ecrire CETTE table, pas en ouvrir une quatrieme.
 *
 * Syntaxe de l'editeur, relevee telle quelle :
 *
 *   Get-SmbMapping    [[-LocalPath] <String[]>] [[-RemotePath] <String[]>]
 *   New-SmbMapping    [[-LocalPath] <String>] [[-RemotePath] <String>]
 *                     [-UserName <String>] [-Password <String>]
 *                     [-Persistent <Boolean>] [-SaveCredentials]
 *                     [-HomeFolder] [-GlobalMapping] ...
 *   Remove-SmbMapping [[-LocalPath] <String[]>] [[-RemotePath] <String[]>]
 *                     [-Force] [-UpdateProfile] [-PassThru] ...
 *
 * L'objet rendu porte `Status`, `LocalPath` et `RemotePath`.
 *
 * `New-SmbMapping` accepte aussi des reglages de transport que ce
 * simulateur ne sait pas honorer — `-RequireIntegrity`, `-RequirePrivacy`,
 * `-TransportType`, `-QuicPort`, `-BlockNTLM` et leurs voisins. Les
 * accepter sans effet serait l'apparence d'exister sans l'effet
 * (regle 6) : ils sont REFUSES en nommant la brique absente.
 *
 * Les attentes sont ecrites d'apres cette documentation, pas d'apres ce
 * que rend ce simulateur.
 *
 * Discrimination `git stash` : 8 des 9 cas tombent. Le neuvieme —
 * « Remove-SmbMapping defait le montage » — passait A VIDE avant, faute
 * de cmdlet pour monter quoi que ce soit et de cmdlet pour lister : deux
 * absences qui se compensaient. Il est nomme ici plutot que laisse
 * croire a un temoin, parce qu'il n'en est pas un ; ce sont les cas
 * « net use voit ce que New-SmbMapping a monte » et l'inverse qui
 * prouvent que les trois interfaces lisent bien une seule table.
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

interface Labo { srv: WindowsServer; client: WindowsPC; sh: ReturnType<typeof ps>; wan: { compter(): number } }

async function lab(): Promise<Labo> {
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
  let vues = 0;
  client.getPorts()[0].attachTap(() => { vues++; });
  return { srv, client, sh: ps(client), wan: { compter: () => vues } };
}

describe('Sonde — les cmdlets SmbMapping lisent et ecrivent la table commune', () => {
  it('New-SmbMapping monte le partage en mettant des trames sur le fil', async () => {
    const { sh, wan } = await lab();
    const avant = wan.compter();
    const out = await run(sh, 'New-SmbMapping -LocalPath Z: -RemotePath \\\\SRV1\\Data');
    expect(out).not.toMatch(/is not recognized/i);
    expect(wan.compter() - avant).toBeGreaterThan(0);
  }, 60_000);

  it('rend un objet portant Status, LocalPath et RemotePath', async () => {
    const { sh } = await lab();
    const out = await run(sh, 'New-SmbMapping -LocalPath Z: -RemotePath \\\\SRV1\\Data | Format-List');
    expect(out).toMatch(/Status\s*:\s*OK/);
    expect(out).toMatch(/LocalPath\s*:\s*Z:/);
    expect(out).toMatch(/RemotePath\s*:\s*\\\\SRV1\\Data/);
  }, 60_000);

  it('Get-SmbMapping voit ce que net use a monte', async () => {
    const { client, sh } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:bob');
    const out = await run(sh, 'Get-SmbMapping');
    expect(out).toMatch(/Z:/);
    expect(out).toMatch(/\\\\SRV1\\Data/);
  }, 60_000);

  it('net use voit ce que New-SmbMapping a monte', async () => {
    const { client, sh } = await lab();
    await run(sh, 'New-SmbMapping -LocalPath Z: -RemotePath \\\\SRV1\\Data');
    expect(await client.executeCommand('net use')).toMatch(/Z:\s+\\\\SRV1\\Data/);
  }, 60_000);

  it('filtre sur -LocalPath comme la documentation le prevoit', async () => {
    const { sh } = await lab();
    await run(sh, 'New-SmbMapping -LocalPath Z: -RemotePath \\\\SRV1\\Data');
    expect(await run(sh, 'Get-SmbMapping -LocalPath Z:')).toMatch(/\\\\SRV1\\Data/);
    expect(await run(sh, 'Get-SmbMapping -LocalPath Y:')).not.toMatch(/\\\\SRV1\\Data/);
  }, 60_000);

  it('Remove-SmbMapping defait le montage, et net use le constate', async () => {
    const { client, sh } = await lab();
    await run(sh, 'New-SmbMapping -LocalPath Z: -RemotePath \\\\SRV1\\Data');
    await run(sh, 'Remove-SmbMapping -LocalPath Z: -Force');
    expect(await run(sh, 'Get-SmbMapping')).not.toMatch(/Z:/);
    expect(await client.executeCommand('net use')).not.toMatch(/Z:/);
  }, 60_000);

  it('refuse un partage inexistant au lieu d inscrire une ligne', async () => {
    const { sh } = await lab();
    const out = await run(sh, 'New-SmbMapping -LocalPath Z: -RemotePath \\\\SRV1\\PasLa');
    expect(out).toMatch(/network name cannot be found|not found/i);
    expect(await run(sh, 'Get-SmbMapping')).not.toMatch(/Z:/);
  }, 60_000);

  it('refuse un reglage de transport qu il ne sait pas honorer, en le nommant', async () => {
    const { sh } = await lab();
    const out = await run(sh, 'New-SmbMapping -LocalPath Z: -RemotePath \\\\SRV1\\Data -RequirePrivacy $true');
    expect(out).toMatch(/RequirePrivacy/);
    expect(out).toMatch(/cannot be honoured|not supported/i);
  }, 60_000);

  it('TEMOIN : le partage monte par la cmdlet est utilisable', async () => {
    const { client, sh } = await lab();
    await run(sh, 'New-SmbMapping -LocalPath Z: -RemotePath \\\\SRV1\\Data');
    expect(await client.executeCommand('dir Z:\\')).toMatch(/doc\.txt/i);
  }, 60_000);
});
