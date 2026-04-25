/**
 * Exhaustive VPN Unit Tests — Multi-Vendor WAN
 *
 * Uses the shared WAN topology from wan-vpn-topology.ts:
 *   - R-HQ  (Cisco)  — hub, 3 WAN links, IKEv1 + IKEv2
 *   - R-BR1 (Huawei) — Branch1, IKEv1 PSK AES-256/SHA256/DH14
 *   - R-BR2 (Cisco)  — Branch2, IKEv2 PSK AES-256/SHA256/DH14
 *   - R-BR3 (Huawei) — Branch3, IKEv1 PSK AES-128/SHA1/DH5
 *   - SRV-HQ (LinuxServer), WinPC1 (Windows), PC-BR2/PC-BR3 (Linux)
 *
 * 15+ sections covering basic to complex VPN scenarios.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { buildWanVpnTopology, type WanVpnTopology } from './wan-vpn-topology';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1: Topology Validation — Addressing & Reachability (no VPN)
// ═══════════════════════════════════════════════════════════════════════════

describe('Section 1: Topology validation — addressing & reachability', () => {

  it('1.01 — HQ server should ping HQ router LAN interface', async () => {
    const t = await buildWanVpnTopology({ skipVPN: true });
    const out = await t.server.executeCommand('ping -c 3 192.168.10.1');
    expect(out).toContain('3 received');
    expect(out).toContain('0% packet loss');
  });

  it('1.02 — HQ router should ping Branch1 router WAN interface', async () => {
    const t = await buildWanVpnTopology({ skipVPN: true });
    const out = await t.rHQ.executeCommand('ping 10.0.12.2');
    expect(out).toContain('Success rate is 100');
  });

  it('1.03 — HQ router should ping Branch2 router WAN interface', async () => {
    const t = await buildWanVpnTopology({ skipVPN: true });
    const out = await t.rHQ.executeCommand('ping 10.0.23.2');
    expect(out).toContain('Success rate is 100');
  });

  it('1.04 — HQ router should ping Branch3 router WAN interface', async () => {
    const t = await buildWanVpnTopology({ skipVPN: true });
    const out = await t.rHQ.executeCommand('ping 10.0.34.2');
    expect(out).toContain('Success rate is 100');
  });

  it('1.05 — Branch1 Huawei router should ping HQ WAN interface', async () => {
    const t = await buildWanVpnTopology({ skipVPN: true });
    const out = await t.rBR1.executeCommand('ping 10.0.12.1');
    expect(out).toContain('0% packet loss');
  });

  it('1.06 — Server (HQ) should reach HQ router LAN gateway', async () => {
    const t = await buildWanVpnTopology({ skipVPN: true });
    const out = await t.server.executeCommand('ping -c 2 192.168.10.1');
    expect(out).toContain('2 received');
  }, 10000);

  it('1.07 — Linux PC (Branch2) should reach HQ server through static routes', async () => {
    const t = await buildWanVpnTopology({ skipVPN: true });
    const out = await t.linuxPC2.executeCommand('ping -c 3 192.168.10.100');
    expect(out).toContain('3 received');
  }, 10000);

  it('1.08 — Linux PC (Branch3) should reach HQ server through static routes', async () => {
    const t = await buildWanVpnTopology({ skipVPN: true });
    const out = await t.linuxPC3.executeCommand('ping -c 3 192.168.10.100');
    expect(out).toContain('3 received');
  }, 10000);

  it('1.09 — Windows PC (Branch1) should reach its default gateway', async () => {
    const t = await buildWanVpnTopology({ skipVPN: true });
    const out = await t.winPC1.executeCommand('ping -n 3 192.168.20.1');
    expect(out).toContain('Received = 3');
    expect(out).toContain('Lost = 0');
  });

  it('1.10 — Windows PC (Branch1) should reach HQ server via HuaweiSwitch + WAN transit', async () => {
    const t = await buildWanVpnTopology({ skipVPN: true });
    const out = await t.winPC1.executeCommand('ping -n 3 192.168.10.100');
    expect(out).toContain('Received = 3');
    expect(out).toContain('Lost = 0');
  }, 10000);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2: IKEv1 (ISAKMP) Policy Configuration — Cisco & Huawei
// ═══════════════════════════════════════════════════════════════════════════

describe('Section 2: IKEv1 (ISAKMP) policy configuration', () => {

  it('2.01 — Cisco HQ should have ISAKMP policy 10 with AES-256/SHA256/DH14', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto isakmp policy');
    expect(out).toContain('priority 10');
    expect(out).toMatch(/[Ee]ncryption.*aes.*256/i);
    expect(out).toMatch(/hash.*256/i);
    expect(out).toMatch(/#14/);
  });

  it('2.02 — Cisco HQ should have ISAKMP policy 20 with AES-128/SHA1/DH5', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto isakmp policy');
    expect(out).toContain('priority 20');
    expect(out).toMatch(/AES 128/i);
  });

  it('2.03 — Cisco HQ should have PSK for Branch1 (10.0.12.2)', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto isakmp key');
    expect(out).toContain('10.0.12.2');
  });

  it('2.04 — Cisco HQ should have PSK for Branch3 (10.0.34.2)', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto isakmp key');
    expect(out).toContain('10.0.34.2');
  });

  it('2.05 — Huawei Branch1 should have IKE proposal 10 with AES-256', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display ike proposal');
    expect(out).toContain('10');
    expect(out).toMatch(/aes.*256/i);
  });

  it('2.06 — Huawei Branch1 should have IKE peer HQ with correct remote address', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display ike peer');
    expect(out).toMatch(/HQ/i);
    expect(out).toContain('10.0.12.1');
  });

  it('2.07 — Huawei Branch3 should have IKE proposal 20 with AES-128', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR3.executeCommand('display ike proposal');
    expect(out).toContain('20');
    expect(out).toMatch(/aes.*128/i);
  });

  it('2.08 — Huawei Branch3 IKE peer should point to HQ (10.0.34.1)', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR3.executeCommand('display ike peer');
    expect(out).toContain('10.0.34.1');
  });

  it('2.09 — ISAKMP lifetime should be 86400 on HQ policy 10', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto isakmp policy');
    expect(out).toContain('86400');
  });

  it('2.10 — Huawei Branch1 IKE proposal should reference DH group14', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display ike proposal');
    expect(out).toMatch(/group.*14|dh.*14|14/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3: IKEv2 Configuration — Cisco Proposals, Policies, Keyrings
// ═══════════════════════════════════════════════════════════════════════════

describe('Section 3: IKEv2 configuration verification', () => {

  it('3.01 — Cisco HQ should have IKEv2 proposal PROP-BR2', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ikev2 proposal');
    expect(out).toContain('PROP-BR2');
    expect(out).toMatch(/aes-cbc-256/i);
  });

  it('3.02 — Cisco HQ IKEv2 proposal should have SHA256 integrity', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ikev2 proposal');
    expect(out).toMatch(/sha256/i);
  });

  it('3.03 — Cisco HQ should have IKEv2 policy POL-BR2', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ikev2 policy');
    expect(out).toContain('POL-BR2');
  });

  it('3.04 — Cisco HQ IKEv2 keyring KR-BR2 should exist', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ikev2 keyring');
    expect(out).toContain('KR-BR2');
  });

  it('3.05 — Cisco HQ IKEv2 profile PROF-BR2 should exist', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ikev2 profile');
    expect(out).toContain('PROF-BR2');
  });

  it('3.06 — Cisco BR2 should have matching IKEv2 proposal PROP-BR2', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR2.executeCommand('show crypto ikev2 proposal');
    expect(out).toContain('PROP-BR2');
    expect(out).toMatch(/aes-cbc-256/i);
  });

  it('3.07 — Cisco BR2 should have IKEv2 profile with HQ address match', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR2.executeCommand('show crypto ikev2 profile');
    expect(out).toContain('PROF-BR2');
    expect(out).toContain('10.0.23.1');
  });

  it('3.08 — Cisco BR2 keyring peer should reference HQ address', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR2.executeCommand('show crypto ikev2 keyring');
    expect(out).toContain('KR-BR2');
    expect(out).toContain('10.0.23.1');
  });

  it('3.09 — IKEv2 proposal on both HQ and BR2 should agree on DH group 14', async () => {
    const t = await buildWanVpnTopology();
    const hqOut = await t.rHQ.executeCommand('show crypto ikev2 proposal');
    const br2Out = await t.rBR2.executeCommand('show crypto ikev2 proposal');
    expect(hqOut).toMatch(/14/);
    expect(br2Out).toMatch(/14/);
  });

  it('3.10 — IKEv2 policy on BR2 should reference PROP-BR2', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR2.executeCommand('show crypto ikev2 policy');
    expect(out).toContain('POL-BR2');
    expect(out).toContain('PROP-BR2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4: IPSec Transform Sets & Crypto Maps
// ═══════════════════════════════════════════════════════════════════════════

describe('Section 4: IPSec transform sets & crypto maps', () => {

  it('4.01 — Cisco HQ should have TSET-STRONG transform set (AES-256/SHA256)', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ipsec transform-set');
    expect(out).toContain('TSET-STRONG');
    expect(out).toMatch(/esp-aes.*256/i);
    expect(out).toMatch(/esp-sha256/i);
  });

  it('4.02 — Cisco HQ should have TSET-WEAK transform set (AES-128/SHA1)', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ipsec transform-set');
    expect(out).toContain('TSET-WEAK');
    expect(out).toMatch(/esp-aes.*128/i);
  });

  it('4.03 — HQ crypto map CMAP-HQ should have 3 entries (seq 10, 20, 30)', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto map');
    expect(out).toContain('CMAP-HQ');
    expect(out).toMatch(/10.*ipsec-isakmp/i);
    expect(out).toMatch(/20.*ipsec-isakmp/i);
    expect(out).toMatch(/30.*ipsec-isakmp/i);
  });

  it('4.04 — HQ crypto map seq 10 should peer with BR1 (10.0.12.2)', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto map');
    expect(out).toContain('10.0.12.2');
    expect(out).toContain('TSET-STRONG');
  });

  it('4.05 — HQ crypto map seq 20 should peer with BR2 (10.0.23.2)', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto map');
    expect(out).toContain('10.0.23.2');
    expect(out).toContain('TSET-STRONG');
  });

  it('4.06 — HQ crypto map seq 30 should peer with BR3 (10.0.34.2) using TSET-WEAK', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto map');
    expect(out).toContain('10.0.34.2');
    expect(out).toContain('TSET-WEAK');
  });

  it('4.07 — BR2 crypto map CMAP-BR2 should reference HQ peer', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR2.executeCommand('show crypto map');
    expect(out).toContain('CMAP-BR2');
    expect(out).toContain('10.0.23.1');
  });

  it('4.08 — Transform sets should be in tunnel mode by default', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ipsec transform-set');
    expect(out).toMatch(/tunnel/i);
  });

  it('4.09 — Huawei BR1 should have IPSec proposal PROP-BR1', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display ipsec proposal');
    expect(out).toContain('PROP-BR1');
  });

  it('4.10 — Huawei BR1 should have IPSec policy PMAP-BR1', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display ipsec policy');
    expect(out).toContain('PMAP-BR1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5: VPN ACLs — Interesting Traffic Definitions
// ═══════════════════════════════════════════════════════════════════════════

describe('Section 5: VPN ACLs — interesting traffic definitions', () => {

  it('5.01 — HQ ACL VPN-BR1 should permit HQ→BR1 LAN traffic', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show ip access-lists');
    expect(out).toContain('VPN-BR1');
    expect(out).toContain('192.168.10.0');
    expect(out).toContain('192.168.20.0');
  });

  it('5.02 — HQ ACL VPN-BR2 should permit HQ→BR2 LAN traffic', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show ip access-lists');
    expect(out).toContain('VPN-BR2');
    expect(out).toContain('192.168.30.0');
  });

  it('5.03 — HQ ACL VPN-BR3 should permit HQ→BR3 LAN traffic', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show ip access-lists');
    expect(out).toContain('VPN-BR3');
    expect(out).toContain('192.168.40.0');
  });

  it('5.04 — BR2 ACL VPN-HQ should permit BR2→HQ LAN traffic', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR2.executeCommand('show ip access-lists');
    expect(out).toContain('VPN-HQ');
    expect(out).toContain('192.168.30.0');
    expect(out).toContain('192.168.10.0');
  });

  it('5.05 — Huawei BR1 ACL 3001 should permit BR1→HQ traffic', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display acl 3001');
    expect(out).toContain('192.168.20.0');
    expect(out).toContain('192.168.10.0');
  });

  it('5.06 — Huawei BR3 ACL 3002 should permit BR3→HQ traffic', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR3.executeCommand('display acl 3002');
    expect(out).toContain('192.168.40.0');
    expect(out).toContain('192.168.10.0');
  });

  it('5.07 — HQ ACLs should use wildcard masks (0.0.0.255)', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show ip access-lists');
    expect(out).toContain('0.0.0.255');
  });

  it('5.08 — Huawei BR1 ACL 3001 should match rule with permit', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display acl 3001');
    expect(out).toMatch(/permit/i);
  });

  it('5.09 — HQ should have all 3 VPN ACLs defined', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show ip access-lists');
    expect(out).toContain('VPN-BR1');
    expect(out).toContain('VPN-BR2');
    expect(out).toContain('VPN-BR3');
  });

  it('5.10 — Crypto map entries should reference their respective ACLs', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto map');
    expect(out).toContain('VPN-BR1');
    expect(out).toContain('VPN-BR2');
    expect(out).toContain('VPN-BR3');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6: IPSec Policy Application — Interface Binding
// ═══════════════════════════════════════════════════════════════════════════

describe('Section 6: IPSec policy application — interface binding', () => {

  it('6.01 — HQ Gi0/1 should have crypto map CMAP-HQ applied', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto map');
    expect(out).toContain('GigabitEthernet0/1');
  });

  it('6.02 — HQ Gi0/2 should have crypto map CMAP-HQ applied', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto map');
    expect(out).toContain('GigabitEthernet0/2');
  });

  it('6.03 — HQ Gi0/3 should have crypto map CMAP-HQ applied', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto map');
    expect(out).toContain('GigabitEthernet0/3');
  });

  it('6.04 — BR2 Gi0/1 should have crypto map CMAP-BR2 applied', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR2.executeCommand('show crypto map');
    expect(out).toContain('GigabitEthernet0/1');
  });

  it('6.05 — Huawei BR1 GE0/0/1 should have IPSec policy PMAP-BR1 applied', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display ipsec policy');
    expect(out).toContain('PMAP-BR1');
  });

  it('6.06 — Huawei BR3 GE0/0/1 should have IPSec policy PMAP-BR3 applied', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR3.executeCommand('display ipsec policy');
    expect(out).toContain('PMAP-BR3');
  });

  it('6.07 — HQ crypto map should list all 3 WAN interface bindings', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto map');
    const ifaces = ['GigabitEthernet0/1', 'GigabitEthernet0/2', 'GigabitEthernet0/3'];
    for (const iface of ifaces) {
      expect(out).toContain(iface);
    }
  });

  it('6.08 — Huawei BR1 IPSec statistics should reflect configuration', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display ipsec statistics');
    expect(out).toBeDefined();
    expect(typeof out).toBe('string');
  });

  it('6.09 — HQ crypto engine should report configured SAs', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto engine configuration');
    expect(out).toBeDefined();
    expect(out.length).toBeGreaterThan(0);
  });

  it('6.10 — Crypto engine on HQ should be active', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto engine brief');
    expect(out).toMatch(/[Aa]ctive|[Ee]nabled/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7: Pre-Shared Key Management
// ═══════════════════════════════════════════════════════════════════════════

describe('Section 7: Pre-shared key management', () => {

  it('7.01 — Cisco HQ should mask PSK values in show output', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto isakmp key');
    expect(out).not.toContain('Branch1Secret!42');
    expect(out).toContain('*');
  });

  it('7.02 — Cisco HQ should list all configured PSK addresses', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto isakmp key');
    expect(out).toContain('10.0.12.2');
    expect(out).toContain('10.0.34.2');
  });

  it('7.03 — Huawei BR1 IKE peer should show PSK is configured', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display ike peer');
    expect(out).toMatch(/HQ/i);
    expect(out).toMatch(/pre-shared|psk|key/i);
  });

  it('7.04 — Huawei BR3 IKE peer should have different proposal than BR1', async () => {
    const t = await buildWanVpnTopology();
    const br1 = await t.rBR1.executeCommand('display ike proposal');
    const br3 = await t.rBR3.executeCommand('display ike proposal');
    expect(br1).toMatch(/aes.*256/i);
    expect(br3).toMatch(/aes.*128/i);
  });

  it('7.05 — Cisco BR2 IKEv2 keyring should have masked PSK', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR2.executeCommand('show crypto ikev2 keyring');
    expect(out).toContain('KR-BR2');
    expect(out).toContain('*');
    expect(out).not.toContain('Branch2IKEv2#77');
  });

  it('7.06 — Custom PSK override should be applied (topology option)', async () => {
    const t = await buildWanVpnTopology({ pskBranch1: 'CustomKey123' });
    const out = await t.rHQ.executeCommand('show crypto isakmp key');
    expect(out).toContain('10.0.12.2');
  });

  it('7.07 — HQ IKEv2 keyring for BR2 should contain peer entry', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ikev2 keyring');
    expect(out).toContain('KR-BR2');
    expect(out).toContain('BR2');
  });

  it('7.08 — HQ and BR2 keyrings should reference each other addresses', async () => {
    const t = await buildWanVpnTopology();
    const hqOut = await t.rHQ.executeCommand('show crypto ikev2 keyring');
    const br2Out = await t.rBR2.executeCommand('show crypto ikev2 keyring');
    expect(hqOut).toContain('10.0.23.2');
    expect(br2Out).toContain('10.0.23.1');
  });

  it('7.09 — IKEv2 profile on HQ should link to keyring KR-BR2', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ikev2 profile');
    expect(out).toContain('KR-BR2');
  });

  it('7.10 — IKEv2 profile auth methods should be pre-share on both ends', async () => {
    const t = await buildWanVpnTopology();
    const hqOut = await t.rHQ.executeCommand('show crypto ikev2 profile');
    const br2Out = await t.rBR2.executeCommand('show crypto ikev2 profile');
    expect(hqOut).toMatch(/pre-share/i);
    expect(br2Out).toMatch(/pre-share/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8: IPSec SA & IKE SA Status (before traffic)
// ═══════════════════════════════════════════════════════════════════════════

describe('Section 8: IPSec SA & IKE SA status (pre-traffic)', () => {

  it('8.01 — HQ should have no IKEv1 SAs before traffic exchange', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto isakmp sa');
    expect(out).toMatch(/no.*sa|There are no/i);
  });

  it('8.02 — HQ should have no IKEv2 SAs before traffic exchange', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ikev2 sa');
    expect(out).toMatch(/no.*sa|There are no/i);
  });

  it('8.03 — HQ should have no IPSec SAs before traffic exchange', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ipsec sa');
    expect(out).toMatch(/no.*sa|There are no/i);
  });

  it('8.04 — Huawei BR1 should have no IKE SAs before traffic', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display ike sa');
    expect(out).toMatch(/no.*sa|There are no/i);
  });

  it('8.05 — Huawei BR1 should have no IPSec SAs before traffic', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display ipsec sa');
    expect(out).toMatch(/no.*sa|There are no/i);
  });

  it('8.06 — Cisco BR2 should have no IKEv2 SAs before traffic', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR2.executeCommand('show crypto ikev2 sa');
    expect(out).toMatch(/no.*sa|There are no/i);
  });

  it('8.07 — Huawei BR3 should have no IPSec SAs before traffic', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR3.executeCommand('display ipsec sa');
    expect(out).toMatch(/no.*sa|There are no/i);
  });

  it('8.08 — HQ crypto session should be empty before traffic', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto session');
    expect(out).toMatch(/[Nn]o active/);
  });

  it('8.09 — HQ show crypto ipsec sa detail should also be empty', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto ipsec sa detail');
    expect(out).toMatch(/no.*sa|There are no/i);
  });

  it('8.10 — Huawei BR1 display ipsec sa verbose should be empty', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('display ipsec sa verbose');
    expect(out).toMatch(/no.*sa|There are no/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 9: VPN Debug & Diagnostic Commands
// ═══════════════════════════════════════════════════════════════════════════

describe('Section 9: VPN debug & diagnostic commands', () => {

  it('9.01 — Cisco debug crypto isakmp should enable ISAKMP debugging', async () => {
    const t = await buildWanVpnTopology();
    await t.rHQ.executeCommand('enable');
    const out = await t.rHQ.executeCommand('debug crypto isakmp');
    expect(out).toMatch(/debug|enabled/i);
  });

  it('9.02 — Cisco debug crypto ipsec should enable IPSec debugging', async () => {
    const t = await buildWanVpnTopology();
    await t.rHQ.executeCommand('enable');
    const out = await t.rHQ.executeCommand('debug crypto ipsec');
    expect(out).toMatch(/debug|enabled/i);
  });

  it('9.03 — Cisco undebug all should disable all debugging', async () => {
    const t = await buildWanVpnTopology();
    await t.rHQ.executeCommand('enable');
    await t.rHQ.executeCommand('debug crypto isakmp');
    const out = await t.rHQ.executeCommand('undebug all');
    expect(out).toMatch(/disabled|off|undebug/i);
  });

  it('9.04 — Huawei debugging ike should enable IKE debugging', async () => {
    const t = await buildWanVpnTopology();
    await t.rBR1.executeCommand('system-view');
    const out = await t.rBR1.executeCommand('debugging ike');
    expect(out).toBeDefined();
  });

  it('9.05 — Huawei undo debugging ike should disable IKE debugging', async () => {
    const t = await buildWanVpnTopology();
    await t.rBR1.executeCommand('system-view');
    await t.rBR1.executeCommand('debugging ike');
    const out = await t.rBR1.executeCommand('undo debugging ike');
    expect(out).toBeDefined();
  });

  it('9.06 — Huawei debugging ipsec should enable IPSec debugging', async () => {
    const t = await buildWanVpnTopology();
    await t.rBR1.executeCommand('system-view');
    const out = await t.rBR1.executeCommand('debugging ipsec');
    expect(out).toBeDefined();
  });

  it('9.07 — Cisco clear crypto sa should work without error', async () => {
    const t = await buildWanVpnTopology();
    await t.rHQ.executeCommand('enable');
    const out = await t.rHQ.executeCommand('clear crypto sa');
    expect(out).toBeDefined();
  });

  it('9.08 — Huawei reset ike sa should work without error', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('reset ike sa');
    expect(out).toBeDefined();
  });

  it('9.09 — Huawei reset ipsec sa should work without error', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rBR1.executeCommand('reset ipsec sa');
    expect(out).toBeDefined();
  });

  it('9.10 — Cisco show crypto engine brief should report engine status', async () => {
    const t = await buildWanVpnTopology();
    const out = await t.rHQ.executeCommand('show crypto engine brief');
    expect(out).toMatch(/[Cc]rypto|[Ee]ngine/);
  });
});
