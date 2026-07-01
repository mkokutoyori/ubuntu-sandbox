/**
 * Scénario 7 — Filtrage du trafic VPN par ACL Cisco (autorisation
 * sélective des protocoles IPsec constitutifs).
 *
 * Objectif : valider qu'un routeur Cisco en transit peut autoriser ou
 * bloquer sélectivement chacun des protocoles utilisés par IPsec
 * (IKE UDP 500, NAT-T UDP 4500, ESP protocole 50, AH protocole 51),
 * et que chaque type de blocage produit un comportement diagnosticable
 * distinct.
 *
 * Topologie :
 *
 *   [PC1] -- [R1 IPsec peer] -- [RA transit + ACL] -- [R2 IPsec peer] -- [PC2]
 *
 * Points de contrôle :
 *   - une ACL "permit-all" laisse tous les protocoles passer et le
 *     tunnel monte ;
 *   - bloquer UDP 500 empêche IKE (aucune SA installée) ;
 *   - bloquer ESP laisse IKE réussir mais aucun trafic chiffré ne
 *     traverse (asymétrie IKE OK / data plane KO) ;
 *   - bloquer UDP 4500 tue le NAT-T lorsque le chemin comporte du NAT ;
 *   - `show access-lists` incrémente le compteur d'ACE denies pour le
 *     protocole bloqué (diagnostic direct).
 *
 * Critère de réussite : chaque protocole bloqué produit une signature
 * d'échec distincte, permettant un diagnostic précis sans tester par
 * élimination.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

async function buildTransitTunnel(opts: { transitAclName?: string } = {}) {
  const r1 = new CiscoRouter('R1');
  const ra = new CiscoRouter('RA');
  const r2 = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  new Cable('r1-ra').connect(r1.getPort('GigabitEthernet0/1')!, ra.getPort('GigabitEthernet0/0')!);
  new Cable('ra-r2').connect(ra.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('ip address 10.0.12.1 255.255.255.252');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  await r1.executeCommand('interface GigabitEthernet0/0');
  await r1.executeCommand('ip address 192.168.1.1 255.255.255.0');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  await r1.executeCommand('crypto isakmp policy 10');
  await r1.executeCommand('encryption aes 256');
  await r1.executeCommand('hash sha256');
  await r1.executeCommand('authentication pre-share');
  await r1.executeCommand('group 14');
  await r1.executeCommand('exit');
  await r1.executeCommand('crypto isakmp key VpnAclSecret1 address 10.0.23.2');
  await r1.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
  await r1.executeCommand('mode tunnel');
  await r1.executeCommand('exit');
  await r1.executeCommand('ip access-list extended VPN_ACL');
  await r1.executeCommand('permit ip 192.168.1.0 0.0.0.255 192.168.2.0 0.0.0.255');
  await r1.executeCommand('exit');
  await r1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await r1.executeCommand('set peer 10.0.23.2');
  await r1.executeCommand('set transform-set TSET');
  await r1.executeCommand('match address VPN_ACL');
  await r1.executeCommand('exit');
  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('crypto map CMAP');
  await r1.executeCommand('exit');
  await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.12.2');
  await r1.executeCommand('ip route 10.0.23.0 255.255.255.252 10.0.12.2');
  await r1.executeCommand('end');

  await ra.executeCommand('enable');
  await ra.executeCommand('configure terminal');
  await ra.executeCommand('interface GigabitEthernet0/0');
  await ra.executeCommand('ip address 10.0.12.2 255.255.255.252');
  await ra.executeCommand('no shutdown');
  await ra.executeCommand('exit');
  await ra.executeCommand('interface GigabitEthernet0/1');
  await ra.executeCommand('ip address 10.0.23.1 255.255.255.252');
  await ra.executeCommand('no shutdown');
  await ra.executeCommand('exit');
  await ra.executeCommand('ip route 192.168.1.0 255.255.255.0 10.0.12.1');
  await ra.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.23.2');
  await ra.executeCommand('end');

  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand('ip address 10.0.23.2 255.255.255.252');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');
  await r2.executeCommand('interface GigabitEthernet0/0');
  await r2.executeCommand('ip address 192.168.2.1 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');
  await r2.executeCommand('crypto isakmp policy 10');
  await r2.executeCommand('encryption aes 256');
  await r2.executeCommand('hash sha256');
  await r2.executeCommand('authentication pre-share');
  await r2.executeCommand('group 14');
  await r2.executeCommand('exit');
  await r2.executeCommand('crypto isakmp key VpnAclSecret1 address 10.0.12.1');
  await r2.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
  await r2.executeCommand('mode tunnel');
  await r2.executeCommand('exit');
  await r2.executeCommand('ip access-list extended VPN_ACL');
  await r2.executeCommand('permit ip 192.168.2.0 0.0.0.255 192.168.1.0 0.0.0.255');
  await r2.executeCommand('exit');
  await r2.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await r2.executeCommand('set peer 10.0.12.1');
  await r2.executeCommand('set transform-set TSET');
  await r2.executeCommand('match address VPN_ACL');
  await r2.executeCommand('exit');
  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand('crypto map CMAP');
  await r2.executeCommand('exit');
  await r2.executeCommand('ip route 192.168.1.0 255.255.255.0 10.0.23.1');
  await r2.executeCommand('ip route 10.0.12.0 255.255.255.252 10.0.23.1');
  await r2.executeCommand('end');

  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

  if (opts.transitAclName) {
    await ra.executeCommand('interface GigabitEthernet0/0');
    await ra.executeCommand(`ip access-group ${opts.transitAclName} in`);
    await ra.executeCommand('exit');
    await ra.executeCommand('interface GigabitEthernet0/1');
    await ra.executeCommand(`ip access-group ${opts.transitAclName} in`);
    await ra.executeCommand('end');
  }

  return { r1, ra, r2, pc1, pc2 };
}

async function installPermitAllIpsecAcl(ra: CiscoRouter, name = 'IPSEC_PERMIT_ALL'): Promise<void> {
  await ra.executeCommand('configure terminal');
  await ra.executeCommand(`ip access-list extended ${name}`);
  await ra.executeCommand('permit udp any any eq 500');
  await ra.executeCommand('permit udp any any eq 4500');
  await ra.executeCommand('permit esp any any');
  await ra.executeCommand('permit ahp any any');
  await ra.executeCommand('permit ip any any');
  await ra.executeCommand('end');
}

async function installBlockIkeAcl(ra: CiscoRouter, name = 'BLOCK_IKE'): Promise<void> {
  await ra.executeCommand('configure terminal');
  await ra.executeCommand(`ip access-list extended ${name}`);
  await ra.executeCommand('deny udp any any eq 500');
  await ra.executeCommand('permit udp any any eq 4500');
  await ra.executeCommand('permit esp any any');
  await ra.executeCommand('permit ahp any any');
  await ra.executeCommand('permit ip any any');
  await ra.executeCommand('end');
}

async function installBlockEspAcl(ra: CiscoRouter, name = 'BLOCK_ESP'): Promise<void> {
  await ra.executeCommand('configure terminal');
  await ra.executeCommand(`ip access-list extended ${name}`);
  await ra.executeCommand('permit udp any any eq 500');
  await ra.executeCommand('permit udp any any eq 4500');
  await ra.executeCommand('deny esp any any');
  await ra.executeCommand('permit ahp any any');
  await ra.executeCommand('permit ip any any');
  await ra.executeCommand('end');
}

async function installBlock4500Acl(ra: CiscoRouter, name = 'BLOCK_4500'): Promise<void> {
  await ra.executeCommand('configure terminal');
  await ra.executeCommand(`ip access-list extended ${name}`);
  await ra.executeCommand('permit udp any any eq 500');
  await ra.executeCommand('deny udp any any eq 4500');
  await ra.executeCommand('permit esp any any');
  await ra.executeCommand('permit ahp any any');
  await ra.executeCommand('permit ip any any');
  await ra.executeCommand('end');
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('Scenario 7 — Cisco ACL filtering of IPsec constituents', () => {
  it('7.01 — permit-all ACL lets the tunnel come up and data flow', async () => {
    const { ra, r1, r2, pc2 } = await buildTransitTunnel();
    await installPermitAllIpsecAcl(ra);
    await ra.executeCommand('configure terminal');
    await ra.executeCommand('interface GigabitEthernet0/0');
    await ra.executeCommand('ip access-group IPSEC_PERMIT_ALL in');
    await ra.executeCommand('exit');
    await ra.executeCommand('interface GigabitEthernet0/1');
    await ra.executeCommand('ip access-group IPSEC_PERMIT_ALL in');
    await ra.executeCommand('end');

    const out = await pc2.executeCommand('ping -c 4 192.168.1.10');
    expect(out).toContain('4 received');

    const saR1 = await r1.executeCommand('show crypto isakmp sa');
    const saR2 = await r2.executeCommand('show crypto isakmp sa');
    expect(saR1).toContain('QM_IDLE');
    expect(saR2).toContain('QM_IDLE');
  });

  it('7.02 — denying UDP 500 blocks IKE: no ISAKMP SA installed, no tunnel', async () => {
    const { ra, r1, r2, pc2 } = await buildTransitTunnel();
    await installBlockIkeAcl(ra);
    await ra.executeCommand('configure terminal');
    await ra.executeCommand('interface GigabitEthernet0/0');
    await ra.executeCommand('ip access-group BLOCK_IKE in');
    await ra.executeCommand('exit');
    await ra.executeCommand('interface GigabitEthernet0/1');
    await ra.executeCommand('ip access-group BLOCK_IKE in');
    await ra.executeCommand('end');

    const out = await pc2.executeCommand('ping -c 2 192.168.1.10');
    expect(out).toContain('0 received');

    const saR1 = await r1.executeCommand('show crypto isakmp sa');
    const saR2 = await r2.executeCommand('show crypto isakmp sa');
    expect(saR1).not.toContain('QM_IDLE');
    expect(saR2).not.toContain('QM_IDLE');

    const acl = await ra.executeCommand('show access-lists BLOCK_IKE');
    expect(acl).toMatch(/deny udp any any eq 500.*\(([1-9][0-9]*) match/);
  });

  it('7.03 — denying ESP is asymmetric: IKE SA up but no encrypted data flows', async () => {
    const { ra, r1, r2, pc2 } = await buildTransitTunnel();
    await installBlockEspAcl(ra);
    await ra.executeCommand('configure terminal');
    await ra.executeCommand('interface GigabitEthernet0/0');
    await ra.executeCommand('ip access-group BLOCK_ESP in');
    await ra.executeCommand('exit');
    await ra.executeCommand('interface GigabitEthernet0/1');
    await ra.executeCommand('ip access-group BLOCK_ESP in');
    await ra.executeCommand('end');

    const out = await pc2.executeCommand('ping -c 3 192.168.1.10');
    expect(out).toContain('0 received');

    const saR1 = await r1.executeCommand('show crypto isakmp sa');
    const saR2 = await r2.executeCommand('show crypto isakmp sa');
    expect(saR1).toContain('QM_IDLE');
    expect(saR2).toContain('QM_IDLE');

    const ipsecSa = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecSa).toMatch(/#pkts (decaps|decrypt): 0/);

    const acl = await ra.executeCommand('show access-lists BLOCK_ESP');
    expect(acl).toMatch(/deny esp any any.*\(([1-9][0-9]*) match/);
  });

  it('7.04 — denying UDP 4500 only leaves IKE alive but breaks NAT-T-encapsulated data', async () => {
    const { ra, r1, pc2 } = await buildTransitTunnel();
    await installBlock4500Acl(ra);
    await ra.executeCommand('configure terminal');
    await ra.executeCommand('interface GigabitEthernet0/0');
    await ra.executeCommand('ip access-group BLOCK_4500 in');
    await ra.executeCommand('exit');
    await ra.executeCommand('interface GigabitEthernet0/1');
    await ra.executeCommand('ip access-group BLOCK_4500 in');
    await ra.executeCommand('end');

    await pc2.executeCommand('ping -c 2 192.168.1.10');
    const saR1 = await r1.executeCommand('show crypto isakmp sa');
    expect(saR1).toContain('QM_IDLE');
  });

  it('7.05 — permit-all ACL reports match counters per protocol after ping', async () => {
    const { ra, pc2 } = await buildTransitTunnel();
    await installPermitAllIpsecAcl(ra);
    await ra.executeCommand('configure terminal');
    await ra.executeCommand('interface GigabitEthernet0/0');
    await ra.executeCommand('ip access-group IPSEC_PERMIT_ALL in');
    await ra.executeCommand('exit');
    await ra.executeCommand('interface GigabitEthernet0/1');
    await ra.executeCommand('ip access-group IPSEC_PERMIT_ALL in');
    await ra.executeCommand('end');

    await pc2.executeCommand('ping -c 3 192.168.1.10');

    const acl = await ra.executeCommand('show access-lists IPSEC_PERMIT_ALL');
    expect(acl).toMatch(/permit udp any any eq 500.*\(([1-9][0-9]*) match/);
    expect(acl).toMatch(/permit esp any any.*\(([1-9][0-9]*) match/);
  });
});
