/**
 * Complex Multi-Vendor WAN VPN Topology Builder
 *
 * Reusable topology for VPN and future WAN tests. Four sites connected via
 * hub-and-spoke IPSec VPN over a simulated WAN backbone.
 *
 * Topology:
 *
 *   SITE-HQ (Cisco R-HQ) — Central hub, 3 WAN interfaces
 *     ├── WAN1 (10.0.12.0/30) ─── SITE-BRANCH1 (Huawei R-BR1) ─── [SW-BR1] ─── [WinPC1]
 *     ├── WAN2 (10.0.23.0/30) ─── SITE-BRANCH2 (Cisco  R-BR2) ─── [SW-BR2] ─── [LinuxPC2]
 *     └── WAN3 (10.0.34.0/30) ─── SITE-BRANCH3 (Huawei R-BR3) ─── ──────────── [LinuxPC3]
 *     └── LAN  (192.168.10.0/24) ─── [SW-HQ] ─── [LinuxServer]
 *
 *   LAN subnets:
 *     HQ:      192.168.10.0/24  (LinuxServer: .100)
 *     Branch1: 192.168.20.0/24  (WinPC1: .10)
 *     Branch2: 192.168.30.0/24  (LinuxPC2: .10)
 *     Branch3: 192.168.40.0/24  (LinuxPC3: .10)
 *
 *   VPN tunnels:
 *     HQ ↔ Branch1: IKEv1 PSK (AES-256/SHA256/DH14) — Cisco-to-Huawei
 *     HQ ↔ Branch2: IKEv2 PSK (AES-256/SHA256/DH14) — Cisco-to-Cisco
 *     HQ ↔ Branch3: IKEv1 PSK (AES-128/SHA1/DH5)    — Cisco-to-Huawei (weaker)
 *
 * All devices are returned for test assertions. The topology is fully wired,
 * addressed, and VPN-configured — ready for traffic tests.
 */

import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { Cable } from '@/network/hardware/Cable';

export interface WanVpnTopology {
  // Routers
  rHQ: CiscoRouter;
  rBR1: HuaweiRouter;
  rBR2: CiscoRouter;
  rBR3: HuaweiRouter;
  // Switches
  swHQ: CiscoSwitch;
  swBR1: HuaweiSwitch;
  swBR2: CiscoSwitch;
  // End hosts
  server: LinuxServer;
  winPC1: WindowsPC;
  linuxPC2: LinuxPC;
  linuxPC3: LinuxPC;
}

export interface WanVpnOptions {
  /** Pre-shared key for HQ ↔ Branch1 tunnel */
  pskBranch1?: string;
  /** Pre-shared key for HQ ↔ Branch2 tunnel */
  pskBranch2?: string;
  /** Pre-shared key for HQ ↔ Branch3 tunnel */
  pskBranch3?: string;
  /** Skip VPN config (topology + addressing only) */
  skipVPN?: boolean;
  /** Skip Branch3 VPN config */
  skipBranch3VPN?: boolean;
}

// ─── Cable helper ──────────────────────────────────────────────────────────

function wire(name: string, p1: any, p2: any): Cable {
  const cable = new Cable(name);
  cable.connect(p1, p2);
  return cable;
}

// ─── Main builder ──────────────────────────────────────────────────────────

export async function buildWanVpnTopology(opts: WanVpnOptions = {}): Promise<WanVpnTopology> {
  const {
    pskBranch1 = 'Branch1Secret!42',
    pskBranch2 = 'Branch2IKEv2#77',
    pskBranch3 = 'Branch3Weak$99',
    skipVPN = false,
    skipBranch3VPN = false,
  } = opts;

  // ═════════════════════════════════════════════════════════════════════
  // 1. Create devices
  // ═════════════════════════════════════════════════════════════════════

  const rHQ   = new CiscoRouter('R-HQ');
  const rBR1  = new HuaweiRouter('R-BR1');
  const rBR2  = new CiscoRouter('R-BR2');
  const rBR3  = new HuaweiRouter('R-BR3');

  const swHQ  = new CiscoSwitch('switch-cisco', 'SW-HQ', 24);
  const swBR1 = new HuaweiSwitch('switch-huawei', 'SW-BR1', 24);
  const swBR2 = new CiscoSwitch('switch-cisco', 'SW-BR2', 24);

  const server   = new LinuxServer('linux-server', 'SRV-HQ');
  const winPC1   = new WindowsPC('windows-pc', 'WinPC1');
  const linuxPC2 = new LinuxPC('linux-pc', 'PC-BR2');
  const linuxPC3 = new LinuxPC('linux-pc', 'PC-BR3');

  // ═════════════════════════════════════════════════════════════════════
  // 2. Cable — WAN links (router-to-router)
  // ═════════════════════════════════════════════════════════════════════

  // HQ Gi0/1 ↔ BR1 GE0/0/1
  wire('wan-hq-br1', rHQ.getPort('GigabitEthernet0/1')!, rBR1.getPort('GE0/0/1')!);
  // HQ Gi0/2 ↔ BR2 Gi0/1
  wire('wan-hq-br2', rHQ.getPort('GigabitEthernet0/2')!, rBR2.getPort('GigabitEthernet0/1')!);
  // HQ Gi0/3 ↔ BR3 GE0/0/1
  wire('wan-hq-br3', rHQ.getPort('GigabitEthernet0/3')!, rBR3.getPort('GE0/0/1')!);

  // ═════════════════════════════════════════════════════════════════════
  // 3. Cable — LAN segments (router ↔ switch ↔ host)
  // ═════════════════════════════════════════════════════════════════════

  // HQ LAN: R-HQ Gi0/0 ↔ SW-HQ ↔ SRV-HQ
  wire('lan-hq-sw', rHQ.getPort('GigabitEthernet0/0')!, swHQ.getPort('FastEthernet0/0')!);
  wire('lan-hq-srv', server.getPort('eth0')!, swHQ.getPort('FastEthernet0/1')!);

  // Branch1 LAN: R-BR1 GE0/0/0 ↔ SW-BR1 ↔ WinPC1
  wire('lan-br1-sw', rBR1.getPort('GE0/0/0')!, swBR1.getPort('GigabitEthernet0/0/0')!);
  wire('lan-br1-win', winPC1.getPort('eth0')!, swBR1.getPort('GigabitEthernet0/0/1')!);

  // Branch2 LAN: R-BR2 Gi0/0 ↔ SW-BR2 ↔ LinuxPC2
  wire('lan-br2-sw', rBR2.getPort('GigabitEthernet0/0')!, swBR2.getPort('FastEthernet0/0')!);
  wire('lan-br2-pc', linuxPC2.getPort('eth0')!, swBR2.getPort('FastEthernet0/1')!);

  // Branch3 LAN: R-BR3 GE0/0/0 ↔ LinuxPC3 (direct, no switch)
  wire('lan-br3-pc', rBR3.getPort('GE0/0/0')!, linuxPC3.getPort('eth0')!);

  // ═════════════════════════════════════════════════════════════════════
  // 4. IP addressing
  // ═════════════════════════════════════════════════════════════════════

  await configureHQAddressing(rHQ);
  await configureBR1Addressing(rBR1);
  await configureBR2Addressing(rBR2);
  await configureBR3Addressing(rBR3);
  await configureEndHosts(server, winPC1, linuxPC2, linuxPC3);

  // ═════════════════════════════════════════════════════════════════════
  // 5. Static routing (all sites know how to reach each other via HQ)
  // ═════════════════════════════════════════════════════════════════════

  await configureHQRouting(rHQ);
  await configureBranchRouting(rBR1, rBR2, rBR3);

  // ═════════════════════════════════════════════════════════════════════
  // 6. VPN configuration
  // ═════════════════════════════════════════════════════════════════════

  if (!skipVPN) {
    await configureHQVPN(rHQ, pskBranch1, pskBranch2, pskBranch3, skipBranch3VPN);
    await configureBR1VPN(rBR1, pskBranch1);
    await configureBR2VPN(rBR2, pskBranch2);
    if (!skipBranch3VPN) {
      await configureBR3VPN(rBR3, pskBranch3);
    }
  }

  return { rHQ, rBR1, rBR2, rBR3, swHQ, swBR1, swBR2, server, winPC1, linuxPC2, linuxPC3 };
}

// ═══════════════════════════════════════════════════════════════════════════
// IP Addressing
// ═══════════════════════════════════════════════════════════════════════════

async function configureHQAddressing(r: CiscoRouter): Promise<void> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  // LAN
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('ip address 192.168.10.1 255.255.255.0');
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  // WAN to BR1
  await r.executeCommand('interface GigabitEthernet0/1');
  await r.executeCommand('ip address 10.0.12.1 255.255.255.252');
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  // WAN to BR2
  await r.executeCommand('interface GigabitEthernet0/2');
  await r.executeCommand('ip address 10.0.23.1 255.255.255.252');
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  // WAN to BR3
  await r.executeCommand('interface GigabitEthernet0/3');
  await r.executeCommand('ip address 10.0.34.1 255.255.255.252');
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  await r.executeCommand('end');
}

async function configureBR1Addressing(r: HuaweiRouter): Promise<void> {
  await r.executeCommand('system-view');
  // WAN
  await r.executeCommand('interface GE0/0/1');
  await r.executeCommand('ip address 10.0.12.2 255.255.255.252');
  await r.executeCommand('quit');
  // LAN
  await r.executeCommand('interface GE0/0/0');
  await r.executeCommand('ip address 192.168.20.1 255.255.255.0');
  await r.executeCommand('quit');
  await r.executeCommand('return');
}

async function configureBR2Addressing(r: CiscoRouter): Promise<void> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  // WAN
  await r.executeCommand('interface GigabitEthernet0/1');
  await r.executeCommand('ip address 10.0.23.2 255.255.255.252');
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  // LAN
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('ip address 192.168.30.1 255.255.255.0');
  await r.executeCommand('no shutdown');
  await r.executeCommand('exit');
  await r.executeCommand('end');
}

async function configureBR3Addressing(r: HuaweiRouter): Promise<void> {
  await r.executeCommand('system-view');
  // WAN
  await r.executeCommand('interface GE0/0/1');
  await r.executeCommand('ip address 10.0.34.2 255.255.255.252');
  await r.executeCommand('quit');
  // LAN
  await r.executeCommand('interface GE0/0/0');
  await r.executeCommand('ip address 192.168.40.1 255.255.255.0');
  await r.executeCommand('quit');
  await r.executeCommand('return');
}

async function configureEndHosts(
  server: LinuxServer, winPC1: WindowsPC,
  linuxPC2: LinuxPC, linuxPC3: LinuxPC,
): Promise<void> {
  // HQ Server
  await server.executeCommand('sudo ip addr add 192.168.10.100/24 dev eth0');
  await server.executeCommand('sudo ip route add default via 192.168.10.1');

  // Branch1 Windows PC
  await winPC1.executeCommand('netsh interface ip set address "Ethernet" static 192.168.20.10 255.255.255.0 192.168.20.1');

  // Branch2 Linux PC
  await linuxPC2.executeCommand('sudo ip addr add 192.168.30.10/24 dev eth0');
  await linuxPC2.executeCommand('sudo ip route add default via 192.168.30.1');

  // Branch3 Linux PC
  await linuxPC3.executeCommand('sudo ip addr add 192.168.40.10/24 dev eth0');
  await linuxPC3.executeCommand('sudo ip route add default via 192.168.40.1');
}

// ═══════════════════════════════════════════════════════════════════════════
// Static routing
// ═══════════════════════════════════════════════════════════════════════════

async function configureHQRouting(r: CiscoRouter): Promise<void> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('ip route 192.168.20.0 255.255.255.0 10.0.12.2');
  await r.executeCommand('ip route 192.168.30.0 255.255.255.0 10.0.23.2');
  await r.executeCommand('ip route 192.168.40.0 255.255.255.0 10.0.34.2');
  await r.executeCommand('end');
}

async function configureBranchRouting(
  rBR1: HuaweiRouter, rBR2: CiscoRouter, rBR3: HuaweiRouter,
): Promise<void> {
  // Branch1 — default route to HQ
  await rBR1.executeCommand('system-view');
  await rBR1.executeCommand('ip route-static 0.0.0.0 0.0.0.0 10.0.12.1');
  await rBR1.executeCommand('return');

  // Branch2 — default route to HQ
  await rBR2.executeCommand('enable');
  await rBR2.executeCommand('configure terminal');
  await rBR2.executeCommand('ip route 0.0.0.0 0.0.0.0 10.0.23.1');
  await rBR2.executeCommand('end');

  // Branch3 — default route to HQ
  await rBR3.executeCommand('system-view');
  await rBR3.executeCommand('ip route-static 0.0.0.0 0.0.0.0 10.0.34.1');
  await rBR3.executeCommand('return');
}

// ═══════════════════════════════════════════════════════════════════════════
// VPN Configuration — HQ (Cisco IKEv1 + IKEv2 hub)
// ═══════════════════════════════════════════════════════════════════════════

async function configureHQVPN(
  r: CiscoRouter,
  pskBR1: string, pskBR2: string, pskBR3: string,
  skipBR3: boolean,
): Promise<void> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');

  // ── IKEv1 policy (for Branch1 & Branch3) ─────────────────────────
  await r.executeCommand('crypto isakmp policy 10');
  await r.executeCommand('encryption aes 256');
  await r.executeCommand('hash sha256');
  await r.executeCommand('authentication pre-share');
  await r.executeCommand('group 14');
  await r.executeCommand('lifetime 86400');
  await r.executeCommand('exit');

  // Weaker policy for Branch3
  if (!skipBR3) {
    await r.executeCommand('crypto isakmp policy 20');
    await r.executeCommand('encryption aes 128');
    await r.executeCommand('hash sha');
    await r.executeCommand('authentication pre-share');
    await r.executeCommand('group 5');
    await r.executeCommand('lifetime 86400');
    await r.executeCommand('exit');
  }

  // PSK for Branch1 (IKEv1)
  await r.executeCommand(`crypto isakmp key ${pskBR1} address 10.0.12.2`);
  // PSK for Branch3 (IKEv1)
  if (!skipBR3) {
    await r.executeCommand(`crypto isakmp key ${pskBR3} address 10.0.34.2`);
  }

  // ── IKEv2 config (for Branch2) ───────────────────────────────────
  await r.executeCommand('crypto ikev2 proposal PROP-BR2');
  await r.executeCommand('encryption aes-cbc-256');
  await r.executeCommand('integrity sha256');
  await r.executeCommand('group 14');
  await r.executeCommand('exit');

  await r.executeCommand('crypto ikev2 policy POL-BR2');
  await r.executeCommand('proposal PROP-BR2');
  await r.executeCommand('exit');

  await r.executeCommand('crypto ikev2 keyring KR-BR2');
  await r.executeCommand('peer BR2');
  await r.executeCommand('address 10.0.23.2');
  await r.executeCommand(`pre-shared-key ${pskBR2}`);
  await r.executeCommand('exit');
  await r.executeCommand('exit');

  await r.executeCommand('crypto ikev2 profile PROF-BR2');
  await r.executeCommand('match identity remote address 10.0.23.2 255.255.255.255');
  await r.executeCommand('authentication remote pre-share');
  await r.executeCommand('authentication local pre-share');
  await r.executeCommand('keyring local KR-BR2');
  await r.executeCommand('exit');

  // ── Transform sets ───────────────────────────────────────────────
  await r.executeCommand('crypto ipsec transform-set TSET-STRONG esp-aes 256 esp-sha256-hmac');
  await r.executeCommand('mode tunnel');
  await r.executeCommand('exit');

  await r.executeCommand('crypto ipsec transform-set TSET-WEAK esp-aes 128 esp-sha-hmac');
  await r.executeCommand('mode tunnel');
  await r.executeCommand('exit');

  // ── ACLs ─────────────────────────────────────────────────────────
  await r.executeCommand('ip access-list extended VPN-BR1');
  await r.executeCommand('permit ip 192.168.10.0 0.0.0.255 192.168.20.0 0.0.0.255');
  await r.executeCommand('exit');

  await r.executeCommand('ip access-list extended VPN-BR2');
  await r.executeCommand('permit ip 192.168.10.0 0.0.0.255 192.168.30.0 0.0.0.255');
  await r.executeCommand('exit');

  if (!skipBR3) {
    await r.executeCommand('ip access-list extended VPN-BR3');
    await r.executeCommand('permit ip 192.168.10.0 0.0.0.255 192.168.40.0 0.0.0.255');
    await r.executeCommand('exit');
  }

  // ── Crypto maps ──────────────────────────────────────────────────
  // Branch1 (IKEv1)
  await r.executeCommand('crypto map CMAP-HQ 10 ipsec-isakmp');
  await r.executeCommand('set peer 10.0.12.2');
  await r.executeCommand('set transform-set TSET-STRONG');
  await r.executeCommand('match address VPN-BR1');
  await r.executeCommand('exit');

  // Branch2 (IKEv2)
  await r.executeCommand('crypto map CMAP-HQ 20 ipsec-isakmp');
  await r.executeCommand('set peer 10.0.23.2');
  await r.executeCommand('set ikev2-profile PROF-BR2');
  await r.executeCommand('set transform-set TSET-STRONG');
  await r.executeCommand('match address VPN-BR2');
  await r.executeCommand('exit');

  // Branch3 (IKEv1 weaker)
  if (!skipBR3) {
    await r.executeCommand('crypto map CMAP-HQ 30 ipsec-isakmp');
    await r.executeCommand('set peer 10.0.34.2');
    await r.executeCommand('set transform-set TSET-WEAK');
    await r.executeCommand('match address VPN-BR3');
    await r.executeCommand('exit');
  }

  // Apply crypto map to all WAN interfaces
  await r.executeCommand('interface GigabitEthernet0/1');
  await r.executeCommand('crypto map CMAP-HQ');
  await r.executeCommand('exit');

  await r.executeCommand('interface GigabitEthernet0/2');
  await r.executeCommand('crypto map CMAP-HQ');
  await r.executeCommand('exit');

  if (!skipBR3) {
    await r.executeCommand('interface GigabitEthernet0/3');
    await r.executeCommand('crypto map CMAP-HQ');
    await r.executeCommand('exit');
  }

  await r.executeCommand('end');
}

// ═══════════════════════════════════════════════════════════════════════════
// VPN Configuration — Branch1 (Huawei, IKEv1 PSK)
// ═══════════════════════════════════════════════════════════════════════════

async function configureBR1VPN(r: HuaweiRouter, psk: string): Promise<void> {
  await r.executeCommand('system-view');

  // IKE proposal (Phase 1)
  await r.executeCommand('ike proposal 10');
  await r.executeCommand('encryption-algorithm aes-256');
  await r.executeCommand('authentication-algorithm sha2-256');
  await r.executeCommand('dh group14');
  await r.executeCommand('sa duration 86400');
  await r.executeCommand('quit');

  // IKE peer
  await r.executeCommand('ike peer HQ');
  await r.executeCommand(`pre-shared-key ${psk}`);
  await r.executeCommand('remote-address 10.0.12.1');
  await r.executeCommand('ike-proposal 10');
  await r.executeCommand('quit');

  // IPSec proposal (Phase 2)
  await r.executeCommand('ipsec proposal PROP-BR1');
  await r.executeCommand('transform esp');
  await r.executeCommand('esp encryption-algorithm aes-256');
  await r.executeCommand('esp authentication-algorithm sha2-256');
  await r.executeCommand('encapsulation-mode tunnel');
  await r.executeCommand('quit');

  // ACL for interesting traffic
  await r.executeCommand('acl 3001');
  await r.executeCommand('rule permit ip source 192.168.20.0 0.0.0.255 destination 192.168.10.0 0.0.0.255');
  await r.executeCommand('quit');

  // IPSec policy
  await r.executeCommand('ipsec policy PMAP-BR1 10 isakmp');
  await r.executeCommand('security acl 3001');
  await r.executeCommand('ike-peer HQ');
  await r.executeCommand('proposal PROP-BR1');
  await r.executeCommand('quit');

  // Apply to WAN interface
  await r.executeCommand('interface GE0/0/1');
  await r.executeCommand('ipsec policy PMAP-BR1');
  await r.executeCommand('quit');

  await r.executeCommand('return');
}

// ═══════════════════════════════════════════════════════════════════════════
// VPN Configuration — Branch2 (Cisco, IKEv2 PSK)
// ═══════════════════════════════════════════════════════════════════════════

async function configureBR2VPN(r: CiscoRouter, psk: string): Promise<void> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');

  // IKEv2 Proposal
  await r.executeCommand('crypto ikev2 proposal PROP-BR2');
  await r.executeCommand('encryption aes-cbc-256');
  await r.executeCommand('integrity sha256');
  await r.executeCommand('group 14');
  await r.executeCommand('exit');

  // IKEv2 Policy
  await r.executeCommand('crypto ikev2 policy POL-BR2');
  await r.executeCommand('proposal PROP-BR2');
  await r.executeCommand('exit');

  // IKEv2 Keyring
  await r.executeCommand('crypto ikev2 keyring KR-BR2');
  await r.executeCommand('peer HQ');
  await r.executeCommand('address 10.0.23.1');
  await r.executeCommand(`pre-shared-key ${psk}`);
  await r.executeCommand('exit');
  await r.executeCommand('exit');

  // IKEv2 Profile
  await r.executeCommand('crypto ikev2 profile PROF-BR2');
  await r.executeCommand('match identity remote address 10.0.23.1 255.255.255.255');
  await r.executeCommand('authentication remote pre-share');
  await r.executeCommand('authentication local pre-share');
  await r.executeCommand('keyring local KR-BR2');
  await r.executeCommand('exit');

  // Transform set
  await r.executeCommand('crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac');
  await r.executeCommand('mode tunnel');
  await r.executeCommand('exit');

  // ACL
  await r.executeCommand('ip access-list extended VPN-HQ');
  await r.executeCommand('permit ip 192.168.30.0 0.0.0.255 192.168.10.0 0.0.0.255');
  await r.executeCommand('exit');

  // Crypto map
  await r.executeCommand('crypto map CMAP-BR2 10 ipsec-isakmp');
  await r.executeCommand('set peer 10.0.23.1');
  await r.executeCommand('set ikev2-profile PROF-BR2');
  await r.executeCommand('set transform-set TSET');
  await r.executeCommand('match address VPN-HQ');
  await r.executeCommand('exit');

  // Apply
  await r.executeCommand('interface GigabitEthernet0/1');
  await r.executeCommand('crypto map CMAP-BR2');
  await r.executeCommand('exit');

  await r.executeCommand('end');
}

// ═══════════════════════════════════════════════════════════════════════════
// VPN Configuration — Branch3 (Huawei, IKEv1 PSK — weaker ciphers)
// ═══════════════════════════════════════════════════════════════════════════

async function configureBR3VPN(r: HuaweiRouter, psk: string): Promise<void> {
  await r.executeCommand('system-view');

  // IKE proposal — weaker: AES-128/SHA1/DH5
  await r.executeCommand('ike proposal 20');
  await r.executeCommand('encryption-algorithm aes-128');
  await r.executeCommand('authentication-algorithm sha1');
  await r.executeCommand('dh group5');
  await r.executeCommand('sa duration 86400');
  await r.executeCommand('quit');

  // IKE peer
  await r.executeCommand('ike peer HQ');
  await r.executeCommand(`pre-shared-key ${psk}`);
  await r.executeCommand('remote-address 10.0.34.1');
  await r.executeCommand('ike-proposal 20');
  await r.executeCommand('quit');

  // IPSec proposal — weaker
  await r.executeCommand('ipsec proposal PROP-BR3');
  await r.executeCommand('transform esp');
  await r.executeCommand('esp encryption-algorithm aes-128');
  await r.executeCommand('esp authentication-algorithm sha1');
  await r.executeCommand('encapsulation-mode tunnel');
  await r.executeCommand('quit');

  // ACL
  await r.executeCommand('acl 3002');
  await r.executeCommand('rule permit ip source 192.168.40.0 0.0.0.255 destination 192.168.10.0 0.0.0.255');
  await r.executeCommand('quit');

  // IPSec policy
  await r.executeCommand('ipsec policy PMAP-BR3 10 isakmp');
  await r.executeCommand('security acl 3002');
  await r.executeCommand('ike-peer HQ');
  await r.executeCommand('proposal PROP-BR3');
  await r.executeCommand('quit');

  // Apply
  await r.executeCommand('interface GE0/0/1');
  await r.executeCommand('ipsec policy PMAP-BR3');
  await r.executeCommand('quit');

  await r.executeCommand('return');
}
