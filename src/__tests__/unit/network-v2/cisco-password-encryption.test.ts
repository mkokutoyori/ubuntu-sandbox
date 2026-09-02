/**
 * Scénario 4 — service password-encryption et sécurisation des mots de
 * passe en configuration.
 *
 * Couvre, avec le vrai moteur (pas de simulation superficielle) :
 *  - Sans `service password-encryption` : `username X password Y` affiche
 *    exactement `password 0 Y` (chiffre de type explicite) alors que
 *    `enable password Y` affiche `Y` SANS chiffre — comportement réel IOS
 *    confirmé, jusqu'ici cette distinction n'existait pas dans le
 *    simulateur (`enable password` affichait aussi `0` en dur).
 *  - Avec `service password-encryption` : les deux deviennent type 7, ET
 *    le passage à ON RÉTROACTIVEMENT ré-encode tout mot de passe type 0
 *    déjà configuré (enable password à tout niveau, ET les mots de passe
 *    `username`) — jusqu'ici seul `enable password` niveau 15 était
 *    ré-encodé rétroactivement.
 *  - `enable secret` et `enable password` configurés ensemble sont TOUS
 *    LES DEUX affichés dans `show running-config`, sans erreur ni
 *    avertissement (IOS utilise `enable secret` en priorité de façon
 *    silencieuse) — déjà correct, testé ici en régression.
 *  - `enable algorithm-type scrypt secret X` (forme alternative de
 *    `enable secret 9 X`) — jusqu'ici non parsée du tout.
 *  - `username X secret 5 ...` (haché, irréversible) est correctement
 *    étiqueté `secret`, tandis que `username X password 7 ...`
 *    (chiffrable) est étiqueté `password` — jusqu'ici TOUT mot de passe
 *    type 0 (qu'il vienne de `secret 0` ou de `password` nu) était
 *    étiqueté `secret` dans `show running-config`, une étiquette fausse
 *    pour la forme `password`.
 *  - Le message d'avertissement IOS récent sur les mots de passe type 0
 *    saisis via `username X password ...` — jusqu'ici totalement absent.
 *  - `show running-config | include A|B|C` — alternance multi-motifs
 *    (syntaxe Cisco `include`, pas un pipe shell) — jusqu'ici seul un
 *    motif littéral unique était supporté ; `include a|b` ne matchait
 *    rien.
 *
 * Portée assumée : ces mécanismes de sécurité de mot de passe
 * (`service password-encryption`, `username ... secret|password`,
 * l'avertissement type 0) sont testés sur `CiscoRouter` — la commande
 * `username`/`service password-encryption` "riche" (avec avertissement
 * et ré-encodage) vit dans `CiscoSecurityCommands.ts`, qui n'est câblée
 * QUE sur `CiscoIOSShell` (routeur) ; `CiscoSwitchShell` utilise encore
 * un chemin plus simple sans ce niveau de détail. Étendre l'intégralité
 * de ce mécanisme au switch serait un chantier séparé et disproportionné
 * pour ce scénario — lacune assumée et non simulée pour le switch,
 * cohérent avec le fait que ce scénario est démontré à 90% via
 * `Router#`/`Router(config)#` dans sa propre transcription.
 *
 * TDD: écrit avant l'implémentation des mécanismes ci-dessus (confirmé
 * absent/lacunaire par la recherche d'architecture : `enable password`
 * affichait `0` en dur pour toute forme non-chiffrée y compris niveau
 * "sans chiffre" attendu par IOS ; `username X password 0/nu` était
 * étiqueté `secret` ; `service password-encryption` ne ré-encodait que
 * `enable password` niveau 15 ; `enable algorithm-type` n'était pas
 * parsée ; aucun avertissement type 0 n'existait ; `| include a|b`
 * traitait `a|b` comme un seul motif littéral).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { decryptType7 } from '@/crypto';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function cfg(r: CiscoRouter): Promise<CiscoRouter> {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  return r;
}

describe('Scénario 4 — sans service password-encryption : type 0 explicite (username) vs implicite (enable password)', () => {
  it("username X password Y affiche 'password 0 Y' -- le chiffre de type EST montré", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    await r.executeCommand('username admin password ClearText123');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toContain('username admin');
    expect(rc).toContain('password 0 ClearText123');
  });

  it("enable password Y affiche 'enable password Y' SANS chiffre de type (comportement réel IOS)", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    await r.executeCommand('enable password EnableClear');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toContain('enable password EnableClear');
    expect(rc).not.toContain('enable password 0 EnableClear');
  });
});

describe('Scénario 4 — avec service password-encryption : type 7 pour les deux, y compris rétroactivement', () => {
  it("service password-encryption ré-encode RÉTROACTIVEMENT un username password déjà configuré", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    await r.executeCommand('username admin password ClearText123');
    await r.executeCommand('service password-encryption');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    const m = /username admin password 7 ([0-9A-F]+)/.exec(rc);
    expect(m).not.toBeNull();
    expect(decryptType7(m![1])).toBe('ClearText123');
    expect(rc).not.toContain('password 0 ClearText123');
  });

  it('service password-encryption ré-encode RÉTROACTIVEMENT un enable password déjà configuré', async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    await r.executeCommand('enable password EnableClear');
    await r.executeCommand('service password-encryption');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    const m = /enable password 7 ([0-9A-F]+)/.exec(rc);
    expect(m).not.toBeNull();
    expect(decryptType7(m![1])).toBe('EnableClear');
  });

  it('un mot de passe entré APRÈS activation devient directement type 7', async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    await r.executeCommand('service password-encryption');
    await r.executeCommand('username operateur password Level7@2025');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toMatch(/username operateur password 7 [0-9A-F]+/);
    expect(rc).not.toContain('Level7@2025');
  });

  it("désactiver le service N'inverse PAS le chiffrement déjà appliqué (irréversible, comme le vrai IOS)", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    await r.executeCommand('enable password EnableClear');
    await r.executeCommand('service password-encryption');
    await r.executeCommand('no service password-encryption');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toMatch(/enable password 7 [0-9A-F]+/);
    expect(rc).not.toContain('enable password EnableClear');
  });
});

describe("Scénario 4 — enable secret et enable password ensemble : les DEUX affichés, sans erreur", () => {
  it('enable secret et enable password coexistent dans show running-config, enable secret hashé, enable password type-7', async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    const out1 = await r.executeCommand('enable secret SecureEnable@2025');
    expect(out1).toBe('');
    await r.executeCommand('service password-encryption');
    const out2 = await r.executeCommand('enable password WeakEnable@2025');
    expect(out2).toBe('');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toMatch(/enable secret 5 \$1\$/);
    expect(rc).toMatch(/enable password 7 [0-9A-F]+/);
  });
});

describe("Scénario 4 — enable algorithm-type scrypt secret (type 9)", () => {
  it("'enable algorithm-type scrypt secret X' produit un vrai hash type 9", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    const out = await r.executeCommand('enable algorithm-type scrypt secret SecureV9@2025');
    expect(out).toBe('');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toMatch(/enable secret 9 \$9\$/);
    expect(rc).not.toContain('SecureV9@2025');
  });
});

describe("Scénario 4 — username secret vs username password : étiquette correcte dans show running-config", () => {
  it("'username X secret ...' (haché) est étiqueté secret ; 'username Y password 7 ...' (chiffrable) est étiqueté password", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    await r.executeCommand('username admin secret HashMe@2025');
    await r.executeCommand('username operateur password 7 120A00170803192E');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toMatch(/username admin secret 5 \$1\$/);
    expect(rc).toContain('username operateur password 7 120A00170803192E');
    expect(rc).not.toContain('username operateur secret 7 120A00170803192E');
  });

  // L'objet de ce cas est l'ÉTIQUETTE — `secret` et non `password` —
  // et il reste vérifié. Ce qu'il fixait en plus, et qui était le
  // défaut, c'est la valeur en clair : le type 0 d'un `secret` décrit la
  // SAISIE, pas le stockage, et IOS rend un secret haché quelle que soit
  // la forme d'entrée.
  it("'username X secret 0 ...' reste étiqueté secret, pas password, et sort haché", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    await r.executeCommand('username lecture secret 0 Read@2025');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config');
    expect(rc).toMatch(/^username lecture secret 5 \$1\$/m);
    expect(rc).not.toContain('Read@2025');
  });
});

describe('Scénario 4 — avertissement de dépréciation des mots de passe type 0', () => {
  it("'username X password Y' (type 0 nu) affiche l'avertissement de dépréciation IOS", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    const out = await r.executeCommand('username admin password ClearText123');
    expect(out).toContain('WARNING: Command has been added to the configuration using a type 0');
    expect(out).toContain('password. However, type 0 passwords will soon be deprecated. Migrate');
    expect(out).toContain('to a supported password type');
  });

  it("'username X password 7 ...' (déjà chiffré) N'affiche PAS l'avertissement", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    const out = await r.executeCommand('username operateur password 7 120A00170803192E');
    expect(out).not.toContain('WARNING');
  });

  it("'username X secret ...' N'affiche JAMAIS l'avertissement (toujours haché par IOS)", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    const out = await r.executeCommand('username admin secret HashMe@2025');
    expect(out).not.toContain('WARNING');
  });
});

describe('Scénario 4 — audit visuel : show running-config | include avec alternance multi-motifs', () => {
  it("'include username|enable' retourne les lignes matchant N'IMPORTE LEQUEL des motifs, pas un motif littéral unique", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    await r.executeCommand('username admin password ClearText123');
    await r.executeCommand('enable password EnableClear');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config | include username|enable');
    expect(rc).toContain('username admin');
    expect(rc).toContain('enable password EnableClear');
    expect(rc).not.toContain('hostname');
  });

  it("'include password|secret|username' -- alternance à trois motifs -- capture toutes les lignes pertinentes pour l'audit", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    await r.executeCommand('enable secret SecureEnable@2025');
    await r.executeCommand('username admin password ClearText123');
    await r.executeCommand('service password-encryption');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config | include password|secret|username');
    expect(rc).toContain('enable secret 5');
    expect(rc).toContain('username admin');
    expect(rc).toContain('service password-encryption');
  });

  it("'include service password' confirme que service password-encryption est actif", async () => {
    const r = await cfg(new CiscoRouter('R1', 0, 0));
    await r.executeCommand('service password-encryption');
    await r.executeCommand('end');
    const rc = await r.executeCommand('show running-config | include service password');
    expect(rc.trim()).toBe('service password-encryption');
  });
});
