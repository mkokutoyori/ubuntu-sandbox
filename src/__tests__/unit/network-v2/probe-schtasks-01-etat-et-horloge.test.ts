/**
 * Probes — les tâches Windows ont un état, et une horloge.
 *
 * `docs/PRD-Taches-Planifiees.md` phase 1, objectifs P1.2, P1.3, P1.4.
 *
 * Trois défauts mesurés :
 *
 * - `/change /disable` répondait SUCCESS et laissait l'état à `Ready`.
 *   L'ordre était accepté puis perdu, des deux côtés de la CLI.
 * - `Get-ScheduledTask -TaskName` filtrait en sous-chaîne, si bien que
 *   `-TaskName T` rendait toute tâche dont le nom contient un « t » —
 *   presque toutes. Le magasin, lui, était bien partagé : le premier
 *   diagnostic du PRD, qui accusait deux magasins, était faux.
 * - Surtout : rien ne déclenchait une tâche à l'heure dite. Le moteur
 *   existait et relançait vraiment le programme, mais on ne l'atteignait
 *   que par `advanceTime`, appelé nulle part hors des tests. C'était de
 *   la planification sans horloge.
 *
 * Réserve d'honnêteté : faute de Windows sur la machine de mesure, les
 * libellés de `/change` et `/end` suivent la documentation Microsoft
 * sans avoir été relevés sur un binaire. Les comportements, eux, sont
 * vérifiés ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.resetInstance(); });

function lab(): { pc: WindowsPC; tick: () => void } {
  const pc = new WindowsPC('windows-pc', 'win1', 0, 0);
  pc.powerOn();
  const t = pc as unknown as { scheduledTaskTick(): void };
  return { pc, tick: () => t.scheduledTaskTick() };
}

const statusOf = (out: string, name: string) =>
  out.split('\n').find((l) => l.startsWith(name + ' '))?.trim().split(/\s{2,}/).pop() ?? '';

describe('Scénario 1 — désactiver veut dire quelque chose', () => {
  it('`/change /disable` change l\'état vu par schtasks', async () => {
    const { pc } = lab();
    await pc.executeCommand('schtasks /create /tn "T" /tr "C:\\a.exe" /sc daily /st 02:00');
    await pc.executeCommand('schtasks /change /tn "T" /disable');
    expect(statusOf(await pc.executeCommand('schtasks /query /tn "T"'), 'T')).toBe('Disabled');
  });

  it('et l\'état vu par PowerShell — c\'est le même magasin', async () => {
    const { pc } = lab();
    await pc.executeCommand('schtasks /create /tn "T" /tr "C:\\a.exe" /sc daily /st 02:00');
    await pc.executeCommand('schtasks /change /tn "T" /disable');
    expect(await pc.executeCommand('powershell -Command "Get-ScheduledTask -TaskName T"'))
      .toContain('Disabled');
  });

  it('`/enable` remet la tâche en marche', async () => {
    const { pc } = lab();
    await pc.executeCommand('schtasks /create /tn "T" /tr "C:\\a.exe" /sc daily /st 02:00');
    await pc.executeCommand('schtasks /change /tn "T" /disable');
    await pc.executeCommand('schtasks /change /tn "T" /enable');
    expect(statusOf(await pc.executeCommand('schtasks /query /tn "T"'), 'T')).toBe('Ready');
  });

  it('`/end` a son propre message, pas celui de `/change`', async () => {
    const { pc } = lab();
    await pc.executeCommand('schtasks /create /tn "T" /tr "C:\\a.exe" /sc daily /st 02:00');
    const out = await pc.executeCommand('schtasks /end /tn "T"');
    expect(out).toContain('has been terminated');
    expect(out).not.toContain('created/modified');
  });

  it('`/change` et `/end` sur une tâche absente rendent l\'erreur', async () => {
    const { pc } = lab();
    expect(await pc.executeCommand('schtasks /change /tn "Absente" /disable'))
      .toBe('ERROR: The system cannot find the file specified.');
    expect(await pc.executeCommand('schtasks /end /tn "Absente"'))
      .toBe('ERROR: The system cannot find the file specified.');
  });
});

describe('Scénario 2 — `-TaskName` désigne un nom, pas un fragment', () => {
  it('un nom court ne ramasse plus toute la table', async () => {
    const { pc } = lab();
    await pc.executeCommand('schtasks /create /tn "T" /tr "C:\\a.exe" /sc daily /st 02:00');
    const out = await pc.executeCommand('powershell -Command "Get-ScheduledTask -TaskName T"');
    // « T » est une sous-chaîne de presque tous les noms d'usine.
    expect(out).toContain('T ');
    expect(out).not.toContain('GoogleUpdateTaskUser');
    expect(out).not.toContain('SimTestTask');
  });

  it('un nom complet trouve sa tâche', async () => {
    const { pc } = lab();
    expect(await pc.executeCommand('powershell -Command "Get-ScheduledTask -TaskName SimTestTask"'))
      .toContain('SimTestTask');
  });

  it('les jokers restent, eux', async () => {
    const { pc } = lab();
    const out = await pc.executeCommand('powershell -Command "Get-ScheduledTask -TaskName Sim*"');
    expect(out).toContain('SimTestTask');
    expect(out).not.toContain('GoogleUpdateTaskUser');
  });

  it('un nom inconnu ne rend rien', async () => {
    const { pc } = lab();
    const out = await pc.executeCommand('powershell -Command "Get-ScheduledTask -TaskName Absente"');
    expect(out).not.toContain('SimTestTask');
  });
});

describe('Scénario 3 — le planificateur a maintenant une horloge', () => {
  it('l\'heure de la machine avance d\'un tour à l\'autre', async () => {
    const { pc, tick } = lab();
    const avant = await pc.executeCommand('powershell -Command "Get-Date"');
    tick(); tick();
    const apres = await pc.executeCommand('powershell -Command "Get-Date"');
    expect(apres).not.toBe(avant);
  });

  it('une tâche à la minute part sans qu\'on avance le temps à la main', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand('schtasks /create /tn "M" /tr "C:\\zsauv.exe" /sc minute /mo 1');
    // Un nom qui n'est la sous-chaîne d'aucun processus d'usine : `m.exe`
    // se retrouvait dans `dwm.exe`, et la probe se croyait déjà satisfaite.
    expect(await pc.executeCommand('tasklist')).not.toContain('zsauv.exe');
    tick();
    // Aucun appel à `advanceTime` : c'est le minuteur de l'hôte qui bat.
    expect(await pc.executeCommand('tasklist')).toContain('zsauv.exe');
  });

  it('elle repart au tour suivant, sur son intervalle', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand('schtasks /create /tn "M" /tr "C:\\zsauv.exe" /sc minute /mo 1');
    tick(); tick();
    const count = (await pc.executeCommand('tasklist')).split('\n')
      .filter((l) => l.includes('zsauv.exe')).length;
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('une tâche désactivée ne part pas', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand('schtasks /create /tn "D" /tr "C:\\dsc.exe" /sc minute /mo 1');
    await pc.executeCommand('schtasks /change /tn "D" /disable');
    tick(); tick();
    expect(await pc.executeCommand('tasklist')).not.toContain('dsc.exe');
  });

  it('le planificateur arrêté ne déclenche rien', async () => {
    const { pc, tick } = lab();
    await pc.executeCommand('schtasks /create /tn "M" /tr "C:\\zsauv.exe" /sc minute /mo 1');
    // Arrêter un service demande l'élévation : sans ce changement
    // d'utilisateur, `Stop-Service` répond « Access is denied » et la
    // probe croyait à tort tenir un planificateur arrêté.
    pc.setCurrentUser('Administrator');
    await pc.executeCommand('powershell -Command "Stop-Service Schedule"');
    tick(); tick();
    expect(await pc.executeCommand('tasklist')).not.toContain('zsauv.exe');
  });
});
