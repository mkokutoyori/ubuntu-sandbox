/**
 * RFC 4702 §3.2 — le drapeau S dit QUI enregistre l'adresse directe.
 *
 * Le client de ce depot posait S=1 sur toutes ses machines : « serveur,
 * fais le A pour moi », parce qu'il n'avait aucun moyen de l'enregistrer
 * lui-meme. La branche S=0 du serveur n'etait donc atteignable que par un
 * client FABRIQUE par une sonde. Un vrai client Windows pose S=0 et
 * s'enregistre par une mise a jour dynamique ; un client Linux sous
 * `dhclient` laisse faire le serveur, et les deux comportements sont ici.
 *
 * Discrimine par `git stash` d'`EndHost.ts`, `WindowsPC.ts` et
 * `DHCPClient.ts` : 4 des 8 cas tombent. Les 4 qui passent des deux
 * cotes sont nommes ici plutot que laisses a decouvrir : les trois cas
 * Linux, dont c'est l'objet meme — ils decrivent le comportement qui ne
 * change pas et servent de TEMOIN au reste — et le bail sans domaine,
 * ou il n'y a rien a enregistrer des deux cotes puisque le serveur ne
 * sait pas davantage a quelle zone rattacher le nom.
 *
 * La duree de vie est ce qui distingue les deux auteurs : le client pose
 * 1200 secondes comme un vrai Windows, le serveur 3600. Sans elle, « le
 * nom est dans la zone » ne dit pas QUI l'y a mis, et trois cas
 * passaient des deux cotes pour cette seule raison.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, line: string) =>
  (await sh.processLine(line)).output.join('\n');

async function labo(options: { domaine?: string } = {}) {
  const { domaine = 'lab.local' } = options;
  const srv = new WindowsServer('SRV');
  const win = new WindowsPC('windows-pc', 'PC-WIN');
  const lnx = new LinuxPC('linux-pc', 'PC-LNX');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(srv.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(win.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(lnx.getPorts()[0], sw.getPorts()[2]);
  srv.getPorts()[0].configureIP(new IPAddress('192.168.40.5'), new SubnetMask('255.255.255.0'));
  srv.setCurrentUser('Administrator');

  const sh = ps(srv);
  for (const c of [
    'Install-WindowsFeature -Name DNS -IncludeManagementTools',
    'Install-WindowsFeature -Name DHCP -IncludeManagementTools',
    'Add-DnsServerPrimaryZone -Name "lab.local"',
    'Add-DhcpServerv4Scope -Name "LAN" -StartRange 192.168.40.10 -EndRange 192.168.40.200 '
      + '-SubnetMask 255.255.255.0 -State Active',
    'Set-DhcpServerv4OptionValue -ScopeId 192.168.40.0 -Router 192.168.40.1',
    domaine
      ? `Set-DhcpServerv4OptionValue -ScopeId 192.168.40.0 -DnsServer 192.168.40.5 -DnsDomain "${domaine}"`
      : 'Set-DhcpServerv4OptionValue -ScopeId 192.168.40.0 -DnsServer 192.168.40.5',
  ]) await run(sh, c);

  return { srv, win, lnx, sh };
}

const bailWindows = async (win: WindowsPC) => {
  const cli = ps(win);
  await run(cli, 'ipconfig /release');
  return run(cli, 'ipconfig /renew');
};

const zone = (sh: ReturnType<typeof ps>) =>
  run(sh, 'Get-DnsServerResourceRecord -ZoneName "lab.local"');

describe('le client Windows enregistre son propre nom', () => {
  it('il annonce S=0 dans l option 81', async () => {
    const { win } = await labo();
    await bailWindows(win);
    const vues: number[] = [];
    const client = win.getDHCPClient() as unknown as {
      clientIdentity(): { clientFqdn?: { flags: number } };
    };
    vues.push(client.clientIdentity().clientFqdn?.flags ?? -1);
    expect(vues).toEqual([0x00]);
  });

  it('son enregistrement A est dans la zone, et porte SA duree de vie', async () => {
    const { win, sh } = await labo();
    await bailWindows(win);
    const records = await zone(sh);
    expect(records.toLowerCase()).toContain('pc-win');
    expect(records).toMatch(/1200/);
  });

  it('liberer le bail RETIRE le nom, comme un vrai client', async () => {
    const { win, sh } = await labo();
    await bailWindows(win);
    expect(await zone(sh)).toMatch(/PC-WIN\.lab\.local\s+A\s+1200/);

    await run(ps(win), 'ipconfig /release');

    expect((await zone(sh)).toLowerCase()).not.toContain('pc-win');
  });

  it('un second bail ne laisse qu UNE adresse pour le nom', async () => {
    const { win, sh } = await labo();
    await bailWindows(win);
    await bailWindows(win);
    const lignes = (await zone(sh)).split('\n')
      .filter(l => l.toLowerCase().includes('pc-win'));
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatch(/\s1200\s/);
  });

  it('sans domaine dans le bail, il n y a rien a enregistrer', async () => {
    const { win, sh } = await labo({ domaine: '' });
    await bailWindows(win);
    expect((await zone(sh)).toLowerCase()).not.toContain('pc-win');
  });
});

describe('le client Linux laisse faire le serveur', () => {
  it('TEMOIN — il annonce S=1', async () => {
    const { lnx } = await labo();
    await lnx.executeCommand('dhclient eth0');
    const client = lnx.getDHCPClient() as unknown as {
      clientIdentity(): { clientFqdn?: { flags: number } };
    };
    expect(client.clientIdentity().clientFqdn?.flags).toBe(0x01);
  });

  it('et c est le SERVEUR qui pose son A', async () => {
    const { lnx, sh } = await labo();
    await lnx.executeCommand('dhclient eth0');
    const records = await zone(sh);
    expect(records.toLowerCase()).toContain('pc-lnx');
    expect(records).toMatch(/3600/);
  });

  it('donc `DynamicUpdates Never` le laisse SANS nom', async () => {
    const { lnx, sh } = await labo();
    await run(sh, 'Set-DhcpServerv4DnsSetting -DynamicUpdates Never');
    await lnx.executeCommand('dhclient eth0');
    expect((await zone(sh)).toLowerCase()).not.toContain('pc-lnx');
  });
});
