/*
 * `telnet server port` etait accepte et n'allait NULLE PART.
 *
 * Le frere de `ssh server port`, ferme plus tot, et le meme defaut de la
 * regle 6 : la CLI dit oui, la ligne tombe dans le sac de chaines brutes
 * (`recordRaw('telnet', …)`), rien ne la rend, et `bindTelnetListener()`
 * ecrit `listen(23, …)` en dur.
 *
 * Mesure de depart, sur un AR1 ou l'on tape `telnet server port 2323` :
 *
 *   telnet server port 2323         accepte, sans un mot
 *   display current-configuration   la ligne MANQUE
 *   telnet 10.0.0.1                 la session S'OUVRE     <- sur 23
 *   telnet 10.0.0.1 2323            Connection refused     <- rien la
 *
 * UN AVEU. Sur le routeur, cette commande etait REFUSEE jusqu'au lot qui
 * a fait de `telnet server enable` un seul fait : la declaration litterale
 * du routeur, `telnet server enable`, ecartait la dispatch partagee pour
 * tout ce qui commencait par `telnet server`. En la retirant, ce lot a
 * laisse la dispatch avaler `telnet server port` comme le commutateur
 * l'avalait deja. La mesure ci-dessus est celle d'apres ; c'est un defaut
 * que j'ai rouvert sur une plateforme et qui existait sur l'autre.
 *
 * L'AUTORITE EST HUAWEI : la commande « configures the listening port
 * number of a Telnet server », le defaut est 23, `undo telnet server
 * port` le restaure, et « if a new port number is set, the Telnet server
 * terminates all established Telnet connections, and then uses the new
 * port number to listen to new requests ». Les trois premieres phrases se
 * mesurent ici.
 *
 * CE QUE JE N'AI PAS PU SOURCER, ET QUE JE N'INVENTE DONC PAS. La PLAGE
 * exacte du parametre : les deux domaines de documentation Huawei sont
 * bloques par le mandataire de sortie, et deux recherches ne la citent
 * pas. Pour `ssh server port` elle l'etait (22 ou 1025-65535) et elle est
 * appliquee ; ici la borne posee est celle du TRANSPORT — un port TCP
 * d'ecoute est un `PortNumber` (RFC 6335) autre que 0. Supposer 1025-65535
 * par analogie serait deviner une valeur de constructeur, ce que la regle
 * 8 refuse. La fermeture des sessions deja etablies, sourcee elle, n'est
 * pas mesuree ici : ce lot ne la porte pas.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire l'ecoute.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 4 des 6 cas tombent — le nouveau port, l'ancien, la borne, le rendu de
 * la configuration. Les 2 autres sont nommes ici :
 *
 *  - TEMOIN DU DEFAUT : sans rien configurer, la session s'ouvre sur 23
 *    des DEUX cotes. Sans lui, « le port suit la configuration » et
 *    « le serveur n'ecoute plus nulle part » seraient indiscernables.
 *  - `undo telnet server port` PASSE DES DEUX COTES, pour des raisons
 *    OPPOSEES : avant, a vide, le port n'ayant jamais bouge ; apres,
 *    parce que l'annulation ramene l'ecoute. Seul son voisin « l'ancien
 *    ne repond plus » separe les deux etats.
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

const ROUTER_IP = '10.0.0.1';
const HOST_IP = '10.0.0.2';
const CHOSEN_PORT = 2323;

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(): Promise<{ ar1: HuaweiRouter; host: LinuxPC }> {
  const ar1 = new HuaweiRouter('AR1');
  const host = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  new Cable('c1').connect(ar1.getPort('GE0/0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(host.getPort('eth0')!, sw.getPorts()[1]);

  for (const c of [
    'system-view',
    'interface GigabitEthernet 0/0/0',
    `ip address ${ROUTER_IP} 24`,
    'undo shutdown', 'quit',
    'telnet server enable',
    'aaa',
    'local-user bob password cipher Huawei@123',
    'local-user bob privilege level 15',
    'local-user bob service-type telnet',
    'quit',
    'user-interface vty 0 4',
    'authentication-mode aaa',
    'protocol inbound telnet',
    'quit', 'return',
  ]) await ar1.executeCommand(c);

  await host.executeCommand(`ifconfig eth0 ${HOST_IP} netmask 255.255.255.0`);
  return { ar1, host };
}

async function inSystemView(ar1: HuaweiRouter, ...commands: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of ['system-view', ...commands, 'return']) out.push(await ar1.executeCommand(c));
  return out.slice(1, -1);
}

const byTelnet = (host: LinuxPC, port?: number): Promise<string> =>
  host.executeCommand(
    `telnet ${ROUTER_IP}${port ? ` ${port}` : ''}`, 'bob\nHuawei@123\nquit\n');

describe('sans rien configurer, le serveur ecoute sur 23 — le TEMOIN', () => {
  it('la session s\'ouvre', async () => {
    const { host } = await lab();

    expect(await byTelnet(host)).not.toMatch(/refused|timed out/i);
  }, 30000);
});

describe('`telnet server port` deplace l\'ecoute', () => {
  it('le nouveau port repond', async () => {
    const { ar1, host } = await lab();
    await inSystemView(ar1, `telnet server port ${CHOSEN_PORT}`);

    expect(await byTelnet(host, CHOSEN_PORT)).not.toMatch(/refused|timed out/i);
  }, 30000);

  it('et l\'ancien ne repond plus', async () => {
    const { ar1, host } = await lab();
    await inSystemView(ar1, `telnet server port ${CHOSEN_PORT}`);

    expect(await byTelnet(host)).toMatch(/refused|timed out|No route/i);
  }, 30000);

  it('`undo telnet server port` ramene le service sur 23', async () => {
    const { ar1, host } = await lab();
    await inSystemView(ar1, `telnet server port ${CHOSEN_PORT}`, 'undo telnet server port');

    expect(await byTelnet(host)).not.toMatch(/refused|timed out/i);
  }, 30000);
});

describe('la borne et le rendu', () => {
  it('un port hors du transport est refuse', async () => {
    const { ar1 } = await lab();

    const [answer] = await inSystemView(ar1, 'telnet server port 70000');
    expect(answer).toMatch(/^Error:/);
  }, 30000);

  it('la configuration courante porte la ligne', async () => {
    const { ar1 } = await lab();
    await inSystemView(ar1, `telnet server port ${CHOSEN_PORT}`);

    expect(await ar1.executeCommand('display current-configuration'))
      .toMatch(new RegExp(`telnet server port ${CHOSEN_PORT}`));
  }, 30000);
});
