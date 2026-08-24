/**
 * Un drapeau de verbosite decide de ce qui est AFFICHE, jamais de ce que
 * la machine FAIT.
 *
 * Trouve dans le transcript d'un utilisateur, a cote du defaut d'adresse
 * MAC : sur une machine non cablee, `dhclient -v eth0` repond « No
 * DHCPOFFERS received. » et ne configure rien, tandis que `dhclient eth0`
 * — la meme commande, la meme machine, le meme instant — s'attribue en
 * silence un 169.254.1.5 que `ifconfig` affiche ensuite sans que rien ne
 * l'explique. La condition etait litteralement `!verbose`.
 *
 * Ce que dit la vraie machine, verifie sur la SOURCE d'ISC plutot que de
 * memoire : `client/dhclient.c` (5890 lignes) ne contient pas une seule
 * occurrence de « 169.254 », ni d'APIPA, ni d'auto-attribution de
 * lien-local. `state_panic()` journalise « No DHCPOFFERS received. »,
 * essaie les baux enregistres, puis « No working leases in persistent
 * database - sleeping. » et se rearme. `quiet` vaut 1 par defaut et `-v`
 * le met a 0 ; il ne gouverne que `log_perror`, c'est-a-dire l'affichage.
 * Une machine Linux ne prend donc JAMAIS d'adresse de lien-local par
 * `dhclient` — c'est NetworkManager ou avahi-autoipd qui le font, chacun
 * etant un autre programme.
 *
 * Windows, lui, le fait vraiment : APIPA est une fonction de Windows,
 * active par defaut, que l'on desarme par
 * HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters
 * \\IPAutoconfigurationEnabled = 0. C'est donc une propriete de la
 * PLATEFORME, et elle se lit desormais dans le registre de la machine.
 *
 * Les deux cas qui passent des deux cotes sont nommes : « TEMOIN, un
 * serveur repond » — c'est son objet, il montre que le laboratoire est
 * bien bati et qu'aucun des deux cotes ne casse le chemin nominal ; et
 * « `-v` ne change que l'affichage », parce que la branche bavarde etait
 * DEJA juste et disait deja les mots d'ISC. C'est tout le propos : seule
 * la branche silencieuse agissait autrement.
 */

import { describe, it, expect } from 'vitest';
import { DHCPClient } from '@/network/dhcp/DHCPClient';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';

async function routerServingDhcp(): Promise<CiscoRouter> {
  const router = new CiscoRouter('R1');
  for (const c of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'ip dhcp pool LAN', 'network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1', 'exit',
    'ip dhcp excluded-address 192.168.1.1', 'end',
  ]) await router.executeCommand(c);
  return router;
}

describe('dhclient sur une machine que personne ne sert', () => {
  it('TEMOIN, un serveur repond : le bail est pris et configure', async () => {
    const router = await routerServingDhcp();
    const pc = new LinuxPC('linux-pc', 'PC1');
    new Cable('c1').connect(router.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);

    await pc.executeCommand('sudo dhclient eth0');
    expect(await pc.executeCommand('ifconfig eth0')).toContain('192.168.1.');
  });

  it('sans serveur, `dhclient eth0` ne configure aucune adresse', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');

    await pc.executeCommand('sudo dhclient eth0');

    const out = await pc.executeCommand('ifconfig eth0');
    expect(out).not.toContain('169.254.');
    expect(out).not.toMatch(/inet \d/);
  });

  it('les deux formes de la commande laissent la machine dans le meme etat', async () => {
    const silencieux = new LinuxPC('linux-pc', 'PC1');
    const bavard = new LinuxPC('linux-pc', 'PC2');

    await silencieux.executeCommand('sudo dhclient eth0');
    await bavard.executeCommand('sudo dhclient -v eth0');

    const sansMac = (t: string) => t.replace(/([0-9a-f]{2}:){5}[0-9a-f]{2}/g, 'MAC');
    expect(sansMac(await silencieux.executeCommand('ifconfig eth0')))
      .toBe(sansMac(await bavard.executeCommand('ifconfig eth0')));
    expect(silencieux.getDHCPState('eth0').state).toBe(bavard.getDHCPState('eth0').state);
  });

  it('`-v` ne change que l\'affichage, et il dit les mots d\'ISC', async () => {
    const silencieux = new LinuxPC('linux-pc', 'PC1');
    const bavard = new LinuxPC('linux-pc', 'PC2');

    expect(await silencieux.executeCommand('sudo dhclient eth0')).toBe('');
    const out = await bavard.executeCommand('sudo dhclient -v eth0');
    expect(out).toContain('No DHCPOFFERS received.');
    expect(out).toContain('No working leases in persistent database - sleeping.');
  });

  it('une adresse de lien-local ne devient pas un bail a redemander', () => {
    const client = new DHCPClient(() => 'AA:BB:CC:DD:EE:01', () => {}, () => {});
    client.setLinkLocalAutoconfiguration(() => true);

    client.requestLease('eth0');

    expect(client.getState('eth0').lease!.ipAddress).toMatch(/^169\.254\./);
    expect(client.getState('eth0').lastKnownLease).toBeNull();
  });

  it('Windows prend une adresse APIPA, et le registre peut la lui retirer', async () => {
    const avec = new WindowsPC('windows-pc', 'WINA');
    await avec.executeCommand('ipconfig /renew');
    expect(await avec.executeCommand('ipconfig')).toContain('169.254.');

    const sans = new WindowsPC('windows-pc', 'WINB');
    sans.setCurrentUser('Administrator');
    await sans.executeCommand(
      'reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters" /v IPAutoconfigurationEnabled /t REG_DWORD /d 0 /f');
    await sans.executeCommand('ipconfig /renew');
    expect(await sans.executeCommand('ipconfig')).not.toContain('169.254.');
  });
});
