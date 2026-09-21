/*
 * Le menu final de `setup` offre TROIS choix et le moteur n'en
 * honorait que DEUX :
 *
 *   [0] Go to the IOS command prompt without saving this config.
 *   [1] Return back to the setup without saving this config.
 *   [2] Save this configuration to nvram and exit.
 *
 * Mesure, avant correctif, en pilotant le dialogue jusqu'au bout :
 *
 *   selection 2  ->  applique et ecrit   (« Building configuration... »)
 *   selection 0  ->  sort sans ecrire
 *   selection 1  ->  sort sans ecrire, EXACTEMENT comme 0
 *   selection 9  ->  applique et ecrit, comme 2
 *
 * Deux defauts distincts.
 *
 * `[1]` ne revient nulle part : « --- System Configuration Dialog --- »
 * n'apparait qu'UNE fois et les questions ne sont pas reposees. Le choix
 * est affiche, lu, range sous `setup_selection`, et sans effet — le
 * critere stocke, rendu, et jamais evalue.
 *
 * Un choix INCONNU prend la branche la plus lourde. Le gestionnaire
 * testait `selection === '0' || selection === '1'` et tout le reste
 * tombait dans le `else` qui applique et ecrit en nvram. Repondre `9` a
 * un menu qui n'offre que 0, 1 et 2 sauvegardait donc la configuration.
 * C'est l'inverse du principe que ce depot tient partout ailleurs : ce
 * que le moteur ne sait pas decider ne doit pas produire l'effet le plus
 * fort.
 *
 * Le correctif tient en trois pieces. La place du choix REFUSE ce qui
 * n'est pas 0, 1, 2 ou vide, et repose la question — le moteur de flux
 * sait deja le faire, `maxRetries` indefini valant « autant de fois
 * qu'il faudra ». Un repere `parametres` est pose avant la premiere
 * question, et une branche y renvoie quand le choix est `1`. Enfin
 * l'application ne se declenche plus que sur `2`.
 *
 * La branche a demande d'ETENDRE le plan d'interaction vendor-neutre :
 * il etait lineaire, alors que le moteur de flux du terminal sait
 * brancher depuis toujours (`buildConsoleLoginSteps` s'en sert, et son
 * commentaire dit qu'il n'emploie PAS le plan neutre « because the retry
 * loop needs real branching »). Deux sortes d'etape sont ajoutees au
 * contrat partage, `label` et `branch`, et l'adaptateur les traduit vers
 * ce que le moteur porte deja — la limite est levee la ou elle vit,
 * plutot que contournee par un second mecanisme.
 *
 * Le libelle du menu n'est pas touche : c'est le texte d'IOS, et c'est
 * lui qui dit ce que les trois choix doivent faire.
 *
 * `setup` quitte par la meme occasion le dernier arbre EXEC des deux
 * plateformes. Il n'y portait qu'un gestionnaire VIDE — le chemin
 * n'existait que pour que `interactionPlanFor` le reconnaisse — et la
 * resolution de chemin y lit deja le socle.
 *
 * Discriminee contre l'etat d'avant (`git stash`).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CiscoTerminalSession } from '@/terminal/sessions';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
});

const key = (k: string): KeyEvent =>
  ({ key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false });

const tick = () => new Promise<void>((r) => setTimeout(r, 15));

async function waitBoot(s: CiscoTerminalSession): Promise<void> {
  for (let i = 0; i < 60; i++) { if (!s.isBooting) return; await tick(); }
}

async function type(s: TerminalSession, c: string): Promise<void> {
  s.setInput(c); s.handleKey(key('Enter')); await tick(); await tick();
}

async function repondre(s: TerminalSession, v: string): Promise<void> {
  s.setInputBuf(v); s.handleKey(key('Enter')); await tick(); await tick();
}

const invite = (s: TerminalSession): string => {
  const m = s.currentInputMode;
  return m.type === 'interactive-text' ? m.promptText : '';
};

const texte = (s: TerminalSession): string => s.lines.map((l) => l.text).join('\n');

type Fabrique = () => CiscoRouter | CiscoSwitch;

const PLATEFORMES: ReadonlyArray<readonly [string, Fabrique]> = [
  ['routeur', () => new CiscoRouter('R1', 0, 0)],
  ['catalyst', () => new CiscoSwitch('switch-cisco', 'S1', 8)],
];

async function ouvrirSetup(faire: Fabrique): Promise<TerminalSession> {
  const d = faire();
  d.powerOn();
  const s = new CiscoTerminalSession('t', d as never);
  await s.init();
  await waitBoot(s);
  await type(s, 'enable');
  await type(s, 'setup');
  return s;
}

/** Repond aux invites jusqu'a la sortie, en donnant `choix` au menu final. */
async function deroulerJusquAuBout(
  s: TerminalSession, choix: readonly string[],
): Promise<number> {
  let menus = 0;
  for (let i = 0; i < 80; i++) {
    const p = invite(s);
    if (p === '') break;
    if (p.includes('Enter your selection')) {
      await repondre(s, choix[Math.min(menus, choix.length - 1)]);
      menus++;
      continue;
    }
    await repondre(s, '');
  }
  return menus;
}

describe('`setup` ouvre son dialogue sur les deux plateformes — les TEMOINS', () => {
  it.each(PLATEFORMES)('sur le %s', async (_nom, faire) => {
    const s = await ouvrirSetup(faire);
    expect(s.currentInputMode.type).toBe('interactive-text');
    expect(texte(s)).toContain('System Configuration Dialog');
  });

  it.each(PLATEFORMES)('et reste refuse en EXEC utilisateur sur le %s',
    async (_nom, faire) => {
      const d = faire();
      d.powerOn();
      expect(await d.executeCommand('setup')).toMatch(/Invalid input/);
    });
});

describe('le choix `1` revient VRAIMENT au setup', () => {
  it('les questions sont reposees une seconde fois', async () => {
    const s = await ouvrirSetup(PLATEFORMES[0][1]);
    const menus = await deroulerJusquAuBout(s, ['1', '2']);
    expect(menus, 'le menu n\'a ete pose qu\'une fois').toBeGreaterThanOrEqual(2);
  });

  it('et le second passage finit par appliquer', async () => {
    const s = await ouvrirSetup(PLATEFORMES[0][1]);
    await deroulerJusquAuBout(s, ['1', '2']);
    expect(texte(s)).toMatch(/Building configuration/);
  });
});

describe('un choix inconnu ne sauvegarde pas', () => {
  it('`9` repose la question au lieu d\'ecrire', async () => {
    const s = await ouvrirSetup(PLATEFORMES[0][1]);
    const menus = await deroulerJusquAuBout(s, ['9', '0']);
    expect(menus, 'le menu n\'a pas ete repose').toBeGreaterThanOrEqual(2);
    expect(texte(s), 'un choix inconnu a sauvegarde').not.toMatch(/Building configuration/);
  });
});

describe('les deux choix qui marchaient marchent encore — les TEMOINS', () => {
  it('`2` applique et ecrit', async () => {
    const s = await ouvrirSetup(PLATEFORMES[0][1]);
    await deroulerJusquAuBout(s, ['2']);
    expect(texte(s)).toMatch(/Building configuration/);
  });

  it('`0` sort sans ecrire', async () => {
    const s = await ouvrirSetup(PLATEFORMES[0][1]);
    await deroulerJusquAuBout(s, ['0']);
    expect(texte(s)).not.toMatch(/Building configuration/);
  });

  it('un choix VIDE vaut `2`', async () => {
    const s = await ouvrirSetup(PLATEFORMES[0][1]);
    await deroulerJusquAuBout(s, ['']);
    expect(texte(s)).toMatch(/Building configuration/);
  });
});

describe('`setup` quitte le dernier arbre EXEC', () => {
  it.each(PLATEFORMES)('sur le %s', (_nom, faire) => {
    const shell = (faire() as unknown as {
      shell: Record<string, { enumerateExecutablePaths(): string[] } | undefined>;
    }).shell;
    for (const nom of ['userTrie', 'privilegedTrie']) {
      const restants = (shell[nom]?.enumerateExecutablePaths() ?? [])
        .filter((p) => p === 'setup');
      expect(restants, `${nom} garde setup`).toEqual([]);
    }
  });
});
