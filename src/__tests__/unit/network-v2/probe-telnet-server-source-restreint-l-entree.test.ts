/*
 * `telnet server-source -i <interface>` etait accepte et ne restreignait
 * RIEN — pire : il s'ecrivait dans le champ de l'ACL du serveur.
 *
 * Mesure de depart, sur un AR1 ou GE0/0/0 porte 10.0.0.1 et LoopBack0
 * 1.1.1.1, apres `telnet server-source -i LoopBack0`, depuis 10.0.0.2 :
 *
 *   telnet server-source -i LoopBack0   accepte, sans un mot
 *   display current-configuration        la ligne MANQUE
 *   telnet 10.0.0.1                      la session S'OUVRE   <- par GE0/0/0
 *   telnet server-source -i LoopBack9    accepte aussi         <- n'existe pas
 *
 * L'AUTORITE EST HUAWEI (`telnet server-source`) : la commande « specifies
 * a source interface for the Telnet server, so that only authorized users
 * can log in » ; « after the source interface is specified, the system
 * only allows Telnet users to log in to the Telnet server through this
 * source interface, and Telnet users logging in through other interfaces
 * are denied » ; et les utilisateurs doivent joindre cette interface au
 * niveau 3. Se connecter « par » une interface, c'est viser son adresse.
 *
 * CE QUI N'EST PAS SOURCE, ET N'EST DONC PAS ACCEPTE. La forme classique
 * est `-i <interface>`. Une forme `-a <adresse>` seule n'est citee par
 * aucune page joignable d'ici (une syntaxe recente la place APRES
 * `physic-isolate -i`), donc elle est refusee plutot que rangee sans
 * effet.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire l'admission.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 3 des 7 cas tombent — l'entree par une autre interface, le rendu, et
 * les deux refus (interface inexistante, forme non sourcee), reunis dans
 * un meme cas. Les 4 autres sont nommes ici :
 *
 *  - TEMOINS DU LABORATOIRE, sans restriction : on entre par GE0/0/0 et
 *    par LoopBack0, des deux cotes — les deux adresses sont joignables,
 *    donc un refus ulterieur tient a la restriction et non au routage.
 *  - L'ENTREE PAR L'INTERFACE NOMMEE passe des deux cotes : avant parce
 *    que rien ne restreint, apres parce qu'elle est la bonne. Son voisin
 *    « par une autre, refuse » interdit le correctif paresseux « tout
 *    refuser ».
 *  - `undo telnet server-source` rouvre GE0/0/0, des deux cotes : avant a
 *    vide, apres parce que l'annulation retire vraiment la restriction.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const GE_IP = '10.0.0.1';
const LOOPBACK_IP = '1.1.1.1';
const HOST_IP = '10.0.0.2';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(...extra: string[]): Promise<{ ar1: HuaweiRouter; host: LinuxPC; answers: string[] }> {
  const ar1 = new HuaweiRouter('AR1');
  const host = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  new Cable('c1').connect(ar1.getPort('GE0/0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(host.getPort('eth0')!, sw.getPorts()[1]);

  for (const c of [
    'system-view',
    'interface GigabitEthernet 0/0/0', `ip address ${GE_IP} 24`, 'undo shutdown', 'quit',
    'interface LoopBack0', `ip address ${LOOPBACK_IP} 32`, 'quit',
    'telnet server enable',
    'aaa',
    'local-user bob password cipher Huawei@123',
    'local-user bob privilege level 15',
    'local-user bob service-type telnet',
    'quit',
    'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound telnet', 'quit',
  ]) await ar1.executeCommand(c);
  const answers: string[] = [];
  for (const c of extra) answers.push(await ar1.executeCommand(c));
  await ar1.executeCommand('return');

  await host.executeCommand(`ifconfig eth0 ${HOST_IP} netmask 255.255.255.0`);
  await host.executeCommand(`ip route add ${LOOPBACK_IP}/32 via ${GE_IP}`);
  return { ar1, host, answers };
}

const logsIn = async (host: LinuxPC, target: string): Promise<boolean> =>
  /<AR1>/.test(await host.executeCommand(`telnet ${target}`, 'bob\nHuawei@123\nquit\n'));

describe('sans restriction, les deux entrees sont ouvertes — les TEMOINS', () => {
  it('par GE0/0/0', async () => {
    const { host } = await lab();

    expect(await logsIn(host, GE_IP)).toBe(true);
  }, 30000);

  it('par LoopBack0', async () => {
    const { host } = await lab();

    expect(await logsIn(host, LOOPBACK_IP)).toBe(true);
  }, 30000);
});

describe('`telnet server-source -i LoopBack0` restreint l\'entree', () => {
  it('on entre par l\'interface nommee', async () => {
    const { host } = await lab('telnet server-source -i LoopBack0');

    expect(await logsIn(host, LOOPBACK_IP)).toBe(true);
  }, 30000);

  it('on n\'entre plus par une autre', async () => {
    const { host } = await lab('telnet server-source -i LoopBack0');

    expect(await logsIn(host, GE_IP)).toBe(false);
  }, 30000);

  it('`undo telnet server-source` rouvre l\'autre entree', async () => {
    const { host } = await lab('telnet server-source -i LoopBack0', 'undo telnet server-source');

    expect(await logsIn(host, GE_IP)).toBe(true);
  }, 30000);

  it('la configuration courante porte la ligne', async () => {
    const { ar1 } = await lab('telnet server-source -i LoopBack0');

    expect(await ar1.executeCommand('display current-configuration'))
      .toMatch(/telnet server-source -i LoopBack0/);
  }, 30000);
});

describe('ce qui ne peut pas etre honore est refuse', () => {
  it('une interface qui n\'existe pas, et une forme non sourcee', async () => {
    const { answers } = await lab('telnet server-source -i LoopBack9', 'telnet server-source -a 10.0.0.1');

    expect(answers[0]).toMatch(/^Error:/);
    expect(answers[1]).toMatch(/^Error:/);
  }, 30000);
});
