/**
 * Le mot de passe d'une vue est VERIFIE.
 *
 * Defaut mesure (audit §2.2, C2/C3/C4) : `ParserView.secret` etait ecrit
 * par sa commande, rendu dans la configuration, et lu par PERSONNE.
 * Aucun chemin d'authentification ne le consultait. Les consequences
 * n'etaient pas theoriques :
 *
 * - depuis n'importe quelle vue restreinte, `enable view` seul rendait
 *   la RACINE et le NIVEAU 15, sans rien demander — un compte
 *   `username X view NOC` etait donc, en pratique, un compte de niveau
 *   15 ;
 * - `enable view AUTRE` sautait d'une vue a l'autre sans presenter le
 *   secret de la vue visee ;
 * - un test existant fournissait deja un `passwordInput` a `enable view`
 *   et ne discriminait rien, puisque n'importe quelle chaine passait.
 *
 * Cisco documente les deux moities : `enable view` demande un mot de
 * passe, et la vue racine confere les privileges de niveau 15.
 *
 * Ce que ces cas fixent en plus, et qui n'allait pas de soi : SANS
 * secret configure, la porte reste ouverte — c'est la meme regle que
 * `enable` sur une machine sans `enable secret`, et l'inverse
 * transformerait une vue en souriciere sur toute topologie existante.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

const SECRET_ACTIVATION = 'Coffre@Routeur2026';
const SECRET_NOC = 'Vue@Noc2026';
const SECRET_HELP = 'Vue@Help2026';

async function jouer(r: CiscoRouter, cmds: string[]): Promise<string> {
  let derniere = '';
  for (const c of cmds) derniere = await r.executeCommand(c);
  return derniere;
}

/** Deux vues avec chacune son secret, et un secret d'activation. */
async function lab(avecSecretActivation = true): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1', MACAddress.generate());
  await jouer(r, [
    'enable', 'configure terminal', 'aaa new-model',
    ...(avecSecretActivation ? [`enable secret ${SECRET_ACTIVATION}`] : []),
    'parser view NOC', `secret ${SECRET_NOC}`,
    'commands exec include show version', 'exit',
    'parser view HELPDESK', `secret ${SECRET_HELP}`,
    'commands exec include show clock', 'exit',
    'end',
  ]);
  return r;
}

const vueCourante = (r: CiscoRouter) => r.executeCommand('show parser view');

describe('C2/C3/C4 — le secret d une vue est verifie', () => {
  it('le BON secret ouvre la vue', async () => {
    const r = await lab();
    await r.executeCommand('enable view NOC', { passwordInput: SECRET_NOC });
    expect(await vueCourante(r)).toBe("Current view is 'NOC'");
    expect(await r.executeCommand('show version')).toContain('Cisco IOS Software');
  });

  it('un MAUVAIS secret n ouvre pas la vue', async () => {
    const r = await lab();
    const out = await r.executeCommand('enable view NOC', { passwordInput: 'PAS-LE-BON' });
    expect(out).toContain('% Access denied');
    expect(out).toContain('% Bad secrets');
    expect(await vueCourante(r)).toBe("Current view is 'root'");
  });

  it('AUCUN secret presente n ouvre pas la vue', async () => {
    const r = await lab();
    await r.executeCommand('enable view NOC');
    expect(await vueCourante(r)).toBe("Current view is 'root'");
  });

  it('on ne saute pas d une vue a l autre sans le secret de la vue visee', async () => {
    const r = await lab();
    await r.executeCommand('enable view NOC', { passwordInput: SECRET_NOC });
    expect(await vueCourante(r)).toBe("Current view is 'NOC'");

    await r.executeCommand('enable view HELPDESK', { passwordInput: SECRET_NOC });
    expect(await vueCourante(r)).toBe("Current view is 'NOC'");

    await r.executeCommand('enable view HELPDESK', { passwordInput: SECRET_HELP });
    expect(await vueCourante(r)).toBe("Current view is 'HELPDESK'");
  });

  it('la vue RACINE est gardee par le secret d activation', async () => {
    const r = await lab();
    await r.executeCommand('enable view NOC', { passwordInput: SECRET_NOC });

    await r.executeCommand('enable view', { passwordInput: 'PAS-LE-BON' });
    expect(await vueCourante(r)).toBe("Current view is 'NOC'");

    await r.executeCommand('enable view', { passwordInput: SECRET_ACTIVATION });
    expect(await vueCourante(r)).toBe("Current view is 'root'");
    expect(await r.executeCommand('show privilege')).toContain('level is 15');
  });

  it('une vue refusee ne rend NI le niveau 15 NI la racine', async () => {
    const r = await lab();
    await r.executeCommand('enable view NOC', { passwordInput: SECRET_NOC });
    await r.executeCommand('enable view', { passwordInput: 'PAS-LE-BON' });
    // Le contournement d'origine : le refus laissait passer quand meme.
    expect(await r.executeCommand('show ip route')).toContain('% Invalid input');
    expect(await r.executeCommand('configure terminal')).toContain('% Invalid input');
  });

  it('un secret RANGE EN CONDENSE se verifie quand meme', async () => {
    const r = await lab();
    // La configuration rendue est rejouee a l'import d'une topologie :
    // le secret y est un condense, et la porte doit le reconnaitre.
    const cfg = await r.executeCommand('show running-config');
    expect(cfg).toMatch(/secret 5 \$1\$/);
    expect(cfg).not.toContain(SECRET_NOC);
    await r.executeCommand('enable view NOC', { passwordInput: SECRET_NOC });
    expect(await vueCourante(r)).toBe("Current view is 'NOC'");
  });

  // ── Ce qui reste ouvert, et pourquoi ──────────────────────────────
  it('SANS secret sur la vue, la porte reste ouverte', async () => {
    const r = new CiscoRouter('R1', MACAddress.generate());
    await jouer(r, [
      'enable', 'configure terminal', 'aaa new-model',
      'parser view LIBRE', 'commands exec include show version', 'exit', 'end',
      'enable view LIBRE',
    ]);
    expect(await vueCourante(r)).toBe("Current view is 'LIBRE'");
  });

  it('SANS secret d activation, la racine reste joignable — pas de souriciere', async () => {
    const r = await lab(false);
    await r.executeCommand('enable view NOC', { passwordInput: SECRET_NOC });
    expect(await vueCourante(r)).toBe("Current view is 'NOC'");
    await r.executeCommand('enable view');
    expect(await vueCourante(r)).toBe("Current view is 'root'");
  });

  it('une vue inexistante est refusee avant toute demande de secret', async () => {
    const r = await lab();
    expect(await r.executeCommand('enable view INEXISTANTE'))
      .toBe('%Error: View INEXISTANTE is not present in the system');
  });
});
