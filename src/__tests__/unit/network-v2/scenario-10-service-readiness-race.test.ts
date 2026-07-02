import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

interface Lab { client: LinuxPC; server: LinuxServer; sw: GenericSwitch }

function svcMgr(server: LinuxServer): {
  setReadinessDelay: (name: string, ms: number) => { ok: boolean; error?: string };
  flushReadiness: (name?: string) => void;
  start: (name: string) => { ok: boolean };
  stop: (name: string) => { ok: boolean };
  status: (name: string) => { state: string; mainPid?: number } | null;
} {
  return (server as unknown as { executor: { serviceMgr: {
    setReadinessDelay: (name: string, ms: number) => { ok: boolean; error?: string };
    flushReadiness: (name?: string) => void;
    start: (name: string) => { ok: boolean };
    stop: (name: string) => { ok: boolean };
    status: (name: string) => { state: string; mainPid?: number } | null;
  } } }).executor.serviceMgr;
}

function sockets(server: LinuxServer): { isPortBound: (p: number, proto: 'tcp' | 'udp') => boolean } {
  return (server as unknown as { executor: { socketTable: { isPortBound: (p: number, proto: 'tcp' | 'udp') => boolean } } }).executor.socketTable;
}

async function buildLab(): Promise<Lab> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const client = new LinuxPC('linux-pc', 'client', 0, 0);
  const server = new LinuxServer('linux-server', 'nginx-host', 0, 0);
  new Cable('cA').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('cB').connect(server.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.10'), mask);
  server.getPorts()[0].configureIP(new IPAddress('10.0.0.20'), mask);
  svcMgr(server).stop('nginx');
  return { client, server, sw };
}

describe('Scenario 10 — Cohérence temporelle port annoncé vs port réel', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    Logger.reset();
    EquipmentRegistry.resetInstance();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sans readiness delay, le port est bindé dès systemctl start (comportement historique)', async () => {
    const { server } = await buildLab();
    expect(sockets(server).isPortBound(80, 'tcp')).toBe(false);
    svcMgr(server).start('nginx');
    expect(sockets(server).isPortBound(80, 'tcp')).toBe(true);
    expect(svcMgr(server).status('nginx')?.state).toBe('active');
    const ss = await server.executeCommand('ss -tlnp');
    expect(ss).toMatch(/:80/);
  });

  it('avec un readiness delay, le service passe par une phase activating où le port n\'est pas encore à l\'écoute', async () => {
    const { server } = await buildLab();
    svcMgr(server).setReadinessDelay('nginx', 500);
    svcMgr(server).start('nginx');
    expect(svcMgr(server).status('nginx')?.state).toBe('activating');
    expect(sockets(server).isPortBound(80, 'tcp')).toBe(false);
    expect(svcMgr(server).status('nginx')?.mainPid).toBeGreaterThan(0);
  });

  it('un client qui tente nc pendant la fenêtre reçoit Connection refused', async () => {
    const { client, server } = await buildLab();
    svcMgr(server).setReadinessDelay('nginx', 500);
    svcMgr(server).start('nginx');
    const early = await client.executeCommand('nc -zv 10.0.0.20 80');
    expect(early).toMatch(/refused|failed/i);
    expect(sockets(server).isPortBound(80, 'tcp')).toBe(false);
  });

  it('après écoulement du delay, le port devient bindé et ss -tlnp expose :80', async () => {
    const { server } = await buildLab();
    svcMgr(server).setReadinessDelay('nginx', 500);
    svcMgr(server).start('nginx');
    const before = sockets(server).isPortBound(80, 'tcp');
    await vi.advanceTimersByTimeAsync(500);
    const after = sockets(server).isPortBound(80, 'tcp');
    expect(before).toBe(false);
    expect(after).toBe(true);
    expect(svcMgr(server).status('nginx')?.state).toBe('active');
    const ss = await server.executeCommand('ss -tlnp');
    expect(ss).toMatch(/:80/);
  });

  it('flushReadiness() résout la fenêtre de manière déterministe sans avancer le clock', async () => {
    const { server } = await buildLab();
    svcMgr(server).setReadinessDelay('nginx', 10000);
    svcMgr(server).start('nginx');
    expect(svcMgr(server).status('nginx')?.state).toBe('activating');
    expect(sockets(server).isPortBound(80, 'tcp')).toBe(false);
    svcMgr(server).flushReadiness('nginx');
    expect(svcMgr(server).status('nginx')?.state).toBe('active');
    expect(sockets(server).isPortBound(80, 'tcp')).toBe(true);
  });

  it('l\'écart entre "processus démarré" (mainPid) et "port opérationnel" est mesurable', async () => {
    const { server } = await buildLab();
    svcMgr(server).setReadinessDelay('nginx', 750);
    const t0 = Date.now();
    svcMgr(server).start('nginx');
    const pidTime = Date.now();
    const pid = svcMgr(server).status('nginx')?.mainPid;
    expect(pid).toBeGreaterThan(0);
    expect(sockets(server).isPortBound(80, 'tcp')).toBe(false);
    await vi.advanceTimersByTimeAsync(750);
    const portTime = Date.now();
    expect(sockets(server).isPortBound(80, 'tcp')).toBe(true);
    expect(pidTime - t0).toBeLessThan(50);
    expect(portTime - pidTime).toBeGreaterThanOrEqual(750);
  });

  it('journalctl -u nginx montre "Started" seulement après readiness, pas au moment de la commande', async () => {
    const { server } = await buildLab();
    svcMgr(server).setReadinessDelay('nginx', 500);
    svcMgr(server).start('nginx');
    const during = await server.executeCommand('journalctl -u nginx');
    expect(during).not.toMatch(/Started nginx/);
    await vi.advanceTimersByTimeAsync(500);
    const after = await server.executeCommand('journalctl -u nginx');
    expect(after).toMatch(/Started nginx/);
  });
});
