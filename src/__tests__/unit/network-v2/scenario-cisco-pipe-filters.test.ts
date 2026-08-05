/**
 * Scénario 7 — show running-config | section et | include : parsing des
 * filtres de pipe Cisco.
 *
 * | include : lignes seules matchant le pattern (regex, ^ supporté), pas
 * leurs enfants ; | section : blocs COMPLETS avec enfants et le ! de fin
 * de bloc ; | begin : tout depuis la première ligne matchant jusqu'à
 * end ; | exclude : lignes ne matchant pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters, MACAddress } from '@/network/core/types';
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

async function buildRouter(): Promise<CiscoRouter> {
  const r = new CiscoRouter('Router');
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  await r.executeCommand('hostname SW-MANDENG-01');
  await r.executeCommand('interface GigabitEthernet0/0');
  await r.executeCommand('description UPLINK');
  await r.executeCommand('ip address 192.168.10.1 255.255.255.0');
  await r.executeCommand('exit');
  await r.executeCommand('interface GigabitEthernet0/1');
  await r.executeCommand('description PC-LINUX-1');
  await r.executeCommand('exit');
  await r.executeCommand('ip access-list extended VTY-ACCESS');
  await r.executeCommand('10 permit tcp 192.168.99.0 0.0.0.255 any eq 22');
  await r.executeCommand('20 deny ip any any log');
  await r.executeCommand('exit');
  await r.executeCommand('line vty 0 4');
  await r.executeCommand('exec-timeout 5 0');
  await r.executeCommand('transport input ssh');
  await r.executeCommand('exit');
  await r.executeCommand('end');
  return r;
}

describe('Scénario 7 — Filtres de pipe Cisco sur show running-config', () => {
  describe('| include — une ligne par occurrence, sans les enfants', () => {
    it('show running-config | include interface retourne uniquement les lignes interface', async () => {
      const r = await buildRouter();
      const out = await r.executeCommand('show running-config | include interface');
      const lines = out.split('\n').filter((l) => l.trim().length > 0);

      expect(lines).toContain('interface GigabitEthernet0/0');
      expect(lines).toContain('interface GigabitEthernet0/1');
      // Les enfants (description, ip address) ne sont PAS inclus.
      expect(out).not.toContain('description');
      expect(out).not.toContain('ip address 192.168.10.1');
      // Les ! de séparation ne sont PAS inclus.
      expect(lines.every((l) => l !== '!')).toBe(true);
    });

    it('| include ^! retourne uniquement les lignes séparateurs (regex ancrée)', async () => {
      const r = await buildRouter();
      const out = await r.executeCommand('show running-config | include ^!');
      const lines = out.split('\n').filter((l) => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.startsWith('!'))).toBe(true);
    });
  });

  describe('| section — bloc complet avec enfants et ! de fin', () => {
    it('| section interface retourne chaque bloc interface COMPLET, ! de fin inclus', async () => {
      const r = await buildRouter();
      const out = await r.executeCommand('show running-config | section interface');

      expect(out).toContain('interface GigabitEthernet0/0\n description UPLINK\n ip address 192.168.10.1 255.255.255.0\n');
      // Chaque bloc est complet et fermé par son ! ; les lignes que
      // l'interface rend par ailleurs (` no ip address`) ne sont pas figées.
      expect(out).toMatch(/^interface GigabitEthernet0\/1\n description PC-LINUX-1\n(?: .*\n)*!$/m);
      // Aucun bloc tronqué : chaque ligne interface est suivie de ses
      // enfants avant le prochain bloc.
      const lines = out.split('\n');
      const gi0 = lines.indexOf('interface GigabitEthernet0/0');
      expect(lines[gi0 + 1]).toBe(' description UPLINK');
    });

    it('| section line vty retourne le bloc VTY avec exec-timeout et transport input', async () => {
      const r = await buildRouter();
      const out = await r.executeCommand('show running-config | section line vty');
      expect(out).toContain('line vty 0 4');
      expect(out).toContain(' exec-timeout 5 0');
      expect(out).toContain(' transport input ssh');
      expect(out.split('\n')).toContain('!');
    });

    it('| section ip access-list retourne le bloc ACL et ses entrées', async () => {
      const r = await buildRouter();
      const out = await r.executeCommand('show running-config | section ip access-list');
      expect(out).toContain('ip access-list extended VTY-ACCESS');
      expect(out).toMatch(/ 10 permit tcp 192\.168\.99\.0 0\.0\.0\.255 any eq 22/);
      expect(out).toMatch(/ 20 deny\s+ip any any log/);
    });

    it('| section banner retourne la bannière multi-lignes complète, ^C de fermeture inclus', async () => {
      const r = await buildRouter();
      await r.executeCommand('configure terminal');
      await r.executeCommand('banner motd #');
      await r.executeCommand('╔════════════════════════════╗');
      await r.executeCommand('║  RÉSEAU MANDENG            ║');
      await r.executeCommand('╚════════════════════════════╝');
      await r.executeCommand('#');
      await r.executeCommand('end');

      const out = await r.executeCommand('show running-config | section banner');
      expect(out).toContain([
        'banner motd ^C',
        '╔════════════════════════════╗',
        '║  RÉSEAU MANDENG            ║',
        '╚════════════════════════════╝',
        '^C',
      ].join('\n'));
    });
  });

  describe('| begin — tout depuis la première ligne matchant', () => {
    it('| begin line retourne tout depuis line vty jusqu\'à end, y compris les !', async () => {
      const r = await buildRouter();
      const out = await r.executeCommand('show running-config | begin line');
      const lines = out.split('\n');

      expect(lines[0]).toMatch(/^line /);
      expect(out).toContain(' exec-timeout 5 0');
      expect(out).toContain(' transport input ssh');
      expect(lines).toContain('!');
      expect(lines[lines.length - 1]).toBe('end');
      // Rien AVANT la première occurrence :
      expect(out).not.toContain('hostname SW-MANDENG-01');
    });

    it('| begin sur un pattern absent ne retourne rien', async () => {
      const r = await buildRouter();
      const out = await r.executeCommand('show running-config | begin zzz-inexistant');
      expect(out.trim()).toBe('');
    });
  });

  describe('| exclude — lignes ne contenant pas le pattern', () => {
    it('| exclude ! supprime tous les séparateurs (configuration compacte)', async () => {
      const r = await buildRouter();
      const out = await r.executeCommand('show running-config | exclude !');
      const lines = out.split('\n');
      expect(lines.some((l) => l === '!')).toBe(false);
      // Le reste de la configuration est intact.
      expect(out).toContain('hostname SW-MANDENG-01');
      expect(out).toContain('interface GigabitEthernet0/0');
      expect(out).toContain(' description UPLINK');
    });

    it('| exclude interface conserve tout sauf les lignes interface', async () => {
      const r = await buildRouter();
      const out = await r.executeCommand('show running-config | exclude interface');
      expect(out).not.toContain('interface GigabitEthernet0/0');
      expect(out).toContain('hostname SW-MANDENG-01');
      expect(out).toContain(' description UPLINK');
    });
  });

  describe('critère de réussite', () => {
    it('section = blocs complets + ! ; include = lignes seules ; begin = jusqu\'à end avec les !', async () => {
      const r = await buildRouter();

      const section = await r.executeCommand('show running-config | section interface');
      const sectionLines = section.split('\n');
      // Jamais de bloc tronqué : chaque "interface X" avec description
      // configurée est immédiatement suivie de sa description.
      const idx0 = sectionLines.indexOf('interface GigabitEthernet0/0');
      const idx1 = sectionLines.indexOf('interface GigabitEthernet0/1');
      expect(idx0).toBeGreaterThanOrEqual(0);
      expect(idx1).toBeGreaterThan(idx0);
      expect(sectionLines.slice(idx0 + 1, idx1)).toContain(' description UPLINK');
      expect(sectionLines.slice(idx0 + 1, idx1)).toContain('!');

      const include = await r.executeCommand('show running-config | include interface');
      expect(include).not.toContain(' description');

      const begin = await r.executeCommand('show running-config | begin line');
      expect(begin.split('\n')[0]).toMatch(/^line /);
      expect(begin.split('\n')).toContain('!');
      expect(begin.trimEnd().endsWith('end')).toBe(true);
    });
  });
});
