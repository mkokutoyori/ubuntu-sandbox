import { describe, it, expect } from 'vitest';
import { getServiceName } from '@/network/core/WellKnownPorts';
import { IanaServiceRegistry } from '@/network/core/ports/IanaServiceRegistry';
import { serviceName as nmapServiceName } from '@/network/scan/nmap/ServiceRegistry';

describe('Port 465 (smtps) registered consistently (§2.1.16, P18)', () => {
  it('WellKnownPorts resolves 465/tcp to smtps', () => {
    expect(getServiceName(465, 'tcp')).toBe('smtps');
  });

  it('IanaServiceRegistry resolves 465/tcp to smtps', () => {
    const registry = IanaServiceRegistry.standard();
    expect(registry.resolveName(465, 'tcp')).toBe('smtps');
    expect(registry.resolvePort('smtps', 'tcp')).toBe(465);
  });

  it('is now consistent with the nmap service registry, which already had it', () => {
    expect(nmapServiceName(465, 'tcp')).toBe('smtps');
    const registry = IanaServiceRegistry.standard();
    expect(registry.resolveName(465, 'tcp')).toBe(nmapServiceName(465, 'tcp'));
  });
});
