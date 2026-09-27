/**
 * Un paquet vit dans le VDOM de son interface : il n'atteint pas une
 * adresse d'un autre VDOM, emprunte les tunnels de son VDOM et se
 * synchronise en HA avec lui — quel que soit le VDOM de la CLI.
 *
 * Mesure de depart (c042776b), FortiGate a deux VDOM, root possedant
 * port1 (192.168.1.99) et customer port2 et port3 :
 * - un hote de customer qui pingue 192.168.1.99 recevait sa reponse :
 *   `destinedToSelf` reconnaissait l'adresse de n'importe quelle
 *   interface de la machine, et le paquet etait delivre localement a
 *   travers la frontiere des VDOM ;
 * - le trafic qui devait emprunter le tunnel IPsec de customer passait
 *   quand l'administrateur etait dans customer, et se perdait quand il
 *   etait a la racine : `forward` cherchait le tunnel parmi ceux du VDOM
 *   de la CLI, l'emission chiffree lisait sa table, et le dechiffrement
 *   ses tunnels ;
 * - un paquet IPv6 de transit etait juge par les politiques et suivi
 *   dans la table de sessions du VDOM de la CLI : une politique IPv6 de
 *   customer ne laissait rien passer tant que l'administrateur etait a
 *   la racine ;
 * - le portail d'authentification cherchait tout utilisateur dans root
 *   (`vdomOfAddress: () => 'root'`) : un utilisateur local de customer,
 *   se presentant depuis un hote de customer, etait « no-such-user » ;
 * - en HA, `session-pickup` n'exportait que les sessions du VDOM de la
 *   CLI : une session de customer ne parvenait pas au secondaire tant
 *   que l'administrateur du primaire etait a la racine.
 *
 * Autorite : guide d'administration FortiOS 7.6, « Virtual Domains » —
 * les VDOM partagent le boitier mais sont isoles : chacun a ses
 * interfaces, sa table de routage, ses politiques et ses VPN ; le trafic
 * ne passe de l'un a l'autre que par un lien inter-VDOM.
 *
 * Discrimination, mesuree sur le commit de base (c042776b) avec ce
 * fichier copie : 5 des 7 cas tombent. Passent des deux cotes les
 * TEMOINS, construits dans les memes laboratoires : l'hote de customer
 * joint l'interface de son propre VDOM, et le tunnel passe quand
 * l'administrateur est dans customer.
 */
import { describe, it, expect } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { makeFlowKey } from '@/network/devices/firewall/session/FlowKey';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<string[]> {
  const outputs: string[] = [];
  for (const command of commands) outputs.push(await device.executeCommand(command));
  return outputs;
}

async function host(name: string, address: string, gateway: string): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', name);
  await type(pc, [`sudo ip addr add ${address}/24 dev eth0`, 'sudo ip link set eth0 up',
    `sudo ip route add default via ${gateway}`]);
  return pc;
}

const MULTI_VDOM = ['config system global', 'set vdom-mode multi-vdom', 'end',
  'config vdom', 'edit customer', 'next', 'end'];

describe('an address of another VDOM is not delivered locally', () => {
  async function isolationLab(): Promise<LinuxPC> {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const client = await host('H3', '10.1.0.2', '10.1.0.1');
    new Cable('fgt-h3').connect(firewall.getPort('port3')!, client.getPorts()[0]);
    await type(firewall, [...MULTI_VDOM, 'config global', 'config system interface',
      'edit port1', 'set ip 192.168.1.99 255.255.255.0', 'set allowaccess ping', 'next',
      'edit port3', 'set vdom customer', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next',
      'end', 'end']);
    return client;
  }

  it('WITNESS: a host of customer reaches the address of its own VDOM', async () => {
    const client = await isolationLab();
    expect(await client.executeCommand('ping -c 1 10.1.0.1')).toContain('1 received');
  });

  it('a host of customer gets no answer from the address of root\'s port1', async () => {
    const client = await isolationLab();
    expect(await client.executeCommand('ping -c 1 192.168.1.99')).toContain('0 received');
  });
});

describe('a route-based tunnel belongs to its VDOM', () => {
  async function tunnelLab() {
    const near = new FortiGate('firewall-fortinet', 'FGT-A', 0, 0);
    const far = new FortiGate('firewall-fortinet', 'FGT-B', 0, 0);
    const client = await host('H3', '10.1.0.2', '10.1.0.1');
    const server = await host('HB', '192.168.2.10', '192.168.2.1');
    new Cable('h3').connect(near.getPort('port3')!, client.getPorts()[0]);
    new Cable('a-b').connect(near.getPort('port2')!, far.getPort('port2')!);
    new Cable('hb').connect(far.getPort('port3')!, server.getPorts()[0]);
    const tunnel = (peer: string, local: string, remote: string) => [
      'config vpn ipsec phase1-interface', 'edit "to-peer"', 'set interface "port2"', 'set ike-version 2',
      `set remote-gw ${peer}`, 'set psksecret "SecretPartage2026"', 'set proposal aes256-sha256',
      'set dhgrp 14', 'next', 'end',
      'config vpn ipsec phase2-interface', 'edit "to-peer-p2"', 'set phase1name "to-peer"',
      `set src-subnet ${local} 255.255.255.0`, `set dst-subnet ${remote} 255.255.255.0`, 'next', 'end',
      'config router static', 'edit 1', `set dst ${remote} 255.255.255.0`, 'set device to-peer', 'next', 'end',
      'config firewall policy',
      'edit 1', 'set srcintf port3', 'set dstintf to-peer', 'set srcaddr all', 'set dstaddr all',
      'set action accept', 'set schedule always', 'set service ALL', 'next',
      'edit 2', 'set srcintf to-peer', 'set dstintf port3', 'set srcaddr all', 'set dstaddr all',
      'set action accept', 'set schedule always', 'set service ALL', 'next', 'end'];
    await type(near, [...MULTI_VDOM, 'config global', 'config system interface',
      'edit port2', 'set vdom customer', 'set ip 203.0.113.1 255.255.255.0', 'set allowaccess ping', 'next',
      'edit port3', 'set vdom customer', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next',
      'end', 'end',
      'config vdom', 'edit customer', ...tunnel('203.0.113.2', '10.1.0.0', '192.168.2.0'), 'next', 'end']);
    await type(far, ['config system interface',
      'edit port2', 'set ip 203.0.113.2 255.255.255.0', 'set allowaccess ping', 'next',
      'edit port3', 'set ip 192.168.2.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
      ...tunnel('203.0.113.1', '192.168.2.0', '10.1.0.0')]);
    return { near, client };
  }

  it('WITNESS: with the administrator in customer, traffic crosses the tunnel', async () => {
    const { near, client } = await tunnelLab();
    await near.executeCommand('execute enter customer');
    expect(await client.executeCommand('ping -c 2 192.168.2.10')).toContain('2 received');
  });

  it('with the administrator at the root, the same traffic crosses the same tunnel', async () => {
    const { near, client } = await tunnelLab();
    expect(near.activeVdomName()).toBe('root');
    expect(await client.executeCommand('ping -c 2 192.168.2.10')).toContain('2 received');
  });
});

describe('an IPv6 packet is judged by the policies of its VDOM', () => {
  it('a customer policy lets IPv6 cross customer while the administrator is at the root', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const left = new LinuxPC('linux-pc', 'PCA');
    const right = new LinuxPC('linux-pc', 'PCB');
    new Cable('fgt-a').connect(firewall.getPort('port2')!, left.getPorts()[0]);
    new Cable('fgt-b').connect(firewall.getPort('port3')!, right.getPorts()[0]);
    await type(firewall, [...MULTI_VDOM, 'config global', 'config system interface',
      'edit "port2"', 'set vdom customer', 'config ipv6', 'set ip6-address 2001:db8:1::1/64',
      'set ip6-allowaccess ping', 'end', 'next',
      'edit "port3"', 'set vdom customer', 'config ipv6', 'set ip6-address 2001:db8:2::1/64',
      'set ip6-allowaccess ping', 'end', 'next', 'end', 'end',
      'config vdom', 'edit customer', 'config firewall policy', 'edit 1',
      'set srcintf "port2"', 'set dstintf "port3"', 'set srcaddr6 "all6"', 'set dstaddr6 "all6"',
      'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end', 'next', 'end']);
    await type(left, ['ip link set eth0 up', 'ip addr add 2001:db8:1::10/64 dev eth0',
      'ip route add default via 2001:db8:1::1']);
    await type(right, ['ip link set eth0 up', 'ip addr add 2001:db8:2::10/64 dev eth0',
      'ip route add default via 2001:db8:2::1']);
    expect(firewall.activeVdomName()).toBe('root');
    expect(await left.executeCommand('ping6 -c 2 2001:db8:2::10')).not.toMatch(/100% packet loss/);
  });
});

describe('the authentication portal serves the VDOM of its client', () => {
  it('a local user of customer authenticates from a host of customer, and is bound there', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    await type(firewall, [...MULTI_VDOM, 'config global', 'config system interface',
      'edit port3', 'set vdom customer', 'set ip 10.1.0.1 255.255.255.0', 'next', 'end', 'end',
      'config vdom', 'edit customer', 'config user local', 'edit "jdupont"', 'set type password',
      'set passwd "Secret2026!"', 'next', 'end', 'next', 'end']);
    const verdict = await firewall.getAuthPortal()
      .authenticate('10.1.0.2', { username: 'jdupont', password: 'Secret2026!' });
    expect(verdict.ok).toBe(true);
    expect(firewall.getIdentityTable('customer').lookup('10.1.0.2')?.user).toBe('jdupont');
  });
});

describe('HA session pickup carries each session in its VDOM', () => {
  function member(name: string, lan: string): { fw: FortiGate; sh: FortiShell } {
    const fw = new FortiGate('firewall-fortinet', name, 0, 0);
    const sh = new FortiShell(fw);
    for (const line of ['config system interface',
      'edit "port1"', `set ip ${lan} 255.255.255.0`, 'next', 'end',
      'config system ha', 'set group-name "cluster"', 'set group-id 10', 'set mode a-p',
      'set password "SecretHA"', 'set hbdev "port7" 50', `set priority ${name === 'FGT-A' ? 200 : 128}`,
      'set session-pickup enable', 'end', ...MULTI_VDOM]) sh.execute(line);
    return { fw, sh };
  }

  it('a session of customer reaches the customer table of the secondary', () => {
    const a = member('FGT-A', '192.168.1.1');
    const b = member('FGT-B', '192.168.1.2');
    new Cable('hb').connect(a.fw.getPort('port7')!, b.fw.getPort('port7')!);
    const beat = () => { for (let round = 0; round < 3; round++) { a.fw.getHa().tick(); b.fw.getHa().tick(); } };
    beat();
    a.fw.getSessionTable('customer').install(makeFlowKey('10.1.0.2', 44000, '198.51.100.9', 443, 6), {
      ingressZone: 'port3', egressZone: 'port2', ingressInterface: 'port3', egressInterface: 'port2',
      timeoutSec: 3600,
    });
    expect(a.fw.activeVdomName()).toBe('root');
    beat();
    expect(b.fw.getSessionTable('customer').view().count()).toBe(1);
    expect(b.fw.getSessionTable('root').view().count()).toBe(0);
  });
});
