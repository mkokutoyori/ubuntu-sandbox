import { describe, it, expect } from 'vitest';
import {
  cdpToNeighborDTO, lldpToNeighborDTO,
} from '@/network/devices/inspection/neighborConverters';
import type { CdpNeighbor } from '@/network/cdp/CdpAgent';
import type { LldpNeighbor } from '@/network/lldp/LldpAgent';

function lldpRow(overrides: Partial<LldpNeighbor> = {}): LldpNeighbor {
  return {
    localPort: 'Gi0/0',
    chassisId: '00:11:22:33:44:55',
    portId: 'Gi0/1',
    systemName: 'R2',
    systemDescription: 'Cisco IOS Software, C2900 Universal',
    remoteCapabilities: ['Router'],
    remoteType: 'router-cisco',
    ttlSec: 120,
    lastSeenMs: 0,
    ...overrides,
  } as LldpNeighbor;
}

describe('lldpToNeighborDTO', () => {
  it('keeps only the platform part before the first comma', () => {
    const [dto] = lldpToNeighborDTO([lldpRow()]);
    expect(dto.remotePlatform).toBe('Cisco IOS Software');
    expect(dto.remoteHost).toBe('R2');
    expect(dto.remotePort).toBe('Gi0/1');
  });

  it('keeps a comma-free description verbatim', () => {
    const [dto] = lldpToNeighborDTO([lldpRow({ systemDescription: 'Linux 6.1' })]);
    expect(dto.remotePlatform).toBe('Linux 6.1');
  });

  it('maps capabilities Router/Bridge/other to Router/Switch/Host', () => {
    expect(lldpToNeighborDTO([lldpRow({ remoteCapabilities: ['Router'] })])[0].remoteCapability).toBe('Router');
    expect(lldpToNeighborDTO([lldpRow({ remoteCapabilities: ['Bridge'] })])[0].remoteCapability).toBe('Switch');
    expect(lldpToNeighborDTO([lldpRow({ remoteCapabilities: ['Station'] })])[0].remoteCapability).toBe('Host');
    expect(lldpToNeighborDTO([lldpRow({ remoteCapabilities: [] })])[0].remoteCapability).toBe('Host');
  });

  it('handles an empty table', () => {
    expect(lldpToNeighborDTO([])).toEqual([]);
  });
});

describe('cdpToNeighborDTO', () => {
  it('is a field-for-field projection', () => {
    const row: CdpNeighbor = {
      localPort: 'Gi0/0',
      remoteHost: 'SW1',
      remotePort: 'Fa0/3',
      remoteType: 'switch-cisco',
      remotePlatform: 'cisco WS-C2960',
      remoteCapability: 'Switch',
      lastSeenMs: 0,
      holdtimeSec: 180,
    } as CdpNeighbor;
    expect(cdpToNeighborDTO([row])).toEqual([{
      localPort: 'Gi0/0',
      remoteHost: 'SW1',
      remotePort: 'Fa0/3',
      remoteType: 'switch-cisco',
      remotePlatform: 'cisco WS-C2960',
      remoteCapability: 'Switch',
    }]);
  });
});
