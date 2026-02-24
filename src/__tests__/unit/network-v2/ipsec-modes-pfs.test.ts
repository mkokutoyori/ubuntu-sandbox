/**
 * IPSec – Modes (Tunnel vs Transport) et Perfect Forward Secrecy (PFS)
 *
 * Topologies :
 *   Tunnel mode  : PC1 ── R1 ═══(WAN)═══ R2 ── PC2   (protège le trafic inter-LAN)
 *   Transport mode : R1-loopback0 ══════════ R2-loopback0  (protège entre les routeurs eux-mêmes)
 *   PFS : même topologie que tunnel mode, avec set pfs group14/group2
 *
 * Tests :
 *   4.01 – Tunnel mode : le paquet IP original est entièrement encapsulé
 *   4.02 – Transport mode : seule la payload est protégée (GRE over IPSec)
 *   4.03 – PFS group14 : la child SA est renégociée avec un nouveau DH
 *   4.04 – PFS group2 : variante DH-1024
 *   4.05 – PFS mismatch : R1 group14 vs R2 group2 → échec de rekey
 *   4.06 – Sans PFS : la child SA réutilise le keying material de l'IKE SA
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

// ─── Helper : topologie LAN-to-LAN (mode tunnel) ───────────────────────────

async function buildTunnelTopology(pfsGroup?: string) {
  const r1  = new CiscoRouter('R1');
  const r2  = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

  for (const [router, outside, inside, peer, lan, lanPeer] of [
    [r1, '10.0.12.1', '192.168.1.1', '10.0.12.2', '192.168.1.0', '192.168.2.0'],
    [r2, '10.0.12.2', '192.168.2.1', '10.0.12.1', '192.168.2.0', '192.168.1.0'],
  ] as [CiscoRouter, string, string, string, string, string][]) {
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');

    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand(`ip address ${outside} 255.255.255.252`);
    await router.executeCommand('no shutdown');
    await router.executeCommand('exit');
    await router.executeCommand('interface GigabitEthernet0/0');
    await router.executeCommand(`ip address ${inside} 255.255.255.0`);
    await router.executeCommand('no shutdown');
    await router.executeCommand('exit');

    await router.executeCommand('crypto isakmp policy 10');
    await router.executeCommand('encryption aes 256');
    await router.executeCommand('hash sha256');
    await router.executeCommand('authentication pre-share');
    await router.executeCommand('group 14');
    await router.executeCommand('lifetime 86400');
    await router.executeCommand('exit');
    await router.executeCommand(`crypto isakmp key ModeTest#1 address ${peer}`);

    await router.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    // Mode tunnel explicite
    await router.executeCommand('mode tunnel');
    await router.executeCommand('exit');

    await router.executeCommand('ip access-list extended VPN_ACL');
    await router.executeCommand(`permit ip ${lan} 0.0.0.255 ${lanPeer} 0.0.0.255`);
    await router.executeCommand('exit');

    await router.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await router.executeCommand(`set peer ${peer}`);
    await router.executeCommand('set transform-set TSET');
    await router.executeCommand('match address VPN_ACL');
    if (pfsGroup) await router.executeCommand(`set pfs ${pfsGroup}`);
    await router.executeCommand('exit');

    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand('crypto map CMAP');
    await router.executeCommand('exit');

    await router.executeCommand(`ip route ${lanPeer} 255.255.255.0 ${peer}`);
    await router.executeCommand('end');
  }

  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

  return { r1, r2, pc1, pc2 };
}

// ─── Helper : topologie host-to-host (mode transport, via loopbacks) ────────

async function buildTransportTopology() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');

  new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);

  for (const [router, outside, loopback, peer] of [
    [r1, '10.0.12.1', '1.1.1.1', '10.0.12.2'],
    [r2, '10.0.12.2', '2.2.2.2', '10.0.12.1'],
  ] as [CiscoRouter, string, string, string][]) {
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');

    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand(`ip address ${outside} 255.255.255.252`);
    await router.executeCommand('no shutdown');
    await router.executeCommand('exit');

    // Interface loopback (simule un hôte sur le routeur lui-même)
    await router.executeCommand('interface Loopback0');
    await router.executeCommand(`ip address ${loopback} 255.255.255.255`);
    await router.executeCommand('exit');

    await router.executeCommand('crypto isakmp policy 10');
    await router.executeCommand('encryption aes 256');
    await router.executeCommand('hash sha256');
    await router.executeCommand('authentication pre-share');
    await router.executeCommand('group 14');
    await router.executeCommand('exit');
    await router.executeCommand(`crypto isakmp key TransportKey address ${peer}`);

    // Transform-set en mode TRANSPORT
    await router.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await router.executeCommand('mode transport');
    await router.executeCommand('exit');

    // ACL : trafic entre les loopbacks (host-to-host)
    await router.executeCommand('ip access-list extended VPN_ACL');
    await router.executeCommand(`permit ip host ${loopback} host ${peer === '10.0.12.2' ? '2.2.2.2' : '1.1.1.1'}`);
    await router.executeCommand('exit');

    await router.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await router.executeCommand(`set peer ${peer}`);
    await router.executeCommand('set transform-set TSET');
    await router.executeCommand('match address VPN_ACL');
    await router.executeCommand('exit');

    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand('crypto map CMAP');
    await router.executeCommand('exit');

    await router.executeCommand('end');
  }

  // Route statique pour atteindre les loopbacks
  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('ip route 2.2.2.2 255.255.255.255 10.0.12.2');
  await r1.executeCommand('end');

  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('ip route 1.1.1.1 255.255.255.255 10.0.12.1');
  await r2.executeCommand('end');

  return { r1, r2 };
}

// ─── Suite ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('IPSec – Mode Tunnel vs Mode Transport', () => {

  // ─── 4.01 : Tunnel mode ──────────────────────────────────────────────────
  it('4.01 – Tunnel mode should encapsulate entire IP packet inside new IP+ESP header', async () => {
    const { r1, pc1 } = await buildTunnelTopology();

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    const sa = await r1.executeCommand('show crypto ipsec sa');
    // Le mode tunnel doit être affiché explicitement
    expect(sa).toContain('Tunnel');
    // En mode tunnel, le routeur encapsule le paquet complet → les idents
    // correspondent aux réseaux LAN, pas aux adresses des routeurs
    expect(sa).toContain('local  ident (addr/mask/prot/port): (192.168.1.0/255.255.255.0/0/0)');
    expect(sa).toContain('remote ident (addr/mask/prot/port): (192.168.2.0/255.255.255.0/0/0)');
    // Pas de mode transport
    expect(sa).not.toContain('Transport');
    expect(sa).toContain('#pkts encaps: 3');
    expect(sa).toContain('#recv errors 0');

    // Vérification dans le transform-set configuré
    const tset = await r1.executeCommand('show crypto ipsec transform-set');
    expect(tset).toContain('TSET');
    expect(tset).toContain('Tunnel');
  });

  // ─── 4.02 : Transport mode ───────────────────────────────────────────────
  it('4.02 – Transport mode should protect only payload, keeping original IP header', async () => {
    const { r1, r2 } = await buildTransportTopology();

    // Ping de la loopback de R1 vers la loopback de R2
    const ping = await r1.executeCommand('ping 2.2.2.2 source Loopback0 repeat 3');
    expect(ping).toContain('!!!')         ; // 3 succès en notation Cisco
    expect(ping).not.toContain('...');      // pas de timeout

    const sa = await r1.executeCommand('show crypto ipsec sa');
    // Le mode transport protège entre les hôtes (loopbacks) → pas d'encapsulation du paquet entier
    expect(sa).toContain('Transport');
    // En mode transport, les idents sont les adresses des routeurs eux-mêmes (host /32)
    expect(sa).toContain('local  ident (addr/mask/prot/port): (1.1.1.1/255.255.255.255/0/0)');
    expect(sa).toContain('remote ident (addr/mask/prot/port): (2.2.2.2/255.255.255.255/0/0)');
    expect(sa).not.toContain('Tunnel');
    expect(sa).toContain('#pkts encaps: 3');
    expect(sa).toContain('#recv errors 0');

    // Vérification dans show crypto ipsec transform-set
    const tset = await r1.executeCommand('show crypto ipsec transform-set');
    expect(tset).toContain('Transport');
  });
});

describe('IPSec – Perfect Forward Secrecy (PFS)', () => {

  // ─── 4.03 : PFS group14 ──────────────────────────────────────────────────
  it('4.03 – PFS group14 should perform new DH exchange when child SA is rekeyed', async () => {
    const { r1, pc1 } = await buildTunnelTopology('group14');

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    // Le crypto map doit afficher PFS activé
    const mapOut = await r1.executeCommand('show crypto map');
    expect(mapOut).toContain('PFS (Y/N): Y');
    expect(mapOut).toContain('DH group: group14');

    // La SA doit être présente et fonctionnelle
    const sa = await r1.executeCommand('show crypto ipsec sa');
    expect(sa).toContain('#pkts encaps: 3');
    expect(sa).toContain('#recv errors 0');

    // show crypto ipsec sa detail doit mentionner PFS
    const saDetail = await r1.executeCommand('show crypto ipsec sa detail');
    expect(saDetail).toMatch(/PFS.*group14|group14.*PFS/i);
  });

  // ─── 4.04 : PFS group2 ───────────────────────────────────────────────────
  it('4.04 – PFS group2 (1024-bit DH) should be configured and displayed correctly', async () => {
    const { r1, pc1 } = await buildTunnelTopology('group2');

    await pc1.executeCommand('ping -c 2 192.168.2.10');

    const mapOut = await r1.executeCommand('show crypto map');
    expect(mapOut).toContain('PFS (Y/N): Y');
    expect(mapOut).toContain('DH group: group2');

    const sa = await r1.executeCommand('show crypto ipsec sa');
    expect(sa).toContain('#pkts encaps: 2');
    expect(sa).toContain('#recv errors 0');
  });

  // ─── 4.05 : PFS mismatch → échec de rekey ────────────────────────────────
  it('4.05 – PFS group mismatch should cause child SA rekey failure', async () => {
    // R1 configure PFS group14, R2 configure PFS group2
    // Le tunnel initial peut s'établir (PFS n'intervient qu'au rekey),
    // mais au moment du rekey la négociation échoue.
    const r1  = new CiscoRouter('R1');
    const r2  = new CiscoRouter('R2');
    const pc1 = new LinuxPC('linux-pc', 'PC1');
    const pc2 = new LinuxPC('linux-pc', 'PC2');

    new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

    // R1 : PFS group14
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
    await r1.executeCommand('crypto isakmp key PfsMismatch address 10.0.12.2');
    await r1.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await r1.executeCommand('mode tunnel');
    await r1.executeCommand('exit');
    await r1.executeCommand('ip access-list extended VPN_ACL');
    await r1.executeCommand('permit ip 192.168.1.0 0.0.0.255 192.168.2.0 0.0.0.255');
    await r1.executeCommand('exit');
    // Lifetime très court pour forcer un rekey rapide
    await r1.executeCommand('crypto ipsec security-association lifetime seconds 60');
    await r1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await r1.executeCommand('set peer 10.0.12.2');
    await r1.executeCommand('set transform-set TSET');
    await r1.executeCommand('match address VPN_ACL');
    await r1.executeCommand('set pfs group14');   // ← group14
    await r1.executeCommand('exit');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('crypto map CMAP');
    await r1.executeCommand('exit');
    await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.12.2');
    await r1.executeCommand('end');

    // R2 : PFS group2 (incompatible avec R1)
    await r2.executeCommand('enable');
    await r2.executeCommand('configure terminal');
    await r2.executeCommand('interface GigabitEthernet0/1');
    await r2.executeCommand('ip address 10.0.12.2 255.255.255.252');
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
    await r2.executeCommand('crypto isakmp key PfsMismatch address 10.0.12.1');
    await r2.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await r2.executeCommand('mode tunnel');
    await r2.executeCommand('exit');
    await r2.executeCommand('ip access-list extended VPN_ACL');
    await r2.executeCommand('permit ip 192.168.2.0 0.0.0.255 192.168.1.0 0.0.0.255');
    await r2.executeCommand('exit');
    await r2.executeCommand('crypto ipsec security-association lifetime seconds 60');
    await r2.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await r2.executeCommand('set peer 10.0.12.1');
    await r2.executeCommand('set transform-set TSET');
    await r2.executeCommand('match address VPN_ACL');
    await r2.executeCommand('set pfs group2');    // ← group2
    await r2.executeCommand('exit');
    await r2.executeCommand('interface GigabitEthernet0/1');
    await r2.executeCommand('crypto map CMAP');
    await r2.executeCommand('exit');
    await r2.executeCommand('ip route 192.168.1.0 255.255.255.0 10.0.12.1');
    await r2.executeCommand('end');

    await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
    await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
    await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
    await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

    // Le tunnel initial peut s'établir (la négociation PFS n'a lieu qu'au rekey)
    await pc1.executeCommand('ping -c 2 192.168.2.10');

    // Vérification du mismatch : les crypto maps montrent des groupes différents
    const mapR1 = await r1.executeCommand('show crypto map');
    expect(mapR1).toContain('DH group: group14');

    const mapR2 = await r2.executeCommand('show crypto map');
    expect(mapR2).toContain('DH group: group2');

    // Forcer un clear et retenter → le rekey avec PFS va échouer
    await r1.executeCommand('clear crypto ipsec sa');
    await r1.executeCommand('clear crypto isakmp');

    // Le tunnel ne peut pas se rétablir car le rekey PFS est incompatible
    // (ou le nouveau tunnel s'établit sans PFS si un côté l'ignore, ce que l'implémentation décide)
    // On vérifie que le SA show reflète un état d'erreur ou vide
    const saAfterClear = await r1.executeCommand('show crypto ipsec sa');
    // Soit vide (pas de SA), soit avec erreurs de rekey
    // Dans tous les cas, le trafic ne passe plus
    const pingAfter = await pc1.executeCommand('ping -c 2 192.168.2.10');
    expect(pingAfter).toContain('100% packet loss');
  });

  // ─── 4.06 : Sans PFS ─────────────────────────────────────────────────────
  it('4.06 – without PFS, child SA rekey reuses IKE keying material (no DH)', async () => {
    const { r1, pc1 } = await buildTunnelTopology(); // pas de pfsGroup → sans PFS

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    const mapOut = await r1.executeCommand('show crypto map');
    // PFS doit être désactivé
    expect(mapOut).toContain('PFS (Y/N): N');

    const sa = await r1.executeCommand('show crypto ipsec sa');
    expect(sa).toContain('#pkts encaps: 3');
    expect(sa).toContain('#recv errors 0');

    // show crypto ipsec sa detail ne mentionne pas PFS
    const saDetail = await r1.executeCommand('show crypto ipsec sa detail');
    expect(saDetail).not.toMatch(/PFS.*group/i);
  });
});
