/**
 * Sonde — `New-PSDrive` et `net use` montent le MEME lecteur.
 *
 * `New-PSDrive -Name Z -PSProvider FileSystem -Root \\SRV1\Data` inscrit
 * aujourd'hui une ligne dans une VARIABLE de session (`__drives__`), sans
 * poser la moindre trame sur le fil. Trois defauts en un :
 *
 *  - un lecteur RESEAU cree sans qu'aucune trame ne circule, alors que
 *    tout echange entre deux machines doit traverser le reseau simule
 *    (regle 4) ;
 *  - deux magasins pour un seul fait — `netUseTable` pour `net use`,
 *    `__drives__` pour PowerShell — qui se contredisent sur la meme
 *    machine, a la meme seconde, quand on demande quels lecteurs
 *    existent (regle 3, la coherence cmd/PowerShell) ;
 *  - `-PSProvider` accepte et jamais lu, comme `-Persist` et
 *    `-Credential`, absents de la declaration (regle 6).
 *
 * La documentation de l'editeur est explicite sur `-Persist` : « creates
 * a Windows mapped network drive ... persistent, not session-specific,
 * and can be viewed and managed in File Explorer and other tools ». Le
 * lecteur ainsi cree est donc celui que `net use` liste, pas un autre.
 *
 * Les attentes sont ecrites d'apres ce contrat, pas d'apres ce que rend
 * ce simulateur.
 *
 * Discrimination `git stash` : 6 des 8 cas tombent. Les deux autres sont
 * nommes plutot que laisses a deviner — « Remove-PSDrive defait le
 * montage », qui passait a vide avant faute de montage a defaire, et le
 * TEMOIN « un lecteur LOCAL reste une affaire de PowerShell seule », qui
 * garantit que brancher PowerShell sur la table de `net use` n'y a pas
 * verse les lecteurs qui n'ont rien a y faire. Ce temoin a servi : une
 * premiere version de la sonde ouvrait un sous-shell NEUF a chaque
 * commande, si bien que `New-PSDrive` et `Get-PSDrive` ne partageaient
 * aucune session — il est tombe, et c'est le laboratoire qui etait faux.
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
  // Une SEULE session PowerShell cote client : `New-PSDrive` et
  // `Get-PSDrive` doivent se parler, et deux sous-shells n'ont rien en
  // commun.
  return { srv, client, sh: ps(client), wan: { compter: () => vues } };
}

describe('Sonde — un seul magasin de lecteurs reseau, deux interfaces', () => {
  it('met des trames sur le fil au lieu d inscrire une ligne en memoire', async () => {
    const { client, sh, wan } = await lab();
    const avant = wan.compter();
    await run(sh, 'New-PSDrive -Name Z -PSProvider FileSystem -Root \\\\SRV1\\Data -Persist');
    expect(wan.compter() - avant).toBeGreaterThan(0);
  }, 60_000);

  it('ouvre une session que le SERVEUR voit', async () => {
    const { srv, client, sh } = await lab();
    await run(sh, 'New-PSDrive -Name Z -PSProvider FileSystem -Root \\\\SRV1\\Data -Persist');
    expect(await run(ps(srv), 'Get-SmbSession')).toContain('bob');
  }, 60_000);

  it('le lecteur cree en PowerShell apparait dans net use', async () => {
    const { client, sh } = await lab();
    await run(sh, 'New-PSDrive -Name Z -PSProvider FileSystem -Root \\\\SRV1\\Data -Persist');
    expect(await client.executeCommand('net use')).toMatch(/Z:\s+\\\\SRV1\\Data/);
  }, 60_000);

  it('le lecteur monte par net use apparait dans Get-PSDrive', async () => {
    const { client, sh } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:bob');
    expect(await run(sh, 'Get-PSDrive')).toMatch(/Z/);
  }, 60_000);

  it('rend le partage utilisable, pas seulement affiche', async () => {
    const { client, sh } = await lab();
    await run(sh, 'New-PSDrive -Name Z -PSProvider FileSystem -Root \\\\SRV1\\Data -Persist');
    expect(await client.executeCommand('dir Z:\\')).toMatch(/doc\.txt/i);
  }, 60_000);

  it('refuse un partage inexistant au lieu d inscrire une ligne', async () => {
    const { client, sh } = await lab();
    const out = await run(sh, 'New-PSDrive -Name Z -PSProvider FileSystem -Root \\\\SRV1\\PasLa -Persist');
    expect(out).toMatch(/not found|cannot be found|does not exist/i);
    expect(await client.executeCommand('net use')).not.toMatch(/Z:/);
  }, 60_000);

  it('Remove-PSDrive defait le montage des deux cotes', async () => {
    const { client, sh } = await lab();
    await run(sh, 'New-PSDrive -Name Z -PSProvider FileSystem -Root \\\\SRV1\\Data -Persist');
    await run(sh, 'Remove-PSDrive -Name Z');
    expect(await client.executeCommand('net use')).not.toMatch(/Z:/);
  }, 60_000);

  it('TEMOIN : un lecteur LOCAL reste une affaire de PowerShell seule', async () => {
    const { client, sh } = await lab();
    await run(sh, 'New-PSDrive -Name Docs -PSProvider FileSystem -Root C:\\');
    expect(await run(sh, 'Get-PSDrive')).toMatch(/Docs/);
    expect(await client.executeCommand('net use')).not.toMatch(/Docs/);
  }, 60_000);
});
