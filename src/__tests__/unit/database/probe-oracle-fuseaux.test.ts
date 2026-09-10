/**
 * Lot T10 du `docs/PRD-Geographie-Et-Temps-Local.md` : Oracle porte un
 * fuseau de BASE et un fuseau de SESSION, et cesse de confondre l'heure
 * du serveur avec celle de la session.
 *
 * ── Ce qui a ete mesure avant correctif ─────────────────────────────
 *
 *     SELECT DBTIMEZONE FROM DUAL                 -> null
 *     SELECT SESSIONTIMEZONE FROM DUAL            -> null
 *     ALTER SESSION SET TIME_ZONE = 'Europe/Paris' -> Session altered.
 *     SELECT SESSIONTIMEZONE FROM DUAL            -> null
 *     SELECT CURRENT_TIMESTAMP FROM DUAL          -> ...12:42:51.645Z
 *
 * Trois defauts d'un coup. `DBTIMEZONE` et `SESSIONTIMEZONE` rendaient
 * `null` — ni valeur, ni erreur : l'identifiant n'etait connu de
 * personne et retombait en NULL silencieux, ce qui est la forme
 * PERMISSIVE de l'inconnu. `ALTER SESSION SET TIME_ZONE` repondait
 * « Session altered. » et ne changeait rien, ce qui est le `CLAUDE.md`
 * §6 dans sa forme pure : accepte, acquitte, sans effet.
 *
 * **Et un quatrieme que le PRD ne nommait pas.** `SYSTIMESTAMP` et
 * `CURRENT_TIMESTAMP` etaient la MEME ecriture — `new Date().toISOString()`
 * — de meme que `SYSDATE` et `CURRENT_DATE`. Or Oracle en fait deux
 * faits DIFFERENTS : `SYS*` est l'heure du SERVEUR, `CURRENT_*` celle de
 * la SESSION. Sans fuseau de session la distinction etait invisible, et
 * c'est precisement pourquoi elle avait pu etre ecrite deux fois pareil.
 * Un cas garde desormais que les deux DIVERGENT quand la session change
 * de fuseau, ce qui est la seule facon de prouver qu'elles ne sont plus
 * le meme fait.
 *
 * ── Ce que la sonde a trouve en cours de route ──────────────────────
 *
 * Rendre `SYSTIMESTAMP` avec son decalage a casse
 * `SYSTIMESTAMP - INTERVAL '1' HOUR`, qui rendait `ORA-01722: invalid
 * number`. Le moteur ECRIVAIT une forme qu'il ne savait pas RELIRE.
 * `coerceDateValue` accepte maintenant le decalage final, ce qui est la
 * meme exigence de coherence que le §3 pose entre deux vues : ici entre
 * le rendu et l'analyse d'une seule et meme valeur.
 *
 * ── Ce qui n'est pas source ─────────────────────────────────────────
 *
 * `docs.oracle.com` est bloque par le proxy de sortie de cet
 * environnement. Deux points sont etablis par des rendus secondaires
 * concordants de la reference SQL — `CURRENT_TIMESTAMP` rend l'heure
 * DANS le fuseau de la session, et `ORA-01882` est l'erreur d'une region
 * inconnue. Le FORMAT exact d'affichage d'un `TIMESTAMP WITH TIME ZONE`
 * ne l'est pas : il depend de `NLS_TIMESTAMP_TZ_FORMAT`, et la forme
 * rendue ici prolonge celle que le depot employait deja plutot que d'en
 * inventer une. Voir l'entree `TODO.md`.
 *
 * ── Discrimination ─────────────────────────────────────────────────
 *
 * Mesure : `git stash push -- src/database` fait tomber **9 des 11
 * cas**. Les 2 qui passent des deux cotes sont nommes :
 *
 *   - « le moteur sait RELIRE l'horodatage qu'il ecrit » passait AVANT
 *     pour une raison qui a disparu : l'horodatage etait un ISO propre
 *     que `Date.parse` avalait sans effort. Il a fallu le faire passer
 *     APRES, quand la valeur porte son decalage — et c'est en le cassant
 *     que le defaut a ete trouve. Il ne mesure donc pas un defaut ferme,
 *     il empeche celui que ce lot a lui-meme failli ouvrir.
 *   - « TEMOIN — sans reglage, serveur et session s'accordent » passait
 *     avant pour la MAUVAISE raison : les deux rendaient `null`, et
 *     `null === null`. Il doit continuer de passer pour la bonne, les
 *     deux valant `+00:00`. Sans lui, une base dont les deux fuseaux
 *     divergeraient des l'ouverture ne serait rattrapee par rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';

let db: OracleDatabase;
let executor: ReturnType<OracleDatabase['connectAsSysdba']>['executor'] | null = null;

beforeEach(() => {
  db = new OracleDatabase();
  executor = null;
});

function exec(sql: string): { rows?: unknown[][]; message?: string; error?: string } {
  if (!executor) executor = db.connectAsSysdba().executor;
  return db.executeSql(executor, sql) as unknown as {
    rows?: unknown[][]; message?: string; error?: string;
  };
}

function scalaire(sql: string): string {
  return String(exec(sql).rows?.[0]?.[0] ?? '');
}

describe('Oracle porte un fuseau de base et un fuseau de session', () => {
  it('DBTIMEZONE rend un decalage, non NULL', () => {
    expect(scalaire('SELECT DBTIMEZONE FROM DUAL')).toBe('+00:00');
  });

  it('SESSIONTIMEZONE aussi, avant tout reglage', () => {
    expect(scalaire('SELECT SESSIONTIMEZONE FROM DUAL')).toBe('+00:00');
  });

  it('ALTER SESSION SET TIME_ZONE change vraiment la session', () => {
    exec("ALTER SESSION SET TIME_ZONE = 'Europe/Paris'");

    expect(scalaire('SELECT SESSIONTIMEZONE FROM DUAL')).toBe('Europe/Paris');
  });

  it('un decalage numerique est accepte et rendu tel quel', () => {
    exec("ALTER SESSION SET TIME_ZONE = '-03:30'");

    expect(scalaire('SELECT SESSIONTIMEZONE FROM DUAL')).toBe('-03:30');
  });

  it('une region inconnue est REFUSEE par ORA-01882', () => {
    const refus = exec("ALTER SESSION SET TIME_ZONE = 'Zorglub/Ville'");

    expect(refus.message ?? refus.error ?? '').toContain('ORA-01882');
  });

  it('et le refus ne detruit pas le fuseau en place', () => {
    exec("ALTER SESSION SET TIME_ZONE = 'Europe/Paris'");
    exec("ALTER SESSION SET TIME_ZONE = 'Zorglub/Ville'");

    expect(scalaire('SELECT SESSIONTIMEZONE FROM DUAL')).toBe('Europe/Paris');
  });
});

describe('l_heure du SERVEUR et celle de la SESSION sont deux faits', () => {
  it('CURRENT_TIMESTAMP porte le decalage de la session', () => {
    exec("ALTER SESSION SET TIME_ZONE = 'Europe/Paris'");

    expect(scalaire('SELECT CURRENT_TIMESTAMP FROM DUAL')).toMatch(/\+02:00$/);
  });

  it('SYSTIMESTAMP reste celui du serveur et ne la suit PAS', () => {
    exec("ALTER SESSION SET TIME_ZONE = 'Europe/Paris'");

    expect(scalaire('SELECT SYSTIMESTAMP FROM DUAL')).toMatch(/\+00:00$/);
  });

  it('CURRENT_DATE se decale quand SYSDATE ne bouge pas', () => {
    exec("ALTER SESSION SET TIME_ZONE = '+09:00'");

    const serveur = scalaire('SELECT SYSDATE FROM DUAL');
    const session = scalaire('SELECT CURRENT_DATE FROM DUAL');

    expect(session).not.toBe(serveur);
  });

  it('le moteur sait RELIRE l_horodatage qu_il ecrit', () => {
    exec("ALTER SESSION SET TIME_ZONE = 'Europe/Paris'");

    const arithmetique = exec(
      "SELECT CAST(SYSTIMESTAMP - INTERVAL '1' HOUR AS VARCHAR2(64)) FROM DUAL");

    expect(String(arithmetique.message ?? '')).not.toContain('ORA-01722');
  });

  it('TEMOIN — sans reglage, serveur et session s_accordent', () => {
    expect(scalaire('SELECT SESSIONTIMEZONE FROM DUAL'))
      .toBe(scalaire('SELECT DBTIMEZONE FROM DUAL'));
  });
});
