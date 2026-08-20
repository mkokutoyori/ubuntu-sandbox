import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { RemoteAccessVpnClient } from '@/network/ipsec/RemoteAccessVpnClient';
import { DeadPeerDetector } from '@/network/ipsec/DeadPeerDetector';

const ISP_GW = '203.0.113.1';
const PRIMARY_GW = '198.51.100.10';
const BACKUP_GW = '198.51.100.20';
const CORP = '10.10.0.0/16';

async function newPc(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC');
  await pc.executeCommand('sudo ip addr add 203.0.113.100/24 dev eth0');
  await pc.executeCommand(`sudo ip route add default via ${ISP_GW}`);
  return pc;
}

describe('Scénario 9 — Failover DPD entre deux passerelles VPN', () => {
  beforeEach(() => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('DeadPeerDetector — RFC 3706', () => {
    it('émet un probe R-U-THERE à chaque intervalle configuré', () => {
      let calls = 0;
      const dpd = new DeadPeerDetector({
        intervalMs: 1000, maxRetries: 3,
        probe: () => { calls++; return true; },
        onDead: () => {},
      });
      dpd.start();
      vi.advanceTimersByTime(3500);
      dpd.stop();
      expect(calls).toBe(3);
    });

    it('déclare le pair mort après maxRetries probes consécutifs sans réponse', () => {
      let dead = false;
      const dpd = new DeadPeerDetector({
        intervalMs: 1000, maxRetries: 3,
        probe: () => false,
        onDead: () => { dead = true; },
      });
      dpd.start();
      vi.advanceTimersByTime(1000); expect(dead).toBe(false);
      vi.advanceTimersByTime(1000); expect(dead).toBe(false);
      vi.advanceTimersByTime(1000); expect(dead).toBe(true);
    });

    it("le délai de détection ≈ intervalMs × maxRetries (paramètres DPD prévisibles)", () => {
      let deadAt = -1;
      const start = 0;
      vi.setSystemTime(new Date(start));
      const dpd = new DeadPeerDetector({
        intervalMs: 500, maxRetries: 4,
        probe: () => false,
        onDead: () => { deadAt = Date.now(); },
      });
      dpd.start();
      vi.advanceTimersByTime(2000);
      expect(deadAt).toBe(2000);
    });

    it("une réponse positive réinitialise le compteur d'échecs", () => {
      let alive = true;
      let dead = false;
      const dpd = new DeadPeerDetector({
        intervalMs: 100, maxRetries: 3,
        probe: () => alive,
        onDead: () => { dead = true; },
      });
      dpd.start();
      alive = false; vi.advanceTimersByTime(200); expect(dead).toBe(false);
      alive = true;  vi.advanceTimersByTime(100); expect(dead).toBe(false);
      alive = false; vi.advanceTimersByTime(300); expect(dead).toBe(true);
    });

    it('stop() empêche toute détection ultérieure', () => {
      let dead = false;
      const dpd = new DeadPeerDetector({
        intervalMs: 100, maxRetries: 2,
        probe: () => false,
        onDead: () => { dead = true; },
      });
      dpd.start();
      dpd.stop();
      vi.advanceTimersByTime(10000);
      expect(dead).toBe(false);
    });
  });

  describe('Failover client — bascule automatique', () => {
    it("connect() sélectionne d'emblée le pair primaire", async () => {
      const pc = await newPc();
      const vpn = new RemoteAccessVpnClient(
        { gatewayPublicIp: PRIMARY_GW, corporateSubnets: [CORP], mode: 'split',
          backupGateways: [BACKUP_GW] },
        pc,
      );
      vpn.connect();
      expect(vpn.getActivePeer()).toBe(PRIMARY_GW);
      const routes = await pc.executeCommand('ip route');
      expect(routes).toMatch(new RegExp(`10\\.10\\.0\\.0/16 via ${PRIMARY_GW}`));
    });

    it('bascule automatiquement vers la passerelle secondaire quand le primaire est déclaré mort', async () => {
      const pc = await newPc();
      let primaryAlive = true;
      const vpn = new RemoteAccessVpnClient(
        { gatewayPublicIp: PRIMARY_GW, corporateSubnets: [CORP], mode: 'split',
          backupGateways: [BACKUP_GW],
          dpd: { intervalMs: 1000, maxRetries: 3,
                 probe: (peer) => peer === PRIMARY_GW ? primaryAlive : true } },
        pc,
      );
      vpn.connect();
      primaryAlive = false;
      vi.advanceTimersByTime(3500);
      expect(vpn.getActivePeer()).toBe(BACKUP_GW);
      const routes = await pc.executeCommand('ip route');
      expect(routes).toMatch(new RegExp(`10\\.10\\.0\\.0/16 via ${BACKUP_GW}`));
      expect(routes).not.toMatch(new RegExp(`10\\.10\\.0\\.0/16 via ${PRIMARY_GW}`));
    });

    it('journalise la suppression des SA périmées et la renégociation via la secondaire', async () => {
      const pc = await newPc();
      const vpn = new RemoteAccessVpnClient(
        { gatewayPublicIp: PRIMARY_GW, corporateSubnets: [CORP], mode: 'split',
          backupGateways: [BACKUP_GW],
          dpd: { intervalMs: 500, maxRetries: 2, probe: () => false } },
        pc,
      );
      vpn.connect();
      vi.advanceTimersByTime(1500);
      const logs = Logger.getLogs().map(e => e.message ?? '').join('\n');
      expect(logs).toMatch(/peer.*dead|dead peer|DPD.*dead/i);
      expect(logs).toMatch(/failover|switch.*backup|renegotiat/i);
    });

    it('la bascule est automatique (aucune API manuelle appelée par le test)', async () => {
      const pc = await newPc();
      const vpn = new RemoteAccessVpnClient(
        { gatewayPublicIp: PRIMARY_GW, corporateSubnets: [CORP], mode: 'split',
          backupGateways: [BACKUP_GW],
          dpd: { intervalMs: 200, maxRetries: 3, probe: () => false } },
        pc,
      );
      vpn.connect();
      const before = vpn.getActivePeer();
      vi.advanceTimersByTime(700);
      expect(before).toBe(PRIMARY_GW);
      expect(vpn.getActivePeer()).toBe(BACKUP_GW);
    });

    it('si toutes les passerelles sont mortes, le client se retrouve déconnecté', async () => {
      const pc = await newPc();
      const vpn = new RemoteAccessVpnClient(
        { gatewayPublicIp: PRIMARY_GW, corporateSubnets: [CORP], mode: 'split',
          backupGateways: [BACKUP_GW],
          dpd: { intervalMs: 100, maxRetries: 2, probe: () => false } },
        pc,
      );
      vpn.connect();
      vi.advanceTimersByTime(1000);
      expect(vpn.isConnected).toBe(false);
      const routes = await pc.executeCommand('ip route');
      expect(routes).not.toMatch(new RegExp(`10\\.10\\.0\\.0/16 via`));
    });

    it('l\'invariant de routage est maintenu après bascule (aucun résidu du primaire)', async () => {
      const pc = await newPc();
      let primaryAlive = true;
      const vpn = new RemoteAccessVpnClient(
        { gatewayPublicIp: PRIMARY_GW, corporateSubnets: [CORP], mode: 'split',
          backupGateways: [BACKUP_GW],
          dpd: { intervalMs: 100, maxRetries: 2,
                 probe: (p) => p === PRIMARY_GW ? primaryAlive : true } },
        pc,
      );
      vpn.connect();
      primaryAlive = false;
      vi.advanceTimersByTime(500);
      for (const r of vpn.getInstalledRoutes()) {
        expect(r.nextHop?.toString()).not.toBe(PRIMARY_GW);
      }
    });

    it('les paramètres DPD contrôlent le délai de bascule de façon prévisible', async () => {
      const pc = await newPc();
      const vpn = new RemoteAccessVpnClient(
        { gatewayPublicIp: PRIMARY_GW, corporateSubnets: [CORP], mode: 'split',
          backupGateways: [BACKUP_GW],
          dpd: { intervalMs: 400, maxRetries: 5, probe: () => false } },
        pc,
      );
      vpn.connect();
      vi.advanceTimersByTime(1999);
      expect(vpn.getActivePeer()).toBe(PRIMARY_GW);
      vi.advanceTimersByTime(1);
      expect(vpn.getActivePeer()).toBe(BACKUP_GW);
    });
  });
});
