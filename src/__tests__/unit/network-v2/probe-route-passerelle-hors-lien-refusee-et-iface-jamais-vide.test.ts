/**
 * Une route par défaut dont la passerelle n'est joignable par aucune
 * interface est REFUSEE par le noyau Linux (`route add default gw` :
 * « SIOCADDRT: Network is unreachable » ; `ip route add default via` :
 * « Error: Nexthop has invalid gateway. »). Le simulateur l'acceptait et
 * l'inscrivait avec une interface vide, d'où une colonne `Iface` vide dans
 * `route -n` et une route qui ne pouvait rien acheminer.
 *
 * MESURE DE DEPART : 4 cas sur 6 tombent (git stash du code source) : route add default gw et ip route add default via hors lien, l'Iface vide de route -n, et l'ordre adresse/passerelle.
 * Passent des deux côtés : les TEMOINS -- la passerelle joignable est
 * acceptée et sort avec son interface dans `route -n`, et `route add -net`
 * hors lien est déjà refusé (non-régression).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

function host(): LinuxPC {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  pc.getPorts()[0].configureIP(new IPAddress('192.168.20.2'), new SubnetMask('255.255.255.0'));
  return pc;
}

const defaultLine = (table: string): string => table.split('\n').find((l) => /^(0\.0\.0\.0|default)\s/.test(l)) ?? '';

describe('passerelle par défaut', () => {
  it('TEMOIN: une passerelle joignable est acceptée et route -n donne son interface', async () => {
    const pc = host();
    expect(await pc.executeCommand('route add default gw 192.168.20.1')).toBe('');
    const line = defaultLine(await pc.executeCommand('route -n'));
    expect(line).toMatch(/^0\.0\.0\.0 +192\.168\.20\.1 +0\.0\.0\.0 +UG +\d+ +\d+ +\d+ eth0$/);
  });

  it('route add default gw hors lien : refusé comme SIOCADDRT, rien d\'inscrit', async () => {
    const pc = host();
    expect(await pc.executeCommand('route add default gw 192.168.10.1')).toContain('SIOCADDRT: Network is unreachable');
    expect(defaultLine(await pc.executeCommand('route -n'))).toBe('');
  });

  it('ip route add default via hors lien : « Nexthop has invalid gateway. »', async () => {
    const pc = host();
    expect(await pc.executeCommand('ip route add default via 192.168.10.1')).toContain('Nexthop has invalid gateway');
    expect(await pc.executeCommand('ip route')).not.toContain('default');
  });

  it('aucune ligne de route -n n\'a une colonne Iface vide', async () => {
    const pc = host();
    await pc.executeCommand('route add default gw 192.168.10.1');
    await pc.executeCommand('ip route add default via 192.168.10.1');
    const rows = (await pc.executeCommand('route -n')).split('\n').slice(2);
    for (const row of rows) expect(row.trimEnd().split(/\s+/).length, row).toBe(8);
  });

  it('TEMOIN: route add -net hors lien est déjà refusé', async () => {
    const pc = host();
    expect(await pc.executeCommand('route add -net 10.9.0.0/16 gw 192.168.10.1')).toContain('Network is unreachable');
  });

  it('l\'ordre importe : la passerelle devient joignable quand l\'adresse est posée', async () => {
    const pc = host();
    expect(await pc.executeCommand('ip route add default via 10.0.0.1')).toContain('invalid gateway');
    pc.getPorts()[0].configureIP(new IPAddress('10.0.0.5'), new SubnetMask('255.255.255.0'));
    expect(await pc.executeCommand('ip route add default via 10.0.0.1')).toBe('');
    expect(defaultLine(await pc.executeCommand('route -n'))).toMatch(/eth0$/);
  });
});
