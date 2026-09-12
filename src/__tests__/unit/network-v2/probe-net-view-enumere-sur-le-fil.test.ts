/**
 * Sonde — `net view` enumere les partages d'un serveur SUR LE FIL.
 *
 * `net help` annonce NET VIEW parmi les commandes disponibles, et taper
 * `net view \\SRV1` rendait un simple gabarit de syntaxe : la machine
 * declarait une commande qu'elle n'avait pas. C'est la moitie
 * DECOUVERTE de tout ce lot — on ne monte pas ce qu'on ne sait pas
 * enumerer.
 *
 * Syntaxe de l'editeur :
 *
 *   NET VIEW [\\computername [/CACHE] | [/ALL] | /DOMAIN[:domainname]]
 *
 * Le listage d'un serveur porte les colonnes `Share name`, `Type`,
 * `Used as` et `Comment`. `Used as` est la que se joue la coherence :
 * elle nomme la lettre locale quand le partage est deja monte, donc elle
 * lit la meme table que `net use`, `Get-PSDrive` et `Get-SmbMapping`.
 *
 * `/ALL` ajoute les partages administratifs (ceux dont le nom finit par
 * `$`), que la forme nue cache.
 *
 * Sans argument, `net view` demanderait un service de navigation que ce
 * simulateur n'a pas — et qu'un Windows moderne n'a plus non plus : la
 * reponse attendue est celle qu'il donne, « System error 6118 ».
 *
 * Rien de tout cela ne peut se lire dans la memoire du serveur : une
 * enumeration est une question posee a la machine d'en face (regle 4).
 *
 * Discrimination `git stash` : 7 des 8 cas tombent. Le huitieme est le
 * TEMOIN — « le serveur sait lui-meme ce qu'il partage » : il prouve que
 * le partage existe bel et bien cote serveur, sans quoi sept refus
 * mesureraient un laboratoire vide plutot qu'une commande absente.
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

interface Labo { srv: WindowsServer; client: WindowsPC; lien: Cable; wan: { compter(): number } }

async function lab(): Promise<Labo> {
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
  client.setCurrentUser('bob');
  await run(ps(srv), 'Install-WindowsFeature FS-FileServer');
  await srv.executeCommand('mkdir C:\\Shares\\Data');
  await srv.executeCommand('echo hello > C:\\Shares\\Data\\doc.txt');
  // Nom ENTRE GUILLEMETS a dessein : un argument PowerShell nu est
  // abaisse en minuscules par l'analyseur de ce depot (`-Name Data` donne
  // `data`), defaut mesure en marge de ce lot et bien plus large que lui.
  // Cette sonde mesure `net view`, pas l'analyseur.
  await run(ps(srv), 'New-SmbShare -Name "Data" -Path C:\\Shares\\Data -FullAccess bob -Description "Partage de test"');
  let vues = 0;
  client.getPorts()[0].attachTap(() => { vues++; });
  return { srv, client, lien, wan: { compter: () => vues } };
}

describe('Sonde — net view interroge le serveur', () => {
  it('enumere les partages du serveur nomme', async () => {
    const { client } = await lab();
    const out = await client.executeCommand('net view \\\\SRV1');
    expect(out).toMatch(/Shared resources at \\\\SRV1/i);
    expect(out).toMatch(/Share name\s+Type\s+Used as\s+Comment/);
    expect(out).toMatch(/Data\s+Disk/);
    expect(out).toMatch(/command completed successfully/i);
  }, 60_000);

  it('met des trames sur le fil pour le demander', async () => {
    const { client, wan } = await lab();
    const avant = wan.compter();
    await client.executeCommand('net view \\\\SRV1');
    expect(wan.compter() - avant).toBeGreaterThan(0);
  }, 60_000);

  it('cache les partages administratifs, sauf avec /ALL', async () => {
    const { client } = await lab();
    expect(await client.executeCommand('net view \\\\SRV1')).not.toMatch(/IPC\$|ADMIN\$/);
    expect(await client.executeCommand('net view \\\\SRV1 /all')).toMatch(/IPC\$|ADMIN\$/);
  }, 60_000);

  it('nomme la lettre locale dans `Used as` quand le partage est monte', async () => {
    const { client } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:bob');
    const out = await client.executeCommand('net view \\\\SRV1');
    expect(out).toMatch(/Data\s+Disk\s+Z:/);
  }, 60_000);

  it('rend le commentaire que le partage porte', async () => {
    const { client } = await lab();
    expect(await client.executeCommand('net view \\\\SRV1')).toMatch(/Partage de test/);
  }, 60_000);

  it('echoue dans les mots de Windows quand le serveur ne repond pas', async () => {
    const { client, lien } = await lab();
    lien.disconnect();
    const out = await client.executeCommand('net view \\\\SRV1');
    expect(out).toMatch(/System error 53 has occurred|network path was not found/i);
  }, 60_000);

  it('sans argument, dit que la liste des serveurs n est pas disponible', async () => {
    const { client } = await lab();
    expect(await client.executeCommand('net view')).toMatch(/System error 6118/);
  }, 60_000);

  it('TEMOIN : le serveur sait lui-meme ce qu il partage', async () => {
    const { srv } = await lab();
    expect(await srv.executeCommand('net share')).toMatch(/Data/);
  }, 60_000);
});
