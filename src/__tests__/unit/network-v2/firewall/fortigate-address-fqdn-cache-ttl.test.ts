/**
 * firewall address `set cache-ttl <s>` (type fqdn): an IP the name resolved to
 * stays in the address for at least that many seconds after the resolver has
 * stopped returning it. The store test drives a resolver that changes its
 * answer; the CLI case proves `set cache-ttl` reaches the object.
 *
 * Measured on a git worktree of HEAD before the change: 2 of 4 fall (the
 * retention inside the TTL and the CLI path). The 2 others pass either way:
 * the unretained witness, and the drop after the TTL, which holds whenever
 * nothing retains the old IP, so it only guards against retaining it forever.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ObjectStore } from '@/network/devices/firewall/model/ObjectStore';
import type { AddressObject } from '@/network/devices/firewall/model/AddressObject';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Logger } from '@/network/core/Logger';

beforeEach(() => { Logger.reset(); });

function fqdn(cacheTtlSec?: number): AddressObject {
  return { name: 'WEB', kind: 'fqdn', family: 'ipv4', fqdn: 'web.example.com',
    cacheTtlSec, predefined: false, tags: [] } as AddressObject;
}

function store(cacheTtlSec?: number) {
  const state = { answer: ['198.51.100.1'], now: 1_000_000 };
  const objects = new ObjectStore({
    resolveFqdn: () => state.answer,
    now: () => state.now,
  });
  objects.addAddress(fqdn(cacheTtlSec));
  objects.matchesAddress('WEB', '198.51.100.1');
  state.answer = ['198.51.100.2'];
  return { objects, state };
}

describe('fqdn address cache-ttl', () => {
  it('witness: without cache-ttl the old IP is dropped when the answer changes', () => {
    const { objects } = store();
    expect(objects.matchesAddress('WEB', '198.51.100.1')).toBe(false);
    expect(objects.matchesAddress('WEB', '198.51.100.2')).toBe(true);
  });

  it('with cache-ttl the old IP is kept inside the TTL', () => {
    const { objects, state } = store(300);
    state.now += 120_000;
    expect(objects.matchesAddress('WEB', '198.51.100.1')).toBe(true);
    expect(objects.matchesAddress('WEB', '198.51.100.2')).toBe(true);
  });

  it('with cache-ttl the old IP is dropped once the TTL has passed', () => {
    const { objects, state } = store(300);
    state.now += 301_000;
    expect(objects.matchesAddress('WEB', '198.51.100.1')).toBe(false);
  });

  it('set cache-ttl on the CLI reaches the address object', async () => {
    const fgt = new FortiGate('firewall-fortinet', 'FGT-01', 0, 0);
    for (const line of ['config firewall address', 'edit "WEB"', 'set type fqdn',
      'set fqdn "web.example.com"', 'set cache-ttl 300', 'next', 'end']) {
      await fgt.executeCommand(line);
    }
    expect(fgt.getObjectStore().getAddress('WEB')?.cacheTtlSec).toBe(300);
  });
});
