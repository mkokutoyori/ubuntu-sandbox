import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { DdnsResolver } from '@/network/ipsec/DdnsResolver';
import { DdnsSiteTunnelController } from '@/network/ipsec/DdnsSiteTunnelController';

const HOSTNAME = 'vpn.example.com';
const OLD_IP = '203.0.113.10';
const NEW_IP = '203.0.113.42';

describe('Scénario 14 — DDNS et renégociation IKE sur changement d\'IP', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('DdnsResolver — TTL respecté', () => {
    it('mémorise la première résolution jusqu\'à expiration du TTL', () => {
      let calls = 0;
      const zone: { current: string } = { current: OLD_IP };
      const resolver = new DdnsResolver({
        hostname: HOSTNAME, ttlMs: 60_000,
        lookup: () => { calls++; return zone.current; },
      });
      expect(resolver.resolve()).toBe(OLD_IP);
      expect(resolver.resolve()).toBe(OLD_IP);
      expect(calls).toBe(1);
    });

    it('déclenche une nouvelle résolution après expiration du TTL', () => {
      let calls = 0;
      const zone: { current: string } = { current: OLD_IP };
      const resolver = new DdnsResolver({
        hostname: HOSTNAME, ttlMs: 60_000,
        lookup: () => { calls++; return zone.current; },
      });
      resolver.resolve();
      zone.current = NEW_IP;
      vi.setSystemTime(new Date('2026-07-01T00:00:30Z'));
      expect(resolver.resolve()).toBe(OLD_IP);
      expect(calls).toBe(1);
      vi.setSystemTime(new Date('2026-07-01T00:01:01Z'));
      expect(resolver.resolve()).toBe(NEW_IP);
      expect(calls).toBe(2);
    });

    it('invalidate() force une résolution immédiate', () => {
      let calls = 0;
      const zone: { current: string } = { current: OLD_IP };
      const resolver = new DdnsResolver({
        hostname: HOSTNAME, ttlMs: 600_000,
        lookup: () => { calls++; return zone.current; },
      });
      resolver.resolve();
      zone.current = NEW_IP;
      resolver.invalidate();
      expect(resolver.resolve()).toBe(NEW_IP);
      expect(calls).toBe(2);
    });

    it('propage une exception si le lookup renvoie une adresse invalide', () => {
      const resolver = new DdnsResolver({
        hostname: HOSTNAME, ttlMs: 60_000,
        lookup: () => 'not-an-ip',
      });
      expect(() => resolver.resolve()).toThrow(/invalid IPv4 address/i);
    });
  });

  describe('DdnsSiteTunnelController — cycle et renégociation', () => {
    function buildController(opts: {
      zone: { current: string };
      ttlMs?: number;
      dpdIntervalMs?: number;
      dpdRetries?: number;
      probe: (peer: string) => boolean;
    }): {
      ctrl: DdnsSiteTunnelController;
      calls: {
        opened: string[];
        closed: string[];
      };
    } {
      const calls = { opened: [] as string[], closed: [] as string[] };
      const resolver = new DdnsResolver({
        hostname: HOSTNAME,
        ttlMs: opts.ttlMs ?? 60_000,
        lookup: () => opts.zone.current,
      });
      const ctrl = new DdnsSiteTunnelController({
        hostname: HOSTNAME,
        resolver,
        dpd: {
          intervalMs: opts.dpdIntervalMs ?? 1000,
          maxRetries: opts.dpdRetries ?? 3,
          probe: opts.probe,
        },
        ikeInitiator: {
          open: (peer) => { calls.opened.push(peer); return true; },
          close: (peer) => { calls.closed.push(peer); },
        },
      });
      return { ctrl, calls };
    }

    it('connect() résout le nom et ouvre le tunnel vers l\'IP actuelle', () => {
      const zone = { current: OLD_IP };
      const { ctrl, calls } = buildController({ zone, probe: () => true });
      ctrl.connect();
      expect(ctrl.getActivePeer()).toBe(OLD_IP);
      expect(calls.opened).toEqual([OLD_IP]);
    });

    it('sur DPD-dead, invalide le cache DNS, ré-résout, et renégocie vers la nouvelle IP', () => {
      const zone = { current: OLD_IP };
      let primaryAlive = true;
      const { ctrl, calls } = buildController({
        zone,
        dpdIntervalMs: 500, dpdRetries: 2,
        probe: (peer) => peer === OLD_IP ? primaryAlive : true,
      });
      ctrl.connect();
      primaryAlive = false;
      zone.current = NEW_IP;
      vi.advanceTimersByTime(1500);
      expect(ctrl.getActivePeer()).toBe(NEW_IP);
      expect(calls.opened).toEqual([OLD_IP, NEW_IP]);
      expect(calls.closed).toEqual([OLD_IP]);
    });

    it("journalise 'peer not responding' via DPD avant d'appeler le DNS", () => {
      const zone = { current: OLD_IP };
      let alive = true;
      const { ctrl } = buildController({
        zone,
        dpdIntervalMs: 500, dpdRetries: 2,
        probe: () => alive,
      });
      ctrl.connect();
      alive = false;
      Logger.reset();
      zone.current = NEW_IP;
      vi.advanceTimersByTime(1500);
      const logs = Logger.getLogs().map(e => e.message ?? '');
      const dpdIdx = logs.findIndex(m => /peer.*not responding|peer.*dead|DPD/i.test(m));
      const dnsIdx = logs.findIndex(m => /DNS.*re-resolv|DDNS|resolved.*to/i.test(m));
      expect(dpdIdx).toBeGreaterThanOrEqual(0);
      expect(dnsIdx).toBeGreaterThanOrEqual(0);
      expect(dpdIdx).toBeLessThan(dnsIdx);
    });

    it('délai total borné : DPD (interval × retries) + délai de renégociation', () => {
      const zone = { current: OLD_IP };
      let alive = true;
      const t0 = Date.now();
      const { ctrl } = buildController({
        zone,
        dpdIntervalMs: 300, dpdRetries: 4,
        probe: () => alive,
      });
      ctrl.connect();
      alive = false;
      zone.current = NEW_IP;
      vi.advanceTimersByTime(1200);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThanOrEqual(1200);
      expect(ctrl.getActivePeer()).toBe(NEW_IP);
    });

    it('aucun état résiduel : ancienne IP absente après rétablissement', () => {
      const zone = { current: OLD_IP };
      let alive = true;
      const { ctrl } = buildController({
        zone,
        dpdIntervalMs: 300, dpdRetries: 2,
        probe: () => alive,
      });
      ctrl.connect();
      alive = false;
      zone.current = NEW_IP;
      vi.advanceTimersByTime(1000);
      expect(ctrl.getActivePeer()).toBe(NEW_IP);
      expect(ctrl.getPreviousPeers()).toContain(OLD_IP);
      expect(ctrl.getPreviousPeers()).not.toContain(NEW_IP);
    });

    it("si le DNS n'a pas encore propagé, une nouvelle passe DPD relance la résolution", () => {
      const zone = { current: OLD_IP };
      let alive = true;
      const { ctrl, calls } = buildController({
        zone,
        dpdIntervalMs: 300, dpdRetries: 2,
        probe: (peer) => peer === NEW_IP ? true : alive,
      });
      ctrl.connect();
      alive = false;
      vi.advanceTimersByTime(700);
      expect(ctrl.getActivePeer()).toBe(OLD_IP);
      zone.current = NEW_IP;
      vi.advanceTimersByTime(700);
      expect(ctrl.getActivePeer()).toBe(NEW_IP);
      expect(calls.opened[calls.opened.length - 1]).toBe(NEW_IP);
    });

    it('disconnect() ferme la SA et arrête DPD', () => {
      const zone = { current: OLD_IP };
      const { ctrl, calls } = buildController({ zone, probe: () => true });
      ctrl.connect();
      ctrl.disconnect();
      expect(ctrl.getActivePeer()).toBeNull();
      expect(calls.closed).toEqual([OLD_IP]);
      vi.advanceTimersByTime(10_000);
      expect(calls.opened).toEqual([OLD_IP]);
    });

    it('le TTL DNS influe sur le délai de résolution après DPD-dead', () => {
      const zone = { current: OLD_IP };
      let alive = true;
      const { ctrl } = buildController({
        zone,
        ttlMs: 5_000,
        dpdIntervalMs: 300, dpdRetries: 2,
        probe: () => alive,
      });
      ctrl.connect();
      alive = false;
      zone.current = NEW_IP;
      vi.advanceTimersByTime(1000);
      expect(ctrl.getActivePeer()).toBe(NEW_IP);
    });
  });
});
