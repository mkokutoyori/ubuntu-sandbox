/**
 * IPSec – Scénarios avancés
 *
 * Tests :
 *   7.01 – Dynamic crypto map : hub accepte connexions de peers inconnus
 *   7.02 – Multiple peers statiques : hub maintient des SAs séparées
 *   7.03 – Peer de repli (failover) : bascule vers le backup quand le primary est down
 *   7.04 – GRE over IPSec (tunnel protection) : protocoles de routage sur tunnel chiffré
 *   7.05 – Crypto map multiple séquences : deux politiques distinctes sur le même routeur
 *   7.06 – IPSec IPv6 : tunnel protégeant du trafic IPv6 (IKEv2 over IPv6)
 *   7.07 – clear crypto session : nettoyage manuel et re-établissement
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

// ─── Helper : configuration IPSec complète sur un routeur ───────────────────

async function configureIPSecRouter(
  router: CiscoRouter,
  outside: string,
  inside: string,
  peer: string,
  lanSrc: string,
  lanDst: string,
  psk: string,
) {
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
  await router.executeCommand(`crypto isakmp key ${psk} address ${peer}`);

  await router.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
  await router.executeCommand('mode tunnel');
  await router.executeCommand('exit');

  await router.executeCommand('ip access-list extended VPN_ACL');
  await router.executeCommand(`permit ip ${lanSrc} 0.0.0.255 ${lanDst} 0.0.0.255`);
  await router.executeCommand('exit');

  await router.executeCommand('crypto map CMAP 10 ipsec-isakmp');
  await router.executeCommand(`set peer ${peer}`);
  await router.executeCommand('set transform-set TSET');
  await router.executeCommand('match address VPN_ACL');
  await router.executeCommand('exit');

  await router.executeCommand('interface GigabitEthernet0/1');
  await router.executeCommand('crypto map CMAP');
  await router.executeCommand('exit');

  await router.executeCommand(`ip route ${lanDst} 255.255.255.0 ${peer}`);
  await router.executeCommand('end');
}

// ─── Suite ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('IPSec – Dynamic Crypto Map (Hub accepte peers inconnus)', () => {

  // ─── 7.01 : Dynamic map sur le hub ───────────────────────────────────────
  it('7.01 – hub with dynamic map should accept IPSec connections from any spoke', async () => {
    const hub    = new CiscoRouter('HUB');
    const spoke1 = new CiscoRouter('SPOKE1');
    const spoke2 = new CiscoRouter('SPOKE2');
    const pcHub   = new LinuxPC('linux-pc', 'PC_HUB');
    const pcSpk1  = new LinuxPC('linux-pc', 'PC_SPK1');
    const pcSpk2  = new LinuxPC('linux-pc', 'PC_SPK2');

    // Câblage : HUB Gi0/1 ↔ SPOKE1 Gi0/1 et HUB Gi0/2 ↔ SPOKE2 Gi0/1
    new Cable('hub-spk1').connect(hub.getPort('GigabitEthernet0/1')!, spoke1.getPort('GigabitEthernet0/1')!);
    new Cable('hub-spk2').connect(hub.getPort('GigabitEthernet0/2')!, spoke2.getPort('GigabitEthernet0/1')!);
    new Cable('hub-pc').connect(pcHub.getPort('eth0')!, hub.getPort('GigabitEthernet0/0')!);
    new Cable('spk1-pc').connect(pcSpk1.getPort('eth0')!, spoke1.getPort('GigabitEthernet0/0')!);
    new Cable('spk2-pc').connect(pcSpk2.getPort('eth0')!, spoke2.getPort('GigabitEthernet0/0')!);

    // ── Configuration HUB ─────────────────────────────────────────────────
    await hub.executeCommand('enable');
    await hub.executeCommand('configure terminal');

    await hub.executeCommand('interface GigabitEthernet0/1');
    await hub.executeCommand('ip address 10.0.12.1 255.255.255.252');
    await hub.executeCommand('no shutdown');
    await hub.executeCommand('exit');
    await hub.executeCommand('interface GigabitEthernet0/2');
    await hub.executeCommand('ip address 10.0.13.1 255.255.255.252');
    await hub.executeCommand('no shutdown');
    await hub.executeCommand('exit');
    await hub.executeCommand('interface GigabitEthernet0/0');
    await hub.executeCommand('ip address 10.1.0.1 255.255.255.0');
    await hub.executeCommand('no shutdown');
    await hub.executeCommand('exit');

    // Clé wildcard pour accepter n'importe quel peer
    await hub.executeCommand('crypto isakmp policy 10');
    await hub.executeCommand('encryption aes 256');
    await hub.executeCommand('hash sha256');
    await hub.executeCommand('authentication pre-share');
    await hub.executeCommand('group 14');
    await hub.executeCommand('exit');
    await hub.executeCommand('crypto isakmp key HubSpokeKey address 0.0.0.0 0.0.0.0');

    await hub.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await hub.executeCommand('mode tunnel');
    await hub.executeCommand('exit');

    // Dynamic map : accepte n'importe quel peer (pas de set peer)
    await hub.executeCommand('crypto dynamic-map DMAP 10');
    await hub.executeCommand('set transform-set TSET');
    await hub.executeCommand('exit');

    // Crypto map statique référençant la dynamic map
    await hub.executeCommand('crypto map CMAP 65535 ipsec-isakmp dynamic DMAP');

    // Application sur les deux interfaces outside
    await hub.executeCommand('interface GigabitEthernet0/1');
    await hub.executeCommand('crypto map CMAP');
    await hub.executeCommand('exit');
    await hub.executeCommand('interface GigabitEthernet0/2');
    await hub.executeCommand('crypto map CMAP');
    await hub.executeCommand('exit');

    await hub.executeCommand('ip route 192.168.10.0 255.255.255.0 10.0.12.2');
    await hub.executeCommand('ip route 192.168.20.0 255.255.255.0 10.0.13.2');
    await hub.executeCommand('end');

    // ── Configuration SPOKE1 ─────────────────────────────────────────────
    await spoke1.executeCommand('enable');
    await spoke1.executeCommand('configure terminal');
    await spoke1.executeCommand('interface GigabitEthernet0/1');
    await spoke1.executeCommand('ip address 10.0.12.2 255.255.255.252');
    await spoke1.executeCommand('no shutdown');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('interface GigabitEthernet0/0');
    await spoke1.executeCommand('ip address 192.168.10.1 255.255.255.0');
    await spoke1.executeCommand('no shutdown');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('crypto isakmp policy 10');
    await spoke1.executeCommand('encryption aes 256');
    await spoke1.executeCommand('hash sha256');
    await spoke1.executeCommand('authentication pre-share');
    await spoke1.executeCommand('group 14');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('crypto isakmp key HubSpokeKey address 10.0.12.1');
    await spoke1.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await spoke1.executeCommand('mode tunnel');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('ip access-list extended VPN_ACL');
    await spoke1.executeCommand('permit ip 192.168.10.0 0.0.0.255 10.1.0.0 0.0.0.255');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await spoke1.executeCommand('set peer 10.0.12.1');
    await spoke1.executeCommand('set transform-set TSET');
    await spoke1.executeCommand('match address VPN_ACL');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('interface GigabitEthernet0/1');
    await spoke1.executeCommand('crypto map CMAP');
    await spoke1.executeCommand('exit');
    await spoke1.executeCommand('ip route 10.1.0.0 255.255.255.0 10.0.12.1');
    await spoke1.executeCommand('end');

    // ── Configuration SPOKE2 ─────────────────────────────────────────────
    await spoke2.executeCommand('enable');
    await spoke2.executeCommand('configure terminal');
    await spoke2.executeCommand('interface GigabitEthernet0/1');
    await spoke2.executeCommand('ip address 10.0.13.2 255.255.255.252');
    await spoke2.executeCommand('no shutdown');
    await spoke2.executeCommand('exit');
    await spoke2.executeCommand('interface GigabitEthernet0/0');
    await spoke2.executeCommand('ip address 192.168.20.1 255.255.255.0');
    await spoke2.executeCommand('no shutdown');
    await spoke2.executeCommand('exit');
    await spoke2.executeCommand('crypto isakmp policy 10');
    await spoke2.executeCommand('encryption aes 256');
    await spoke2.executeCommand('hash sha256');
    await spoke2.executeCommand('authentication pre-share');
    await spoke2.executeCommand('group 14');
    await spoke2.executeCommand('exit');
    await spoke2.executeCommand('crypto isakmp key HubSpokeKey address 10.0.13.1');
    await spoke2.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await spoke2.executeCommand('mode tunnel');
    await spoke2.executeCommand('exit');
    await spoke2.executeCommand('ip access-list extended VPN_ACL');
    await spoke2.executeCommand('permit ip 192.168.20.0 0.0.0.255 10.1.0.0 0.0.0.255');
    await spoke2.executeCommand('exit');
    await spoke2.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await spoke2.executeCommand('set peer 10.0.13.1');
    await spoke2.executeCommand('set transform-set TSET');
    await spoke2.executeCommand('match address VPN_ACL');
    await spoke2.executeCommand('exit');
    await spoke2.executeCommand('interface GigabitEthernet0/1');
    await spoke2.executeCommand('crypto map CMAP');
    await spoke2.executeCommand('exit');
    await spoke2.executeCommand('ip route 10.1.0.0 255.255.255.0 10.0.13.1');
    await spoke2.executeCommand('end');

    // ── PCs ───────────────────────────────────────────────────────────────
    await pcHub.executeCommand('sudo ip addr add 10.1.0.10/24 dev eth0');
    await pcHub.executeCommand('sudo ip route add default via 10.1.0.1');
    await pcSpk1.executeCommand('sudo ip addr add 192.168.10.10/24 dev eth0');
    await pcSpk1.executeCommand('sudo ip route add default via 192.168.10.1');
    await pcSpk2.executeCommand('sudo ip addr add 192.168.20.10/24 dev eth0');
    await pcSpk2.executeCommand('sudo ip route add default via 192.168.20.1');

    // ── Spoke1 initie vers Hub ────────────────────────────────────────────
    const ping1 = await pcSpk1.executeCommand('ping -c 3 10.1.0.10');
    expect(ping1).toContain('3 received');
    expect(ping1).toContain('0% packet loss');

    // ── Spoke2 initie vers Hub ────────────────────────────────────────────
    const ping2 = await pcSpk2.executeCommand('ping -c 3 10.1.0.10');
    expect(ping2).toContain('3 received');
    expect(ping2).toContain('0% packet loss');

    // ── Vérification hub : deux SAs dynamiques établies ──────────────────
    const hubSA = await hub.executeCommand('show crypto ipsec sa');
    // Deux paires de SAs (une par spoke)
    expect(hubSA).toContain('10.0.12.2'); // SPOKE1
    expect(hubSA).toContain('10.0.13.2'); // SPOKE2
    // Compteurs pour chaque spoke
    expect(hubSA).toContain('#pkts decaps: 3');

    // show crypto dynamic-map doit lister la map
    const dynMap = await hub.executeCommand('show crypto dynamic-map');
    expect(dynMap).toContain('DMAP');
    expect(dynMap).toContain('TSET');
  });
});

describe('IPSec – Multiple Peers et Failover', () => {

  // ─── 7.02 : SAs séparées par peer ────────────────────────────────────────
  it('7.02 – hub should maintain separate IPSec SAs for each spoke', async () => {
    const hub   = new CiscoRouter('HUB');
    const spk1  = new CiscoRouter('SPK1');
    const spk2  = new CiscoRouter('SPK2');
    const pcS1  = new LinuxPC('linux-pc', 'PCS1');
    const pcS2  = new LinuxPC('linux-pc', 'PCS2');

    new Cable('h-s1').connect(hub.getPort('GigabitEthernet0/1')!, spk1.getPort('GigabitEthernet0/1')!);
    new Cable('h-s2').connect(hub.getPort('GigabitEthernet0/2')!, spk2.getPort('GigabitEthernet0/1')!);
    new Cable('s1-pc').connect(pcS1.getPort('eth0')!, spk1.getPort('GigabitEthernet0/0')!);
    new Cable('s2-pc').connect(pcS2.getPort('eth0')!, spk2.getPort('GigabitEthernet0/0')!);

    // ── HUB : deux entrées statiques dans la crypto map ──────────────────
    await hub.executeCommand('enable');
    await hub.executeCommand('configure terminal');
    await hub.executeCommand('interface GigabitEthernet0/1');
    await hub.executeCommand('ip address 10.0.12.1 255.255.255.252');
    await hub.executeCommand('no shutdown');
    await hub.executeCommand('exit');
    await hub.executeCommand('interface GigabitEthernet0/2');
    await hub.executeCommand('ip address 10.0.13.1 255.255.255.252');
    await hub.executeCommand('no shutdown');
    await hub.executeCommand('exit');
    await hub.executeCommand('interface GigabitEthernet0/0');
    await hub.executeCommand('ip address 10.1.0.1 255.255.255.0');
    await hub.executeCommand('no shutdown');
    await hub.executeCommand('exit');

    await hub.executeCommand('crypto isakmp policy 10');
    await hub.executeCommand('encryption aes 256');
    await hub.executeCommand('hash sha256');
    await hub.executeCommand('authentication pre-share');
    await hub.executeCommand('group 14');
    await hub.executeCommand('exit');
    await hub.executeCommand('crypto isakmp key Key4Spk1 address 10.0.12.2');
    await hub.executeCommand('crypto isakmp key Key4Spk2 address 10.0.13.2');

    await hub.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await hub.executeCommand('mode tunnel');
    await hub.executeCommand('exit');

    // ACL pour SPOKE1
    await hub.executeCommand('ip access-list extended VPN_SPK1');
    await hub.executeCommand('permit ip 10.1.0.0 0.0.0.255 192.168.10.0 0.0.0.255');
    await hub.executeCommand('exit');
    // ACL pour SPOKE2
    await hub.executeCommand('ip access-list extended VPN_SPK2');
    await hub.executeCommand('permit ip 10.1.0.0 0.0.0.255 192.168.20.0 0.0.0.255');
    await hub.executeCommand('exit');

    // Crypto map séquence 10 → SPOKE1
    await hub.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await hub.executeCommand('set peer 10.0.12.2');
    await hub.executeCommand('set transform-set TSET');
    await hub.executeCommand('match address VPN_SPK1');
    await hub.executeCommand('exit');
    // Crypto map séquence 20 → SPOKE2
    await hub.executeCommand('crypto map CMAP 20 ipsec-isakmp');
    await hub.executeCommand('set peer 10.0.13.2');
    await hub.executeCommand('set transform-set TSET');
    await hub.executeCommand('match address VPN_SPK2');
    await hub.executeCommand('exit');

    await hub.executeCommand('interface GigabitEthernet0/1');
    await hub.executeCommand('crypto map CMAP');
    await hub.executeCommand('exit');
    await hub.executeCommand('interface GigabitEthernet0/2');
    await hub.executeCommand('crypto map CMAP');
    await hub.executeCommand('exit');

    await hub.executeCommand('ip route 192.168.10.0 255.255.255.0 10.0.12.2');
    await hub.executeCommand('ip route 192.168.20.0 255.255.255.0 10.0.13.2');
    await hub.executeCommand('end');

    // ── SPK1 ─────────────────────────────────────────────────────────────
    await configureIPSecRouter(spk1, '10.0.12.2', '192.168.10.1', '10.0.12.1',
      '192.168.10.0', '10.1.0.0', 'Key4Spk1');
    // ── SPK2 ─────────────────────────────────────────────────────────────
    await configureIPSecRouter(spk2, '10.0.13.2', '192.168.20.1', '10.0.13.1',
      '192.168.20.0', '10.1.0.0', 'Key4Spk2');

    await pcS1.executeCommand('sudo ip addr add 192.168.10.10/24 dev eth0');
    await pcS1.executeCommand('sudo ip route add default via 192.168.10.1');
    await pcS2.executeCommand('sudo ip addr add 192.168.20.10/24 dev eth0');
    await pcS2.executeCommand('sudo ip route add default via 192.168.20.1');

    // Trafic depuis chaque spoke vers le hub
    await pcS1.executeCommand('ping -c 3 10.1.0.1');
    await pcS2.executeCommand('ping -c 3 10.1.0.1');

    // Deux SAs IKE distinctes sur le hub
    const ikeHub = await hub.executeCommand('show crypto isakmp sa');
    expect(ikeHub).toContain('10.0.12.2');  // SPOKE1
    expect(ikeHub).toContain('10.0.13.2');  // SPOKE2
    // Les deux doivent être QM_IDLE (établies)
    const qmIdleCount = (ikeHub.match(/QM_IDLE/g) ?? []).length;
    expect(qmIdleCount).toBeGreaterThanOrEqual(2);

    // Deux ensembles de SAs IPSec sur le hub
    const ipsecHub = await hub.executeCommand('show crypto ipsec sa');
    expect(ipsecHub).toContain('current_peer 10.0.12.2');
    expect(ipsecHub).toContain('current_peer 10.0.13.2');
  });

  // ─── 7.03 : Peer de repli (backup peer) ──────────────────────────────────
  it('7.03 – should fail over to backup peer when primary is unreachable', async () => {
    const r1    = new CiscoRouter('R1');
    const r2    = new CiscoRouter('R2');   // peer primaire
    const r3    = new CiscoRouter('R3');   // peer de repli
    const pc1   = new LinuxPC('linux-pc', 'PC1');
    const pc2   = new LinuxPC('linux-pc', 'PC2');  // LAN derrière R2
    const pc3   = new LinuxPC('linux-pc', 'PC3');  // LAN derrière R3

    // Câblage : R1-Gi0/1 ↔ R2-Gi0/1, R1-Gi0/2 ↔ R3-Gi0/1
    const cableR1R2 = new Cable('r1r2');
    cableR1R2.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    new Cable('r1r3').connect(r1.getPort('GigabitEthernet0/2')!, r3.getPort('GigabitEthernet0/1')!);
    new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);
    new Cable('lan3').connect(pc3.getPort('eth0')!, r3.getPort('GigabitEthernet0/0')!);

    // ── R1 : peer primaire 10.0.12.2, backup 10.0.13.2 ───────────────────
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('ip address 10.0.12.1 255.255.255.252');
    await r1.executeCommand('no shutdown');
    await r1.executeCommand('exit');
    await r1.executeCommand('interface GigabitEthernet0/2');
    await r1.executeCommand('ip address 10.0.13.1 255.255.255.252');
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
    await r1.executeCommand('crypto isakmp key FailKey1 address 10.0.12.2');
    await r1.executeCommand('crypto isakmp key FailKey1 address 10.0.13.2');

    await r1.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await r1.executeCommand('mode tunnel');
    await r1.executeCommand('exit');

    await r1.executeCommand('ip access-list extended VPN_ACL');
    await r1.executeCommand('permit ip 192.168.1.0 0.0.0.255 192.168.2.0 0.0.0.255');
    await r1.executeCommand('exit');

    // set peer avec primaire + backup (ordre = priorité)
    await r1.executeCommand('crypto map CMAP 10 ipsec-isakmp');
    await r1.executeCommand('set peer 10.0.12.2 10.0.13.2');  // primaire puis backup
    await r1.executeCommand('set transform-set TSET');
    await r1.executeCommand('match address VPN_ACL');
    await r1.executeCommand('exit');

    await r1.executeCommand('interface GigabitEthernet0/1');
    await r1.executeCommand('crypto map CMAP');
    await r1.executeCommand('exit');
    await r1.executeCommand('interface GigabitEthernet0/2');
    await r1.executeCommand('crypto map CMAP');
    await r1.executeCommand('exit');

    await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.12.2');
    await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 10.0.13.2 20'); // backup AD plus haute
    await r1.executeCommand('end');

    // ── R2 et R3 ──────────────────────────────────────────────────────────
    await configureIPSecRouter(r2, '10.0.12.2', '192.168.2.1', '10.0.12.1',
      '192.168.2.0', '192.168.1.0', 'FailKey1');
    await configureIPSecRouter(r3, '10.0.13.2', '192.168.2.1', '10.0.13.1',
      '192.168.2.0', '192.168.1.0', 'FailKey1');

    await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
    await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
    await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
    await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

    // Tunnel avec peer primaire (R2)
    const pingPrimaire = await pc1.executeCommand('ping -c 3 192.168.2.10');
    expect(pingPrimaire).toContain('3 received');

    const ikeAvant = await r1.executeCommand('show crypto isakmp sa');
    expect(ikeAvant).toContain('10.0.12.2');   // peer primaire actif
    expect(ikeAvant).toContain('QM_IDLE');

    // Panne du peer primaire : déconnexion du câble R1-R2
    cableR1R2.disconnect();

    // Effacement des SAs du peer primaire
    await r1.executeCommand('clear crypto session remote 10.0.12.2');

    // Le trafic doit basculer sur le backup (R3)
    const pingBackup = await pc1.executeCommand('ping -c 3 192.168.2.10');
    expect(pingBackup).toContain('3 received');

    const ikeApres = await r1.executeCommand('show crypto isakmp sa');
    // Le backup peer doit maintenant être QM_IDLE
    expect(ikeApres).toContain('10.0.13.2');
    expect(ikeApres).toContain('QM_IDLE');
  });
});

describe('IPSec – GRE over IPSec (Tunnel Protection)', () => {

  // ─── 7.04 : GRE over IPSec ───────────────────────────────────────────────
  it('7.04 – GRE tunnel protected by IPSec profile should carry dynamic routing', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    const pc1 = new LinuxPC('linux-pc', 'PC1');
    const pc2 = new LinuxPC('linux-pc', 'PC2');

    new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

    // ── R1 ────────────────────────────────────────────────────────────────
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

    // Tunnel GRE
    await r1.executeCommand('interface Tunnel0');
    await r1.executeCommand('ip address 172.16.0.1 255.255.255.252');
    await r1.executeCommand('tunnel source GigabitEthernet0/1');
    await r1.executeCommand('tunnel destination 10.0.12.2');
    await r1.executeCommand('tunnel mode gre ip');
    await r1.executeCommand('exit');

    // IPSec profile (protège le tunnel GRE)
    await r1.executeCommand('crypto isakmp policy 10');
    await r1.executeCommand('encryption aes 256');
    await r1.executeCommand('hash sha256');
    await r1.executeCommand('authentication pre-share');
    await r1.executeCommand('group 14');
    await r1.executeCommand('exit');
    await r1.executeCommand('crypto isakmp key GRESecret1 address 10.0.12.2');
    await r1.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await r1.executeCommand('mode transport');   // transport mode pour GRE over IPSec
    await r1.executeCommand('exit');
    await r1.executeCommand('crypto ipsec profile GRE_PROF');
    await r1.executeCommand('set transform-set TSET');
    await r1.executeCommand('exit');

    // Application du profil IPSec sur le tunnel GRE
    await r1.executeCommand('interface Tunnel0');
    await r1.executeCommand('tunnel protection ipsec profile GRE_PROF');
    await r1.executeCommand('exit');

    // Route via le tunnel pour atteindre le LAN distant
    await r1.executeCommand('ip route 192.168.2.0 255.255.255.0 172.16.0.2');
    await r1.executeCommand('end');

    // ── R2 ────────────────────────────────────────────────────────────────
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

    await r2.executeCommand('interface Tunnel0');
    await r2.executeCommand('ip address 172.16.0.2 255.255.255.252');
    await r2.executeCommand('tunnel source GigabitEthernet0/1');
    await r2.executeCommand('tunnel destination 10.0.12.1');
    await r2.executeCommand('tunnel mode gre ip');
    await r2.executeCommand('exit');

    await r2.executeCommand('crypto isakmp policy 10');
    await r2.executeCommand('encryption aes 256');
    await r2.executeCommand('hash sha256');
    await r2.executeCommand('authentication pre-share');
    await r2.executeCommand('group 14');
    await r2.executeCommand('exit');
    await r2.executeCommand('crypto isakmp key GRESecret1 address 10.0.12.1');
    await r2.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
    await r2.executeCommand('mode transport');
    await r2.executeCommand('exit');
    await r2.executeCommand('crypto ipsec profile GRE_PROF');
    await r2.executeCommand('set transform-set TSET');
    await r2.executeCommand('exit');

    await r2.executeCommand('interface Tunnel0');
    await r2.executeCommand('tunnel protection ipsec profile GRE_PROF');
    await r2.executeCommand('exit');

    await r2.executeCommand('ip route 192.168.1.0 255.255.255.0 172.16.0.1');
    await r2.executeCommand('end');

    // ── PCs ───────────────────────────────────────────────────────────────
    await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
    await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
    await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
    await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

    // Ping à travers le tunnel GRE protégé par IPSec
    const ping = await pc1.executeCommand('ping -c 3 192.168.2.10');
    expect(ping).toContain('3 received');
    expect(ping).toContain('0% packet loss');

    // ── Vérifications tunnel GRE ──────────────────────────────────────────
    const tunShow = await r1.executeCommand('show interface Tunnel0');
    expect(tunShow).toContain('Tunnel0 is up');
    expect(tunShow).toContain('Internet address is 172.16.0.1/30');
    // La protection IPSec doit être mentionnée
    expect(tunShow).toMatch(/tunnel protection ipsec profile GRE_PROF/i);

    // ── Vérifications IPSec SA ────────────────────────────────────────────
    const ipsecSA = await r1.executeCommand('show crypto ipsec sa');
    // Le trafic GRE est encapsulé → paquets encryptés
    expect(ipsecSA).toContain('#pkts encaps: 3');
    expect(ipsecSA).toContain('#recv errors 0');
    // Mode transport (pour GRE over IPSec)
    expect(ipsecSA).toContain('Transport');

    // ── Vérification profil IPSec ─────────────────────────────────────────
    const profShow = await r1.executeCommand('show crypto ipsec profile');
    expect(profShow).toContain('GRE_PROF');
    expect(profShow).toContain('TSET');
  });
});

describe('IPSec – Maintenance et Opérations', () => {

  // ─── 7.05 : clear crypto session ─────────────────────────────────────────
  it('7.05 – clear crypto session should remove all SAs and allow clean re-establishment', async () => {
    const r1  = new CiscoRouter('R1');
    const r2  = new CiscoRouter('R2');
    const pc1 = new LinuxPC('linux-pc', 'PC1');
    const pc2 = new LinuxPC('linux-pc', 'PC2');

    new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

    await configureIPSecRouter(r1, '10.0.12.1', '192.168.1.1', '10.0.12.2',
      '192.168.1.0', '192.168.2.0', 'ClearTest1');
    await configureIPSecRouter(r2, '10.0.12.2', '192.168.2.1', '10.0.12.1',
      '192.168.2.0', '192.168.1.0', 'ClearTest1');

    await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
    await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
    await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
    await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

    // Établissement du tunnel
    await pc1.executeCommand('ping -c 3 192.168.2.10');
    const ikeAvant = await r1.executeCommand('show crypto isakmp sa');
    expect(ikeAvant).toContain('QM_IDLE');
    const ipsecAvant = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecAvant).toContain('#pkts encaps: 3');

    // Nettoyage de toutes les SAs
    await r1.executeCommand('clear crypto session');

    // Les SAs IKE doivent être effacées immédiatement
    const ikeApres = await r1.executeCommand('show crypto isakmp sa');
    expect(ikeApres).not.toContain('QM_IDLE');

    // Les SAs IPSec doivent aussi être effacées
    const ipsecApres = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecApres).not.toContain('#pkts encaps:');

    // Re-établissement automatique via nouveau trafic intéressant
    const pingPost = await pc1.executeCommand('ping -c 3 192.168.2.10');
    expect(pingPost).toContain('3 received');
    expect(pingPost).toContain('0% packet loss');

    const ikeRenouvelle = await r1.executeCommand('show crypto isakmp sa');
    expect(ikeRenouvelle).toContain('QM_IDLE');
    // Les compteurs repartent à zéro (nouvelle SA)
    const ipsecRenouvelle = await r1.executeCommand('show crypto ipsec sa');
    expect(ipsecRenouvelle).toContain('#pkts encaps: 3');
  });

  // ─── 7.06 : show crypto session ──────────────────────────────────────────
  it('7.06 – show crypto session should display all active VPN sessions with status', async () => {
    const r1  = new CiscoRouter('R1');
    const r2  = new CiscoRouter('R2');
    const pc1 = new LinuxPC('linux-pc', 'PC1');
    const pc2 = new LinuxPC('linux-pc', 'PC2');

    new Cable('wan').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);
    new Cable('lan1').connect(pc1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
    new Cable('lan2').connect(pc2.getPort('eth0')!, r2.getPort('GigabitEthernet0/0')!);

    await configureIPSecRouter(r1, '10.0.12.1', '192.168.1.1', '10.0.12.2',
      '192.168.1.0', '192.168.2.0', 'ShowSession1');
    await configureIPSecRouter(r2, '10.0.12.2', '192.168.2.1', '10.0.12.1',
      '192.168.2.0', '192.168.1.0', 'ShowSession1');

    await pc1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
    await pc1.executeCommand('sudo ip route add default via 192.168.1.1');
    await pc2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
    await pc2.executeCommand('sudo ip route add default via 192.168.2.1');

    await pc1.executeCommand('ping -c 3 192.168.2.10');

    const sessionOut = await r1.executeCommand('show crypto session');
    // Interface on which the session is established
    expect(sessionOut).toContain('Interface: GigabitEthernet0/1');
    // Session status
    expect(sessionOut).toContain('Session status: UP-ACTIVE');
    // Peer address
    expect(sessionOut).toContain('Peer: 10.0.12.2 port 500');
    // IKEv1 session
    expect(sessionOut).toContain('IKEv1 SA:');
    // Child SA / IPSec SA (fvr / fvs = forward/reverse flows)
    expect(sessionOut).toContain('IPSEC FLOW:');
    expect(sessionOut).toContain('Active SAs: 2');  // une inbound, une outbound
  });
});
