/*
 * La sonde du fil repondait « ouvert » a TOUTE destination IPv6.
 *
 * `wireReachOutcome` est l'autorite que les lots precedents ont donnee a
 * quatre clients `ssh` et aux deux entrees de `telnet` : c'est elle qui
 * dit si le pair a repondu SYN-ACK, un RST, un ICMP, ou rien. Elle
 * s'ouvre sur un garde :
 *
 *     if (IPAddress.tryParse(destIp) === null) return 'open';
 *
 * `IPAddress` est l'IPv4. Toute adresse IPv6 tombe donc dans ce `return`
 * et la sonde n'est jamais tiree. Mesure, sur un LAN ou le poste et le
 * serveur partagent `2001:db8::/64` :
 *
 *   wireReachOutcome(poste, '2001:db8::6', 22)   open   (sshd ecoute)
 *   wireReachOutcome(poste, '2001:db8::6', 23)   open   <- RIEN n'ecoute
 *   wireReachOutcome(poste, '10.0.10.6',   23)   refused
 *   apres `ip6tables -A INPUT -p tcp --dport 22 -j DROP`
 *   wireReachOutcome(poste, '2001:db8::6', 22)   open   <- le paquet est JETE
 *
 * La premiere ligne est juste par accident : « ouvert » y est la bonne
 * reponse, mais elle n'a pas ete mesuree. Les deux autres sont fausses,
 * et elles emportent avec elles tout ce que les lots precedents ont
 * bati : en IPv6, un `ssh` vers un pair dont le port est ferme ne peut
 * plus dire « Connection refused », un paquet jete ne peut plus dire
 * « Connection timed out », et surtout `telnet` ne BORNE plus rien — il
 * compose et attend le repli de retransmission, ce que le lot
 * precedent venait de fermer en IPv4.
 *
 * Rien ne manque en dessous : `TcpStack.scanProbe` passe par
 * `resolveEgress`, qui aiguille vers `resolveEgress6` des que la cible
 * est de la famille v6. La pile savait sonder ; c'est le garde du
 * dessus qui l'en empechait. Il devient `parseDialAddress`, la meme
 * lecture des deux familles que ce lot-ci a deja installee chez
 * `telnet`, chez `scp` et dans la marche du plan de cables.
 *
 * Ecrite a l'aveugle contre ce qu'un noyau repond : un SYN vers un port
 * ferme rend un RST quelle que soit la famille d'adresses, et un SYN
 * jete ne rend rien.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/terminal`) :
 * 3 des 9 cas tombent. Les 6 autres sont nommes ici, et aucun ne prouve
 * le mecanisme :
 *
 *  - TEMOIN DE LA SONDE : en IPv4 elle distinguait DEJA les trois
 *    issues. C'est lui qui designe la cause comme etant le garde de
 *    famille, et non la pile.
 *  - TEMOIN DU PORT OUVERT : `2001:db8::6` sur le 22 repond « open »
 *    des DEUX cotes. Avant, parce que la sonde ne partait pas ; apres,
 *    parce qu'un SYN-ACK est revenu. Il ne discrimine rien et c'est
 *    voulu — il est la pour que « la sonde voit » et « la sonde refuse
 *    tout » ne soient pas confondus par les cas qui tombent.
 *  - NON-REGRESSIONS : les trois issues IPv4, et un port v6 FERME vu
 *    depuis `telnet`. Ce dernier passait DEJA, et pour une raison qui
 *    merite d'etre dite : faute de sonde, le client composait, et le
 *    RST lui revenait quand meme. C'est ce qui rendait le defaut
 *    invisible tant qu'on ne regardait pas le DELAI ni le cas jete.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { wireReachOutcome } from '@/terminal/ssh/wireSshLogin';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { TerminalSession, KeyEvent } from '@/terminal/sessions/TerminalSession';

const SERVEUR_V4 = '10.0.10.6';
const SERVEUR_V6 = '2001:db8::6';
const POSTE_V4 = '10.0.10.9';
const POSTE_V6 = '2001:db8::9';

/** Un cas qui attend le repli de retransmission ne peut pas tenir ici. */
const BORNE_MS = 5000;

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

const tick = () => new Promise<void>((r) => setTimeout(r, 25));

interface Cmd { executeCommand(c: string): Promise<string> }

const runOn = (d: Cmd, cmds: readonly string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function saisir(s: TerminalSession, ligne: string): Promise<void> {
  s.foreground.setInput(ligne);
  s.foreground.setInputBuf(ligne);
  s.handleKey(key('Enter'));
  for (let i = 0; i < 12; i++) await tick();
}

const transcript = (s: TerminalSession): string => s.lines.map((l) => l.text).join('\n');

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const poste = new LinuxPC('linux-pc', 'PC', -150, 0);
  const serveur = new LinuxServer('linux-server', 'SRV', 150, 0);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 120);
  commutateur.powerOn(); poste.powerOn(); serveur.powerOn();

  new Cable('a').connect(poste.getPort('eth0')!, commutateur.getPort('eth0')!);
  new Cable('b').connect(serveur.getPorts()[0], commutateur.getPort('eth1')!);

  serveur.getPorts()[0].configureIP(new IPAddress(SERVEUR_V4), new SubnetMask('255.255.255.0'));
  await runOn(poste, [
    'ip link set eth0 up', `ip addr add ${POSTE_V4}/24 dev eth0`,
    `ip -6 addr add ${POSTE_V6}/64 dev eth0`,
  ]);
  await runOn(serveur, [
    'ip link set eth0 up', `ip -6 addr add ${SERVEUR_V6}/64 dev eth0`,
  ]);

  return { poste, serveur };
}

describe('la sonde distingue deja les trois issues en IPv4 — le TEMOIN', () => {
  it('un port ouvert', async () => {
    const { poste } = await laboratoire();

    expect(wireReachOutcome(poste, SERVEUR_V4, 22)).toBe('open');
  });

  it('un port ferme', async () => {
    const { poste } = await laboratoire();

    expect(wireReachOutcome(poste, SERVEUR_V4, 23)).toBe('refused');
  });

  it('un paquet jete', async () => {
    const { poste, serveur } = await laboratoire();
    await runOn(serveur, ['iptables -A INPUT -p tcp --dport 22 -j DROP']);

    expect(wireReachOutcome(poste, SERVEUR_V4, 22)).toBe('timeout');
  });
});

describe('elle les distingue aussi en IPv6', () => {
  it('un port ouvert repond « open » — le TEMOIN', async () => {
    const { poste } = await laboratoire();

    expect(wireReachOutcome(poste, SERVEUR_V6, 22)).toBe('open');
  });

  it('un port FERME repond « refused »', async () => {
    const { poste } = await laboratoire();

    expect(wireReachOutcome(poste, SERVEUR_V6, 23)).toBe('refused');
  });

  it('un paquet JETE repond « timeout »', async () => {
    const { poste, serveur } = await laboratoire();
    await runOn(serveur, ['ip6tables -A INPUT -p tcp --dport 22 -j DROP']);

    expect(wireReachOutcome(poste, SERVEUR_V6, 22)).toBe('timeout');
  });
});

describe('ce que la sonde aveugle coutait aux clients', () => {
  it('`telnet` BORNE une connexion v6 vaine', async () => {
    const { poste, serveur } = await laboratoire();
    await runOn(serveur, ['ip6tables -A INPUT -p tcp --dport 22 -j DROP']);
    const host = new LinuxTerminalSession('l', poste);
    await host.init?.();

    await saisir(host, `telnet ${SERVEUR_V6} 22`);

    expect(transcript(host)).toMatch(/Connection timed out/);
  }, BORNE_MS);

  it('et joint toujours un port v6 qui ECOUTE — le TEMOIN', async () => {
    const { poste } = await laboratoire();
    const host = new LinuxTerminalSession('l', poste);
    await host.init?.();

    await saisir(host, `telnet ${SERVEUR_V6} 22`);

    expect(transcript(host)).toMatch(/SSH-2\.0/);
  }, BORNE_MS);

  it('un port v6 FERME reste un refus', async () => {
    const { poste } = await laboratoire();
    const host = new LinuxTerminalSession('l', poste);
    await host.init?.();

    await saisir(host, `telnet ${SERVEUR_V6} 23`);

    expect(transcript(host)).toMatch(/Connection refused/);
  }, BORNE_MS);
});
