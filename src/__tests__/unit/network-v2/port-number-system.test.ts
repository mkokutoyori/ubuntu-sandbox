/**
 * Port-number domain model — unit tests.
 *
 * Exercises the cross-OS port subsystem model:
 *   - PortNumber          — RFC 6335 range classification & privilege
 *   - IanaServiceRegistry — the port ⇄ service-name database (/etc/services)
 *   - PortBindingPolicy   — the privileged-port binding rule
 *
 * Coverage spans the happy path and the awkward edges: range boundaries,
 * invalid input, aliases, unassigned ports and the POSIX/Windows split.
 */

import { describe, it, expect } from 'vitest';
import {
  PortNumber,
  PortClass,
  MAX_PORT,
} from '@/network/core/ports/PortNumber';
import { IanaServiceRegistry } from '@/network/core/ports/IanaServiceRegistry';
import { PortBindingPolicy } from '@/network/core/ports/PortBindingPolicy';

// ═══════════════════════════════════════════════════════════════════
// PortNumber
// ═══════════════════════════════════════════════════════════════════

describe('PortNumber', () => {
  it('accepts a valid port and rejects an out-of-range one', () => {
    expect(PortNumber.of(443).value).toBe(443);
    expect(() => PortNumber.of(70000)).toThrow(RangeError);
    expect(() => PortNumber.of(-1)).toThrow(RangeError);
    expect(() => PortNumber.of(1.5)).toThrow(RangeError);
  });

  it('treats both range boundaries as valid', () => {
    expect(PortNumber.isValid(0)).toBe(true);
    expect(PortNumber.isValid(MAX_PORT)).toBe(true);
    expect(PortNumber.isValid(MAX_PORT + 1)).toBe(false);
  });

  it('classifies ports per RFC 6335', () => {
    expect(PortNumber.of(22).classification).toBe(PortClass.WellKnown);
    expect(PortNumber.of(8080).classification).toBe(PortClass.Registered);
    expect(PortNumber.of(50000).classification).toBe(PortClass.Dynamic);
  });

  it('flags privileged ports below 1024', () => {
    expect(PortNumber.of(80).isPrivileged).toBe(true);
    expect(PortNumber.of(1023).isPrivileged).toBe(true);
    expect(PortNumber.of(1024).isPrivileged).toBe(false);
  });

  it('flags ephemeral ports in the dynamic range', () => {
    expect(PortNumber.of(49152).isEphemeral).toBe(true);
    expect(PortNumber.of(49151).isEphemeral).toBe(false);
  });

  it('parses textual ports, returning null for anything invalid', () => {
    expect(PortNumber.tryParse('443')?.value).toBe(443);
    expect(PortNumber.tryParse('  22 ')?.value).toBe(22);
    expect(PortNumber.tryParse('abc')).toBeNull();
    expect(PortNumber.tryParse('99999')).toBeNull();
    expect(PortNumber.tryParse('-5')).toBeNull();
  });

  it('compares by value', () => {
    expect(PortNumber.of(80).equals(PortNumber.of(80))).toBe(true);
    expect(PortNumber.of(80).equals(PortNumber.of(443))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════
// IanaServiceRegistry
// ═══════════════════════════════════════════════════════════════════

describe('IanaServiceRegistry', () => {
  it('resolves a numeric port to its IANA service name', () => {
    const registry = IanaServiceRegistry.standard();
    expect(registry.resolveName(22, 'tcp')).toBe('ssh');
    expect(registry.resolveName(443, 'tcp')).toBe('https');
    expect(registry.resolveName(53, 'udp')).toBe('domain');
  });

  it('falls back to the port number for an unassigned port', () => {
    expect(IanaServiceRegistry.standard().resolveName(9999, 'tcp')).toBe('9999');
  });

  it('resolves a service name (and aliases) to its port', () => {
    const registry = IanaServiceRegistry.standard();
    expect(registry.resolvePort('https')).toBe(443);
    expect(registry.resolvePort('ssh', 'tcp')).toBe(22);
    expect(registry.resolvePort('oracle')).toBe(1521);
  });

  it('distinguishes the tcp and udp assignment of the same port', () => {
    const registry = IanaServiceRegistry.standard();
    expect(registry.lookup(53, 'tcp')?.protocol).toBe('tcp');
    expect(registry.lookup(53, 'udp')?.protocol).toBe('udp');
  });

  it('renders a canonical /etc/services file', () => {
    const content = IanaServiceRegistry.standard().render();
    expect(content).toContain('ssh');
    expect(content).toContain('22/tcp');
    expect(content).toContain('443/tcp');
  });

  it('accepts a custom registration', () => {
    const registry = IanaServiceRegistry.standard();
    registry.register({ name: 'myapp', port: 9100, protocol: 'tcp', aliases: ['ma'] });
    expect(registry.resolveName(9100, 'tcp')).toBe('myapp');
    expect(registry.resolvePort('ma')).toBe(9100);
  });
});

// ═══════════════════════════════════════════════════════════════════
// PortBindingPolicy
// ═══════════════════════════════════════════════════════════════════

describe('PortBindingPolicy', () => {
  it('treats ports below 1024 as privileged on Linux', () => {
    const policy = PortBindingPolicy.linux();
    expect(policy.requiresPrivilege(80)).toBe(true);
    expect(policy.requiresPrivilege(8080)).toBe(false);
  });

  it('permits root to bind a privileged port', () => {
    expect(PortBindingPolicy.linux().evaluate(80, { uid: 0 }).allowed).toBe(true);
  });

  it('denies an unprivileged user a privileged port', () => {
    const verdict = PortBindingPolicy.linux().evaluate(80, { uid: 1000 });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain('Permission denied');
  });

  it('permits an unprivileged user with CAP_NET_BIND_SERVICE', () => {
    const verdict = PortBindingPolicy.linux().evaluate(80, {
      uid: 1000,
      hasNetBindCapability: true,
    });
    expect(verdict.allowed).toBe(true);
  });

  it('permits an unprivileged user a registered port', () => {
    expect(PortBindingPolicy.linux().permits(8080, { uid: 1000 })).toBe(true);
  });

  it('imposes no privileged-port restriction on Windows', () => {
    const policy = PortBindingPolicy.windows();
    expect(policy.requiresPrivilege(80)).toBe(false);
    expect(policy.evaluate(80, { uid: 1000 }).allowed).toBe(true);
  });

  it('honours a lowered ip_unprivileged_port_start', () => {
    const policy = new PortBindingPolicy({ unprivilegedPortStart: 80 });
    expect(policy.requiresPrivilege(80)).toBe(false);
    expect(policy.requiresPrivilege(79)).toBe(true);
  });
});
