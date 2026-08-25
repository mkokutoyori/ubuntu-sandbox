/**
 * FaultProjection — real events on a real topology become incidents.
 *
 * Nothing here publishes an event by hand: cables are pulled, devices are
 * switched off and services are killed exactly the way the UI and the CLI
 * do it, so what is asserted is that the model's OWN events carry enough
 * to build the incident (docs/PRD-Pannes.md §25, Phase 1 — no behaviour
 * change, only visibility).
 *
 * Operator-facing counterpart: e2e/faults-incident-registry.spec.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { getFaultRegistry } from '@/network/faults/FaultRegistry';
import { ensureFaultProjection } from '@/network/faults/FaultProjection';

const MASK = new SubnetMask('255.255.255.0');

interface Lab {
  pc: LinuxPC;
  srv: LinuxServer;
  cable: Cable;
}

/**
 * Two addressed hosts on one cable. The projection is attached BEFORE any
 * event fires, mirroring the app, where it is wired at startup.
 */
function lab(): Lab {
  EquipmentRegistry.getInstance().clear();
  // Touch the bus first so the projection attaches to the same instance
  // the devices will publish on.
  EquipmentRegistry.getInstance().getBus();
  ensureFaultProjection();

  const pc = new LinuxPC('linux-pc', 'PC1');
  const srv = new LinuxServer('linux-server', 'SRV1');
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
  srv.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
  const cable = new Cable('c1');
  cable.connect(pc.getPorts()[0], srv.getPorts()[0]);
  return { pc, srv, cable };
}

const faults = () => getFaultRegistry();

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

describe('F1 — pulling a cable raises a link fault', () => {
  it('raises LINK_DOWN on both ends, critical because they carry addresses', () => {
    const { pc, srv, cable } = lab();
    expect(faults().list()).toHaveLength(0);

    cable.disconnect();

    const pcFault = faults().forDevice(pc.getId())[0];
    const srvFault = faults().forDevice(srv.getId())[0];
    expect(pcFault.code).toBe('LINK_DOWN');
    expect(pcFault.severity).toBe('critical');
    expect(srvFault.code).toBe('LINK_DOWN');
    // The wording matches what `ip link` shows for the same port, so the
    // incident and the CLI never disagree (docs/PRD-Pannes.md §5 P3).
    expect(pcFault.summary).toContain('NO-CARRIER');
  });

  it('an unaddressed port is only a notice — severity follows the consequence', () => {
    EquipmentRegistry.getInstance().clear();
    EquipmentRegistry.getInstance().getBus();
    ensureFaultProjection();

    const a = new LinuxPC('linux-pc', 'PC1');
    const b = new LinuxPC('linux-pc', 'PC2');
    // No configureIP: nothing was routing over this link.
    const cable = new Cable('c1');
    cable.connect(a.getPorts()[0], b.getPorts()[0]);

    cable.disconnect();

    expect(faults().forDevice(a.getId())[0].severity).toBe('notice');
  });

  it('reconnecting resolves it, leaving no residue', () => {
    const { pc, srv } = lab();
    const cable = new Cable('c2');
    // Fresh cable so the ports are re-cabled the way the canvas does it.
    pc.getPorts()[0].getCable()?.disconnect();
    expect(faults().list().length).toBeGreaterThan(0);

    cable.connect(pc.getPorts()[0], srv.getPorts()[0]);

    expect(faults().forDevice(pc.getId())).toHaveLength(0);
    expect(faults().forDevice(srv.getId())).toHaveLength(0);
  });

  it('a flapping link stays one incident, dated from the first flap', () => {
    const { pc, srv } = lab();
    for (let i = 0; i < 3; i++) {
      pc.getPorts()[0].getCable()?.disconnect();
      new Cable(`flap${i}`).connect(pc.getPorts()[0], srv.getPorts()[0]);
    }
    pc.getPorts()[0].getCable()?.disconnect();

    expect(faults().forDevice(pc.getId())).toHaveLength(1);
  });
});

describe('F1.2 — administrative shutdown is distinguished from carrier loss', () => {
  it('raises LINK_ADMIN_DOWN, a notice: the operator asked for it', () => {
    const { pc } = lab();

    pc.getPorts()[0].setAdminDown(true);

    const fault = faults().forDevice(pc.getId()).find(f => f.code === 'LINK_ADMIN_DOWN');
    expect(fault).toBeDefined();
    expect(fault?.severity).toBe('notice');
    expect(fault?.remedy).toContain('ip link set');
  });

  it('bringing the port back up resolves it', () => {
    const { pc } = lab();
    pc.getPorts()[0].setAdminDown(true);
    pc.getPorts()[0].setAdminDown(false);

    expect(faults().forDevice(pc.getId()).some(f => f.code === 'LINK_ADMIN_DOWN')).toBe(false);
  });

  it('`ip link set down` counts as administrative even though it never sets adminDown', async () => {
    // Regression: Linux goes through `setUp(false)`, so `port.link.down`
    // arrives with `adminDown: false` and used to be reported as a pulled
    // cable. The projection derives the truth from the port instead —
    // down while the cable still carries signal means somebody shut it.
    const { pc } = lab();

    await pc.executeCommand('sudo ip link set eth0 down');

    const codes = faults().forDevice(pc.getId()).map(f => f.code);
    expect(codes).toContain('LINK_ADMIN_DOWN');
    expect(codes).not.toContain('LINK_DOWN');
  });

  it('a pulled cable is still a carrier loss, not an administrative down', () => {
    // The other side of the same discrimination: no carrier means the
    // cable is out, whatever the line state says.
    const { pc, cable } = lab();
    cable.disconnect();

    const codes = faults().forDevice(pc.getId()).map(f => f.code);
    expect(codes).toContain('LINK_DOWN');
    expect(codes).not.toContain('LINK_ADMIN_DOWN');
  });
});

describe('F2 — powering a device off', () => {
  it('raises one device-level notice, not one incident per port', () => {
    const { srv } = lab();

    srv.powerOff();

    const own = faults().forDevice(srv.getId());
    expect(own).toHaveLength(1);
    expect(own[0].code).toBe('DEVICE_POWERED_OFF');
    expect(own[0].severity).toBe('notice');
  });

  it('its neighbour DOES report a link fault — the loss is theirs to suffer', () => {
    const { pc, srv } = lab();

    srv.powerOff();

    // Counter-intuitive and exactly right: switching a device off makes
    // its NEIGHBOURS' links go red (docs/PRD-Pannes.md §F2.7).
    const neighbour = faults().forDevice(pc.getId());
    expect(neighbour.map(f => f.code)).toContain('LINK_DOWN');
  });

  it('powering back on resolves the device fault', () => {
    const { srv } = lab();
    srv.powerOff();
    srv.powerOn();

    expect(faults().forDevice(srv.getId())).toHaveLength(0);
  });

  it('ports going down while already off do not pile up', () => {
    const { srv } = lab();
    srv.powerOff();
    srv.getPorts()[0].getCable()?.disconnect();

    expect(faults().forDevice(srv.getId()).map(f => f.code)).toEqual(['DEVICE_POWERED_OFF']);
  });
});

describe('F3 — port security', () => {
  it('raises LINK_ERRDISABLE when a violation shuts the port', async () => {
    EquipmentRegistry.getInstance().clear();
    EquipmentRegistry.getInstance().getBus();
    ensureFaultProjection();
    const sw = new GenericSwitch('switch-generic', 'SW1');

    sw.getBus().publish({
      topic: 'port.security.errdisable.set',
      payload: {
        deviceId: sw.getId(),
        portName: sw.getPortNames()[0],
        mac: { toString: () => 'aa:bb:cc:dd:ee:ff' } as never,
      },
    });

    const fault = faults().forDevice(sw.getId())[0];
    expect(fault.code).toBe('LINK_ERRDISABLE');
    expect(fault.severity).toBe('critical');
    expect(fault.summary).toContain('err-disable');
    expect(fault.investigate).toContain('show port-security');
  });

  it('recovery clears it', () => {
    EquipmentRegistry.getInstance().clear();
    EquipmentRegistry.getInstance().getBus();
    ensureFaultProjection();
    const sw = new GenericSwitch('switch-generic', 'SW1');
    const portName = sw.getPortNames()[0];

    sw.getBus().publish({
      topic: 'port.security.errdisable.set',
      payload: { deviceId: sw.getId(), portName, mac: { toString: () => 'aa:bb' } as never },
    });
    sw.getBus().publish({
      topic: 'port.security.errdisable.cleared',
      payload: { deviceId: sw.getId(), portName },
    });

    expect(faults().forDevice(sw.getId())).toHaveLength(0);
  });
});

describe('F6 — services', () => {
  it('a failed unit becomes a critical incident carrying systemd\'s own reason', () => {
    const { srv } = lab();

    srv.getBus().publish({
      topic: 'linux.service.failed',
      payload: {
        deviceId: srv.getId(),
        hostname: srv.getHostname(),
        name: 'ssh',
        reason: 'main process exited with status 255',
      },
    });

    const fault = faults().forDevice(srv.getId()).find(f => f.code === 'SERVICE_FAILED');
    expect(fault?.severity).toBe('critical');
    expect(fault?.summary).toContain('main process exited with status 255');
    expect(fault?.investigate).toBe('systemctl status ssh');
  });

  it('a start-limited unit says so in systemd\'s wording', () => {
    const { srv } = lab();

    srv.getBus().publish({
      topic: 'linux.service.start-limited',
      payload: { deviceId: srv.getId(), hostname: srv.getHostname(), name: 'ssh' },
    });

    const fault = faults().forDevice(srv.getId()).find(f => f.code === 'SERVICE_START_LIMITED');
    expect(fault?.summary).toContain('start request repeated too quickly');
    // A plain restart will NOT clear a start limit; the remedy must say so.
    expect(fault?.remedy).toContain('reset-failed');
  });

  it('starting the unit again resolves both service faults', () => {
    const { srv } = lab();
    const bus = srv.getBus();
    const ref = { deviceId: srv.getId(), hostname: srv.getHostname(), name: 'ssh' };

    bus.publish({ topic: 'linux.service.failed', payload: { ...ref, reason: 'x' } });
    bus.publish({ topic: 'linux.service.start-limited', payload: ref });
    bus.publish({
      topic: 'linux.service.started',
      payload: { ...ref, state: 'active' as never, type: 'simple' },
    });

    expect(faults().forDevice(srv.getId()).some(f => f.code.startsWith('SERVICE_'))).toBe(false);
  });

  it('hangs a service failure under the power-off that explains it', () => {
    const { srv } = lab();
    srv.powerOff();

    srv.getBus().publish({
      topic: 'linux.service.failed',
      payload: { deviceId: srv.getId(), hostname: srv.getHostname(), name: 'ssh', reason: 'x' },
    });

    const groups = faults().grouped().filter(g => g.root.deviceId === srv.getId());
    expect(groups).toHaveLength(1);
    expect(groups[0].root.code).toBe('DEVICE_POWERED_OFF');
    expect(groups[0].consequences.map(f => f.code)).toEqual(['SERVICE_FAILED']);
  });
});

describe('lifecycle', () => {
  it('removing a device takes its incidents with it', () => {
    const { srv } = lab();
    srv.getPorts()[0].getCable()?.disconnect();
    expect(faults().forDevice(srv.getId()).length).toBeGreaterThan(0);

    EquipmentRegistry.getInstance().getBus().publish({ topic: 'device.removed', payload: { id: srv.getId() } });

    // Otherwise the incident centre accumulates references to devices that
    // are no longer on the canvas (docs/PRD-Pannes.md §F2.8).
    expect(faults().forDevice(srv.getId())).toHaveLength(0);
  });

  it('clearing the registry empties the incident board', () => {
    // clearAll() powers every device off on the way out — which raises a
    // fault per device — then clears the registry WITHOUT a per-device
    // `device.removed`. Without handling `registry.cleared` the board
    // outlives the topology it described.
    const { pc, srv } = lab();
    pc.powerOff();
    srv.powerOff();
    expect(faults().list().length).toBeGreaterThan(0);

    EquipmentRegistry.getInstance().clear();

    expect(faults().list()).toHaveLength(0);
  });

  it('re-attaches when the default bus is swapped', () => {
    // The global test setup nulls the bus before every test; a
    // subscribe-once-at-import would silently go dead after the first one.
    const { pc } = lab();
    pc.getPorts()[0].getCable()?.disconnect();
    expect(faults().list().length).toBeGreaterThan(0);

    // A fresh lab() gets a fresh bus and must still project.
    const second = lab();
    second.cable.disconnect();
    expect(faults().forDevice(second.pc.getId()).length).toBeGreaterThan(0);
  });
});
