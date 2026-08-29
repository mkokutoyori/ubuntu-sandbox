/**
 * `ipv6 route <prefixe> <interface>` installe une route, et le saut
 * suivant ABSENT vise la destination (BRD-Modele-TCP-IP.md phase 8,
 * lot 11).
 *
 * ── Ce que la mesure a trouve ───────────────────────────────────────
 *
 * La forme par INTERFACE SEULE — `ipv6 route 2001:DB8:5::/64
 * GigabitEthernet0/1`, syntaxe reelle d'IOS pour une route statique
 * directement attachee — etait acceptee SANS MESSAGE et n'installait
 * RIEN : `show ipv6 route` ne rendait que la route connectee. Son
 * equivalent IPv4 fonctionne depuis toujours.
 *
 * La cause est un `catch` qui avalait tout : `new IPv6Address(
 * 'GigabitEthernet0/1')` leve, et la branche de rattrapage rangeait la
 * ligne dans `_ipv6StaticRoutes`, un sac que RIEN ne lit pour acheminer.
 * Le meme `catch` avalait aussi un prefixe ou un saut suivant MALFORMES —
 * `ipv6 route 2001:DB8:7::/64 zorglub` etait accepte en silence, ce que
 * la regle du depot interdit : on ne range pas un critere qu'on
 * n'evalue pas.
 *
 * ── Pourquoi ce lot suit immediatement le precedent ─────────────────
 *
 * Le lot 10 a corrige le cinquieme site de `route.nextHop || destination`
 * et a constate que le jumeau IPv6 etait INATTEIGNABLE — precisement
 * parce qu'aucune commande ne savait installer une route sans saut
 * suivant. En rendant la commande vivante, ce lot rend le chemin v6
 * atteignable, et le cas ci-dessous verifie qu'il est JUSTE : la
 * sollicitation de voisin vise la DESTINATION.
 *
 * Elle l'est par construction plutot que par correctif : la route porte
 * `nextHop: null` — ce que `IPv6RouteEntry` admettait deja — et non
 * l'adresse non specifiee, si bien que l'idiome `route.nextHop ?? dstIp`
 * du plan de donnees rend la destination sans qu'on ait a le toucher.
 * C'est la difference avec le cote v4, ou `0.0.0.0` etait un OBJET donc
 * VRAI : ici l'absence est representee par une absence.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * QUATRE cas sur cinq tombent. Le TEMOIN est la forme par SAUT SUIVANT,
 * qui fonctionnait deja et doit continuer — sans lui, un correctif qui
 * casserait la forme ordinaire passerait cette sonde.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPv6Address } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function maquette() {
  const routeur = new CiscoRouter('R');
  const poste = new LinuxPC('PC');
  new Cable('c1').connect(routeur.getPort('GigabitEthernet0/1')!, poste.getPorts()[0]);
  for (const c of ['enable', 'configure terminal', 'ipv6 unicast-routing',
    'interface GigabitEthernet0/1', 'ipv6 address 2001:DB8:1::1/64', 'no shutdown', 'exit',
    'ipv6 route 2001:DB8:5::/64 GigabitEthernet0/1',
    'ipv6 route 2001:DB8:6::/64 2001:DB8:1::2', 'end']) {
    await routeur.executeCommand(c);
  }
  return { routeur, poste };
}

describe('une route IPv6 par interface existe', () => {
  it('la forme par INTERFACE paraît dans la table, SANS « via »', async () => {
    const { routeur } = await maquette();
    const table = await routeur.executeCommand('show ipv6 route');
    expect(table).toContain('S  2001:db8:5::/64 [1/0], GigabitEthernet0/1');
  });

  it('la sollicitation de voisin vise la DESTINATION, jamais ::', async () => {
    const { routeur, poste } = await maquette();
    const cibles: string[] = [];
    poste.getPorts()[0].attachTap(({ direction, frame }) => {
      const pkt = frame.payload as { type?: string; nextHeader?: number; payload?: unknown } | undefined;
      if (direction !== 'in' || pkt?.type !== 'ipv6' || pkt.nextHeader !== 58) return;
      const ndp = (pkt.payload as { ndp?: { targetAddress?: { toString(): string } } } | undefined)?.ndp;
      if (ndp?.targetAddress) cibles.push(String(ndp.targetAddress));
    });

    routeur.sendUdpDatagram6(new IPv6Address('2001:DB8:5::9'), 99, 88, 'x', 1);
    await new Promise((r) => setTimeout(r, 40));
    expect(cibles).toContain('2001:db8:5::9');
    expect(cibles).not.toContain('::');
  });

  it('un saut suivant MALFORME est refuse, pas range en silence', async () => {
    const { routeur } = await maquette();
    await routeur.executeCommand('configure terminal');
    const refus = await routeur.executeCommand('ipv6 route 2001:DB8:7::/64 zorglub');
    expect(refus).toContain('% Invalid next-hop address');
  });

  it('un PREFIXE malforme est refuse aussi', async () => {
    const { routeur } = await maquette();
    await routeur.executeCommand('configure terminal');
    const refus = await routeur.executeCommand('ipv6 route zorglub/64 2001:DB8:1::2');
    expect(refus).toContain('% Invalid prefix format');
  });

  it('TEMOIN : la forme par SAUT SUIVANT marche toujours', async () => {
    const { routeur } = await maquette();
    const table = await routeur.executeCommand('show ipv6 route');
    expect(table).toContain('S  2001:db8:6::/64 [1/0], via 2001:db8:1::2');
  });
});
