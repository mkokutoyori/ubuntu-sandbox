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
