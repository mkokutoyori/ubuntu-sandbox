/**
 * DHCPv6 sans etat : le drapeau O, et l'INFORMATION-REQUEST qu'il
 * reclame (RFC 8415 §18.2.6).
 *
 * Le drapeau O d'une annonce de routeur dit : « ton adresse, tu la
 * tiens de l'autoconfiguration ; le reste — resolveur, domaine —,
 * viens le demander ». Il etait pose sur le fil depuis le lot
 * `ipv6-nd-ra-controles` et n'avait AUCUN consommateur : le message qui
 * repond a cette demande n'existait nulle part. `INFORMATION-REQUEST`
 * figurait dans le type `DHCPv6MessageType` et dans un commentaire du
 * serveur qui le declarait hors perimetre — le mot etait la, la
 * fonction non.
 *
 * Ce que ce lot ajoute est le message et ses deux bouts : le client
 * (`EndHost.requestDhcpv6Information`, declenche par le drapeau ou par
 * `dhclient -6 -S`) et le serveur (`processInformationRequest`), plus
 * le dispatch du routeur. Le consommateur, lui, existait deja : le
 * crochet qui ecrit `/etc/resolv.conf`.
 *
 * Ce qui distingue vraiment cet echange d'un bail : il n'attribue rien
 * et ne RETIENT rien. Un pool interroge cent fois ne s'epuise pas, et
 * un pool sans prefixe est legitime — c'est meme la configuration
 * normale du service sans etat.
 *
 * Un coin mesure et laisse tel quel, dit plutot que tu : un drapeau M
 * pointant sur un pool SANS adresse a distribuer ne produit rien du
 * tout — `processSolicit` ne trouve pas d'adresse, n'emet aucune
 * ADVERTISE, et les options du pool restent avec elle. La RFC 8415
 * §18.2.10 laisse un client prendre les options d'une ADVERTISE meme
 * sans adresse ; ce serveur n'envoie pas cette ADVERTISE-la. C'est une
 * configuration contradictoire (M demande une adresse a un pool qui
 * n'en a pas), et la corriger appartient au chemin du bail, pas a
 * celui-ci.
 */

import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

const cfg = async (r: CiscoRouter, lignes: string[]): Promise<string[]> => {
  const out: string[] = [];
  for (const l of lignes) out.push(await r.executeCommand(l));
  return out;
};

/**
 * Le laboratoire sans etat : un pool qui ne porte QUE de la
 * configuration, sans le moindre prefixe a distribuer.
 */
async function labo(options: { drapeau?: 'O' | 'M' | 'aucun'; prefixe?: boolean } = {}): Promise<{
  r: CiscoRouter; h: LinuxPC; sorties: string[];
}> {
  const drapeau = options.drapeau ?? 'O';
  const r = new CiscoRouter('R1');
  const h = new LinuxPC('H');
  h.powerOn();
  const sorties = await cfg(r, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    'ipv6 dhcp pool SANSETAT',
    ...(options.prefixe ? ['address prefix 2001:db8:aa::/64'] : []),
    'dns-server 2001:db8:aa::53', 'domain-name lab.local', 'exit',
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:aa::1/64',
    'ipv6 dhcp server SANSETAT',
    ...(drapeau === 'O' ? ['ipv6 nd other-config-flag'] : []),
    ...(drapeau === 'M' ? ['ipv6 nd managed-config-flag'] : []),
    'no shutdown', 'end',
  ]);
  new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);
  return { r, h, sorties };
}

const globales = async (h: LinuxPC): Promise<string[]> => {
  const sortie = await h.executeCommand('ip -6 addr show');
  return sortie.split('\n')
    .filter((l) => l.includes('inet6') && l.includes('scope global'))
    .map((l) => l.trim().split(/\s+/)[1]);
};

describe('le drapeau O amene la configuration, et rien qu\'elle', () => {
  it('le resolveur arrive dans /etc/resolv.conf', async () => {
    const { h, sorties } = await labo();
    expect(sorties.filter((s) => s.includes('%'))).toEqual([]);
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 2001:db8:aa::53');
    expect(resolv).toContain('search lab.local');
  });

  it('aucune adresse n\'est attribuee — c\'est le sens de « sans etat »', async () => {
    const { h } = await labo();
    // L'absence d'adresse ne veut rien dire tant qu'on n'a pas prouve
    // que l'echange a EU LIEU : sans cette ligne, le cas passerait aussi
    // bien avec la fonction absente.
    expect(await h.executeCommand('cat /etc/resolv.conf'))
      .toContain('nameserver 2001:db8:aa::53');
    const adresses = await globales(h);
    // Seule l'autoconfiguration a servi : l'identifiant vient de la MAC.
    expect(adresses).toEqual([expect.stringMatching(/^2001:db8:aa::ff:fe00:[0-9a-f]+\/64$/)]);
  });

  it('le serveur ne retient aucun bail', async () => {
    const { r, h } = await labo();
    expect(await h.executeCommand('cat /etc/resolv.conf'))
      .toContain('nameserver 2001:db8:aa::53');
    const vue = await r.executeCommand('show ipv6 dhcp binding');
    expect(vue).not.toContain('2001:db8:aa::2');
  });

  it('sans le drapeau, rien n\'est demande', async () => {
    const { h } = await labo({ drapeau: 'aucun' });
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv.trim()).toBe('');
    // Le garde-fou : l'autoconfiguration a bien eu lieu, donc le silence
    // du resolveur n'est pas le silence de tout.
    expect((await globales(h)).length).toBe(1);
  });
});

describe('le drapeau M ne repose pas la question', () => {
  it('sous M, la configuration vient du bail et non d\'une demande separee', async () => {
    // Le bail complet porte deja les memes options : reposer la question
    // ferait un aller-retour pour la meme reponse. Ce cas veut un pool
    // qui a des adresses a donner, puisque c'est ce que M reclame.
    const { h } = await labo({ drapeau: 'M', prefixe: true });
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 2001:db8:aa::53');
  });
});

describe('la demande se fait aussi a la main', () => {
  it('dhclient -6 -S rend sa transcription et configure', async () => {
    const { h } = await labo({ drapeau: 'aucun' });
    const sortie = await h.executeCommand('dhclient -6 -S -v eth0');
    expect(sortie).toContain('DHCPv6 INFORMATION-REQUEST');
    expect(sortie).toContain('nameserver 2001:db8:aa::53');
    const resolv = await h.executeCommand('cat /etc/resolv.conf');
    expect(resolv).toContain('nameserver 2001:db8:aa::53');
  });

  it('et il ne prend toujours pas d\'adresse', async () => {
    const { h } = await labo({ drapeau: 'aucun' });
    await h.executeCommand('dhclient -6 -S eth0');
    expect(await h.executeCommand('cat /etc/resolv.conf'))
      .toContain('nameserver 2001:db8:aa::53');
    expect((await globales(h)).length).toBe(1);
  });

  it('un pool interroge deux fois ne s\'epuise pas', async () => {
    // Un echange sans etat n'inscrit rien : cent demandes valent une.
    const { r, h } = await labo({ drapeau: 'aucun' });
    await h.executeCommand('dhclient -6 -S eth0');
    expect(await h.executeCommand('dhclient -6 -S -v eth0'))
      .toContain('nameserver 2001:db8:aa::53');
    const vue = await r.executeCommand('show ipv6 dhcp binding');
    expect(vue).not.toContain('2001:db8:aa::');
  });
});

describe('non-regression du bail ordinaire', () => {
  it('dhclient -6 sans -S prend toujours une adresse', async () => {
    const r = new CiscoRouter('R1');
    const h = new LinuxPC('H');
    h.powerOn();
    await cfg(r, [
      'enable', 'configure terminal', 'ipv6 unicast-routing',
      'ipv6 dhcp pool LAB', 'address prefix 2001:db8:bb::/64',
      'dns-server 2001:db8:bb::53', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:bb::1/64',
      'ipv6 dhcp server LAB', 'no shutdown', 'end',
    ]);
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);
    const sortie = await h.executeCommand('dhclient -6 -v eth0');
    expect(sortie).toContain('DHCPv6 REPLY of 2001:db8:bb::2');
    expect(await globales(h)).toContain('2001:db8:bb::2/64');
  });
});
