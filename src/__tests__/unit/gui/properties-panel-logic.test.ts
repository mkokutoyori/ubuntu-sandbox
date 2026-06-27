/**
 * Tests for PropertiesPanel connection details logic.
 *
 * `bandwidth` / `latency` left this module in GAP §11.3 follow-up: those
 * values now come from the live Port via `useConnectionPerf` (covered by
 * `src/__tests__/unit/gui/use-connection-perf.test.ts`). This file only
 * covers the static type / interface / isActive pure projection.
 */

import { describe, it, expect } from 'vitest';
import { getConnectionDetails } from '@/components/network/properties-panel-logic';
import { Cable, Port } from '@/network';
import type { Connection } from '@/store/networkStore';

function makeConnectedCable(id: string): Cable {
  const cable = new Cable('cable-' + id);
  cable.connect(new Port('eth0'), new Port('eth0'));
  return cable;
}

function makeConnection(overrides: Partial<Connection> & { id: string; type: Connection['type'] }): Connection {
  return {
    sourceDeviceId: 'dev-1',
    sourceInterfaceId: 'eth0',
    targetDeviceId: 'dev-2',
    targetInterfaceId: 'eth0',
    cable: makeConnectedCable(overrides.id),
    ...overrides,
  };
}

describe('getConnectionDetails', () => {
  it('returns ethernet type + interfaces + active flag', () => {
    const connection = makeConnection({
      id: 'conn-1', type: 'ethernet',
      sourceInterfaceId: 'Ethernet0',
      targetInterfaceId: 'Ethernet0',
    });
    const details = getConnectionDetails(connection);
    expect(details.type).toBe('ethernet');
    expect(details.typeLabel).toBe('Ethernet');
    expect(details.sourceInterface).toBe('Ethernet0');
    expect(details.targetInterface).toBe('Ethernet0');
    expect(details.isActive).toBe(true);
  });

  it('returns serial type label', () => {
    const connection = makeConnection({
      id: 'conn-2', type: 'serial',
      sourceInterfaceId: 'serial0/0',
      targetInterfaceId: 'serial0/0',
    });
    expect(getConnectionDetails(connection).typeLabel).toBe('Serial');
  });

  it('returns console type label', () => {
    const connection = makeConnection({
      id: 'conn-3', type: 'console',
      sourceInterfaceId: 'console0',
      targetInterfaceId: 'console0',
    });
    expect(getConnectionDetails(connection).typeLabel).toBe('Console');
  });

  it('reports inactive when the cable has no peer ports', () => {
    const connection = makeConnection({
      id: 'conn-4', type: 'ethernet',
      cable: new Cable('cable-conn-4'),
    });
    expect(getConnectionDetails(connection).isActive).toBe(false);
  });

  it('omits bandwidth / latency fields (live values come from useConnectionPerf)', () => {
    const details = getConnectionDetails(makeConnection({ id: 'conn-5', type: 'ethernet' }));
    expect('bandwidth' in details).toBe(false);
    expect('latency' in details).toBe(false);
  });
});
