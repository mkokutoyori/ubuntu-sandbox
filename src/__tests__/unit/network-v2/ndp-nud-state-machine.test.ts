import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualTimeScheduler } from '@/events/Scheduler';
import {
  NeighborCache,
  NDP_REACHABLE_TIME_MS,
  NDP_DELAY_FIRST_PROBE_MS,
  NDP_RETRANS_TIMER_MS,
  NDP_MAX_UNICAST_SOLICIT,
  type NeighborCacheEntry,
} from '@/network/devices/host/NeighborCache';
import { MACAddress } from '@/network/core/types';

const IP = '2001:db8::1';
const MAC_A = new MACAddress('aa:bb:cc:00:00:01');
const MAC_B = new MACAddress('aa:bb:cc:00:00:02');

describe('NeighborCache — RFC 4861 §7.3 NUD state machine', () => {
  let scheduler: VirtualTimeScheduler;
  let cache: NeighborCache;
  let probes: Array<{ ip: string; entry: NeighborCacheEntry }>;
  let unreachable: string[];
  let learned: string[];

  beforeEach(() => {
    scheduler = new VirtualTimeScheduler();
    probes = [];
    unreachable = [];
    learned = [];
    cache = new NeighborCache(() => scheduler, {
      sendUnicastSolicit: (ip, entry) => probes.push({ ip, entry }),
      onUnreachable: (ip) => unreachable.push(ip),
      onLearned: (ip) => learned.push(ip),
    });
  });

  it('test_learn_from_solicit_source_creates_stale_entry', () => {
    cache.learnFromSource(IP, MAC_A, 'eth0', false);
    expect(cache.get(IP)?.state).toBe('stale');
    expect(learned).toEqual([IP]);
  });

  it('test_solicited_advertisement_creates_reachable_entry', () => {
    cache.learnFromAdvertisement(IP, MAC_A, 'eth0', {
      solicited: true, isRouter: false, override: true,
    });
    expect(cache.get(IP)?.state).toBe('reachable');
  });

  it('test_unsolicited_advertisement_creates_stale_entry', () => {
    cache.learnFromAdvertisement(IP, MAC_A, 'eth0', {
      solicited: false, isRouter: false, override: true,
    });
    expect(cache.get(IP)?.state).toBe('stale');
  });

  it('test_reachable_expires_to_stale_after_reachable_time', () => {
    cache.learnFromAdvertisement(IP, MAC_A, 'eth0', {
      solicited: true, isRouter: false, override: true,
    });
    scheduler.advance(NDP_REACHABLE_TIME_MS + 1);
    expect(cache.get(IP)?.state).toBe('stale');
  });

  it('test_reachable_within_reachable_time_stays_reachable', () => {
    cache.learnFromAdvertisement(IP, MAC_A, 'eth0', {
      solicited: true, isRouter: false, override: true,
    });
    scheduler.advance(NDP_REACHABLE_TIME_MS - 1);
    expect(cache.get(IP)?.state).toBe('reachable');
  });

  it('test_mark_used_on_stale_enters_delay_and_returns_mac', () => {
    cache.learnFromSource(IP, MAC_A, 'eth0', false);
    const entry = cache.markUsed(IP);
    expect(entry?.mac.equals(MAC_A)).toBe(true);
    expect(cache.get(IP)?.state).toBe('delay');
  });

  it('test_delay_transitions_to_probe_after_delay_first_probe_time', () => {
    cache.learnFromSource(IP, MAC_A, 'eth0', false);
    cache.markUsed(IP);
    scheduler.advance(NDP_DELAY_FIRST_PROBE_MS);
    expect(cache.get(IP)?.state).toBe('probe');
    expect(probes).toHaveLength(1);
    expect(probes[0].ip).toBe(IP);
  });

  it('test_probe_retransmits_unicast_solicits_then_removes_entry', () => {
    cache.learnFromSource(IP, MAC_A, 'eth0', false);
    cache.markUsed(IP);
    scheduler.advance(NDP_DELAY_FIRST_PROBE_MS);
    scheduler.advance(NDP_RETRANS_TIMER_MS * NDP_MAX_UNICAST_SOLICIT);
    expect(probes).toHaveLength(NDP_MAX_UNICAST_SOLICIT);
    expect(cache.get(IP)).toBeUndefined();
    expect(unreachable).toEqual([IP]);
  });

  it('test_confirm_reachability_during_delay_cancels_probing', () => {
    cache.learnFromSource(IP, MAC_A, 'eth0', false);
    cache.markUsed(IP);
    cache.confirmReachability(IP);
    scheduler.advance(NDP_DELAY_FIRST_PROBE_MS + NDP_RETRANS_TIMER_MS * 5);
    expect(cache.get(IP)?.state).toBe('reachable');
    expect(probes).toHaveLength(0);
    expect(unreachable).toHaveLength(0);
  });

  it('test_advertisement_during_probe_restores_reachable', () => {
    cache.learnFromSource(IP, MAC_A, 'eth0', false);
    cache.markUsed(IP);
    scheduler.advance(NDP_DELAY_FIRST_PROBE_MS);
    cache.learnFromAdvertisement(IP, MAC_A, 'eth0', {
      solicited: true, isRouter: false, override: true,
    });
    scheduler.advance(NDP_RETRANS_TIMER_MS * NDP_MAX_UNICAST_SOLICIT);
    expect(cache.get(IP)?.state).toBe('reachable');
    expect(unreachable).toHaveLength(0);
  });

  it('test_same_mac_solicit_source_preserves_reachable_state', () => {
    cache.learnFromAdvertisement(IP, MAC_A, 'eth0', {
      solicited: true, isRouter: false, override: true,
    });
    cache.learnFromSource(IP, MAC_A, 'eth0', false);
    expect(cache.get(IP)?.state).toBe('reachable');
  });

  it('test_changed_mac_solicit_source_resets_to_stale', () => {
    cache.learnFromAdvertisement(IP, MAC_A, 'eth0', {
      solicited: true, isRouter: false, override: true,
    });
    cache.learnFromSource(IP, MAC_B, 'eth0', false);
    const entry = cache.get(IP);
    expect(entry?.state).toBe('stale');
    expect(entry?.mac.equals(MAC_B)).toBe(true);
  });

  it('test_non_override_advertisement_with_new_mac_keeps_old_mac_demotes_state', () => {
    cache.learnFromAdvertisement(IP, MAC_A, 'eth0', {
      solicited: true, isRouter: false, override: true,
    });
    cache.learnFromAdvertisement(IP, MAC_B, 'eth0', {
      solicited: true, isRouter: false, override: false,
    });
    const entry = cache.get(IP);
    expect(entry?.mac.equals(MAC_A)).toBe(true);
    expect(entry?.state).toBe('stale');
  });

  it('test_mark_used_on_missing_entry_returns_undefined', () => {
    expect(cache.markUsed('2001:db8::dead')).toBeUndefined();
  });

  it('test_stop_cancels_pending_probe_timers', () => {
    cache.learnFromSource(IP, MAC_A, 'eth0', false);
    cache.markUsed(IP);
    cache.stop();
    scheduler.advance(NDP_DELAY_FIRST_PROBE_MS + NDP_RETRANS_TIMER_MS * 5);
    expect(probes).toHaveLength(0);
    expect(cache.get(IP)?.state).toBe('delay');
  });
});
