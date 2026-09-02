/**
 * `ip route add` sait poser une route IPv6.
 *
 * Mesure de depart, sur un poste Linux portant `2001:db8:1::10/64` :
 * `ip route add default via 2001:db8:1::1` repondait
 * « Error: 2001:db8:1::1 is not a valid IPv4 address. » et
 * `ip -6 route add 2001:db8:9::/64 via …` repondait
 * « Command "add" is unknown » — le sous-commandant v6 ne connaissait que
 * `show`. Tout `ip route` etait donc une commande v4, alors que la table
 * v6 existe, que `ip -6 route show` la rend, et que `ip addr add` pose
 * deja la route connectee du prefixe.
 *
 * La consequence n'etait pas l'inertie : elle etait MASQUEE. Un poste
 * cable a un routeur recevait sa route par defaut de l'annonce de
 * routeur, si bien qu'un laboratoire ecrivant `ip route add default via
 * <v6>` fonctionnait — par l'annonce, pas par la commande — et le refus
 * passait inapercu. C'est en coupant l'annonce sur un pare-feu, qui ne
 * doit annoncer que sur ordre, que le trou est apparu.
 *
 * La famille se DEDUIT de l'adresse quand `-4`/`-6` ne la nomme pas,
 * comme le vrai `ip`, donc les deux orthographes marchent.
 *
 * Discrimine par `git stash push` : 5 des 7 cas tombent. Les 2 autres
 * sont nommes ici — « une route v4 continue de fonctionner » est le
 * TEMOIN de non-regression, dont c'est l'objet de passer des deux cotes,
 * et « ip -6 route show rend la table » etait juste depuis toujours,
 * c'est meme ce qui rendait l'absence d'ecriture invisible.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function poste() {
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 0);
  new Cable('lan').connect(a.getPort('eth0')!, b.getPort('eth0')!);
  for (const c of ['ip link set eth0 up', 'ip addr add 2001:db8:1::10/64 dev eth0']) {
    await a.executeCommand(c);
  }
  for (const c of ['ip link set eth0 up', 'ip addr add 2001:db8:1::11/64 dev eth0']) {
    await b.executeCommand(c);
  }
  return { a, b };
}

describe('ip route et IPv6', () => {
  it('`ip route add default via <v6>` pose la route par defaut', async () => {
    const { a } = await poste();

    expect(await a.executeCommand('ip route add default via 2001:db8:1::1'))
      .not.toMatch(/Error|unknown/i);
    expect(await a.executeCommand('ip -6 route show'))
      .toContain('default via 2001:db8:1::1 dev eth0');
  });

  it('`ip -6 route add <prefixe> via <gw>` pose une route statique', async () => {
    const { a } = await poste();

    expect(await a.executeCommand('ip -6 route add 2001:db8:9::/64 via 2001:db8:1::11'))
      .not.toMatch(/Error|unknown/i);
    expect(await a.executeCommand('ip -6 route show'))
      .toContain('2001:db8:9::/64 via 2001:db8:1::11 dev eth0');
  });

  it('`ip -6 route del` la retire', async () => {
    const { a } = await poste();
    await a.executeCommand('ip -6 route add 2001:db8:9::/64 via 2001:db8:1::11');

    expect(await a.executeCommand('ip -6 route del 2001:db8:9::/64'))
      .not.toMatch(/Error|unknown|No such/i);
    expect(await a.executeCommand('ip -6 route show')).not.toContain('2001:db8:9::/64');
  });

  it('retirer une route absente est refuse', async () => {
    const { a } = await poste();

    expect(await a.executeCommand('ip -6 route del 2001:db8:9::/64'))
      .toContain('RTNETLINK answers: No such process');
  });

  it('une adresse malformee est refusee et ne pose rien', async () => {
    const { a } = await poste();

    expect(await a.executeCommand('ip route add default via 2001:db8:1::zz'))
      .toContain('is not a valid IPv6 address.');
    expect(await a.executeCommand('ip -6 route add zorglub via 2001:db8:1::1'))
      .toContain('is not a valid IPv6 prefix.');
    expect(await a.executeCommand('ip -6 route show')).not.toContain('default');
  });

  it('TEMOIN : une route v4 continue de fonctionner', async () => {
    const { a } = await poste();
    await a.executeCommand('ip addr add 192.168.1.10/24 dev eth0');

    expect(await a.executeCommand('ip route add default via 192.168.1.1'))
      .not.toMatch(/Error|unknown/i);
    expect(await a.executeCommand('ip route show')).toContain('default via 192.168.1.1');
  });

  it('TEMOIN : `ip -6 route show` rend la table connectee', async () => {
    const { a } = await poste();

    expect(await a.executeCommand('ip -6 route show'))
      .toContain('2001:db8:1::/64 dev eth0 proto kernel');
  });
});
