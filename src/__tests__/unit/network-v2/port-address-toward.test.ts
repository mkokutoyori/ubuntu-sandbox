import { describe, it, expect } from 'vitest';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { Port } from '@/network/hardware/Port';

const mask = (cidr: number): SubnetMask => SubnetMask.fromCIDR(cidr);
const portWith = (primary: [string, number] | null, ...others: Array<[string, number]>): Port => {
  const port = new Port('eth0');
  if (primary !== null) port.configureIP(new IPAddress(primary[0]), mask(primary[1]));
  for (const [address, cidr] of others) port.addSecondaryIP(new IPAddress(address), mask(cidr));
  return port;
};
const toward = (port: Port, hop: string): string | null => port.addressToward(new IPAddress(hop))?.toString() ?? null;

describe('the address an interface offers toward a next hop is the one inet_select_addr picks', () => {
  it('gives none to an interface without an address', () => {
    expect(toward(portWith(null), '10.0.0.9')).toBeNull();
  });

  it('gives the only address whatever the next hop', () => {
    const port = portWith(['10.0.0.1', 24]);
    expect(toward(port, '10.0.0.9')).toBe('10.0.0.1');
    expect(toward(port, '192.0.2.9')).toBe('10.0.0.1');
  });

  it('gives the address of the subnet the next hop is on, not the primary one', () => {
    const port = portWith(['10.0.0.1', 24], ['10.0.1.1', 24]);
    expect(toward(port, '10.0.1.9')).toBe('10.0.1.1');
    expect(toward(port, '10.0.0.9')).toBe('10.0.0.1');
  });

  it('falls back to the first primary address for a next hop that no subnet holds', () => {
    const port = portWith(['10.0.0.1', 24], ['10.0.1.1', 24]);
    expect(toward(port, '192.0.2.9')).toBe('10.0.0.1');
  });

  it('does not count a second address of the same subnet as another candidate', () => {
    const port = portWith(['10.0.0.1', 24], ['10.0.0.77', 24], ['10.0.1.1', 24]);
    expect(toward(port, '10.0.0.9')).toBe('10.0.0.1');
    expect(toward(port, '10.0.1.9')).toBe('10.0.1.1');
    expect(toward(port, '192.0.2.9')).toBe('10.0.0.1');
  });

  it('finds the subnet of a next hop among three', () => {
    const port = portWith(['10.0.0.1', 24], ['10.0.1.1', 24], ['10.0.2.1', 24]);
    expect(toward(port, '10.0.2.9')).toBe('10.0.2.1');
    expect(toward(port, '10.0.1.9')).toBe('10.0.1.1');
  });

  it('keeps an address with another prefix length as a candidate of its own', () => {
    const port = portWith(['10.0.0.1', 24], ['10.0.0.129', 25]);
    expect(toward(port, '10.0.0.200')).toBe('10.0.0.1');
    expect(toward(port, '192.0.2.9')).toBe('10.0.0.1');
  });
});
