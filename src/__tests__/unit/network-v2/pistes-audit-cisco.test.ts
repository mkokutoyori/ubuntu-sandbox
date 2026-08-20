/**
 * Les pistes d'audit Cisco — la trace de changement de configuration
 * (`docs/PRD-Pistes-Audit-Cisco.md`).
 *
 * Mesure de départ : les 65 commandes de configuration du tutoriel sont
 * TOUTES acceptées, et la plupart honorées — syslog, SNMPv3, NTP et
 * l'archivage sont réels. Ce qui ne l'était pas tenait en un point :
 * **la trace ne nommait personne et ne se relisait pas.**
 *
 * — `log config` et ses quatre réglages étaient acceptés, rangés, et
 *   RIEN n'était jamais retenu ni annoncé : aucun
 *   `%PARSER-5-CFGLOG_LOGGEDCMD` n'existait dans tout le dépôt, donc la
 *   seule trace de « qui a tapé quoi » qui n'exige aucun serveur ne
 *   produisait rien. `logging size` n'était même pas rendu dans la
 *   configuration, donc perdu au rechargement d'une topologie.
 * — `show archive log config` n'existait pas : le journal n'avait pas de
 *   porte.
 * — `show archive config differences` — que le tutoriel appelle « la
 *   commande la plus utile pour un auditeur » — était enregistrée SANS
 *   ARGUMENT (la forme du tutoriel était donc refusée) et rendait une
 *   PHRASE au lieu d'un diff. Le support ne savait qu'écrire : le
 *   contenu archivé n'était relu par personne, donc aucune comparaison
 *   n'était calculable.
 * — `dir flash:archive/` ignorait le répertoire demandé et listait la
 *   racine — une réponse fausse à une question précise de la séquence
 *   de collecte de preuves.
 * — `show who`, synonyme de `show users` sur IOS, répondait
 *   `% Invalid input`.
 *
 * Discriminé par remise en état des quatre fichiers produit : **15 cas
 * sur 19 tombent** avant correctif. Les 4 qui passent des deux côtés sont
 * nommés ici plutôt que laissés à découvrir, parce que deux d'entre eux
 * ne prouvent rien du mécanisme : « une commande refusée n'entre pas au
 * journal » passait parce qu'AUCUNE commande n'y entrait, et « le
 * préambule n'est jamais compté » parce que le diff était une phrase qui
 * ne contenait ni l'un ni l'autre des deux mots cherchés. Les deux
 * autres sont les cas de non-régression, dont c'est l'objet.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

async function run(r: CiscoRouter, cmds: string[]): Promise<string> {
  let last = '';
  for (const c of cmds) last = String(await r.executeCommand(c));
  return last;
}

/** Un routeur dont le journal de configuration est armé, comme au §4. */
async function labJournal(): Promise<CiscoRouter> {
  const r = new CiscoRouter('R1');
  await run(r, ['enable', 'configure terminal',
    'archive',
    'path flash:archive/R1-config',
    'maximum 5',
    'write-memory',
    'log config',
    'logging enable',
    'logging size 1000',
    'notify syslog contenttype plaintext',
    'hidekeys',
    'exit', 'exit', 'end']);
  return r;
}

describe('§3 : le journal de configuration nomme qui a tapé quoi', () => {
  it('chaque commande de configuration est retenue avec son auteur', async () => {
    const r = await labJournal();
    await run(r, ['configure terminal', 'interface GigabitEthernet0/2',
      'description Lien vers SW3', 'no shutdown', 'end']);
    const journal = String(await r.executeCommand('show archive log config all'));
    expect(journal).toContain('Logged command');
    expect(journal).toContain('console@console');
    expect(journal).toContain('interface GigabitEthernet0/2');
    expect(journal).toContain('description Lien vers SW3');
    expect(journal).toContain('no shutdown');
    // `configure terminal` n'est pas une commande de configuration : on
    // n'y est pas encore quand on la tape.
    expect(journal).not.toContain('configure terminal');
  });

  it('le message syslog est celui d\'IOS', async () => {
    const r = await labJournal();
    await run(r, ['configure terminal', 'hostname R2', 'end']);
    const logs = String(await r.executeCommand('show logging'));
    expect(logs).toContain('%PARSER-5-CFGLOG_LOGGEDCMD: User:console logged command:hostname R2');
  });

  /**
   * Le point qui compte le plus : `hidekeys` masque à l'ÉCRITURE. Un
   * journal d'audit qui retiendrait le secret en clair pour le cacher
   * ensuite serait la fuite même que cette option existe pour empêcher.
   */
  it('`hidekeys` masque le secret dans le journal ET dans le syslog', async () => {
    const r = await labJournal();
    await run(r, ['configure terminal',
      'username auditeur privilege 15 secret TopSecret123', 'end']);
    const journal = String(await r.executeCommand('show archive log config all'));
    const logs = String(await r.executeCommand('show logging'));
    expect(journal).toContain('secret <removed>');
    expect(journal).not.toContain('TopSecret123');
    expect(logs).not.toContain('TopSecret123');
  });

  it('sans `hidekeys`, le secret est retenu tel quel', async () => {
    const r = new CiscoRouter('R1');
    await run(r, ['enable', 'configure terminal', 'archive', 'log config',
      'logging enable', 'exit', 'exit',
      'username x privilege 15 secret EnClair123', 'end']);
    expect(String(await r.executeCommand('show archive log config all')))
      .toContain('EnClair123');
  });

  it('une commande REFUSÉE n\'entre pas au journal', async () => {
    const r = await labJournal();
    await run(r, ['configure terminal', 'interface Bidon0/99', 'end']);
    expect(String(await r.executeCommand('show archive log config all')))
      .not.toContain('Bidon0/99');
  });

  /** Le journal est circulaire : `logging size` décide ce qu'on peut relire. */
  it('`logging size` borne vraiment le journal', async () => {
    const r = new CiscoRouter('R1');
    await run(r, ['enable', 'configure terminal', 'archive', 'log config',
      'logging enable', 'logging size 3', 'exit', 'exit',
      'hostname A', 'hostname B', 'hostname C', 'hostname D', 'end']);
    const journal = String(await r.executeCommand('show archive log config all'));
    expect(journal).not.toContain('hostname A');
    expect(journal).toContain('hostname D');
  });

  it('les réglages du journal se relisent dans la configuration', async () => {
    const r = await labJournal();
    const cfg = String(await r.executeCommand('show running-config'));
    for (const ligne of ['  logging enable', '  logging size 1000',
      '  hidekeys', '  notify syslog contenttype plaintext']) {
      expect(cfg, ligne).toContain(ligne);
    }
  });

  it('sans `notify syslog`, rien n\'est annoncé — mais tout est retenu', async () => {
    const r = new CiscoRouter('R1');
    await run(r, ['enable', 'configure terminal', 'archive', 'log config',
      'logging enable', 'exit', 'exit', 'hostname SANSNOTIF', 'end']);
    expect(String(await r.executeCommand('show logging'))).not.toContain('CFGLOG_LOGGEDCMD');
    expect(String(await r.executeCommand('show archive log config all')))
      .toContain('hostname SANSNOTIF');
  });
});

describe('§4 : comparer deux configurations', () => {
  it('le diff dit ce qui a changé, avec son contexte', async () => {
    const r = await labJournal();
    await r.executeCommand('archive config');
    await run(r, ['configure terminal', 'interface GigabitEthernet0/2',
      'description Lien vers SW3', 'end']);
    const diff = String(await r.executeCommand('show archive config differences'));
    expect(diff).toContain('!Contextual Config Diffs:');
    expect(diff).toContain('+ description Lien vers SW3');
    // La ligne de contexte est rendue SANS signe : elle n'a pas changé,
    // elle dit seulement OÙ le changement a eu lieu.
    expect(diff).toContain('interface GigabitEthernet0/2');
    expect(diff).not.toContain('+interface GigabitEthernet0/2');
  });

  it('une suppression est rendue comme telle', async () => {
    const r = await labJournal();
    await run(r, ['configure terminal', 'interface GigabitEthernet0/2',
      'description A SUPPRIMER', 'end']);
    await r.executeCommand('archive config');
    await run(r, ['configure terminal', 'interface GigabitEthernet0/2',
      'no description', 'end']);
    expect(String(await r.executeCommand('show archive config differences')))
      .toContain('- description A SUPPRIMER');
  });

  it('sans changement, il le dit', async () => {
    const r = await labJournal();
    await r.executeCommand('archive config');
    expect(String(await r.executeCommand('show archive config differences')))
      .toBe('!No changes were found');
  });

  /**
   * La taille annoncée en tête de configuration change dès qu'une lettre
   * change ailleurs : la compter ferait de CHAQUE diff un diff qui
   * signale une différence sans modification.
   */
  it('le préambule n\'est jamais compté comme une modification', async () => {
    const r = await labJournal();
    await r.executeCommand('archive config');
    await run(r, ['configure terminal', 'hostname UNNOMBEAUCOUPPLUSLONG', 'end']);
    const diff = String(await r.executeCommand('show archive config differences'));
    expect(diff).not.toContain('Current configuration');
    expect(diff).not.toContain('Building configuration');
  });

  it('la forme du tutoriel, avec argument, est acceptée', async () => {
    const r = await labJournal();
    await r.executeCommand('archive config');
    await run(r, ['configure terminal', 'hostname APRES', 'end']);
    const diff = String(await r.executeCommand(
      'show archive config differences system:running-config'));
    expect(diff).toContain('+hostname APRES');
  });

  it('un fichier inexistant est nommé plutôt qu\'ignoré', async () => {
    const r = await labJournal();
    await r.executeCommand('archive config');
    expect(String(await r.executeCommand(
      'show archive config differences flash:archive/inexistant')))
      .toContain('%Error opening flash:archive/inexistant');
  });
});

describe('§9 : la séquence de collecte de preuves', () => {
  it('`dir flash:archive/` liste le RÉPERTOIRE demandé', async () => {
    const r = await labJournal();
    await r.executeCommand('archive config');
    const out = String(await r.executeCommand('dir flash:archive/'));
    expect(out).toContain('Directory of flash:archive/');
    expect(out).toContain('R1-config-1');
    // L'image IOS et la configuration d'usine ne sont PAS dans archive/.
    expect(out).not.toContain('c2900-universalk9');
    expect(out).not.toContain('cpconfig');
  });

  it('la racine, elle, montre tout', async () => {
    const r = await labJournal();
    await r.executeCommand('archive config');
    const out = String(await r.executeCommand('dir flash:'));
    expect(out).toContain('c2900-universalk9');
    expect(out).toContain('archive/R1-config-1');
  });

  it('`show who` répond, et répond comme `show users`', async () => {
    const r = new CiscoRouter('R1');
    await r.executeCommand('enable');
    const who = String(await r.executeCommand('show who'));
    expect(who).not.toContain('% Invalid input');
    expect(who).toBe(String(await r.executeCommand('show users')));
  });
});

describe('non-régression : sans `log config`, rien ne change', () => {
  it('un routeur sans journal n\'annonce rien et n\'a rien à relire', async () => {
    const r = new CiscoRouter('R1');
    await run(r, ['enable', 'configure terminal', 'hostname R9', 'end']);
    expect(String(await r.executeCommand('show logging'))).not.toContain('CFGLOG_LOGGEDCMD');
    expect(String(await r.executeCommand('show archive log config all')))
      .toContain('Logged command');
  });

  it('sa configuration ne porte aucune ligne `archive`', async () => {
    const r = new CiscoRouter('R1');
    await run(r, ['enable', 'configure terminal', 'hostname R9', 'end']);
    expect(String(await r.executeCommand('show running-config'))).not.toContain('log config');
  });
});
