/*
 * Probe — a port with BPDU Guard that receives a BPDU is err-disabled, and
 * `show interfaces status` says so with "err-disabled", not "disabled".
 *
 * Before (FortiGate battery 03, test 104): the guard already shut the port
 * on a received BPDU, but the status table read "disabled" (the port is
 * merely down) — the same word an admin-shut port shows, hiding the cause.
 * The test itself invoked a fictitious `send_bpdu` on a Linux host, which
 * cannot originate STP BPDUs; the real trigger is a switch on the wire.
 *
 * Authority: Cisco IOS `show interfaces status` prints "err-disabled" for
 * a port shut by an err-disable cause (BPDU Guard, port-security,
 * arp-inspection, storm-control), distinct from "disabled" (admin down)
 * and "notconnect" (no link). BPDU Guard shuts a PortFast/guarded access
 * port the instant it hears any BPDU (Catalyst STP configuration guide).
 *
 * Measured before the change (git stash of src/network/devices): only
 * "show interfaces status reads err-disabled" fails — the guard already
 * shut the port and stopped it forwarding; the defect was the status word.
 * The other four prove the mechanism and the lab are sound (a witness that
 * a connected port reads "connected", non-regression that an admin-shut
 * port stays "disabled"), so the one refusal measures the rendering.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { Cable } from '@/network/hardware/Cable';

async function aggressorOnGuardedPort(): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
  const root = new CiscoSwitch('switch-cisco', 'ROOT', 8);
  sw.powerOn();
  root.powerOn();
  for (const c of ['enable', 'configure terminal', 'spanning-tree vlan 1 priority 0', 'end']) {
    await root.executeCommand(c);
  }
  for (const c of ['enable', 'configure terminal', 'interface FastEthernet0/3', 'spanning-tree bpduguard enable', 'end']) {
    await sw.executeCommand(c);
  }
  new Cable('rogue').connect(sw.getPort('FastEthernet0/3') as never, root.getPort('FastEthernet0/1') as never);
  return sw;
}

describe('BPDU Guard err-disables a port that hears a BPDU', () => {
  it('a normal access port is connected', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    const peer = new CiscoSwitch('switch-cisco', 'P', 8);
    sw.powerOn();
    peer.powerOn();
    new Cable('c').connect(sw.getPort('FastEthernet0/3') as never, peer.getPort('FastEthernet0/1') as never);
    expect(await sw.executeCommand('show interfaces FastEthernet0/3 status')).toMatch(/^Fa0\/3\s+connected/m);
  });

  it('the guarded port is err-disabled on the wire', async () => {
    const sw = await aggressorOnGuardedPort();
    expect([...sw._getBpduGuardErrDisabledPorts()]).toContain('FastEthernet0/3');
  });

  it('show interfaces status reads err-disabled', async () => {
    const sw = await aggressorOnGuardedPort();
    expect(await sw.executeCommand('show interfaces FastEthernet0/3 status')).toMatch(/^Fa0\/3\s+err-disabled/m);
  });

  it('the port is not forwarding once err-disabled', async () => {
    const sw = await aggressorOnGuardedPort();
    expect(sw.getPort('FastEthernet0/3')!.getIsUp()).toBe(false);
  });

  it('an admin-shut port reads disabled, not err-disabled', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW', 8);
    sw.powerOn();
    for (const c of ['enable', 'configure terminal', 'interface FastEthernet0/4', 'shutdown', 'end']) {
      await sw.executeCommand(c);
    }
    const out = await sw.executeCommand('show interfaces FastEthernet0/4 status');
    expect(out).toMatch(/^Fa0\/4\s+disabled/m);
    expect(out).not.toContain('err-disabled');
  });
});
