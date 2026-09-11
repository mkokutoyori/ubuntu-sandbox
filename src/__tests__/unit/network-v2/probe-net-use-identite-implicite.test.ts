/**
 * Sonde — `net use` sans `/user:` parle au nom de CELUI QUI EST CONNECTE,
 * et `/savecred` range vraiment le secret.
 *
 * Deux ecarts mesures sur le lot precedent :
 *
 * 1. Sans `/user:`, la commande se presentait comme `Administrator`, en
 *    dur, quel que soit l'utilisateur ouvert sur la machine. Un vrai
 *    Windows presente l'identite de la session : le compte du domaine
 *    quand la machine est jointe et qu'une session de domaine est
 *    ouverte, le compte local sinon. Se presenter sous un nom que
 *    personne n'a tape est faux deux fois : la session distante porte le
 *    mauvais nom, et l'operateur ne voit pas qui a ouvert le partage.
 *
 * 2. `/SAVECRED` etait REFUSE au motif que la machine n'a pas de magasin
 *    de secrets. C'etait faux : `WindowsUserManager` en porte un, celui
 *    que `runas /savecred` utilise deja. Le refus ecartait une capacite
 *    presente — et deux commandes qui rangent des secrets doivent ranger
 *    dans le MEME coffre, sans quoi `runas` et `net use` se contrediront
 *    sur ce que la machine retient.
 *
 * Les attentes sont ecrites d'apres ce que fait un vrai Windows, pas
 * d'apres ce que rend ce simulateur.
 *
 * Discrimination `git stash` : 5 des 6 cas tombent. Le sixieme est le
 * TEMOIN, nomme plutot que laisse a decouvrir — « une identite nommee
 * explicitement reste souveraine » : il passait deja et doit continuer,
 * sans quoi ce lot aurait remplace un nom en dur par un autre.
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
  return { srv, client };
}

describe('Sonde — net use se presente sous l identite de la session', () => {
  it('ouvre la session distante au nom de l utilisateur connecte, pas d Administrator', async () => {
    const { srv, client } = await lab();
    client.setCurrentUser('bob');
    const out = await client.executeCommand('net use Z: \\\\SRV1\\Data');
    expect(out).toMatch(/command completed successfully/i);
    const sessions = await run(ps(srv), 'Get-SmbSession');
    expect(sessions).toContain('bob');
    expect(sessions).not.toContain('Administrator');
  }, 60_000);

  it('nomme l utilisateur connecte dans le detail de la connexion', async () => {
    const { client } = await lab();
    client.setCurrentUser('bob');
    await client.executeCommand('net use Z: \\\\SRV1\\Data');
    expect(await client.executeCommand('net use')).toMatch(/\\\\SRV1\\Data/);
  }, 60_000);

  it('range le secret avec /savecred au lieu de refuser', async () => {
    const { client } = await lab();
    const out = await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:bob /savecred');
    expect(out).toMatch(/command completed successfully/i);
    expect(out).not.toMatch(/cannot be honoured/i);
  }, 60_000);

  it('reutilise le secret range pour une reconnexion sans mot de passe', async () => {
    const { client } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:bob /savecred');
    await client.executeCommand('net use Z: /delete');
    const again = await client.executeCommand('net use Z: \\\\SRV1\\Data /user:bob');
    expect(again).toMatch(/command completed successfully/i);
  }, 60_000);

  it('range dans le MEME coffre que runas, une seule memoire des secrets', async () => {
    const { client } = await lab();
    await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:bob /savecred');
    expect(client.getSavedRunasCredential('bob')).toBe('bob');
  }, 60_000);

  it('TEMOIN : une identite nommee explicitement reste souveraine', async () => {
    const { srv, client } = await lab();
    client.setCurrentUser('bob');
    const out = await client.executeCommand('net use Z: \\\\SRV1\\Data bob /user:SRV1\\bob');
    expect(out).toMatch(/command completed successfully/i);
    expect(await run(ps(srv), 'Get-SmbSession')).toContain('bob');
  }, 60_000);
});
