/**
 * FaultRegistry — aggregation, identity, resolution, causal grouping.
 *
 * These tests exercise the registry in isolation (no bus, no devices):
 * what is asserted is the contract every projection relies on
 * (docs/PRD-Pannes.md §6.1). The wiring to real events is covered by
 * fault-projection.test.ts, and the operator-visible behaviour by
 * e2e/faults-incident-registry.spec.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FaultRegistry } from '@/network/faults/FaultRegistry';
import { maxSeverity, loggerLevelFor, faultId } from '@/network/faults/FaultTypes';
import { FAULT_CATALOG } from '@/network/faults/faultCatalog';

let reg: FaultRegistry;
/** Deterministic clock so `since` / `durationMs` are assertable. */
let now = 1_000;

beforeEach(() => {
  reg = new FaultRegistry();
  now = 1_000;
  reg.setClock(() => now);
});

describe('raising a fault', () => {
  it('records it with the catalogue category and severity', () => {
    reg.raise({
      code: 'LINK_DOWN',
      deviceId: 'dev1',
      scope: 'eth0',
      summary: 'eth0 lost carrier (NO-CARRIER)',
    });

    const [fault] = reg.list();
    expect(fault.code).toBe('LINK_DOWN');
    expect(fault.category).toBe('physical');
    expect(fault.severity).toBe('critical');
    expect(fault.deviceId).toBe('dev1');
    expect(fault.scope).toBe('eth0');
    expect(fault.since).toBe(1_000);
  });

  it('lets the caller override severity, because severity follows the consequence', () => {
    // docs/PRD-Pannes.md §5 P7: the same carrier loss is critical on a
    // routed uplink and a notice on an unused port.
    reg.raise({
      code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth9',
      summary: 'eth9 lost carrier (NO-CARRIER)',
      severity: 'notice',
    });
    expect(reg.list()[0].severity).toBe('notice');
    expect(FAULT_CATALOG.LINK_DOWN.severity).toBe('critical');
  });

  it('uses the catalogue investigate/remedy unless overridden', () => {
    reg.raise({ code: 'SERVICE_FAILED', deviceId: 'd', scope: 'ssh', summary: 'x' });
    expect(reg.list()[0].investigate).toBe('systemctl status <unit>');

    reg.raise({
      code: 'SERVICE_FAILED', deviceId: 'd2', scope: 'ssh', summary: 'x',
      investigate: 'systemctl status ssh',
    });
    expect(reg.forDevice('d2')[0].investigate).toBe('systemctl status ssh');
  });
});

describe('identity and idempotence', () => {
  it('builds the id from device, code and scope', () => {
    const f = reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth0', summary: 's' });
    expect(f.id).toBe(faultId('dev1', 'LINK_DOWN', 'eth0'));
    expect(f.id).toBe('dev1:LINK_DOWN:eth0');
  });

  it('re-raising the same fault does not duplicate it', () => {
    for (let i = 0; i < 5; i++) {
      reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth0', summary: 's' });
    }
    expect(reg.list()).toHaveLength(1);
  });

  it('re-raising preserves the original `since`', () => {
    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth0', summary: 's' });
    now = 9_000;
    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth0', summary: 's' });

    // A port that flapped five times has been broken since the FIRST flap;
    // that is the number an operator needs.
    expect(reg.list()[0].since).toBe(1_000);
  });

  it('keeps faults on different scopes of the same device apart', () => {
    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth0', summary: 's' });
    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth1', summary: 's' });
    expect(reg.forDevice('dev1')).toHaveLength(2);
  });

  it('only notifies listeners on a genuinely new fault', () => {
    const seen: string[] = [];
    reg.subscribe(e => seen.push(e.kind));

    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth0', summary: 's' });
    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth0', summary: 's' });
    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth0', summary: 's' });

    expect(seen).toEqual(['raised']);
  });
});

describe('resolution', () => {
  it('removes the fault and reports how long it lasted', () => {
    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth0', summary: 's' });
    now = 4_500;
    const resolved = reg.resolve('dev1', 'LINK_DOWN', 'eth0');

    expect(reg.list()).toHaveLength(0);
    expect(resolved?.durationMs).toBe(3_500);
    expect(resolved?.resolvedAt).toBe(4_500);
  });

  it('is a no-op for a fault that was never raised', () => {
    // Projections call resolve() unconditionally on the inverse event
    // rather than tracking what they raised, so this must be safe.
    expect(reg.resolve('ghost', 'LINK_DOWN', 'eth0')).toBeNull();
    expect(reg.list()).toHaveLength(0);
  });

  it('notifies listeners once', () => {
    const seen: string[] = [];
    reg.subscribe(e => seen.push(e.kind));
    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth0', summary: 's' });
    reg.resolve('dev1', 'LINK_DOWN', 'eth0');
    reg.resolve('dev1', 'LINK_DOWN', 'eth0');
    expect(seen).toEqual(['raised', 'resolved']);
  });

  it('keeps resolved faults in a bounded, most-recent-first history', () => {
    reg.raise({ code: 'LINK_DOWN', deviceId: 'd', scope: 'eth0', summary: 'first' });
    reg.resolve('d', 'LINK_DOWN', 'eth0');
    reg.raise({ code: 'LINK_DOWN', deviceId: 'd', scope: 'eth1', summary: 'second' });
    reg.resolve('d', 'LINK_DOWN', 'eth1');

    const history = reg.recentlyResolved();
    expect(history[0].summary).toBe('second');
    expect(history[1].summary).toBe('first');
  });

  it('caps the resolved history at 50 entries', () => {
    for (let i = 0; i < 60; i++) {
      reg.raise({ code: 'LINK_DOWN', deviceId: 'd', scope: `eth${i}`, summary: 's' });
      reg.resolve('d', 'LINK_DOWN', `eth${i}`);
    }
    expect(reg.recentlyResolved()).toHaveLength(50);
  });

  it('clears every fault of a device at once', () => {
    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth0', summary: 's' });
    reg.raise({ code: 'SERVICE_FAILED', deviceId: 'dev1', scope: 'ssh', summary: 's' });
    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev2', scope: 'eth0', summary: 's' });

    reg.resolveAllForDevice('dev1');

    expect(reg.forDevice('dev1')).toHaveLength(0);
    expect(reg.forDevice('dev2')).toHaveLength(1);
  });

  it('clears every fault of one code on a device', () => {
    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth0', summary: 's' });
    reg.raise({ code: 'LINK_DOWN', deviceId: 'dev1', scope: 'eth1', summary: 's' });
    reg.raise({ code: 'SERVICE_FAILED', deviceId: 'dev1', scope: 'ssh', summary: 's' });

    reg.resolveAllOfCode('dev1', 'LINK_DOWN');

    expect(reg.forDevice('dev1').map(f => f.code)).toEqual(['SERVICE_FAILED']);
  });
});

describe('ordering and counting', () => {
  it('sorts worst severity first, then oldest first', () => {
    reg.raise({ code: 'DEVICE_POWERED_OFF', deviceId: 'a', scope: 'device', summary: 'notice' });
    now = 2_000;
    reg.raise({ code: 'SERVICE_FAILED', deviceId: 'b', scope: 'ssh', summary: 'critical-late' });
    now = 1_500;
    reg.raise({ code: 'LINK_DOWN', deviceId: 'c', scope: 'eth0', summary: 'critical-early' });

    expect(reg.list().map(f => f.summary))
      .toEqual(['critical-early', 'critical-late', 'notice']);
  });

  it('counts by severity', () => {
    reg.raise({ code: 'LINK_DOWN', deviceId: 'a', scope: 'eth0', summary: 's' });
    reg.raise({ code: 'SERVICE_FAILED', deviceId: 'b', scope: 'ssh', summary: 's' });
    reg.raise({ code: 'DEVICE_POWERED_OFF', deviceId: 'c', scope: 'device', summary: 's' });

    expect(reg.count()).toBe(3);
    expect(reg.count('critical')).toBe(2);
    expect(reg.count('notice')).toBe(1);
    expect(reg.count('degraded')).toBe(0);
  });

  it('answers `has` without needing the whole list', () => {
    reg.raise({ code: 'LINK_DOWN', deviceId: 'a', scope: 'eth0', summary: 's' });
    expect(reg.has('a', 'LINK_DOWN', 'eth0')).toBe(true);
    expect(reg.has('a', 'LINK_DOWN', 'eth1')).toBe(false);
  });
});

describe('causal grouping', () => {
  it('nests consequences under their cause instead of listing peers', () => {
    // docs/PRD-Pannes.md §18.2 U4: one pulled cable is ONE incident with
    // consequences, not eight alerts of equal weight.
    const cause = reg.raise({
      code: 'LINK_DOWN', deviceId: 'sw1', scope: 'Gi0/1',
      summary: 'Gi0/1 lost carrier (NO-CARRIER)',
    });
    reg.raise({
      code: 'SERVICE_FAILED', deviceId: 'srv1', scope: 'ssh',
      summary: 'ssh.service failed', causedBy: [cause.id],
    });
    reg.raise({
      code: 'SERVICE_FAILED', deviceId: 'srv1', scope: 'ntp',
      summary: 'ntp.service failed', causedBy: [cause.id],
    });

    const groups = reg.grouped();
    expect(groups).toHaveLength(1);
    expect(groups[0].root.id).toBe(cause.id);
    expect(groups[0].consequences.map(f => f.scope)).toEqual(['ssh', 'ntp']);
  });

  it('treats a fault whose cause is already resolved as a root of its own', () => {
    const cause = reg.raise({ code: 'LINK_DOWN', deviceId: 'sw1', scope: 'Gi0/1', summary: 's' });
    reg.raise({
      code: 'SERVICE_FAILED', deviceId: 'srv1', scope: 'ssh',
      summary: 'ssh.service failed', causedBy: [cause.id],
    });
    reg.resolve('sw1', 'LINK_DOWN', 'Gi0/1');

    // The cable is back but the service did not recover on its own: it is
    // now a problem in its own right, not an orphan hidden from the user.
    const groups = reg.grouped();
    expect(groups).toHaveLength(1);
    expect(groups[0].root.scope).toBe('ssh');
  });

  it('lists independent faults as separate roots', () => {
    reg.raise({ code: 'LINK_DOWN', deviceId: 'a', scope: 'eth0', summary: 's' });
    reg.raise({ code: 'SERVICE_FAILED', deviceId: 'b', scope: 'ssh', summary: 's' });
    expect(reg.grouped()).toHaveLength(2);
  });
});

describe('listener isolation', () => {
  it('a throwing listener does not stop the others', () => {
    let reached = false;
    reg.subscribe(() => { throw new Error('boom'); });
    reg.subscribe(() => { reached = true; });

    expect(() =>
      reg.raise({ code: 'LINK_DOWN', deviceId: 'a', scope: 'eth0', summary: 's' }),
    ).not.toThrow();
    expect(reached).toBe(true);
  });

  it('unsubscribing stops delivery', () => {
    let count = 0;
    const off = reg.subscribe(() => { count++; });
    reg.raise({ code: 'LINK_DOWN', deviceId: 'a', scope: 'eth0', summary: 's' });
    off();
    reg.raise({ code: 'LINK_DOWN', deviceId: 'b', scope: 'eth0', summary: 's' });
    expect(count).toBe(1);
  });
});

describe('severity helpers', () => {
  it('maxSeverity returns the worst of a set', () => {
    const mk = (severity: 'critical' | 'degraded' | 'notice') =>
      ({ severity }) as never;
    expect(maxSeverity([mk('notice'), mk('critical'), mk('degraded')])).toBe('critical');
    expect(maxSeverity([mk('notice'), mk('degraded')])).toBe('degraded');
    expect(maxSeverity([])).toBeNull();
  });

  it('projects severity onto the Logger levels', () => {
    expect(loggerLevelFor('critical')).toBe('error');
    expect(loggerLevelFor('degraded')).toBe('warn');
    expect(loggerLevelFor('notice')).toBe('info');
  });
});

describe('reset', () => {
  it('wipes active and resolved faults', () => {
    reg.raise({ code: 'LINK_DOWN', deviceId: 'a', scope: 'eth0', summary: 's' });
    reg.resolve('a', 'LINK_DOWN', 'eth0');
    reg.raise({ code: 'SERVICE_FAILED', deviceId: 'b', scope: 'ssh', summary: 's' });

    reg.reset();

    expect(reg.list()).toHaveLength(0);
    expect(reg.recentlyResolved()).toHaveLength(0);
  });
});
