/**
 * `route` (net-tools) on Linux — TDD coverage of the real command surface:
 * -net/-host, CIDR notation, dev (on-link), metric, del, and the honest
 * SIOCADDRT/SIOCDELRT error ladder for unreachable gateways / missing
 * routes, exercised on a real LAN topology.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function seededPc(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC');
  await pc.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  return pc;
}

describe('route — table display', () => {
  it("route -n affiche la destination par défaut en numérique (0.0.0.0)", async () => {
    const pc = await seededPc();
    await pc.executeCommand('route add default gw 192.168.1.1');
    const out = await pc.executeCommand('route -n');
    expect(out).toMatch(/^0\.0\.0\.0\s+192\.168\.1\.1/m);
  });

  it("route (sans -n) affiche 'default' pour la route par défaut", async () => {
    const pc = await seededPc();
    await pc.executeCommand('route add default gw 192.168.1.1');
    const out = await pc.executeCommand('route');
    expect(out).toMatch(/^default\s+192\.168\.1\.1/m);
    expect(out).not.toMatch(/^0\.0\.0\.0/m);
  });

  it('une route statique apparaît avec le flag UG (gateway) et le bon masque', async () => {
    const pc = await seededPc();
    await pc.executeCommand('route add -net 10.20.0.0 netmask 255.255.0.0 gw 192.168.1.1');
    const out = await pc.executeCommand('route -n');
    expect(out).toMatch(/^10\.20\.0\.0\s+192\.168\.1\.1\s+255\.255\.0\.0\s+UG/m);
  });
});

describe('route add -net / -host — nouvelles capacités', () => {
  it('route add -net avec notation CIDR (10.20.0.0/16) fonctionne comme netmask', async () => {
    const pc = await seededPc();
    const out = await pc.executeCommand('route add -net 10.20.0.0/16 gw 192.168.1.1');
    expect(out).toBe('');
    const table = await pc.executeCommand('route -n');
    expect(table).toMatch(/^10\.20\.0\.0\s+192\.168\.1\.1\s+255\.255\.0\.0\s+UG/m);
  });

  it('route add -host ajoute une route hôte /32', async () => {
    const pc = await seededPc();
    await pc.executeCommand('route add -host 10.20.30.40 gw 192.168.1.1');
    const out = await pc.executeCommand('route -n');
    expect(out).toMatch(/^10\.20\.30\.40\s+192\.168\.1\.1\s+255\.255\.255\.255\s+UGH/m);
  });

  it('route add -net ... dev <iface> ajoute une route on-link sans passerelle', async () => {
    const pc = await seededPc();
    await pc.executeCommand('route add -net 172.16.0.0 netmask 255.255.0.0 dev eth0');
    const out = await pc.executeCommand('route -n');
    expect(out).toMatch(/^172\.16\.0\.0\s+0\.0\.0\.0\s+255\.255\.0\.0\s+U\s/m);
    expect(out).toMatch(/eth0\s*$/m);
  });

  it('route add ... metric <n> est reflété dans la colonne Metric', async () => {
    const pc = await seededPc();
    await pc.executeCommand('route add -net 10.30.0.0 netmask 255.255.0.0 gw 192.168.1.1 metric 50');
    const out = await pc.executeCommand('route -n');
    const line = out.split('\n').find(l => l.startsWith('10.30.0.0'));
    expect(line).toMatch(/\s50\s/);
  });

  it("route add avec une passerelle injoignable échoue avec SIOCADDRT et n'ajoute rien", async () => {
    const pc = await seededPc();
    const out = await pc.executeCommand('route add -net 10.40.0.0 netmask 255.255.0.0 gw 8.8.8.8');
    expect(out).toMatch(/SIOCADDRT/);
    const table = await pc.executeCommand('route -n');
    expect(table).not.toContain('10.40.0.0');
  });

  it('route add -net sans gw ni dev renvoie une erreur explicite', async () => {
    const pc = await seededPc();
    const out = await pc.executeCommand('route add -net 10.50.0.0 netmask 255.255.0.0');
    expect(out).toMatch(/SIOCADDRT|Usage/);
    const table = await pc.executeCommand('route -n');
    expect(table).not.toContain('10.50.0.0');
  });
});

describe('route del — capacités réellement manquantes avant ce correctif', () => {
  it('route del -net supprime une route statique existante', async () => {
    const pc = await seededPc();
    await pc.executeCommand('route add -net 10.60.0.0 netmask 255.255.0.0 gw 192.168.1.1');
    let table = await pc.executeCommand('route -n');
    expect(table).toContain('10.60.0.0');

    const delOut = await pc.executeCommand('route del -net 10.60.0.0 netmask 255.255.0.0');
    expect(delOut).toBe('');
    table = await pc.executeCommand('route -n');
    expect(table).not.toContain('10.60.0.0');
  });

  it('route del -net accepte la notation CIDR', async () => {
    const pc = await seededPc();
    await pc.executeCommand('route add -net 10.70.0.0/16 gw 192.168.1.1');
    await pc.executeCommand('route del -net 10.70.0.0/16');
    const table = await pc.executeCommand('route -n');
    expect(table).not.toContain('10.70.0.0');
  });

  it('route del -host supprime une route hôte', async () => {
    const pc = await seededPc();
    await pc.executeCommand('route add -host 10.80.1.1 gw 192.168.1.1');
    await pc.executeCommand('route del -host 10.80.1.1');
    const table = await pc.executeCommand('route -n');
    expect(table).not.toContain('10.80.1.1');
  });

  it('route del default supprime toujours la passerelle par défaut (non-régression)', async () => {
    const pc = await seededPc();
    await pc.executeCommand('route add default gw 192.168.1.1');
    await pc.executeCommand('route del default');
    const table = await pc.executeCommand('route -n');
    expect(table).not.toMatch(/^0\.0\.0\.0/m);
  });

  it("route del sur une route inexistante échoue avec SIOCDELRT", async () => {
    const pc = await seededPc();
    const out = await pc.executeCommand('route del -net 172.99.0.0 netmask 255.255.0.0');
    expect(out).toMatch(/SIOCDELRT/);
  });
});
