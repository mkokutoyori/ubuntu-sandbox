/**
 * Linux : une adresse posée sur `lo` est LOCALE (table `local`) pour connect() — la connexion aboutit à la pile locale et un port
 * fermé répond ECONNREFUSED (« Connection refused »), jamais ENETUNREACH.
 *
 * Mesure de départ : `ip addr add 10.0.0.1/24 dev lo` puis `nc -zv 10.0.0.1 7000` répondait « Network is unreachable » alors que
 * `ping 10.0.0.1` aboutissait (TcpStack.isLocalDestination ne lisait que l'adresse PRIMAIRE de chaque port). Un seul prédicat
 * d'appartenance : EndHost.isLocalAddress. Témoin : un écouteur sur cette adresse accepte la connexion.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxServer } from '@/network/devices/LinuxServer';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

describe('une adresse de lo est locale pour connect()', () => {
  it('port fermé : Connection refused, pas Network is unreachable', async () => {
    const s = new LinuxServer('linux-server', 'S');
    await s.executeCommand('ip addr add 10.9.0.1/24 dev lo');
    const out = await s.executeCommand('nc -zv 10.9.0.1 7000');
    expect(out).toContain('Connection refused');
    expect(out).not.toContain('Network is unreachable');
  });

  it('témoin : un écouteur sur cette adresse accepte', async () => {
    const s = new LinuxServer('linux-server', 'S');
    await s.executeCommand('ip addr add 10.9.0.1/24 dev lo');
    await s.executeCommand('sh -c "nc -l 10.9.0.1 7001 > /dev/null &"');
    const out = await s.executeCommand('nc -zv 10.9.0.1 7001; echo rc=$?');
    expect(out).toContain('rc=0');
  });
});
