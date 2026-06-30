/**
 * Scénario 11 — Restriction d'accès par plage horaire (time-based ACL).
 *
 * Objectif : valider qu'un accès SSH peut être autorisé uniquement
 * pendant une fenêtre horaire définie (typique d'une politique en
 * environnement bancaire / sensible).
 *
 * Déroulé : ACL étendue 100 sur le routeur (modélisant un L3-switch),
 * avec une clause `time-range BUSINESS_HOURS` (lundi-vendredi 8h-18h)
 * sur l'entrée permit. Une tentative SSH pendant la plage autorisée
 * passe ; hors plage, le SYN est silencieusement droppé et le client
 * voit `Connection timed out`.
 *
 * Critère de réussite : connexion possible uniquement dans la fenêtre,
 * avec un comportement de drop identique à n'importe quelle ACL réseau
 * le reste du temps.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

afterEach(() => {
  vi.useRealTimers();
});

async function buildLan() {
  const adminPc = new LinuxPC('linux-pc', 'admin-pc', 0, 0);
  const server  = new LinuxServer('linux-server', 'server', 0, 0);
  const router  = new CiscoRouter('switch-l3');
  router.configureInterface('GigabitEthernet0/0', new IPAddress('10.0.10.1'), new SubnetMask('255.255.255.0'));
  router.configureInterface('GigabitEthernet0/1', new IPAddress('10.0.30.1'), new SubnetMask('255.255.255.0'));
  new Cable('c1').connect(adminPc.getPorts()[0], router.getPorts()[0]);
  new Cable('c2').connect(server.getPorts()[0],  router.getPorts()[1]);
  adminPc.getPorts()[0].configureIP(new IPAddress('10.0.10.10'), new SubnetMask('255.255.255.0'));
  server.getPorts()[0].configureIP(new IPAddress('10.0.30.10'), new SubnetMask('255.255.255.0'));
  adminPc.setDefaultGateway(new IPAddress('10.0.10.1'));
  server.setDefaultGateway(new IPAddress('10.0.30.1'));
  const um = (server as unknown as { executor: { userMgr: {
    useradd(u: string, o?: object): void;
    setPassword(u: string, p: string): void;
  } } }).executor.userMgr;
  um.useradd('alice', { m: true, s: '/bin/bash' });
  um.setPassword('alice', 'admin');
  return { adminPc, server, router };
}

async function installTimeBoundedAcl(router: CiscoRouter) {
  for (const cmd of [
    'enable',
    'configure terminal',
    'time-range BUSINESS_HOURS',
    'periodic weekdays 8:00 to 18:00',
    'exit',
    'access-list 100 permit tcp any host 10.0.30.10 eq 22 time-range BUSINESS_HOURS',
    'access-list 100 deny tcp any host 10.0.30.10 eq 22',
    'access-list 100 permit ip any any',
    'interface GigabitEthernet0/1',
    'ip access-group 100 out',
    'end',
  ]) await router.executeCommand(cmd);
}

describe('Scénario 11 — ACL Cisco étendue avec time-range', () => {
  it('show time-range affiche la fenêtre BUSINESS_HOURS', async () => {
    const { router } = await buildLan();
    await installTimeBoundedAcl(router);
    const out = await router.executeCommand('show time-range');
    expect(out).toMatch(/time-range entry: BUSINESS_HOURS/);
    expect(out).toMatch(/periodic weekdays 8:00 to 18:00/);
  });

  it('show access-lists 100 montre la clause time-range sur la première entrée', async () => {
    const { router } = await buildLan();
    await installTimeBoundedAcl(router);
    const out = await router.executeCommand('show access-lists 100');
    expect(out).toMatch(/permit tcp any host 10\.0\.30\.10 eq 22 time-range BUSINESS_HOURS/);
    expect(out).toMatch(/deny tcp any host 10\.0\.30\.10 eq 22/);
  });

  it('mercredi 10h : connexion SSH passe (fenêtre active)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T10:00:00')); // mercredi 10h local
    const { adminPc, router } = await buildLan();
    await installTimeBoundedAcl(router);
    const out = await adminPc.executeCommand('ssh alice@10.0.30.10 whoami');
    expect(out).toMatch(/^alice\s*$/m);
    expect(out).not.toMatch(/Connection timed out/);
  });

  it('mercredi 22h : connexion droppée (hors fenêtre) — Connection timed out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T22:00:00')); // mercredi 22h local
    const { adminPc, router } = await buildLan();
    await installTimeBoundedAcl(router);
    const out = await adminPc.executeCommand('ssh alice@10.0.30.10 whoami');
    expect(out).toMatch(/Connection timed out/);
    expect(out).not.toMatch(/Connection refused/);
    expect(out).not.toMatch(/^alice\s*$/m);
  });

  it('dimanche 10h : connexion droppée (jour hors weekdays)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-05T10:00:00')); // dimanche
    const { adminPc, router } = await buildLan();
    await installTimeBoundedAcl(router);
    const out = await adminPc.executeCommand('ssh alice@10.0.30.10 whoami');
    expect(out).toMatch(/Connection timed out/);
  });

  it('show access-lists 100 : le compteur deny grimpe après une tentative hors plage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-01T22:00:00'));
    const { adminPc, router } = await buildLan();
    await installTimeBoundedAcl(router);

    await adminPc.executeCommand('ssh alice@10.0.30.10 whoami');

    const out = await router.executeCommand('show access-lists 100');
    const denyLine = out.split('\n').find(l => /deny tcp any host 10\.0\.30\.10 eq 22/.test(l)) ?? '';
    const matches = parseInt(/\((\d+) match/.exec(denyLine)?.[1] ?? '0', 10);
    expect(matches).toBeGreaterThanOrEqual(1);
  });

  it('basculer le jour vendredi 17h → samedi 10h change le verdict', async () => {
    vi.useFakeTimers();
    const { adminPc, router } = await buildLan();
    await installTimeBoundedAcl(router);

    vi.setSystemTime(new Date('2026-07-03T17:00:00')); // vendredi 17h
    const friday = await adminPc.executeCommand('ssh alice@10.0.30.10 whoami');
    expect(friday).toMatch(/^alice\s*$/m);

    vi.setSystemTime(new Date('2026-07-04T10:00:00')); // samedi 10h
    const saturday = await adminPc.executeCommand('ssh alice@10.0.30.10 whoami');
    expect(saturday).toMatch(/Connection timed out/);
  });
});
