/**
 * Ce que la FortiGate emet appartient au VDOM de son interface, ou au
 * VDOM de gestion — jamais au VDOM ou se tient la session CLI.
 *
 * Mesure de depart (d299a1e0), sur une FortiGate a deux VDOM : root
 * possede port1 et une route par defaut vers un routeur ; customer
 * possede port2 et port3, avec une politique port2 → port3.
 * - Un ping de TTL 1 d'un hote de port2 vers port3 recevait « Time to
 *   live exceeded » de 10.1.0.1 quand l'administrateur etait dans
 *   customer, et RIEN quand il etait a la racine, ou la configuration
 *   le laisse : l'erreur ICMP etait routee par la table de root, donc
 *   vers son routeur par defaut.
 * - Le trap linkDown de port3 atteignait un NMS situe derriere le
 *   routeur de root quand l'administrateur etait a la racine, et se
 *   perdait quand il etait dans customer : l'emission UDP routait dans
 *   la table du VDOM de la CLI, puis se rabattait sur n'importe quelle
 *   interface directement connectee.
 * - Une requete SNMP venue d'un gestionnaire situe derriere un routeur,
 *   du cote de customer, restait sans reponse quand l'administrateur
 *   etait a la racine.
 * - Une negociation IKE ouverte par un pair situe derriere le routeur de
 *   customer restait sans reponse quand l'administrateur etait a la
 *   racine : IKE sortait par la table du VDOM de la CLI.
 * - Le bail DHCP d'une interface de customer ne posait sa route par
 *   defaut dans aucune table visible : elle entrait dans root, ou sa
 *   passerelle n'est pas joignable.
 *
 * Autorite : le guide d'administration FortiOS 7.6, « Virtual Domains »
 * — chaque VDOM a sa propre table de routage et ses propres politiques,
 * et le VDOM de gestion (root par defaut) porte le trafic de gestion
 * que la FortiGate emet elle-meme : SNMP, journaux, NTP, FortiGuard.
 * La reponse a une requete part du VDOM qui porte l'adresse interrogee ;
 * IKE part par l'interface de sa phase 1, donc dans le VDOM de celle-ci.
 *
 * Discrimination, mesuree sur le commit de base (d299a1e0) avec ce
 * fichier copie : 5 des 7 cas tombent. Passent des deux cotes les deux
 * TEMOINS, construits dans les memes laboratoires : l'erreur ICMP quand
 * l'administrateur est dans customer, et le trap quand il est a la
 * racine — ils prouvent que chaque laboratoire fonctionne, et que seul
 * le VDOM de la CLI change entre le temoin et le cas qui tombe.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import type { SnmpMessage } from '@/network/snmp/types';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<string[]> {
  const outputs: string[] = [];
  for (const command of commands) outputs.push(await device.executeCommand(command));
  return outputs;
}

const LINK_DOWN = '1.3.6.1.6.3.1.1.5.3';
const LINK_UP = '1.3.6.1.6.3.1.1.5.4';

async function host(name: string, address: string, gateway: string): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', name);
  await type(pc, [`sudo ip addr add ${address}/24 dev eth0`, 'sudo ip link set eth0 up',
    `sudo ip route add default via ${gateway}`]);
  return pc;
}

async function router(name: string, inside: string, outside: string): Promise<CiscoRouter> {
  const r = new CiscoRouter(name, 0, 0);
  await type(r, ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', `ip address ${inside} 255.255.255.0`, 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', `ip address ${outside} 255.255.255.0`, 'no shutdown', 'end']);
  return r;
}

function listen(nms: LinuxPC): string[] {
  const received: string[] = [];
  nms.udpBind(162, ({ udp }) => {
    const message = udp.payload as SnmpMessage | undefined;
    if (message?.type === 'snmp' && message.pduType !== 'trap-v1') {
      received.push(String(message.varBindings[1]?.value.value));
    }
  }, 'snmptrapd');
  return received;
}

async function twoVdoms() {
  const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const h2 = await host('H2', '10.1.0.2', '10.1.0.1');
  const h3 = await host('H3', '10.3.0.2', '10.3.0.1');
  const r1 = await router('R1', '192.168.1.254', '172.16.0.1');
  const nms = await host('NMS', '172.16.0.10', '172.16.0.1');
  new Cable('fgt-h2').connect(firewall.getPort('port2')!, h2.getPorts()[0]);
  const toH3 = new Cable('fgt-h3');
  toH3.connect(firewall.getPort('port3')!, h3.getPorts()[0]);
  new Cable('fgt-r1').connect(firewall.getPort('port1')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('r1-nms').connect(r1.getPort('GigabitEthernet0/1')!, nms.getPorts()[0]);
  await type(firewall, ['config system global', 'set vdom-mode multi-vdom', 'end',
    'config vdom', 'edit customer', 'next', 'end', 'config global',
    'config system interface',
    'edit port1', 'set ip 192.168.1.99 255.255.255.0', 'set allowaccess ping snmp', 'next',
    'edit port2', 'set vdom customer', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping snmp', 'next',
    'edit port3', 'set vdom customer', 'set ip 10.3.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    'config system snmp sysinfo', 'set status enable', 'end',
    'config system snmp community', 'edit 1', 'set name "public"',
    'config hosts', 'edit 1', 'set ip 172.16.0.10 255.255.255.255', 'next',
    'edit 2', 'set ip 10.9.0.10 255.255.255.255', 'next', 'end', 'next', 'end', 'end',
    'config vdom', 'edit root', 'config router static', 'edit 1', 'set gateway 192.168.1.254',
    'set device port1', 'next', 'end', 'next',
    'edit customer', 'config firewall policy', 'edit 1', 'set srcintf port2', 'set dstintf port3',
    'set srcaddr all', 'set dstaddr all', 'set action accept', 'set schedule always', 'set service ALL',
    'next', 'end', 'next', 'end']);
  return { firewall, h2, h3, toH3, nms, traps: listen(nms) };
}

describe('an ICMP error leaves by the VDOM of the interface it answers', () => {
  it('WITNESS: with the administrator in customer, a TTL-1 ping through customer gets Time to live exceeded', async () => {
    const { firewall, h2 } = await twoVdoms();
    await firewall.executeCommand('execute enter customer');
    expect(await h2.executeCommand('ping -c 1 -t 1 10.3.0.2')).toContain('From 10.1.0.1 icmp_seq=1 Time to live exceeded');
  });

  it('with the administrator at the root, the same ping gets the same answer', async () => {
    const { firewall, h2 } = await twoVdoms();
    expect(firewall.activeVdomName()).toBe('root');
    expect(await h2.executeCommand('ping -c 1 -t 1 10.3.0.2')).toContain('From 10.1.0.1 icmp_seq=1 Time to live exceeded');
  });
});

describe('the FortiGate sends its management traffic from the management VDOM', () => {
  it('WITNESS: with the administrator at the root, the NMS behind root\'s router receives linkUp of port3', async () => {
    const { firewall, h3, toH3, traps } = await twoVdoms();
    toH3.disconnect();
    traps.length = 0;
    toH3.connect(firewall.getPort('port3')!, h3.getPorts()[0]);
    expect(traps).toContain(LINK_UP);
  });

  it('with the administrator in customer, the same NMS still receives linkDown of port3', async () => {
    const { firewall, toH3, traps } = await twoVdoms();
    await firewall.executeCommand('execute enter customer');
    toH3.disconnect();
    expect(traps).toContain(LINK_DOWN);
  });

  it('a manager behind a router of customer is answered while the administrator is at the root', async () => {
    const { firewall } = await twoVdoms();
    const r2 = await router('R2', '10.1.0.254', '10.9.0.1');
    const manager = await host('MGR', '10.9.0.10', '10.9.0.1');
    const lan = new Cable('fgt-r2');
    lan.connect(firewall.getPort('port4')!, r2.getPort('GigabitEthernet0/0')!);
    new Cable('r2-mgr').connect(r2.getPort('GigabitEthernet0/1')!, manager.getPorts()[0]);
    await type(firewall, ['config global', 'config system interface', 'edit port4', 'set vdom customer',
      'set ip 10.1.0.253 255.255.255.0', 'set allowaccess ping snmp', 'next', 'end', 'end',
      'config vdom', 'edit customer', 'config router static', 'edit 1', 'set dst 10.9.0.0 255.255.255.0',
      'set gateway 10.1.0.254', 'set device port4', 'next', 'end', 'next', 'end']);
    expect(firewall.activeVdomName()).toBe('root');
    expect(await manager.executeCommand('snmpwalk -v2c -c public 10.1.0.253 1.3.6.1.2.1.1.5'))
      .toBe('iso.3.6.1.2.1.1.5.0 = STRING: "FGT"');
  });
});

describe('IKE leaves by its phase1 interface, in the VDOM of that interface', () => {
  it('a peer reached through customer\'s router brings the tunnel up while the administrator is at the root', async () => {
    const near = new FortiGate('firewall-fortinet', 'FGT-A', 0, 0);
    const far = new FortiGate('firewall-fortinet', 'FGT-B', 0, 0);
    const transit = await router('R1', '198.51.100.254', '203.0.113.254');
    new Cable('a-r1').connect(near.getPort('port2')!, transit.getPort('GigabitEthernet0/0')!);
    new Cable('r1-b').connect(transit.getPort('GigabitEthernet0/1')!, far.getPort('port2')!);
    const tunnel = (peer: string, local: string, remote: string) => [
      'config vpn ipsec phase1-interface', 'edit "to-peer"', 'set interface "port2"', 'set ike-version 2',
      `set remote-gw ${peer}`, 'set psksecret "SecretPartage2026"', 'set proposal aes256-sha256',
      'set dhgrp 14', 'next', 'end',
      'config vpn ipsec phase2-interface', 'edit "to-peer-p2"', 'set phase1name "to-peer"',
      `set src-subnet ${local} 255.255.255.0`, `set dst-subnet ${remote} 255.255.255.0`, 'next', 'end'];
    await type(near, ['config system global', 'set vdom-mode multi-vdom', 'end',
      'config vdom', 'edit customer', 'next', 'end', 'config global',
      'config system interface', 'edit port2', 'set vdom customer', 'set ip 198.51.100.1 255.255.255.0',
      'set allowaccess ping', 'next', 'end', 'end',
      'config vdom', 'edit customer', 'config router static', 'edit 1', 'set gateway 198.51.100.254',
      'set device port2', 'next', 'end', ...tunnel('203.0.113.2', '10.1.0.0', '192.168.2.0'), 'next', 'end']);
    await type(far, ['config system interface', 'edit port2', 'set ip 203.0.113.2 255.255.255.0',
      'set allowaccess ping', 'next', 'end',
      'config router static', 'edit 1', 'set gateway 203.0.113.254', 'set device port2', 'next', 'end',
      ...tunnel('198.51.100.1', '192.168.2.0', '10.1.0.0')]);
    expect(near.activeVdomName()).toBe('root');
    await far.executeCommand('execute vpn ipsec tunnel up to-peer');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(await far.executeCommand('get vpn ipsec tunnel summary'))
      .toMatch(/'to-peer' 198\.51\.100\.1:0\s+selectors\(total,up\): 1\/1/);
  });
});

describe('a DHCP lease belongs to the VDOM of its interface', () => {
  it('the default route learned on a customer interface is in customer\'s table, not in root\'s', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const isp = new CiscoRouter('ISP', 0, 0);
    new Cable('fgt-isp').connect(firewall.getPort('port4')!, isp.getPort('GigabitEthernet0/0')!);
    await type(isp, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 203.0.113.1 255.255.255.0', 'no shutdown', 'exit',
      'ip dhcp excluded-address 203.0.113.1 203.0.113.99',
      'ip dhcp pool WAN', 'network 203.0.113.0 255.255.255.0', 'default-router 203.0.113.1', 'end']);
    await type(firewall, ['config system global', 'set vdom-mode multi-vdom', 'end',
      'config vdom', 'edit customer', 'next', 'end', 'config global',
      'config system interface', 'edit port4', 'set vdom customer', 'set mode dhcp', 'next', 'end', 'end']);
    const [, customer] = await type(firewall, ['execute enter customer', 'get router info routing-table all']);
    const [, root] = await type(firewall, ['execute enter root', 'get router info routing-table all']);
    expect(customer).toMatch(/^S\*\s+0\.0\.0\.0\/0 \[\d+\/0\] via 203\.0\.113\.1, port4$/m);
    expect(root).not.toContain('203.0.113.1');
  });
});
