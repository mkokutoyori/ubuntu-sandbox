/**
 * Ce que le suivi de connexions retient pour MASQUERADE : l'interface par laquelle le flux est sorti (`nat->masq_index`, pose par
 * `nf_nat_masquerade_ipv4` dans net/netfilter/nf_nat_masquerade.c), la question que `nf_nat_oif_changed` (include/net/netfilter/nf_nat.h)
 * pose a chaque paquet (le flux est-il masquerade, le paquet est-il du sens d'origine, sort-il par une autre interface que `masq_index`),
 * et l'oubli du flux que `nf_nat_inet_fn` ordonne ensuite (`nf_ct_kill_acct`). Le suivi seul, sans machine : la sonde de bout en bout
 * lit les memes choix par `ip link`, `ip addr` et `ip route`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { IPAddress } from '@/network/core/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { ConnectionTracker, type TrackedPacket } from '@/network/devices/linux/ConnectionTracker';
import type { NatRange } from '@/network/devices/linux/NatRange';

beforeEach(() => {
  __setDefaultScheduler(new VirtualTimeScheduler());
});

const request: TrackedPacket = { protocol: 17, srcIP: '10.0.0.2', srcPort: 5000, dstIP: '198.51.100.9', dstPort: 53 };
const answer: TrackedPacket = { protocol: 17, srcIP: '198.51.100.9', srcPort: 53, dstIP: '203.0.113.1', dstPort: 5000 };
const masqueradeRange: NatRange = {
  addresses: { min: new IPAddress('203.0.113.1'), max: new IPAddress('203.0.113.1') },
  ports: null, random: false, randomFully: false, persistent: false,
};

function masqueraded(tracker: ConnectionTracker, iface: string | null): void {
  const entry = tracker.enter(request);
  tracker.bind(entry, masqueradeRange, 'source');
  if (iface !== null) tracker.masquerade(entry, iface);
  tracker.confirm(entry);
}

describe('a flow keeps the interface MASQUERADE sent it out by', () => {
  it('shows it in the view of the flow', () => {
    const tracker = new ConnectionTracker(4);
    masqueraded(tracker, 'eth1');
    expect(tracker.flows().map((view) => view.masqueradeInterface)).toEqual(['eth1']);
  });

  it('shows none for a flow nothing masqueraded', () => {
    const tracker = new ConnectionTracker(4);
    masqueraded(tracker, null);
    expect(tracker.flows().map((view) => view.masqueradeInterface)).toEqual([null]);
  });

  it('keeps it for the later packets of the flow', () => {
    const tracker = new ConnectionTracker(4);
    masqueraded(tracker, 'eth1');
    tracker.enter(request);
    expect(tracker.flows().map((view) => view.masqueradeInterface)).toEqual(['eth1']);
  });
});

describe('a packet of the original direction that leaves by another interface is the one nf_nat_oif_changed names', () => {
  it('is not one when the flow was not masqueraded', () => {
    const tracker = new ConnectionTracker(4);
    masqueraded(tracker, null);
    expect(tracker.leavesByAnotherInterface(tracker.enter(request), 'eth2')).toBe(false);
  });

  it('is not one when the packet leaves by the interface of the flow', () => {
    const tracker = new ConnectionTracker(4);
    masqueraded(tracker, 'eth1');
    expect(tracker.leavesByAnotherInterface(tracker.enter(request), 'eth1')).toBe(false);
  });

  it('is one when the packet leaves by another interface', () => {
    const tracker = new ConnectionTracker(4);
    masqueraded(tracker, 'eth1');
    expect(tracker.leavesByAnotherInterface(tracker.enter(request), 'eth2')).toBe(true);
  });

  it('is not one for a packet of the reply direction, whatever the interface', () => {
    const tracker = new ConnectionTracker(4);
    masqueraded(tracker, 'eth1');
    expect(tracker.leavesByAnotherInterface(tracker.enter(answer), 'eth2')).toBe(false);
  });
});

describe('a flow that is killed is forgotten', () => {
  it('leaves no flow in the table', () => {
    const tracker = new ConnectionTracker(4);
    masqueraded(tracker, 'eth1');
    tracker.kill(tracker.enter(request));
    expect(tracker.flows()).toEqual([]);
  });

  it('makes the next packet of the same flow a new one', () => {
    const tracker = new ConnectionTracker(4);
    masqueraded(tracker, 'eth1');
    expect(tracker.initialized(tracker.enter(request), 'source')).toBe(true);
    tracker.kill(tracker.enter(request));
    expect(tracker.initialized(tracker.enter(request), 'source')).toBe(false);
  });

  it('leaves the other flows alone', () => {
    const tracker = new ConnectionTracker(4);
    masqueraded(tracker, 'eth1');
    const other = tracker.enter({ ...request, srcPort: 6000 });
    tracker.bind(other, masqueradeRange, 'source');
    tracker.confirm(other);
    tracker.kill(tracker.enter(request));
    expect(tracker.flows().map((view) => view.original.srcPort)).toEqual([6000]);
  });
});
