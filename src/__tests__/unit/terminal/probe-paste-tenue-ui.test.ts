/**
 * Le collage tient l'interface.
 *
 * Un collage exécutait ses lignes sans jamais rendre la main à la
 * boucle d'événements : `await` sur une promesse déjà résolue ne
 * produit qu'une micro-tâche, et le navigateur les épuise toutes avant
 * de peindre quoi que ce soit. L'onglet restait donc figé du début à la
 * fin — rien ne s'affichait au fur et à mesure, aucun clic ne passait,
 * et le Ctrl-C censé l'interrompre n'était jamais lu.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let pc: LinuxPC;
let session: LinuxTerminalSession;

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  session = new LinuxTerminalSession('term-1', pc);
});

function texte(): string {
  return session.lines.map((l) => l.text).join('\n');
}

/** Compte les tours de boucle d'événements obtenus pendant `travail`. */
async function toursPendant(travail: () => Promise<void>): Promise<number> {
  let tours = 0;
  let stop = false;
  const battre = () => { if (!stop) { tours++; setTimeout(battre, 0); } };
  setTimeout(battre, 0);
  await new Promise((r) => setTimeout(r, 20));
  const avant = tours;
  await travail();
  stop = true;
  return tours - avant;
}

const BLOC_300 = Array.from({ length: 300 }, (_, i) => `echo ligne${i}`).join('\n') + '\n';

/** Ouvre une vraie invite de mot de passe, par le chemin qu'un opérateur emprunte. */
async function enInviteDeMotDePasse(): Promise<void> {
  session.setInput('su - root');
  await session.dispatchEnter();
  expect(session.currentInputMode.type,
    'le laboratoire n\'a pas ouvert d\'invite de mot de passe').toBe('password');
}

describe('un collage rend la main au navigateur', () => {
  it('la boucle d\'événements tourne pendant un gros collage', async () => {
    const tours = await toursPendant(() => session.pasteText(BLOC_300));
    expect(tours, 'aucun tour de boucle : l\'onglet est gelé').toBeGreaterThan(0);
  }, 60_000);

  it('et le collage reste correct : toutes les lignes s\'exécutent, dans l\'ordre', async () => {
    await session.pasteText(BLOC_300);
    const out = texte();
    expect(out).toContain('ligne0');
    expect(out).toContain('ligne299');
    expect(out.indexOf('ligne0')).toBeLessThan(out.indexOf('ligne299'));
    expect(session.input).toBe('');
  }, 60_000);

  // La découpe suit le TEMPS, pas le nombre de lignes : elle ne peut
  // donc jamais rendre la main plus d'une fois par ligne, et un petit
  // collage ne la paie pratiquement pas. Affirmer « zéro tour » serait
  // encoder une horloge : sous charge, deux lignes peuvent dépasser la
  // tranche, et le test deviendrait instable sans qu'un défaut existe.
  it('un petit collage n\'est pas fragmenté ligne à ligne', async () => {
    const tours = await toursPendant(() => session.pasteText('echo a\necho b\n'));
    expect(tours).toBeLessThanOrEqual(2);
    expect(texte()).toContain('a');
  }, 30_000);
});

describe('un collage s\'interrompt', () => {
  it('`abortPaste` arrête le bloc et dit combien de lignes ont sauté', async () => {
    const marche = session.pasteText(BLOC_300);
    // Laisser démarrer, puis interrompre depuis la boucle d'événements —
    // ce que le Ctrl-C du terminal fait, et qui était impossible tant
    // que la boucle ne tournait pas.
    await new Promise((r) => setTimeout(r, 5));
    const arrete = session.abortPaste();
    await marche;
    expect(arrete, 'le collage n\'a pas pu être interrompu').toBe(true);
    expect(texte()).toMatch(/Paste aborted — \d+ lines? not executed/);
    expect(texte()).not.toContain('ligne299');
    expect(session.input).toBe('');
  }, 60_000);

  it('hors collage, `abortPaste` ne prétend rien avoir arrêté', () => {
    expect(session.abortPaste()).toBe(false);
    expect(session.isPasteRunning()).toBe(false);
  });

  it('`isPasteRunning` est vrai pendant, faux après', async () => {
    const marche = session.pasteText(BLOC_300);
    await new Promise((r) => setTimeout(r, 5));
    expect(session.isPasteRunning()).toBe(true);
    session.abortPaste();
    await marche;
    expect(session.isPasteRunning()).toBe(false);
  }, 60_000);
});

/**
 * La retenue est désormais un RÉGLAGE, et non le comportement par
 * défaut : un vrai terminal livre le bloc entier, invite comprise, et
 * c'est ce que fait le simulateur quand on ne lui demande rien (voir
 * `paste-fidelite-ios.test.ts`). Ces cas décrivent donc ce que le
 * réglage coupé garantit — c'est là que la protection a déménagé.
 */
describe('collage coupé : un mot de passe est une ligne, et le reste ne s\'y ajoute pas', () => {
  it('un bloc collé dans une invite de mot de passe n\'en garde que la première ligne', async () => {
    session.definirCollageMultiligne(false);
    await enInviteDeMotDePasse();
    await session.pasteText('secret\nrm -rf /\nautre chose\n');
    expect(session.getPasswordBuf()).toBe('secret');
    expect(texte()).toMatch(/2 further lines ignored/);
  }, 30_000);

  it('et rien n\'est exécuté : le mot de passe ne soumet pas la suite', async () => {
    session.definirCollageMultiligne(false);
    await enInviteDeMotDePasse();
    await session.pasteText('secret\necho FUITE\n');
    expect(texte()).not.toContain('FUITE');
  }, 30_000);

  it('une seule ligne collée reste silencieuse, réglage ou pas', async () => {
    await enInviteDeMotDePasse();
    await session.pasteText('secret');
    expect(session.getPasswordBuf()).toBe('secret');
    expect(texte()).not.toMatch(/ignored/);
  }, 30_000);
});

/**
 * Le collage sous un sous-shell — ce qu'un `ssh` ouvre.
 *
 * `pasteText` s'exécute sur la session que la VUE tient — l'hôte — et y
 * pose son drapeau, alors que les accesseurs déléguaient au sous-shell
 * le plus profond : le drapeau était posé à un endroit et lu à un
 * autre, donc le Ctrl-C d'interruption échouait en silence dès qu'une
 * session distante était ouverte.
 *
 * Le second cas ne corrige rien : il PINNE une propriété qui tenait
 * déjà, parce que toutes les sous-classes concrètes surchargent
 * `currentInputMode` pour déléguer au premier plan. Seule la base
 * abstraite ne le fait pas, et elle n'est jamais instanciée — j'ai cru
 * y voir un défaut, la mesure dit le contraire. Le test reste, parce
 * que rien n'empêchait jusqu'ici qu'une future sous-classe oublie cette
 * surcharge et fasse fuiter un bloc collé dans une invite masquée.
 */
describe('sous un sous-shell, le collage reste gouvernable', () => {
  /** Ce que fait `ssh` : une session enfant attachée à l'hôte. */
  async function avecSousShell(): Promise<LinuxTerminalSession> {
    const enfant = new LinuxTerminalSession('term-enfant', pc);
    enfant.attachAsChildOf(session);
    expect(session.hasActiveChild, 'le sous-shell ne s\'est pas attaché').toBe(true);
    return enfant;
  }

  it('le Ctrl-C interrompt un collage même quand un sous-shell est ouvert', async () => {
    await avecSousShell();
    const marche = session.pasteText(BLOC_300);
    await new Promise((r) => setTimeout(r, 5));
    expect(session.isPasteRunning(), 'le collage n\'est pas vu depuis l\'hôte').toBe(true);
    expect(session.abortPaste(), 'le collage n\'a pas pu être interrompu').toBe(true);
    await marche;
    expect(texte()).toMatch(/Paste aborted/);
    expect(session.isPasteRunning()).toBe(false);
  }, 60_000);

  it('collage coupé, une invite de mot de passe DANS le sous-shell retient le bloc', async () => {
    session.definirCollageMultiligne(false);
    const enfant = await avecSousShell();
    // Si l'hôte cessait de relayer le mode de son premier plan, le
    // collage soumettrait la suite du bloc dans l'invite masquée.
    enfant.setInput('su - root');
    await enfant.dispatchEnter();
    expect(enfant.currentInputMode.type).toBe('password');
    // L'hôte relaie le mode de son premier plan : c'est cette
    // délégation que le test protège.
    expect(session.currentInputMode.type).toBe('password');

    await session.pasteText('secret\necho FUITE\n');
    expect(enfant.getPasswordBuf()).toBe('secret');
    expect(texte(), 'la suite du bloc a été exécutée depuis une invite masquée')
      .not.toContain('FUITE');
  }, 30_000);

  it('collage actif, le mot de passe du sous-shell est livré et la suite passe', async () => {
    const enfant = await avecSousShell();
    enfant.setInput('su - root');
    await enfant.dispatchEnter();
    expect(enfant.currentInputMode.type).toBe('password');

    // Ce que fait une vraie console : la ligne suivante répond à
    // l'invite, et le bloc continue derrière. Le mot de passe est le
    // VRAI — avec un mauvais, `su` redemande, et l'invite resterait
    // ouverte pour une raison qui ne prouverait rien de la livraison.
    await session.pasteText('admin\necho SUITE\n');
    expect(enfant.getPasswordBuf()).toBe('');
    expect(session.currentInputMode.type,
      'l invite est restée ouverte : le mot de passe n a pas été livré').toBe('normal');
    expect(texte()).toContain('SUITE');
  }, 30_000);
});
