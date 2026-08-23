/**
 * IPsec : le repondeur RETRECIT les selecteurs au lieu de tout refuser.
 *
 * RFC 7296 §2.9 : quand l'initiateur propose des selecteurs plus larges
 * que ce que le repondeur couvre, celui-ci repond avec l'INTERSECTION et
 * l'enfant s'etablit dessus. Ce depot n'acceptait que le cas MIROIR
 * exact — la fonction s'appelait pourtant `selectorsNarrow` — et refusait
 * tout le reste par `TS_UNACCEPTABLE`, y compris le cas ou l'un des deux
 * ensembles CONTIENT l'autre.
 *
 * Deux moities, et la seconde n'est pas cosmetique : sans elle les deux
 * bouts monteraient des selecteurs DIFFERENTS. Le repondeur pose
 * l'intersection sur sa propre SA, et la renvoie dans l'acceptation
 * (`narrowedSelectors`, vue depuis l'autre bout) ; l'initiateur installe
 * ce qu'on lui a rendu plutot que ce qu'il avait demande.
 *
 * L'intersection de deux prefixes est le plus SPECIFIQUE des deux quand
 * l'un contient l'autre, et vide sinon — ce qui est exact pour des
 * selecteurs exprimes en adresse + masque generique, la seule forme que
 * ce moteur porte. Le refus subsiste donc, mais pour la seule raison qui
 * le justifie : deux ensembles disjoints.
 *
 * **Une troisieme moitie, trouvee en mesurant** : l'offre ne portait PAS
 * les selecteurs de l'initiateur. `entry.trafficSelectors` etait lu
 * directement alors que la voie normale — `match address <acl>` — les
 * derive de l'ACL par `selectorsForEntry`, jamais appelee la. Le
 * repondeur n'avait donc rien a comparer et posait toujours les SIENS :
 * aucune negociation de selecteurs n'etait possible, et les deux bouts
 * pouvaient monter des selecteurs differents en silence. Sans ce
 * correctif, le retrecissement n'aurait rien eu a retrecir.
 *
 * Discrimine par `git stash` de `IPSecEngine.ts` et `IPSecTypes.ts` : 3
 * des 5 cas tombent. Les 2 qui passent des deux cotes sont nommes ici
 * plutot que laisses a decouvrir, et le second est une COINCIDENCE qu'il
 * faut connaitre : le TEMOIN miroir, qui montait deja et sans lequel
 * « l'enfant monte » ne prouverait rien ; et « un sur-ensemble propose
 * monte sur l'intersection », qui passait avant parce que le repondeur
 * posait ses propres selecteurs et que ceux-ci SE TROUVAIENT etre
 * l'intersection. C'est le cas « les DEUX bouts retiennent les MEMES
 * selecteurs » qui distingue les deux situations, et c'est pour cela
 * qu'il existe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

interface Cote {
  wanIp: string;
  peerWan: string;
  lanIp: string;
  /** Ce que CE routeur declare proteger : `<local> <wc> <distant> <wc>`. */
  regle: string;
}

async function configurer(router: CiscoRouter, cote: Cote, psk: string): Promise<void> {
  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/1', `ip address ${cote.wanIp} 255.255.255.252`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/0', `ip address ${cote.lanIp} 255.255.255.0`, 'no shutdown', 'exit',
    'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256',
    'authentication pre-share', 'group 14', 'exit',
    `crypto isakmp key ${psk} address ${cote.peerWan}`,
    'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
    'ip access-list extended VPN', `permit ip ${cote.regle}`, 'exit',
    'crypto map CMAP 10 ipsec-isakmp',
    `set peer ${cote.peerWan}`, 'set transform-set TSET', 'match address VPN', 'exit',
    'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit',
    'end',
  ]) await router.executeCommand(cmd);
}

async function labo(regleR1: string, regleR2: string) {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');
  new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);
  const psk = 'RetrecissementSecret';
  await configurer(r1, {
    wanIp: '10.0.12.1', peerWan: '10.0.12.2', lanIp: '10.1.0.1', regle: regleR1,
  }, psk);
  await configurer(r2, {
    wanIp: '10.0.12.2', peerWan: '10.0.12.1', lanIp: '192.168.2.1', regle: regleR2,
  }, psk);
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.12.2');
  await r1.executeCommand('end');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('ip route 10.1.0.0 255.255.0.0 10.0.12.1');
  await r2.executeCommand('end');
  await pc1.executeCommand('sudo ip addr add 10.1.0.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 10.1.0.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');
  return { r1, r2, pc1, pc2 };
}

/** La ligne `Traffic selectors:` que rend `show crypto ipsec sa detail`. */
function selecteursRendus(vue: string): string[] {
  return vue.split('\n')
    .filter(l => l.includes('Traffic selectors:'))
    .map(l => l.trim());
}

async function negocier(l: Awaited<ReturnType<typeof labo>>) {
  const ping = await pingOnSimulatedClock(l.pc1, 'ping -c 3 192.168.2.10');
  return {
    ping,
    surR1: selecteursRendus(await l.r1.executeCommand('show crypto ipsec sa detail')),
    surR2: selecteursRendus(await l.r2.executeCommand('show crypto ipsec sa detail')),
  };
}

describe('IPsec : RFC 7296 §2.9 — le repondeur rend l intersection', () => {
  it('TEMOIN — deux selecteurs miroirs montaient deja', async () => {
    const l = await labo(
      '10.1.0.0 0.0.255.255 192.168.2.0 0.0.0.255',
      '192.168.2.0 0.0.0.255 10.1.0.0 0.0.255.255');

    const { ping, surR1, surR2 } = await negocier(l);

    expect(ping).toMatch(/, 0% packet loss/);
    expect(surR1).toContain(
      'Traffic selectors: src=10.1.0.0/0.0.255.255 dst=192.168.2.0/0.0.0.255 proto=any');
    expect(surR2.length).toBeGreaterThan(0);
  });

  it('un sur-ensemble propose monte sur l intersection', async () => {
    const l = await labo(
      '10.0.0.0 0.255.255.255 192.168.2.0 0.0.0.255',
      '192.168.2.0 0.0.0.255 10.1.0.0 0.0.255.255');

    const { ping, surR2 } = await negocier(l);

    expect(ping).toMatch(/, 0% packet loss/);
    expect(surR2).toContain(
      'Traffic selectors: src=192.168.2.0/0.0.0.255 dst=10.1.0.0/0.0.255.255 proto=any');
  });

  it('les DEUX bouts retiennent les MEMES selecteurs', async () => {
    const l = await labo(
      '10.0.0.0 0.255.255.255 192.168.2.0 0.0.0.255',
      '192.168.2.0 0.0.0.255 10.1.0.0 0.0.255.255');

    const { surR1, surR2 } = await negocier(l);

    expect(surR1).toContain(
      'Traffic selectors: src=10.1.0.0/0.0.255.255 dst=192.168.2.0/0.0.0.255 proto=any');
    expect(surR2).toContain(
      'Traffic selectors: src=192.168.2.0/0.0.0.255 dst=10.1.0.0/0.0.255.255 proto=any');
  });

  it('le retrecissement joue aussi quand c est le REPONDEUR qui est large', async () => {
    const l = await labo(
      '10.1.0.0 0.0.255.255 192.168.2.0 0.0.0.255',
      '192.168.2.0 0.0.0.255 10.0.0.0 0.255.255.255');

    const { ping, surR1, surR2 } = await negocier(l);

    expect(ping).toMatch(/, 0% packet loss/);
    expect(surR1).toContain(
      'Traffic selectors: src=10.1.0.0/0.0.255.255 dst=192.168.2.0/0.0.0.255 proto=any');
    expect(surR2).toContain(
      'Traffic selectors: src=192.168.2.0/0.0.0.255 dst=10.1.0.0/0.0.255.255 proto=any');
  });

  it('deux ensembles DISJOINTS restent refuses', async () => {
    const l = await labo(
      '10.1.0.0 0.0.255.255 192.168.2.0 0.0.0.255',
      '192.168.2.0 0.0.0.255 172.16.0.0 0.0.255.255');

    const { ping, surR1, surR2 } = await negocier(l);

    expect(ping).toMatch(/, 100% packet loss/);
    expect(surR1).toHaveLength(0);
    expect(surR2).toHaveLength(0);
  });
});
