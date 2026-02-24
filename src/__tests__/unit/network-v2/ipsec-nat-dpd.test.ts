/**
 * IPSec – NAT Traversal (NAT-T) et Dead Peer Detection (DPD)
 *
 * NAT-T (RFC 3947/3948) :
 *   Lorsqu'un routeur IPSec est derrière un NAT, les paquets ESP (protocole 50)
 *   ne peuvent pas traverser un NAT standard. NAT-T détecte la présence d'un NAT
 *   pendant la négociation IKE et encapsule les paquets ESP dans UDP 4500.
 *
 * Topologie NAT-T :
 *   [PC1 192.168.1.10] ── [R1 Gi0/1:203.0.113.2/30] ──── [NAT 203.0.113.1 | 172.16.0.1] ── [R2 Gi0/1:172.16.0.2/30]
 *   R1 est côté public, R2 est derrière le NAT (MASQUERADE sur eth0 du NATRouter)
 *   UDP 500 et UDP 4500 sont forwardés du NAT vers R2.
 *
 * DPD (RFC 3706) :
 *   Envoie des messages R-U-THERE périodiques à l'autre pair.
 *   Si le pair ne répond pas dans le délai, ses SAs sont effacées.
 *
 * Topologie DPD :
 *   Même topologie simple que les tests IKEv1 PSK.
 *
 * Tests :
 *   5.01 – NAT-T : détection du NAT pendant IKE, encapsulation ESP-in-UDP
 *   5.02 – NAT-T : port UDP 4500 utilisé après détection du NAT
 *   5.03 – NAT-T keepalive : paquets UDP 4500 envoyés périodiquement pour maintenir les entrées NAT
 *   5.04 – DPD periodic : R1 détecte la panne de R2 et efface les SAs
 *   5.05 – DPD on-demand : DPD déclenché uniquement lors du trafic
 *   5.06 – DPD récupération : le tunnel se rétablit quand le peer redevient joignable
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

// ─── Helper : topologie NAT-T ───────────────────────────────────────────────

async function buildNATTopology() {
  const r1        = new CiscoRouter('R1');        // côté public
  const r2        = new CiscoRouter('R2');        // derrière le NAT
  const natRouter = new LinuxPC('linux-pc', 'NAT');
  const pc1       = new LinuxPC('linux-pc', 'PC1');
  const pc2       = new LinuxPC('linux-pc', 'PC2');

  // ── Câblage ─────────────────────────────────────────────────────────────
  // R1 Gi0/1 ↔ NAT eth0 (interface publique du NAT)
  new Cable('r1-nat').connect(r1.getPort('GigabitEthernet0/1')!, natRouter.getPort('eth0')!);
  // NAT eth1 ↔ R2 Gi0/1 (interface privée du NAT)
  new Cable('nat-r2').connect(natRouter.getPort('eth1')!, r2.getPort('GigabitEthernet0/1')!);
  // PC1 ↔ R1 Gi0/0
  new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  // PC2 ↔ R2 Gi0/0
  new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

  // ── Configuration du routeur NAT (Linux) ─────────────────────────────────
  // Interface publique (vers R1) : 203.0.113.1/30
  await natRouter.executeCommand('sudo ip addr add 203.0.113.1/30 dev eth0');
  // Interface privée (vers R2) : 172.16.0.1/30
  await natRouter.executeCommand('sudo ip addr add 172.16.0.1/30 dev eth1');
  // Activation du forwarding IP
  await natRouter.executeCommand('sudo sysctl -w net.ipv4.ip_forward=1');
  // Masquerade sur l'interface publique (NAT pour tout ce qui sort)
  await natRouter.executeCommand('sudo iptables -t nat -A POSTROUTING -o eth0 -j MASQUERADE');
  // DNAT : forwarder UDP 500 (IKE) vers R2
  await natRouter.executeCommand(
    'sudo iptables -t nat -A PREROUTING -i eth0 -p udp --dport 500 -j DNAT --to-destination 172.16.0.2:500',
  );
  // DNAT : forwarder UDP 4500 (NAT-T / ESP encapsulé) vers R2
  await natRouter.executeCommand(
    'sudo iptables -t nat -A PREROUTING -i eth0 -p udp --dport 4500 -j DNAT --to-destination 172.16.0.2:4500',
  );

  // ── Configuration R1 (côté public, IP publique 203.0.113.2) ──────────────
  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');

  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('ip address 203.0.113.2 255.255.255.252');
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
  // Le peer de R1 est l'adresse publique du NAT (203.0.113.1)
  await r1.executeCommand('crypto isakmp key NatTSecret1 address 203.0.113.1');
  // NAT-T activé par défaut sur IOS (crypto isakmp nat keepalive)
  await r1.executeCommand('crypto isakmp nat keepalive 20');

  await r1.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
  await r1.executeCommand('mode tunnel');
  await r1.executeCommand('exit');

  await r1.executeCommand('ip access-list extended VPN_ACL');
  await r1.executeCommand('permit ip 192.168.1.0 0.0.0.255 192.168.2.0 0.0.0.255');
  await r1.executeCommand('exit');

  await r1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await r1.executeCommand('set peer 203.0.113.1');        // adresse publique du NAT
  await r1.executeCommand('set transform-set TSET');
  await r1.executeCommand('match address VPN_ACL');
  await r1.executeCommand('exit');

  await r1.executeCommand('interface GigabitEthernet0/1');
  await r1.executeCommand('crypto map CMAP');
  await r1.executeCommand('exit');

  await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 203.0.113.1');
  await r1.executeCommand('end');

  // ── Configuration R2 (derrière le NAT, IP privée 172.16.0.2) ─────────────
  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');

  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand('ip address 172.16.0.2 255.255.255.252');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');
  await r2.executeCommand('interface GigabitEthernet0/0');
  await r2.executeCommand('ip address 192.168.2.1 255.255.255.0');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');

  // Route par défaut via le NAT
  await r2.executeCommand('ip route 0.0.0.0 0.0.0.0 172.16.0.1');

  await r2.executeCommand('crypto isakmp policy 10');
  await r2.executeCommand('encryption aes 256');
  await r2.executeCommand('hash sha256');
  await r2.executeCommand('authentication pre-share');
  await r2.executeCommand('group 14');
  await r2.executeCommand('exit');
  // Le peer de R2 est l'IP publique de R1 (203.0.113.2)
  await r2.executeCommand('crypto isakmp key NatTSecret1 address 203.0.113.2');
  await r2.executeCommand('crypto isakmp nat keepalive 20');

  await r2.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
  await r2.executeCommand('mode tunnel');
  await r2.executeCommand('exit');

  await r2.executeCommand('ip access-list extended VPN_ACL');
  await r2.executeCommand('permit ip 192.168.2.0 0.0.0.255 192.168.1.0 0.0.0.255');
  await r2.executeCommand('exit');

  await r2.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await r2.executeCommand('set peer 203.0.113.2');       // IP publique de R1
  await r2.executeCommand('set transform-set TSET');
  await r2.executeCommand('match address VPN_ACL');
  await r2.executeCommand('exit');

  await r2.executeCommand('interface GigabitEthernet0/1');
  await r2.executeCommand('crypto map CMAP');
  await r2.executeCommand('exit');

  await r2.executeCommand('ip route 192.168.1.0 255.255.255.0 172.16.0.1');
  await r2.executeCommand('end');

  // ── PCs ─────────────────────────────────────────────────────────────────
  await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
  await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

  return { r1, r2, natRouter, pc1, pc2 };
}

// ─── Helper : topologie DPD simple ─────────────────────────────────────────

async function buildDPDTopology(dpdInterval: number, dpdRetries: number, dpdMode: 'periodic' | 'on-demand') {
  const r1  = new CiscoRouter('R1');
  const r2  = new CiscoRouter('R2');
  const pc1 = new LinuxPC('linux-pc', 'PC1');
  const pc2 = new LinuxPC('linux-pc', 'PC2');

  const cableWAN = new Cable('wan');
  cableWAN.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
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
    await router.executeCommand('exit');
    await router.executeCommand(`crypto isakmp key DpdSecret1 address ${peer}`);
    // DPD configuration : keepalive <interval> <retries> [periodic | on-demand]
    await router.executeCommand(`crypto isakmp keepalive ${dpdInterval} ${dpdRetries} ${dpdMode}`);

    await router.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await router.executeCommand('mode tunnel');
    await router.executeCommand('exit');

    await router.executeCommand('ip access-list extended VPN_ACL');
    await router.executeCommand(`permit ip ${lan} 0.0.0.255 ${lanPeer} 0.0.0.255`);
    await router.executeCommand('exit');

    await router.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await router.executeCommand(`set peer ${peer}`);
    await router.executeCommand('set transform-set TSET');
    await router.executeCommand('match address VPN_ACL');
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

  return { r1, r2, pc1, pc2, cableWAN };
}

// ─── Suite ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('IPSec – NAT Traversal (NAT-T)', () => {

  // ─── 5.01 : Détection du NAT et encapsulation ESP ────────────────────────
  it('5.01 – should detect NAT during IKE negotiation and encapsulate ESP in UDP 4500', async () => {
    const { r1, r2, pc1, pc2 } = await buildNATTopology();

    // PC2 initie (derrière le NAT) → R2 envoie IKE vers R1
    const pingOut = await pc2.executeCommand('ping -c 4 192.168.1.10');
    expect(pingOut).toContain('4 received');
    expect(pingOut).toContain('0% packet loss');

    // ── Vérification IKE SA (R1 voit le NAT 203.0.113.1 comme peer) ──────
    const ikeR1 = await r1.executeCommand('show crypto isakmp sa');
    expect(ikeR1).toContain('203.0.113.1');   // IP publique du NAT
    expect(ikeR1).toContain('QM_IDLE');

    // ── Vérification IPSec SA avec encapsulation UDP ──────────────────────
    const ipsecR1 = await r1.executeCommand('show crypto ipsec sa');
    // NAT-T encapsule ESP dans UDP → le port 4500 doit apparaître
    expect(ipsecR1).toContain('4500');
    // L'encapsulation UDP doit être indiquée
    expect(ipsecR1).toMatch(/UDP.*encap|encap.*UDP/i);
    expect(ipsecR1).toContain('#pkts encaps: 4');
    expect(ipsecR1).toContain('#pkts decaps: 4');
    expect(ipsecR1).toContain('#recv errors 0');

    // ── Même vérification côté R2 ─────────────────────────────────────────
    const ipsecR2 = await r2.executeCommand('show crypto ipsec sa');
    expect(ipsecR2).toContain('4500');
    expect(ipsecR2).toMatch(/UDP.*encap|encap.*UDP/i);
    expect(ipsecR2).toContain('#pkts encaps: 4');
    expect(ipsecR2).toContain('#pkts decaps: 4');
  });

  // ─── 5.02 : Port UDP 4500 après détection du NAT ─────────────────────────
  it('5.02 – should switch from UDP 500 to UDP 4500 after NAT detection', async () => {
    const { r1, r2, pc1 } = await buildNATTopology();

    await pc1.executeCommand('ping -c 2 192.168.2.10');

    // Avant NAT-T (pendant IKE_SA_INIT) → port 500
    // Après NAT-T détecté → port 4500 pour ESP et pour IKE_AUTH
    const ikeDetail = await r1.executeCommand('show crypto isakmp sa detail');
    // Le port de l'IKE SA doit être passé à 4500 après détection
    expect(ikeDetail).toContain('NAT-T');
    // Confirmation que le port 4500 est utilisé
    expect(ikeDetail).toMatch(/port.*4500|4500.*port/i);

    // La SA IPSec doit montrer le port 4500
    const ipsecSA = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecSA).toContain('4500');
  });

  // ─── 5.03 : NAT-T keepalives UDP 4500 ────────────────────────────────────
  it('5.03 – should send NAT-T keepalive packets on UDP 4500 to maintain NAT mapping', async () => {
    const { r1, r2, pc1 } = await buildNATTopology();

    await pc1.executeCommand('ping -c 2 192.168.2.10');

    // Vérification que le keepalive NAT-T est configuré (20 secondes)
    const showIsakmp = await r1.executeCommand('show crypto isakmp');
    expect(showIsakmp).toMatch(/nat.*keepalive.*20|keepalive.*nat.*20/i);

    // La SA doit indiquer que les keepalives sont actifs
    const ikeDetail = await r1.executeCommand('show crypto isakmp sa detail');
    expect(ikeDetail).toMatch(/keepalive.*enabled|nat.*keepalive/i);
  });
});

describe('IPSec – Dead Peer Detection (DPD)', () => {

  // ─── 5.04 : DPD periodic – détection de panne ───────────────────────────
  it('5.04 – DPD periodic should clear SAs when peer becomes unresponsive', async () => {
    // DPD : keepalive toutes les 10s, 3 tentatives avant de déclarer le peer mort
    const { r1, r2, pc1, cableWAN } = await buildDPDTopology(10, 3, 'periodic');

    // Établissement du tunnel
    await pc1.executeCommand('ping -c 3 192.168.2.10');

    // Vérification que les SAs sont présentes
    const saAvant = await r1.executeCommand('show crypto isakmp sa');
    expect(saAvant).toContain('QM_IDLE');
    expect(saAvant).toContain('10.0.12.2');

    // Vérification de la configuration DPD
    const ikeConfig = await r1.executeCommand('show crypto isakmp');
    expect(ikeConfig).toMatch(/keepalive.*10.*3|dpd.*10/i);

    // Simulation de panne : on déconnecte le câble WAN
    cableWAN.disconnect();

    // Vérification que R2 est inaccessible
    const pingApres = await pc1.executeCommand('ping -c 1 192.168.2.10');
    expect(pingApres).toContain('100% packet loss');

    // Après l'expiration DPD (10s × 3 tentatives = 30s + marge),
    // R1 doit avoir effacé les SAs du pair mort.
    // Dans les tests unitaires on vérifie l'état post-détection (simulé instantanément).
    const saApres = await r1.executeCommand('show crypto isakmp sa');
    // La SA doit avoir été supprimée (peer marqué mort)
    expect(saApres).not.toContain('QM_IDLE');
    // Ou : l'entrée existe mais en état MM_NO_STATE / deleted
    expect(saApres).toMatch(/no sa|deleted|MM_NO_STATE|^$/i);
  });

  // ─── 5.05 : DPD on-demand ────────────────────────────────────────────────
  it('5.05 – DPD on-demand should only probe when outbound traffic fails', async () => {
    const { r1, r2, pc1, cableWAN } = await buildDPDTopology(10, 3, 'on-demand');

    await pc1.executeCommand('ping -c 2 192.168.2.10');

    // Vérification de la configuration on-demand
    const ikeConfig = await r1.executeCommand('show crypto isakmp');
    expect(ikeConfig).toMatch(/keepalive.*on-demand|on-demand.*keepalive/i);

    // Déconnexion du câble
    cableWAN.disconnect();

    // Pas de traffic → pas de DPD probe encore (on-demand)
    // Un ping va déclencher le DPD
    await pc1.executeCommand('ping -c 1 192.168.2.10');

    // Après le DPD on-demand, les SAs doivent être effacées
    const saApres = await r1.executeCommand('show crypto isakmp sa');
    expect(saApres).not.toContain('QM_IDLE');
  });

  // ─── 5.06 : DPD – récupération après reconnexion ─────────────────────────
  it('5.06 – should re-establish tunnel automatically after peer recovers', async () => {
    const { r1, r2, pc1, pc2, cableWAN } = await buildDPDTopology(10, 3, 'periodic');

    // Établissement initial
    await pc1.executeCommand('ping -c 3 192.168.2.10');
    const saAvant = await r1.executeCommand('show crypto isakmp sa');
    expect(saAvant).toContain('QM_IDLE');

    // Déconnexion (peer mort)
    cableWAN.disconnect();
    await pc1.executeCommand('ping -c 1 192.168.2.10');

    // Reconnexion du câble (peer de retour)
    const newCable = new Cable('wan-new');
    newCable.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);

    // Le premier trafic intéressant doit déclencher la re-négociation
    const pingRecovery = await pc1.executeCommand('ping -c 3 192.168.2.10');
    expect(pingRecovery).toContain('3 received');
    expect(pingRecovery).toContain('0% packet loss');

    // Les nouvelles SAs doivent être établies (nouveaux SPIs)
    const saApres = await r1.executeCommand('show crypto isakmp sa');
    expect(saApres).toContain('QM_IDLE');
    expect(saApres).toContain('10.0.12.2');

    // Les compteurs repartent de zéro (nouvelle SA)
    const ipsecApres = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecApres).toContain('#pkts encaps: 3');
  });
});
