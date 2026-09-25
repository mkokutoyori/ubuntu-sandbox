/*
 * Le commutateur VRP acceptait `ssh server port`, `telnet server port` et
 * `telnet server acl` — et n'en appliquait aucun.
 *
 * Les lots precedents les ont rendus reels sur le ROUTEUR. Le commutateur
 * partage la meme dispatch, le meme gestionnaire, le meme rendu de
 * configuration : la commande y est donc acceptee, rangee et RENDUE. Mais
 * `Switch` a sa propre synchronisation d'ecoute, qui ecrit 22 et 23 en
 * dur, et sa propre admission Telnet, qui ne lit que la configuration de
 * ligne. Mesure de depart, sur un commutateur dont Vlanif1 porte
 * 10.0.3.2 :
 *
 *   telnet server port 2323     rendu dans la configuration
 *   telnet 10.0.3.2 2323        Connection refused      <- rien la
 *   telnet 10.0.3.2             la session S'OUVRE      <- sur 23
 *   ssh server port 2222        rendu dans la configuration
 *   ssh -p 2222 admin@…         Connection refused      <- rien la
 *   telnet server acl 2000      rendu dans la configuration
 *   telnet 10.0.3.2 (hors liste) la session S'OUVRE     <- porte ouverte
 *
 * La configuration du commutateur AFFIRME ce que son plan de donnees
 * dement : la regle 3 entre deux vues, et la regle 6 pour l'ACL, un
 * critere de securite qui echoue ouvert.
 *
 * L'AUTORITE est celle des lots du routeur, Huawei pour les trois
 * commandes — le port d'ecoute qu'elles deplacent, le defaut qu'`undo`
 * restaure, l'ACL qui refuse ce qu'elle ne permet pas — et l'exigence
 * d'uniformite : un meme mot, tape sur deux boitiers VRP, doit produire
 * le meme effet.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire `Switch`.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 5 des 7 cas tombent — les deux nouveaux ports, les deux anciens, et la
 * source hors de la liste. Les 2 autres sont les TEMOINS : sans rien
 * configurer, Telnet s'ouvre sur 23 et SSH sur 22, des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const SWITCH_IP = '10.0.3.2';
const HOST_IP = '10.0.3.10';
const OTHER_IP = '10.0.3.99';
const SECRET = 'Admin@123';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function settle(times = 14): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function lab(...extra: string[]): Promise<LinuxPC> {
  const sw = new HuaweiSwitch('switch-huawei', 'HW2', 8, 0, 0);
  const host = new LinuxPC('linux-pc', 'P4');
  host.getPort('eth0')!.configureIP(new IPAddress(HOST_IP), new SubnetMask('255.255.255.0'));
  new Cable('c4').connect(host.getPort('eth0')!, sw.getPorts()[0]);
  for (const c of [
    'system-view', 'sysname HW2',
    'interface Vlanif1', `ip address ${SWITCH_IP} 255.255.255.0`, 'undo shutdown', 'quit',
    'aaa', `local-user admin password cipher ${SECRET}`,
    'local-user admin service-type telnet ssh', 'local-user admin privilege level 15', 'quit',
    'rsa local-key-pair create', 'stelnet server enable',
    'user-interface vty 0 4', 'authentication-mode aaa', 'protocol inbound all', 'quit',
    ...extra,
    'quit',
  ]) await sw.executeCommand(c);
  await settle();
  return host;
}

const telnetOpens = async (host: LinuxPC, port?: number): Promise<boolean> =>
  /<HW2>/.test(await host.executeCommand(
    `telnet ${SWITCH_IP}${port ? ` ${port}` : ''}`, `admin\n${SECRET}\nquit\n`));

const sshOpens = async (host: LinuxPC, port?: number): Promise<boolean> =>
  /VRP|Huawei|Version/i.test(await host.executeCommand(
    `ssh ${port ? `-p ${port} ` : ''}admin@${SWITCH_IP} "display version"`, `${SECRET}\n`));

describe('sans rien configurer — les TEMOINS', () => {
  it('Telnet s\'ouvre sur 23', async () => {
    expect(await telnetOpens(await lab())).toBe(true);
  }, 30000);

  it('SSH s\'ouvre sur 22', async () => {
    expect(await sshOpens(await lab())).toBe(true);
  }, 30000);
});

describe('`telnet server port` deplace l\'ecoute du commutateur', () => {
  it('le nouveau port repond', async () => {
    expect(await telnetOpens(await lab('telnet server port 2323'), 2323)).toBe(true);
  }, 30000);

  it('et l\'ancien ne repond plus', async () => {
    expect(await telnetOpens(await lab('telnet server port 2323'))).toBe(false);
  }, 30000);
});

describe('`ssh server port` deplace l\'ecoute du commutateur', () => {
  it('le nouveau port repond', async () => {
    expect(await sshOpens(await lab('ssh server port 2222'), 2222)).toBe(true);
  }, 30000);

  it('et l\'ancien ne repond plus', async () => {
    expect(await sshOpens(await lab('ssh server port 2222'))).toBe(false);
  }, 30000);
});

describe('`telnet server acl` filtre sur le commutateur', () => {
  it('une source que la liste ne nomme pas est refusee', async () => {
    const host = await lab(
      'acl 2000', `rule 5 permit source ${OTHER_IP} 0`, 'quit', 'telnet server acl 2000');

    expect(await telnetOpens(host)).toBe(false);
  }, 30000);
});
