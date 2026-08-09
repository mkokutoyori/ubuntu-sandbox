/**
 * Le drapeau M d'une annonce de routeur declenche vraiment DHCPv6.
 *
 * Ce que la mesure a corrige dans ma propre lecture, et qui vaut d'etre
 * ecrit : ce depot a un serveur DHCPv6 ET un client complet
 * (`EndHost.requestDhcpv6Lease` : un vrai SOLICIT / ADVERTISE /
 * REQUEST / REPLY, verifie de bout en bout). J'avais annonce l'inverse
 * dans le journal de coordination, sur la foi d'un `grep` qui ne
 * trouvait pas de fichier « client » — il n'y a pas de fichier, il y a
 * une methode.
 *
 * Le manquement reel est plus etroit et bien present : le client
 * n'etait declenche QUE par un `dhclient -6` tape a la main. Le
 * drapeau M — « va chercher ton adresse en DHCPv6 », RFC 4861 §4.2 —
 * voyageait sur le fil sans que personne l'execute, de sorte qu'un
 * routeur configure en `managed` ne servait aucune adresse tant que
 * l'operateur ne la demandait pas lui-meme.
 *
 * Le drapeau A du prefixe reste independant (RFC 4862 §5.5.3) : un
 * hote porte legitimement les deux adresses sous une annonce qui pose
 * M et A ensemble, et c'est ce qu'on observe ici.
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

/** Un routeur servant un pool DHCPv6, cable a un hote. */
async function labo(options: { managed?: boolean; serveur?: boolean } = {}): Promise<{
  r: CiscoRouter; h: LinuxPC; sorties: string[];
}> {
  const r = new CiscoRouter('R1');
  const h = new LinuxPC('H');
  h.powerOn();
  const sorties = await cfg(r, [
    'enable', 'configure terminal', 'ipv6 unicast-routing',
    ...(options.serveur === false ? [] : [
      'ipv6 dhcp pool LAB', 'address prefix 2001:db8:aa::/64', 'exit',
    ]),
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:aa::1/64',
    ...(options.serveur === false ? [] : ['ipv6 dhcp server LAB']),
    ...(options.managed ? ['ipv6 nd managed-config-flag'] : []),
    'no shutdown', 'end',
  ]);
  new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, h.getPort('eth0')!);
  return { r, h, sorties };
}

const adressesGlobales = async (h: LinuxPC): Promise<string[]> => {
  const sortie = await h.executeCommand('ip -6 addr show');
  return sortie.split('\n')
    .filter((l) => l.includes('inet6') && l.includes('scope global'))
    .map((l) => l.trim().split(/\s+/)[1]);
};

describe('le drapeau M declenche le client', () => {
  it('l\'hote obtient un bail sans qu\'on tape dhclient', async () => {
    const { h } = await labo({ managed: true });
    // `::2` est la premiere adresse du pool : elle ne peut pas venir de
    // l'autoconfiguration, qui derive l'identifiant de la MAC.
    expect(await adressesGlobales(h)).toContain('2001:db8:aa::2/64');
  });

  it('et il garde AUSSI son adresse autoconfiguree', async () => {
    // Le drapeau A du prefixe est independant du drapeau M.
    const { h } = await labo({ managed: true });
    const adresses = await adressesGlobales(h);
    expect(adresses.some((a) => a.startsWith('2001:db8:aa::ff:fe00:'))).toBe(true);
  });

  it('sans le drapeau, aucun bail n\'est demande', async () => {
    const { h } = await labo({ managed: false });
    const adresses = await adressesGlobales(h);
    expect(adresses).not.toContain('2001:db8:aa::2/64');
    // Le garde-fou : l'autoconfiguration a bien eu lieu, donc l'absence
    // de bail n'est pas l'absence de tout.
    expect(adresses.some((a) => a.startsWith('2001:db8:aa::ff:fe00:'))).toBe(true);
  });

  it('le drapeau sans serveur ne casse rien', async () => {
    const { h } = await labo({ managed: true, serveur: false });
    const adresses = await adressesGlobales(h);
    expect(adresses).not.toContain('2001:db8:aa::2/64');
    expect(adresses.some((a) => a.startsWith('2001:db8:aa::ff:fe00:'))).toBe(true);
  });
});

describe('la demande ne se repete pas', () => {
  it('un second echange d\'annonces ne prend pas un second bail', async () => {
    // Une annonce arrive a chaque sollicitation et a chaque lien qui
    // monte : sans garde, l'hote redemanderait a chaque fois et le pool
    // se viderait tout seul.
    const { h } = await labo({ managed: true });
    await h.executeCommand('ip link set eth0 down');
    await h.executeCommand('ip link set eth0 up');
    const baux = (await adressesGlobales(h))
      .filter((a) => /^2001:db8:aa::\d+\/64$/.test(a));
    expect(baux).toEqual(['2001:db8:aa::2/64']);
  });
});

describe('le client repond toujours a la commande', () => {
  it('dhclient -6 continue de fonctionner et rend sa transcription', async () => {
    const { h } = await labo({ managed: false });
    const sortie = await h.executeCommand('dhclient -6 -v eth0');
    expect(sortie).toContain('DHCPv6 SOLICIT');
    expect(sortie).toContain('DHCPv6 REPLY of 2001:db8:aa::2');
  });
});
