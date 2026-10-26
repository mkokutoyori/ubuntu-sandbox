/**
 * Mesure (Node, labo NAT statique du scenario Cisco 2 : srv-oracle 192.168.10.20 publie en 203.0.113.10 par `ip nat inside source static`, un hote `outside` en 203.0.113.2)
 * d'une connexion Oracle Net par l'adresse GLOBALE d'un NAT statique.
 *
 * `sqlplus system/oracle@203.0.113.10:1521/ORCL` depuis `outside` rendait « ORA-12545: Connect failed because target host or object does not exist » : le client retrouvait
 * la cible en cherchant l'adresse dans le registre des equipements (`findEquipmentByIp`) au lieu de TRAVERSER le reseau ; or aucun equipement ne porte l'adresse globale, la
 * traduction vit dans le routeur. C'est le raccourci que la regle 4 du depot interdit (un echange entre deux machines passe par les trames). Adresse inconnue du registre : le client
 * ouvre maintenant la connexion TCP sur le fil (le SYN franchit le routeur, qui le traduit), mene la poignee de main Oracle Net, puis demande a celui qui repond QUI il est
 * (appel Identify du listener, la reponse du service handler) et c'est cette reponse, non l'adresse, qui designe la base. L'adresse interne continue de marcher.
 *
 * Discrimine par `git stash push -- src/terminal src/network src/database` : 2 cas sur 4 tombent. Passent des deux cotes, TEMOINS : la connexion par l'adresse interne depuis le LAN, et le refus d'une adresse publique que personne ne traduit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getOracleDatabase } from '@/terminal/commands/database';

interface Lab {
  oracle: LinuxServer;
  outside: LinuxServer;
  inside: LinuxPC;
  router: CiscoRouter;
}

const ORACLE_IP = '192.168.10.20';
const ORACLE_PUBLIC_IP = '203.0.113.10';
const UNMAPPED_PUBLIC_IP = '203.0.113.99';

async function buildLab(): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('router', 0, 0);
  const oracle = new LinuxServer('linux-server', 'srv-oracle', 0, 0);
  const outside = new LinuxServer('linux-server', 'outside', 0, 0);
  const inside = new LinuxPC('linux-pc', 'pc-user', 0, 0);

  new Cable('a').connect(oracle.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('b').connect(inside.getPort('eth0')!, lanSw.getPorts()[1]);
  new Cable('c').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('d').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('e').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  oracle.getPorts()[0].configureIP(new IPAddress(ORACLE_IP), new SubnetMask('255.255.255.0'));
  inside.getPorts()[0].configureIP(new IPAddress('192.168.10.50'), new SubnetMask('255.255.255.0'));
  oracle.setDefaultGateway(new IPAddress('192.168.10.254'));
  inside.setDefaultGateway(new IPAddress('192.168.10.254'));
  outside.getPorts()[0].configureIP(new IPAddress('203.0.113.2'), new SubnetMask('255.255.255.252'));
  outside.setDefaultGateway(new IPAddress('203.0.113.1'));

  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.10.254 255.255.255.0', 'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 203.0.113.1 255.255.255.252', 'ip nat outside', 'no shutdown', 'exit',
    `ip nat inside source static ${ORACLE_IP} ${ORACLE_PUBLIC_IP}`,
    'ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1', 'end',
  ]) await router.executeCommand(cmd);

  getOracleDatabase(oracle.id);
  return { oracle, outside, inside, router };
}

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('Oracle Net a travers un NAT statique', () => {
  it('TEMOIN — depuis le LAN, l\'adresse interne marche', async () => {
    const { inside } = await buildLab();
    const out = String(await inside.executeCommand(`echo "SELECT 1 FROM dual;" | sqlplus -S system/oracle@${ORACLE_IP}:1521/ORCL`));
    expect(out).toContain('1 row selected.');
  });

  it('depuis l\'exterieur, l\'adresse globale du NAT statique marche', async () => {
    const { outside } = await buildLab();
    const out = String(await outside.executeCommand(`echo "SELECT 1 FROM dual;" | sqlplus -S system/oracle@${ORACLE_PUBLIC_IP}:1521/ORCL`));
    expect(out).not.toContain('ORA-12545');
    expect(out).toContain('1 row selected.');
  });

  it('la session passe par le routeur : le NAT compte la traduction', async () => {
    const { outside, router } = await buildLab();
    await outside.executeCommand(`echo "SELECT 1 FROM dual;" | sqlplus -S system/oracle@${ORACLE_PUBLIC_IP}:1521/ORCL`);
    const translations = await router.executeCommand('show ip nat translations');
    expect(translations).toContain(`${ORACLE_PUBLIC_IP}:1521`);
    expect(translations).toContain(`${ORACLE_IP}:1521`);
  });

  it('une adresse publique que personne ne traduit n\'aboutit pas', async () => {
    const { outside } = await buildLab();
    const out = String(await outside.executeCommand(`echo "SELECT 1 FROM dual;" | sqlplus -S system/oracle@${UNMAPPED_PUBLIC_IP}:1521/ORCL`));
    expect(out).toMatch(/ORA-12170|ORA-12541|ORA-12545/);
    expect(out).not.toContain('1 row selected.');
  });
});
