/*
 * `telnet server acl` etait accepte et ne filtrait RIEN.
 *
 * Le pire des trois cas de la regle 6 : un critere de SECURITE, accepte,
 * range, et jamais evalue. L'operateur qui restreint les sources
 * autorisees a se connecter en Telnet croit la porte fermee ; elle est
 * ouverte a tous.
 *
 * Mesure de depart, sur un AR1 ou l'ACL 2000 ne permet que 10.0.0.9 et
 * ou l'on tape `telnet server acl 2000`, puis ou 10.0.0.2 se connecte :
 *
 *   telnet server acl 2000          accepte, sans un mot
 *   display current-configuration   la ligne MANQUE
 *   telnet 10.0.0.1 (depuis .2)     la session S'OUVRE      <- porte ouverte
 *
 * L'AUTORITE EST HUAWEI (`telnet server acl`, et « Using an ACL to
 * Control Telnet Login Rights ») : « When a device functions as the
 * Telnet server, you can configure the ACL on the device to control the
 * login of the clients » ; « if the access control right for a network
 * segment is permit or deny, the access control right for the other
 * network segments is deny » ; et « if no rule is configured, the
 * incoming and outgoing calls are not restricted after the command
 * telnet server acl is run ». Les trois se mesurent ici.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire l'admission.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 3 des 7 cas tombent — la source hors de la liste, la source refusee
 * explicitement, et le rendu. Les 4 autres sont nommes ici :
 *
 *  - TEMOIN DU LABORATOIRE : sans ACL, la session s'ouvre des deux
 *    cotes. Sans lui, un refus pourrait venir d'un labo casse.
 *  - LA SOURCE PERMISE passe des deux cotes : avant parce que rien ne
 *    filtre, apres parce que la liste la permet. C'est son voisin « une
 *    autre source est refusee » qui distingue les deux etats — et c'est
 *    lui qui interdit le correctif paresseux « tout refuser ».
 *  - UNE LISTE SANS REGLE ne restreint rien, des deux cotes : c'est la
 *    phrase du constructeur, et le cas qu'un filtre trop zele
 *    casserait.
 *  - `undo telnet server acl` rouvre la porte, des deux cotes : avant a
 *    vide, apres parce que l'annulation retire vraiment le filtre.
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
const OTHER_IP = '10.0.0.9';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(...acl: string[]): Promise<{ ar1: HuaweiRouter; host: LinuxPC }> {
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
    'quit',
    ...acl,
    'return',
  ]) await ar1.executeCommand(c);

  await host.executeCommand(`ifconfig eth0 ${HOST_IP} netmask 255.255.255.0`);
  return { ar1, host };
}

const byTelnet = (host: LinuxPC): Promise<string> =>
  host.executeCommand(`telnet ${ROUTER_IP}`, 'bob\nHuawei@123\nquit\n');

const opened = (transcript: string): boolean => /<AR1>/.test(transcript);

describe('sans liste, la porte est ouverte — le TEMOIN', () => {
  it('la session s\'ouvre', async () => {
    const { host } = await lab();

    expect(opened(await byTelnet(host))).toBe(true);
  }, 30000);
});

describe('`telnet server acl` filtre les sources', () => {
  it('une source que la liste permet se connecte', async () => {
    const { host } = await lab(
      'acl 2000', `rule 5 permit source ${HOST_IP} 0`, 'quit', 'telnet server acl 2000');

    expect(opened(await byTelnet(host))).toBe(true);
  }, 30000);

  it('une source que la liste ne nomme pas est refusee', async () => {
    const { host } = await lab(
      'acl 2000', `rule 5 permit source ${OTHER_IP} 0`, 'quit', 'telnet server acl 2000');

    expect(opened(await byTelnet(host))).toBe(false);
  }, 30000);

  it('une source que la liste refuse est refusee', async () => {
    const { host } = await lab(
      'acl 2000', `rule 5 deny source ${HOST_IP} 0`, 'rule 10 permit', 'quit',
      'telnet server acl 2000');

    expect(opened(await byTelnet(host))).toBe(false);
  }, 30000);

  it('une liste sans regle ne restreint rien', async () => {
    const { host } = await lab('acl 2000', 'quit', 'telnet server acl 2000');

    expect(opened(await byTelnet(host))).toBe(true);
  }, 30000);

  it('`undo telnet server acl` rouvre la porte', async () => {
    const { host } = await lab(
      'acl 2000', `rule 5 permit source ${OTHER_IP} 0`, 'quit', 'telnet server acl 2000',
      'undo telnet server acl');

    expect(opened(await byTelnet(host))).toBe(true);
  }, 30000);
});

describe('la configuration dit ce qui filtre', () => {
  it('la configuration courante porte la ligne', async () => {
    const { ar1 } = await lab('acl 2000', 'quit', 'telnet server acl 2000');

    expect(await ar1.executeCommand('display current-configuration'))
      .toMatch(/telnet server acl 2000/);
  }, 30000);
});
