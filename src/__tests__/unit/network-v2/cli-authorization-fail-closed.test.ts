/**
 * Une table d'autorisation illisible REFUSE, elle n'accorde pas.
 *
 * Defaut mesure (audit §4, G5) : la fabrique de `CommandLevelTable` rend
 * `undefined` quand l'equipement n'est pas joignable — `deviceRef` nul —
 * et `levelOf` rendait alors le niveau PAR DEFAUT. Pour une commande de
 * l'arbre utilisateur ce defaut vaut 1, donc `authorize` accordait : une
 * commande HISSEE au niveau 15 redevenait joignable au niveau 1 des lors
 * que la table etait illisible.
 *
 * Que `commandVisibleTo` ait du inventer un mecanisme d'EMPRUNT de
 * l'equipement montre que ce cas se produit en pratique ; qu'aucun
 * chemin de production ne l'atteigne aujourd'hui ne rend pas le repli
 * moins dangereux — c'est le prochain appelant qui paierait.
 *
 * La regle est celle de tout systeme d'autorisation : ne pas savoir
 * n'est pas savoir que oui.
 */
import { describe, it, expect } from 'vitest';
import {
  CliAuthorization, CommandLevelTable, ParserViewRegistry,
  type AuthView, type CommandLevelRule,
} from '@/network/devices/shells/cli/CliAuthorization';

function autorisation(table: Map<string, CommandLevelRule> | undefined): CliAuthorization {
  return new CliAuthorization(
    new CommandLevelTable(() => table),
    new ParserViewRegistry(() => new Map<string, AuthView>()),
  );
}

const racine = { level: 1, view: null };

describe('G5 — table illisible', () => {
  it('une commande de niveau 1 par defaut est REFUSEE quand la table est illisible', () => {
    const a = autorisation(undefined);
    expect(a.authorize({
      principal: racine, scope: 'exec', command: 'show version', defaultLevel: 1,
    })).toBe('absent');
  });

  it('le niveau 15 passe quand meme — il ne peut rien y avoir au-dessus', () => {
    const a = autorisation(undefined);
    expect(a.authorize({
      principal: { level: 15, view: null }, scope: 'exec',
      command: 'show version', defaultLevel: 1,
    })).toBe('run');
  });

  it('les SORTIES restent joignables : une table illisible n est pas une souriciere', () => {
    const a = autorisation(undefined);
    for (const c of ['exit', 'end', 'logout', 'disable', 'enable']) {
      expect(a.authorize({
        principal: racine, scope: 'exec', command: c, defaultLevel: 1,
      }), c).toBe('run');
    }
  });

  // ── Non-régression : une table VIDE n'est pas une table illisible ──
  it('une table VIDE accorde le niveau par defaut, comme avant', () => {
    const a = autorisation(new Map());
    expect(a.authorize({
      principal: racine, scope: 'exec', command: 'show version', defaultLevel: 1,
    })).toBe('run');
    expect(a.authorize({
      principal: racine, scope: 'exec', command: 'reload', defaultLevel: 15,
    })).toBe('absent');
  });

  it('une table LISIBLE decide normalement', () => {
    const a = autorisation(new Map([['exec show version', { level: 15, all: false }]]));
    expect(a.authorize({
      principal: racine, scope: 'exec', command: 'show version', defaultLevel: 1,
    })).toBe('absent');
    // `show clock` est refusee elle aussi, et c'est la promotion des
    // PARENTES : hisser `show version` hisse `show`. Le remede est celui
    // qu'IOS documente — redescendre `show`.
    expect(a.authorize({
      principal: racine, scope: 'exec', command: 'show clock', defaultLevel: 1,
    })).toBe('absent');
    const b = autorisation(new Map([
      ['exec show version', { level: 15, all: false }],
      ['exec show', { level: 1, all: false }],
    ]));
    expect(b.authorize({
      principal: racine, scope: 'exec', command: 'show clock', defaultLevel: 1,
    })).toBe('run');
  });
});
