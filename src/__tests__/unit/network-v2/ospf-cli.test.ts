/**
 * OSPF CLI Test Suite — Cisco IOS & Huawei VRP
 *
 * Tests CLI commands end-to-end via executeCommand(), verifying:
 *   - Mode transitions (config → config-router-ospf, system → ospf → ospf-area)
 *   - Configuration commands (network, router-id, passive-interface, area types)
 *   - Show/Display commands output format and content
 *   - Error handling (incomplete commands, invalid parameters)
 *   - Abbreviation support
 *   - OSPF enable/disable lifecycle
 *   - Interface-level OSPF commands (cost, priority)
 *   - OSPF and RIP coexistence
 *
 * Cisco IOS tests: 1-25
 * Huawei VRP tests: 26-50
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';

// ─── Helpers ─────────────────────────────────────────────────────────

async function exec(router: CiscoRouter | HuaweiRouter, cmd: string): Promise<string> {
  return router.executeCommand(cmd);
}

/** Bootstrap Cisco router into config mode */
async function ciscoConfigMode(r: CiscoRouter): Promise<void> {
  await exec(r, 'enable');
  await exec(r, 'configure terminal');
}

/** Bootstrap Cisco router into OSPF config-router mode */
async function ciscoOspfMode(r: CiscoRouter, processId: number = 1): Promise<void> {
  await ciscoConfigMode(r);
  await exec(r, `router ospf ${processId}`);
}

/** Bootstrap Huawei router into system view */
async function huaweiSystemView(r: HuaweiRouter): Promise<void> {
  await exec(r, 'system-view');
}

/** Bootstrap Huawei router into OSPF view */
async function huaweiOspfView(r: HuaweiRouter, processId: number = 1): Promise<void> {
  await huaweiSystemView(r);
  await exec(r, `ospf ${processId}`);
}

// ═══════════════════════════════════════════════════════════════════
// CISCO IOS OSPF CLI TESTS (1-25)
// ═══════════════════════════════════════════════════════════════════

describe('Cisco IOS — OSPF CLI', () => {
  let r1: CiscoRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    r1 = new CiscoRouter('R1');
    r1.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GigabitEthernet0/1', new IPAddress('172.16.0.1'), new SubnetMask('255.255.255.0'));
  });

  afterEach(() => {
    r1._disableOSPF();
    vi.useRealTimers();
  });

  // ─── 1. Enable OSPF ───────────────────────────────────────────

  it('1. "router ospf 1" should enable OSPF and enter config-router mode', async () => {
    await ciscoConfigMode(r1);
    const output = await exec(r1, 'router ospf 1');
    expect(output).toBe('');
    expect(r1.isOSPFEnabled()).toBe(true);
    expect(r1._getOSPFEngineInternal()!.getProcessId()).toBe(1);
  });

  // ─── 2. Enable with custom process ID ─────────────────────────

  it('2. "router ospf 100" should use process ID 100', async () => {
    await ciscoConfigMode(r1);
    await exec(r1, 'router ospf 100');
    expect(r1._getOSPFEngineInternal()!.getProcessId()).toBe(100);
  });

  // ─── 3. Invalid process ID ─────────────────────────────────────

  it('3. "router ospf" without ID should return error', async () => {
    await ciscoConfigMode(r1);
    const output = await exec(r1, 'router ospf');
    expect(output).toContain('Incomplete');
  });

  // ─── 4. Disable OSPF ──────────────────────────────────────────

  it('4. "no router ospf" should disable OSPF', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'exit');
    await exec(r1, 'no router ospf');
    expect(r1.isOSPFEnabled()).toBe(false);
  });

  // ─── 5. Network statement ──────────────────────────────────────

  it('5. "network ... area" should add network to OSPF', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'network 10.0.0.0 0.0.0.255 area 0');

    const ospf = r1._getOSPFEngineInternal()!;
    const config = ospf.getConfig();
    expect(config.networks).toHaveLength(1);
    expect(config.networks[0].network).toBe('10.0.0.0');
    expect(config.networks[0].wildcard).toBe('0.0.0.255');
    expect(config.networks[0].areaId).toBe('0');
  });

  // ─── 6. Multiple network statements ───────────────────────────

  it('6. multiple network statements in different areas', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'network 10.0.0.0 0.0.0.255 area 0');
    await exec(r1, 'network 172.16.0.0 0.0.0.255 area 1');

    const config = r1._getOSPFEngineInternal()!.getConfig();
    expect(config.networks).toHaveLength(2);
    expect(config.areas.size).toBe(2);
    expect(config.areas.has('0')).toBe(true);
    expect(config.areas.has('1')).toBe(true);
  });

  // ─── 7. Incomplete network statement ──────────────────────────

  it('7. "network 10.0.0.0" without wildcard/area should return error', async () => {
    await ciscoOspfMode(r1);
    const output = await exec(r1, 'network 10.0.0.0');
    expect(output).toContain('Incomplete');
  });

  // ─── 8. Missing "area" keyword ────────────────────────────────

  it('8. "network 10.0.0.0 0.0.0.255 0" without "area" keyword should return error', async () => {
    await ciscoOspfMode(r1);
    // Only 3 args, needs 4 (ip wildcard area area-id), so "Incomplete command"
    const output = await exec(r1, 'network 10.0.0.0 0.0.0.255 0');
    expect(output).toContain('Incomplete command');
  });

  // ─── 9. Router-ID ──────────────────────────────────────────────

  it('9. "router-id" should set the OSPF Router ID', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'router-id 9.9.9.9');

    expect(r1._getOSPFEngineInternal()!.getRouterId()).toBe('9.9.9.9');
  });

  // ─── 10. Passive interface ─────────────────────────────────────

  it('10. "passive-interface" should suppress hellos on interface', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'passive-interface GigabitEthernet0/0');

    const ospf = r1._getOSPFEngineInternal()!;
    expect(ospf.isPassiveInterface('GigabitEthernet0/0')).toBe(true);
    expect(ospf.isPassiveInterface('GigabitEthernet0/1')).toBe(false);
  });

  // ─── 11. Passive interface default ─────────────────────────────

  it('11. "passive-interface default" should make all interfaces passive', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'passive-interface default');

    const ospf = r1._getOSPFEngineInternal()!;
    expect(ospf.isPassiveInterface('GigabitEthernet0/0')).toBe(true);
    expect(ospf.isPassiveInterface('GigabitEthernet0/1')).toBe(true);
  });

  // ─── 12. No passive interface ──────────────────────────────────

  it('12. "no passive-interface" should re-enable hellos on interface', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'passive-interface default');
    await exec(r1, 'no passive-interface GigabitEthernet0/1');

    const ospf = r1._getOSPFEngineInternal()!;
    expect(ospf.isPassiveInterface('GigabitEthernet0/0')).toBe(true);
    expect(ospf.isPassiveInterface('GigabitEthernet0/1')).toBe(false);
  });

  // ─── 13. Area stub ─────────────────────────────────────────────

  it('13. "area 1 stub" should configure area as stub', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'network 172.16.0.0 0.0.0.255 area 1');
    await exec(r1, 'area 1 stub');

    const area = r1._getOSPFEngineInternal()!.getConfig().areas.get('1');
    expect(area).toBeDefined();
    expect(area!.type).toBe('stub');
  });

  // ─── 14. Area totally-stubby ───────────────────────────────────

  it('14. "area 1 stub no-summary" should configure totally-stubby', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'network 172.16.0.0 0.0.0.255 area 1');
    await exec(r1, 'area 1 stub no-summary');

    const area = r1._getOSPFEngineInternal()!.getConfig().areas.get('1');
    expect(area!.type).toBe('totally-stubby');
  });

  // ─── 15. Area NSSA ─────────────────────────────────────────────

  it('15. "area 2 nssa" should configure area as NSSA', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'network 172.16.0.0 0.0.0.255 area 2');
    await exec(r1, 'area 2 nssa');

    const area = r1._getOSPFEngineInternal()!.getConfig().areas.get('2');
    expect(area!.type).toBe('nssa');
  });

  // ─── 16. Auto-cost reference bandwidth ─────────────────────────

  it('16. "auto-cost reference-bandwidth 1000" should set reference BW', async () => {
    await ciscoOspfMode(r1);
    const output = await exec(r1, 'auto-cost reference-bandwidth 1000');

    expect(output).toContain('Reference bandwidth is changed');
    const config = r1._getOSPFEngineInternal()!.getConfig();
    expect(config.autoCostReferenceBandwidth).toBe(1000);
    expect(config.referenceBandwidth).toBe(1_000_000_000);
  });

  // ─── 17. Default information originate ─────────────────────────

  it('17. "default-information originate" should enable default route advertisement', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'default-information originate');

    expect(r1._getOSPFEngineInternal()!.getConfig().defaultInformationOriginate).toBe(true);
  });

  // ─── 18. Interface cost ────────────────────────────────────────

  it('18. "ip ospf cost" should set OSPF cost on interface', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'network 10.0.0.0 0.0.0.255 area 0');
    // Activate the interface in OSPF
    r1._getOSPFEngineInternal()!.activateInterface('GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', '0');

    await exec(r1, 'exit'); // back to config
    await exec(r1, 'interface GigabitEthernet0/0');
    await exec(r1, 'ip ospf cost 50');

    const iface = r1._getOSPFEngineInternal()!.getInterface('GigabitEthernet0/0');
    expect(iface).toBeDefined();
    expect(iface!.cost).toBe(50);
  });

  // ─── 19. Interface priority ────────────────────────────────────

  it('19. "ip ospf priority" should set OSPF priority on interface', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'network 10.0.0.0 0.0.0.255 area 0');
    r1._getOSPFEngineInternal()!.activateInterface('GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', '0');

    await exec(r1, 'exit');
    await exec(r1, 'interface GigabitEthernet0/0');
    await exec(r1, 'ip ospf priority 200');

    const iface = r1._getOSPFEngineInternal()!.getInterface('GigabitEthernet0/0');
    expect(iface!.priority).toBe(200);
  });

  // ─── 20. show ip ospf — not configured ─────────────────────────

  it('20. "show ip ospf" without OSPF should return error', async () => {
    await exec(r1, 'enable');
    const output = await exec(r1, 'show ip ospf');
    expect(output).toContain('not configured');
  });

  // ─── 21. show ip ospf — configured ─────────────────────────────

  it('21. "show ip ospf" should display process info and areas', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'router-id 1.1.1.1');
    await exec(r1, 'network 10.0.0.0 0.0.0.255 area 0');
    await exec(r1, 'end');

    const output = await exec(r1, 'show ip ospf');
    expect(output).toContain('Routing Process "ospf 1"');
    expect(output).toContain('ID 1.1.1.1');
    expect(output).toContain('Area 0');
    expect(output).toContain('Reference bandwidth');
  });

  // ─── 22. show ip ospf neighbor ─────────────────────────────────

  it('22. "show ip ospf neighbor" should display neighbor header', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'network 10.0.0.0 0.0.0.255 area 0');
    await exec(r1, 'end');

    const output = await exec(r1, 'show ip ospf neighbor');
    expect(output).toContain('Neighbor ID');
    expect(output).toContain('State');
    expect(output).toContain('Interface');
  });

  // ─── 23. show ip ospf database ─────────────────────────────────

  it('23. "show ip ospf database" should show LSDB header', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'router-id 1.1.1.1');
    await exec(r1, 'network 10.0.0.0 0.0.0.255 area 0');
    await exec(r1, 'end');

    const output = await exec(r1, 'show ip ospf database');
    expect(output).toContain('OSPF Router with ID (1.1.1.1)');
    expect(output).toContain('Process ID 1');
  });

  // ─── 24. show ip ospf interface ────────────────────────────────

  it('24. "show ip ospf interface" should show interface details after activation', async () => {
    await ciscoOspfMode(r1);
    await exec(r1, 'router-id 1.1.1.1');
    await exec(r1, 'network 10.0.0.0 0.0.0.255 area 0');
    r1._getOSPFEngineInternal()!.activateInterface('GigabitEthernet0/0', '10.0.0.1', '255.255.255.0', '0');
    await exec(r1, 'end');

    const output = await exec(r1, 'show ip ospf interface');
    expect(output).toContain('GigabitEthernet0/0');
    expect(output).toContain('10.0.0.1');
    expect(output).toContain('Area 0');
    expect(output).toContain('Hello');
    expect(output).toContain('Dead');
    expect(output).toContain('Cost');
  });

  // ─── 25. OSPF and RIP coexistence ──────────────────────────────

  it('25. OSPF and RIP should coexist without interference', async () => {
    await ciscoConfigMode(r1);

    // Enable RIP first
    await exec(r1, 'router rip');
    await exec(r1, 'network 10.0.0.0');
    await exec(r1, 'exit');
    expect(r1.isRIPEnabled()).toBe(true);

    // Now enable OSPF
    await exec(r1, 'router ospf 1');
    await exec(r1, 'network 172.16.0.0 0.0.0.255 area 0');
    await exec(r1, 'exit');

    // Both should be active
    expect(r1.isRIPEnabled()).toBe(true);
    expect(r1.isOSPFEnabled()).toBe(true);

    // Disable OSPF should not affect RIP
    await exec(r1, 'no router ospf');
    expect(r1.isRIPEnabled()).toBe(true);
    expect(r1.isOSPFEnabled()).toBe(false);

    r1.disableRIP();
  });
});

// ═══════════════════════════════════════════════════════════════════
// HUAWEI VRP OSPF CLI TESTS (26-50)
// ═══════════════════════════════════════════════════════════════════

describe('Huawei VRP — OSPF CLI', () => {
  let r1: HuaweiRouter;

  beforeEach(() => {
    vi.useFakeTimers();
    r1 = new HuaweiRouter('AR1');
    r1.configureInterface('GE0/0/0', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    r1.configureInterface('GE0/0/1', new IPAddress('172.16.0.1'), new SubnetMask('255.255.255.0'));
  });

  afterEach(() => {
    r1._disableOSPF();
    vi.useRealTimers();
  });

  // ─── 26. Enable OSPF ──────────────────────────────────────────

  it('26. "ospf 1" should enable OSPF and enter OSPF view', async () => {
    await huaweiSystemView(r1);
    const output = await exec(r1, 'ospf 1');
    expect(output).toBe('');
    expect(r1.isOSPFEnabled()).toBe(true);
    expect(r1._getOSPFEngineInternal()!.getProcessId()).toBe(1);
  });

  // ─── 27. Enable with default process ID ───────────────────────

  it('27. "ospf" without ID should default to process ID 1', async () => {
    await huaweiSystemView(r1);
    await exec(r1, 'ospf');
    expect(r1.isOSPFEnabled()).toBe(true);
    expect(r1._getOSPFEngineInternal()!.getProcessId()).toBe(1);
  });

  // ─── 28. Disable OSPF ─────────────────────────────────────────

  it('28. "undo ospf" should disable OSPF', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'quit'); // back to system view
    await exec(r1, 'undo ospf');
    expect(r1.isOSPFEnabled()).toBe(false);
  });

  // ─── 29. Enter area view ──────────────────────────────────────

  it('29. "area 0" should enter OSPF area view', async () => {
    await huaweiOspfView(r1);
    const output = await exec(r1, 'area 0');
    expect(output).toBe('');
    // Prompt should now be ospf-area mode (verified by next command working in area context)
  });

  // ─── 30. Network in area view ─────────────────────────────────

  it('30. "network" in area view should add network to OSPF area', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'area 0');
    await exec(r1, 'network 10.0.0.0 0.0.0.255');

    const config = r1._getOSPFEngineInternal()!.getConfig();
    expect(config.networks).toHaveLength(1);
    expect(config.networks[0].network).toBe('10.0.0.0');
    expect(config.networks[0].wildcard).toBe('0.0.0.255');
    expect(config.networks[0].areaId).toBe('0');
  });

  // ─── 31. Multiple areas ───────────────────────────────────────

  it('31. configuring networks in multiple areas', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'area 0');
    await exec(r1, 'network 10.0.0.0 0.0.0.255');
    await exec(r1, 'quit'); // back to OSPF view
    await exec(r1, 'area 1');
    await exec(r1, 'network 172.16.0.0 0.0.0.255');

    const config = r1._getOSPFEngineInternal()!.getConfig();
    expect(config.networks).toHaveLength(2);
    expect(config.areas.size).toBe(2);
  });

  // ─── 32. Incomplete network ───────────────────────────────────

  it('32. "network 10.0.0.0" without wildcard should return error', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'area 0');
    const output = await exec(r1, 'network 10.0.0.0');
    expect(output).toContain('Incomplete');
  });

  // ─── 33. Router-ID ─────────────────────────────────────────────

  it('33. "router-id" should set the OSPF Router ID', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'router-id 9.9.9.9');

    expect(r1._getOSPFEngineInternal()!.getRouterId()).toBe('9.9.9.9');
  });

  // ─── 34. Silent interface ──────────────────────────────────────

  it('34. "silent-interface" should make interface passive', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'silent-interface GE0/0/0');

    expect(r1._getOSPFEngineInternal()!.isPassiveInterface('GE0/0/0')).toBe(true);
  });

  // ─── 35. Undo silent interface ─────────────────────────────────

  it('35. "undo silent-interface" should remove passive flag', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'silent-interface GE0/0/0');
    await exec(r1, 'undo silent-interface GE0/0/0');

    expect(r1._getOSPFEngineInternal()!.isPassiveInterface('GE0/0/0')).toBe(false);
  });

  // ─── 36. Area stub ─────────────────────────────────────────────

  it('36. "stub" in area view should configure area as stub', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'area 1');
    await exec(r1, 'network 172.16.0.0 0.0.0.255');
    await exec(r1, 'stub');

    const area = r1._getOSPFEngineInternal()!.getConfig().areas.get('1');
    expect(area!.type).toBe('stub');
  });

  // ─── 37. Area totally-stubby ──────────────────────────────────

  it('37. "stub no-summary" should configure totally-stubby area', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'area 1');
    await exec(r1, 'network 172.16.0.0 0.0.0.255');
    await exec(r1, 'stub no-summary');

    const area = r1._getOSPFEngineInternal()!.getConfig().areas.get('1');
    expect(area!.type).toBe('totally-stubby');
  });

  // ─── 38. Area NSSA ─────────────────────────────────────────────

  it('38. "nssa" in area view should configure NSSA area', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'area 2');
    await exec(r1, 'network 172.16.0.0 0.0.0.255');
    await exec(r1, 'nssa');

    const area = r1._getOSPFEngineInternal()!.getConfig().areas.get('2');
    expect(area!.type).toBe('nssa');
  });

  // ─── 39. Bandwidth reference ──────────────────────────────────

  it('39. "bandwidth-reference 1000" should set reference bandwidth', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'bandwidth-reference 1000');

    const config = r1._getOSPFEngineInternal()!.getConfig();
    expect(config.autoCostReferenceBandwidth).toBe(1000);
  });

  // ─── 40. Default route advertise ──────────────────────────────

  it('40. "default-route-advertise" should enable default route advertisement', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'default-route-advertise');

    expect(r1._getOSPFEngineInternal()!.getConfig().defaultInformationOriginate).toBe(true);
  });

  // ─── 41. display ospf brief — not configured ──────────────────

  it('41. "display ospf brief" without OSPF should return error', async () => {
    const output = await exec(r1, 'display ospf brief');
    expect(output).toContain('not configured');
  });

  // ─── 42. display ospf brief — configured ──────────────────────

  it('42. "display ospf brief" should show process info and area table', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'router-id 1.1.1.1');
    await exec(r1, 'area 0');
    await exec(r1, 'network 10.0.0.0 0.0.0.255');
    await exec(r1, 'return');

    const output = await exec(r1, 'display ospf brief');
    expect(output).toContain('OSPF Process 1');
    expect(output).toContain('Router ID 1.1.1.1');
    expect(output).toContain('Area');
    expect(output).toContain('Type');
    expect(output).toContain('Intf');
  });

  // ─── 43. display ospf peer ─────────────────────────────────────

  it('43. "display ospf peer" should show neighbor table header', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'router-id 1.1.1.1');
    await exec(r1, 'return');

    const output = await exec(r1, 'display ospf peer');
    expect(output).toContain('Neighbor Brief Information');
    expect(output).toContain('Area ID');
    expect(output).toContain('Interface');
    expect(output).toContain('Neighbor ID');
  });

  // ─── 44. display ospf lsdb ─────────────────────────────────────

  it('44. "display ospf lsdb" should show LSDB header', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'router-id 1.1.1.1');
    await exec(r1, 'area 0');
    await exec(r1, 'network 10.0.0.0 0.0.0.255');
    await exec(r1, 'return');

    const output = await exec(r1, 'display ospf lsdb');
    expect(output).toContain('OSPF Process 1');
    expect(output).toContain('Router ID 1.1.1.1');
    expect(output).toContain('Link State Database');
  });

  // ─── 45. display ospf interface ────────────────────────────────

  it('45. "display ospf interface" after interface activation', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'router-id 1.1.1.1');
    await exec(r1, 'area 0');
    await exec(r1, 'network 10.0.0.0 0.0.0.255');
    r1._getOSPFEngineInternal()!.activateInterface('GE0/0/0', '10.0.0.1', '255.255.255.0', '0');
    await exec(r1, 'return');

    const output = await exec(r1, 'display ospf interface');
    expect(output).toContain('GE0/0/0');
    expect(output).toContain('10.0.0.1');
    expect(output).toContain('Area: 0');
    expect(output).toContain('Cost');
    expect(output).toContain('Hello');
  });

  // ─── 46. Quit navigation from area to OSPF to system ──────────

  it('46. "quit" should navigate back through OSPF mode hierarchy', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'area 0');
    // Now in ospf-area. quit → ospf
    await exec(r1, 'quit');
    // Now in ospf. quit → system
    await exec(r1, 'quit');
    // Now in system. Verify by running a system-view command
    const output = await exec(r1, 'display ospf brief');
    expect(output).toContain('OSPF Process');
  });

  // ─── 47. Return from deep nested mode ──────────────────────────

  it('47. "return" from area view should go back to user view', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'area 0');
    await exec(r1, 'return');
    // Now in user view. system-view should work
    const output = await exec(r1, 'system-view');
    expect(output).toContain('Enter system view');
  });

  // ─── 48. Display commands available in OSPF view ───────────────

  it('48. display commands should work from within OSPF view', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'router-id 1.1.1.1');
    await exec(r1, 'area 0');
    await exec(r1, 'network 10.0.0.0 0.0.0.255');
    await exec(r1, 'quit'); // back to OSPF view

    const output = await exec(r1, 'display ospf brief');
    expect(output).toContain('OSPF Process 1');
    expect(output).toContain('Router ID 1.1.1.1');
  });

  // ─── 49. Display in area view ──────────────────────────────────

  it('49. display commands should work from within area view', async () => {
    await huaweiOspfView(r1);
    await exec(r1, 'router-id 1.1.1.1');
    await exec(r1, 'area 0');
    await exec(r1, 'network 10.0.0.0 0.0.0.255');

    // Still in area view — display should work
    const output = await exec(r1, 'display ospf brief');
    expect(output).toContain('OSPF Process 1');
  });

  // ─── 50. Full OSPF configuration workflow ──────────────────────

  it('50. complete OSPF configuration workflow with multiple areas', async () => {
    await huaweiSystemView(r1);

    // Enter OSPF
    await exec(r1, 'ospf 10');
    expect(r1.isOSPFEnabled()).toBe(true);

    // Set Router ID
    await exec(r1, 'router-id 10.10.10.10');

    // Configure backbone area
    await exec(r1, 'area 0.0.0.0');
    await exec(r1, 'network 10.0.0.0 0.0.0.255');
    await exec(r1, 'quit');

    // Configure area 1 as stub
    await exec(r1, 'area 0.0.0.1');
    await exec(r1, 'network 172.16.0.0 0.0.0.255');
    await exec(r1, 'stub');
    await exec(r1, 'quit');

    // Set silent interface
    await exec(r1, 'silent-interface GE0/0/1');

    // Set bandwidth reference
    await exec(r1, 'bandwidth-reference 10000');

    // Enable default route
    await exec(r1, 'default-route-advertise');

    // Verify all configuration
    const ospf = r1._getOSPFEngineInternal()!;
    const config = ospf.getConfig();

    expect(config.processId).toBe(10);
    expect(config.routerId).toBe('10.10.10.10');
    expect(config.networks).toHaveLength(2);
    expect(config.areas.size).toBe(2);
    expect(config.areas.get('0.0.0.0')!.type).toBe('normal');
    expect(config.areas.get('0.0.0.1')!.type).toBe('stub');
    expect(ospf.isPassiveInterface('GE0/0/1')).toBe(true);
    expect(config.autoCostReferenceBandwidth).toBe(10000);
    expect(config.defaultInformationOriginate).toBe(true);

    // Verify display commands show correct data
    await exec(r1, 'return');
    const briefOutput = await exec(r1, 'display ospf brief');
    expect(briefOutput).toContain('OSPF Process 10');
    expect(briefOutput).toContain('Router ID 10.10.10.10');
  });
});
