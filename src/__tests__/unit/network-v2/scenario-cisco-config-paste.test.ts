/**
 * Scénario 4 — Copy-paste d'une configuration avec ! : comportement lors
 * de l'application.
 *
 * Un copy-paste en mode configure terminal arrive ligne à ligne : les !
 * sont ignorés silencieusement (sans sortir du bloc courant), les lignes
 * d'en-tête de show run (Building configuration…, Current
 * configuration : N bytes, version …) génèrent « % Invalid input
 * detected at '^' marker. » SANS interrompre la suite, et `end` provoque
 * la sortie immédiate du mode configuration.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

// ─── process_config_paste_line du scénario, transcrit ──────────────

function processConfigPasteLine(line: string, currentMode: string): {
  action: 'ignore' | 'error' | 'exit_config' | 'execute';
  message: string | null;
  mode: string;
} {
  const stripped = line.trim();
  if (stripped === '!') return { action: 'ignore', message: null, mode: currentMode };
  if (stripped.startsWith('!')) return { action: 'ignore', message: null, mode: currentMode };
  if (stripped === 'end') return { action: 'exit_config', message: null, mode: 'exec_privileged' };
  if (stripped === 'Building configuration...' || stripped.startsWith('Current configuration')) {
    return { action: 'error', message: "% Invalid input detected at '^' marker.", mode: currentMode };
  }
  return { action: 'execute', message: null, mode: currentMode };
}

const PASTED_SHOW_RUN = [
  'Building configuration...',
  'Current configuration : 2847 bytes',
  '!',
  '! Last configuration change at 08:42:15 UTC Tue Jul 1 2025',
  '!',
  'version 15.7',
  '!',
  'hostname SW-MANDENG-01',
  '!',
  '!',
  'interface GigabitEthernet0/0',
  ' description UPLINK-TO-ROUTER',
  ' ip address 192.168.10.1 255.255.255.0',
  '!',
  'interface GigabitEthernet0/1',
  ' description PC-LINUX-1',
  '!',
  'line vty 0 4',
  ' exec-timeout 5 0',
  ' transport input ssh',
  '!',
  'end',
];

describe('Scénario 4 — Copy-paste d\'une configuration avec !', () => {
  describe('comportement de ! en mode configure terminal', () => {
    it('! est accepté mais ignoré silencieusement, et ne sort PAS du bloc courant', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('description TEST');
      // L'admin pense que ! = exit de l'interface… mais non :
      expect(await r.executeCommand('!')).toBe('');
      expect(r.getPrompt()).toBe('Router(config-if)#');
      // La commande de niveau 0 suivante sort automatiquement de Gi0/0
      // et entre dans Gi0/1 — « ça fonctionne par hasard ».
      expect(await r.executeCommand('interface GigabitEthernet0/1')).toBe('');
      expect(r.getPrompt()).toBe('Router(config-if)#');
      await r.executeCommand('description AUTRE');
      await r.executeCommand('end');

      const run = await r.executeCommand('show running-config');
      // Chaque description a bien atterri sur SA propre interface.
      expect(run).toMatch(/interface GigabitEthernet0\/0\n description TEST/);
      expect(run).toMatch(/interface GigabitEthernet0\/1\n description AUTRE/);
    });
  });

  describe('collage complet d\'un show running-config', () => {
    it('reproduit ligne à ligne le comportement IOS : erreurs non bloquantes, config appliquée, end sort du mode config', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');

      const outputs: string[] = [];
      for (const line of PASTED_SHOW_RUN) {
        outputs.push(await r.executeCommand(line));
      }

      // 1. Lignes d'en-tête : erreur exacte, non bloquante.
      expect(outputs[0]).toContain("% Invalid input detected at '^' marker."); // Building configuration...
      expect(outputs[1]).toContain("% Invalid input detected at '^' marker."); // Current configuration : 2847 bytes
      // 2. ! seuls et ! commentaires : ignorés silencieusement.
      expect(outputs[2]).toBe('');  // !
      expect(outputs[3]).toBe('');  // ! Last configuration change...
      expect(outputs[4]).toBe('');  // !
      // 3. version 15.7 : pas une commande config → erreur non bloquante.
      expect(outputs[5]).toContain("% Invalid input detected at '^' marker.");
      // 4. hostname : EXÉCUTÉ malgré les erreurs précédentes.
      expect(outputs[7]).toBe('');
      // 5. end final : sortie du mode configuration.
      expect(r.getPrompt()).toBe('SW-MANDENG-01#');

      // La configuration valide a bien été appliquée.
      const run = await r.executeCommand('show running-config');
      expect(run).toContain('hostname SW-MANDENG-01');
      expect(run).toMatch(/interface GigabitEthernet0\/0\n description UPLINK-TO-ROUTER\n ip address 192\.168\.10\.1 255\.255\.255\.0/);
      expect(run).toMatch(/interface GigabitEthernet0\/1\n description PC-LINUX-1/);
      expect(run).toContain(' transport input ssh');
    });

    it('le hostname change immédiatement pendant le collage (visible au prompt)', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('hostname SW-MANDENG-01');
      expect(r.getPrompt()).toBe('SW-MANDENG-01(config)#');
      await r.executeCommand('end');
    });

    it('end au milieu d\'un collage : la suite est exécutée en mode EXEC et échoue', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('hostname R-PASTE');
      await r.executeCommand('end');
      // L'admin n'a pas fini de coller : la ligne config suivante arrive
      // en mode EXEC privilégié → erreur.
      const out = await r.executeCommand('ip domain-name mandeng.lan');
      expect(out).toContain("% Invalid input detected at '^' marker.");
      expect(r.getPrompt()).toBe('R-PASTE#');
    });
  });

  describe('process_config_paste_line (pseudocode du scénario) vs simulateur', () => {
    it('la classification du pseudocode correspond au comportement observé du simulateur', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');

      const cases: Array<{ line: string; expected: 'ignore' | 'error' | 'exit_config' | 'execute' }> = [
        { line: '!', expected: 'ignore' },
        { line: '! Last configuration change', expected: 'ignore' },
        { line: 'Building configuration...', expected: 'error' },
        { line: 'Current configuration : 2847 bytes', expected: 'error' },
        { line: 'ip domain-name mandeng.lan', expected: 'execute' },
        { line: 'end', expected: 'exit_config' },
      ];

      for (const c of cases) {
        const verdict = processConfigPasteLine(c.line, 'config');
        expect(verdict.action).toBe(c.expected);
        const out = await r.executeCommand(c.line);
        if (verdict.action === 'ignore') {
          expect(out).toBe('');
        } else if (verdict.action === 'error') {
          expect(out).toContain(verdict.message!);
        } else if (verdict.action === 'execute') {
          expect(out).toBe('');
        } else {
          expect(r.getPrompt().endsWith('#')).toBe(true);
          expect(r.getPrompt()).not.toContain('(config)');
        }
      }
    });
  });

  describe('bonne pratique — script awk de nettoyage avant copy-paste', () => {
    it('le script awk du scénario supprime en-tête, ! seuls, commentaires informatifs et end final', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);

      await pc.executeCommand(`cat << 'SHOWRUN' > /tmp/show-run-output.txt
Building configuration...
Current configuration : 2847 bytes
!
! Last configuration change at 08:42:15 UTC Tue Jul 1 2025
! NVRAM config last updated at 08:42:20 UTC Tue Jul 1 2025
!
hostname SW-MANDENG-01
!
interface GigabitEthernet0/0
 description UPLINK-TO-ROUTER
!
end
SHOWRUN`);

      await pc.executeCommand(`cat << 'AWK_SCRIPT' > /tmp/clean-cisco-config.awk
{
    if (/^Building configuration/) next
    if (/^Current configuration/) next
    if (/^!$/) next
    if (/^! Last configuration/) next
    if (/^! NVRAM config/) next
    if (/^end$/) next
    print
}
AWK_SCRIPT`);

      await pc.executeCommand(
        'cat /tmp/show-run-output.txt | awk -f /tmp/clean-cisco-config.awk > /tmp/clean-config.txt',
      );

      const cleaned = await pc.executeCommand('cat /tmp/clean-config.txt');
      expect(cleaned).toBe([
        'hostname SW-MANDENG-01',
        'interface GigabitEthernet0/0',
        ' description UPLINK-TO-ROUTER',
      ].join('\n'));

      const wc = await pc.executeCommand('wc -l < /tmp/show-run-output.txt; wc -l < /tmp/clean-config.txt');
      const counts = wc.trim().split('\n').map((s) => parseInt(s.trim(), 10));
      expect(counts[0]).toBe(12);
      expect(counts[1]).toBe(3);
    });

    it('la configuration nettoyée se colle sans aucune erreur parasite', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      const cleanLines = [
        'hostname SW-MANDENG-01',
        'interface GigabitEthernet0/0',
        ' description UPLINK-TO-ROUTER',
      ];
      for (const line of cleanLines) {
        expect(await r.executeCommand(line)).toBe('');
      }
      await r.executeCommand('end');
      const run = await r.executeCommand('show running-config');
      expect(run).toContain('hostname SW-MANDENG-01');
      expect(run).toContain(' description UPLINK-TO-ROUTER');
    });
  });

  describe('critère de réussite', () => {
    it('! sans erreur ni interruption ; en-têtes → erreur exacte non bloquante ; end → sortie immédiate', async () => {
      const r = new CiscoRouter('Router');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');

      expect(await r.executeCommand('!')).toBe('');
      const err1 = await r.executeCommand('Building configuration...');
      expect(err1).toContain("% Invalid input detected at '^' marker.");
      const err2 = await r.executeCommand('Current configuration : 2847 bytes');
      expect(err2).toContain("% Invalid input detected at '^' marker.");
      // La saisie continue malgré les erreurs :
      expect(await r.executeCommand('hostname SW-FINAL')).toBe('');
      await r.executeCommand('end');
      expect(r.getPrompt()).toBe('SW-FINAL#');
    });
  });
});
