/**
 * Deux constats releves sur une vraie session ASA du simulateur.
 *
 * 1. `conf t` REFUSE. La navigation comparait le mot entier
 *    (`head === 'configure'`), donc la forme que tout operateur tape
 *    depuis trente ans repondait `% Invalid input detected`. Une CLI
 *    Cisco abrege : c'est un trait du produit, pas un confort.
 *
 * 2. `show ?` rendait des LIGNES ENTIERES la ou une CLI Cisco rend la
 *    SUITE. Le vocabulaire herite de l'ASA est une liste de lignes
 *    (`'show conn'`), et `help()` la filtrait pour l'afficher telle
 *    quelle — donc apres avoir tape `show `, l'aide proposait de
 *    retaper `show conn`. Le routeur du meme depot repond `conn`, et
 *    c'est lui qui a raison : l'aide decrit ce qui vient APRES le
 *    curseur.
 *
 * Le second est le plus couteux des deux, parce qu'il se propage : la
 * tabulation, elle, veut bien la ligne entiere. Les deux formes sont
 * donc distinctes et le restent — `help()` decrit la suite,
 * `completions()` rend la ligne.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetCounters, MACAddress } from '@/network/core/types';

interface Cli {
  executeCommand(command: string): Promise<string>;
  getPrompt(): string;
  cliHelp(inputBeforeQuestion: string): string;
  cliTabCandidates(input: string): string[];
}

async function asa(): Promise<Cli> {
  const device = createDevice('firewall-cisco', 0, 0) as unknown as Cli;
  await device.executeCommand('enable');
  return device;
}

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
});

describe('une CLI Cisco abrege', () => {
  it('`conf t` entre en configuration', async () => {
    const fw = await asa();

    const out = await fw.executeCommand('conf t');

    expect(out).not.toContain('Invalid input');
    expect(fw.getPrompt()).toBe('FW1(config)#');
  });

  it('`sh conn` marche comme `show conn`', async () => {
    const fw = await asa();

    const abrege = await fw.executeCommand('sh conn');
    const entier = await fw.executeCommand('show conn');

    expect(abrege).toBe(entier);
  });

  it('`en` entre en mode privilegie depuis l\'EXEC utilisateur', async () => {
    const fw = createDevice('firewall-cisco', 0, 0) as unknown as Cli;

    await fw.executeCommand('en');

    expect(fw.getPrompt()).toBe('FW1#');
  });

  it('une abreviation AMBIGUE ne passe pas en silence', async () => {
    const fw = await asa();
    await fw.executeCommand('conf t');

    const out = await fw.executeCommand('zorglub');

    expect(out).toContain('Invalid input');
  });

  it('un mot qui n\'abrege rien reste refuse — le temoin', async () => {
    const fw = await asa();

    expect(await fw.executeCommand('confx t')).toContain('Invalid input');
  });
});

describe('l\'aide decrit la SUITE, la tabulation rend la ligne', () => {
  it('`show ?` liste les suites, sans repeter `show`', async () => {
    const fw = await asa();

    const lignes = (await fw.executeCommand('show ?'))
      .split('\n').filter(l => l.trim().length > 0);

    expect(lignes.length).toBeGreaterThan(0);
    expect(lignes.every(l => !l.trim().startsWith('show '))).toBe(true);
    expect(lignes.some(l => l.trim().startsWith('conn'))).toBe(true);
  });

  it('chaque suite garde sa description', async () => {
    const fw = await asa();

    const ligne = (await fw.executeCommand('show ?'))
      .split('\n').find(l => l.trim().startsWith('conn'));

    expect(ligne).toContain('connection table');
  });

  it('`?` a la racine liste les commandes du mode', async () => {
    const fw = await asa();

    const aide = await fw.executeCommand('?');

    expect(aide).toContain('show');
    expect(aide).toContain('configure');
  });

  it('la tabulation, elle, rend la LIGNE entiere', async () => {
    const fw = await asa();

    const candidats = fw.cliTabCandidates('show c');

    expect(candidats.some(c => c === 'show conn')).toBe(true);
  });

  it('le routeur repondait deja ainsi — le temoin', async () => {
    const r = createDevice('router-cisco', 0, 0) as unknown as Cli;
    await r.executeCommand('enable');

    const lignes = (await r.executeCommand('show ?'))
      .split('\n').filter(l => l.trim().length > 0);

    expect(lignes.every(l => !l.trim().startsWith('show '))).toBe(true);
  });
});

describe('la tabulation se comporte comme sur les autres equipements Cisco', () => {
  interface Tab { executeCommand(c: string): Promise<string>; cliTabComplete(i: string): string | null }

  async function trois(): Promise<Record<string, Tab>> {
    const out: Record<string, Tab> = {};
    for (const [nom, type] of [
      ['asa', 'firewall-cisco'], ['routeur', 'router-cisco'], ['commutateur', 'switch-cisco'],
    ] as const) {
      const d = createDevice(type, 0, 0) as unknown as Tab;
      await d.executeCommand('enable');
      out[nom] = d;
    }
    return out;
  }

  it('`sh` donne `show ` sur les TROIS', async () => {
    const m = await trois();

    for (const nom of ['asa', 'routeur', 'commutateur']) {
      expect(m[nom].cliTabComplete('sh'), nom).toBe('show ');
    }
  });

  it('`conf t` donne `configure terminal ` sur les TROIS', async () => {
    const m = await trois();

    for (const nom of ['asa', 'routeur', 'commutateur']) {
      expect(m[nom].cliTabComplete('conf t'), nom).toBe('configure terminal ');
    }
  });

  it('une abreviation se DEVELOPPE, elle ne se recopie pas', async () => {
    const m = await trois();

    expect(m.asa.cliTabComplete('conf t')).not.toContain('conf t');
  });

  it('un prefixe qui ne mene nulle part ne complete rien', async () => {
    const m = await trois();

    expect(m.asa.cliTabComplete('zorglub')).toBeNull();
  });

  it('`show ver` se complete aussi', async () => {
    const m = await trois();

    expect(m.asa.cliTabComplete('show ver')).toBe('show version ');
  });
});
