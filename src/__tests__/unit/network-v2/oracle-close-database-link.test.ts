/**
 * `ALTER SESSION CLOSE DATABASE LINK' : un critere accepte et jamais honore.
 *
 * Mesure AVANT (base mise de cote par `git stash push -- src/database') :
 *
 *   SELECT db_link FROM v$dblink        -> no rows selected  (toujours)
 *   ALTER SESSION CLOSE ... ghostlink   -> Session altered.
 *   ALTER SESSION CLOSE ... farlink     -> Session altered.  (rien ferme)
 *   idem pendant une transaction        -> Session altered.
 *
 * `parseAlterSession' avalait tous les jetons jusqu'au point-virgule et
 * rendait un noeud vide ; `execAlterSession' repondait << Session
 * altered. >> quoi qu'il arrive. La commande avait toutes les apparences
 * d'exister sauf l'effet — le cas que CLAUDE.md §6 nomme le pire des
 * trois. `V$DBLINK', de son cote, etait declaree avec ses dix colonnes et
 * rendait toujours zero ligne : une vue qui ne peut contredire personne
 * parce qu'elle ne dit rien.
 *
 * Mesure APRES :
 *
 *   avant tout usage                    -> no rows selected
 *   apres un SELECT par le lien         -> FARLINK / YES / NO
 *   CLOSE d'un lien inconnu             -> ORA-02081
 *   CLOSE du lien ouvert                -> Session altered., puis 0 ligne
 *   CLOSE pendant une transaction       -> ORA-02080
 *   apres COMMIT                        -> 0 ligne
 *
 * Les trois faits tiennent ensemble : la session de lien VIT jusqu'au
 * COMMIT (auparavant `fetchDbLinkRows' ouvrait et refermait par requete),
 * `V$DBLINK' la MONTRE, et `CLOSE DATABASE LINK' la FERME. Un seul
 * registre — `OracleRuntimeState.openDbLinks' — porte le fait, sur le
 * seam que ce depot reserve aux vues reactives.
 *
 * AUTORITES, et leurs limites, dites plutot que sous-entendues :
 *
 *   - La SYNTAXE (`ALTER SESSION CLOSE DATABASE LINK parameter_name')
 *     vient de la grammaire PL/SQL d'`antlr/grammars-v4'. C'est une
 *     grammaire COMMUNAUTAIRE, pas la documentation d'Oracle.
 *   - Le LIBELLE d'ORA-02080 et d'ORA-02081 n'a PAS pu etre verifie :
 *     docs.oracle.com rend 000, oracle.com rend 403 et oracle.github.io
 *     rend 000 depuis cette machine — tout hote appartenant a Oracle est
 *     bloque par le proxy de sortie — et je n'ai pas de capture. Les cas
 *     ci-dessous n'affirment donc QUE le code et la condition, jamais la
 *     phrase : si le libelle exact differe, une chaine change et aucun
 *     test n'aura epingle un faux.
 *
 * Discrimination : 6 cas sur 7, mesures par `git stash push -- src/database'.
 * Le septieme, « rien n est ouvert avant le premier usage du lien », passe
 * des deux cotes : la vue d'avant rendait TOUJOURS zero ligne, elle avait
 * donc raison par accident sur ce cas precis. Il reste comme TEMOIN — il
 * prouve que la vue est lisible et que le registre n'invente pas de ligne
 * avant qu'un lien serve — et il est nomme ici pour qu'on ne le prenne pas
 * pour une preuve.
 *
 * Deux cas de ce banc ne discriminaient pas non plus a la premiere
 * ecriture, pour la meme raison de fond : ils verifiaient « 0 ligne apres
 * fermeture » sur une vue qui rendait deja 0 ligne partout. Ils exigent
 * maintenant la ligne AVANT la fermeture, faute de quoi ils passaient sans
 * rien prouver.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { SqlPlusSubShell } from '@/terminal/subshells/SqlPlusSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
});

function lan() {
  const client = new LinuxServer('linux-server', 'appclient', 0, 0);
  const dbhost = new LinuxServer('linux-server', 'dbhost', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw1', 8, 0, 0);
  new Cable('c1').connect(client.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(dbhost.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  client.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  dbhost.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  client.setHostname('appclient');
  dbhost.setHostname('dbhost');

  const far = SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']).subShell;
  far.processLine('CREATE TABLE system.remote_marker (city VARCHAR2(30));');
  far.processLine("INSERT INTO system.remote_marker VALUES ('YAOUNDE');");
  far.processLine('COMMIT;');
  far.dispose();

  SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']).subShell.dispose();
  return { client };
}

function linked(client: LinuxServer) {
  const shell = SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']).subShell;
  shell.processLine(
    "CREATE DATABASE LINK farlink CONNECT TO system IDENTIFIED BY oracle USING '//10.0.0.2/ORCL';");
  return shell;
}

const say = (shell: ReturnType<typeof linked>, sql: string): string =>
  (shell.processLine(sql).output ?? []).join('\n');

describe('V$DBLINK dit ce que la session tient vraiment ouvert', () => {
  it('rien n est ouvert avant le premier usage du lien', () => {
    const { client } = lan();
    const shell = linked(client);
    const rows = say(shell, 'SELECT db_link FROM v$dblink;');
    shell.dispose();
    expect(rows).toContain('no rows selected');
  });

  it('un SELECT par le lien l ouvre, et la vue le montre hors transaction', () => {
    const { client } = lan();
    const shell = linked(client);
    shell.processLine('SELECT city FROM system.remote_marker@farlink;');
    const rows = say(shell, 'SELECT db_link, logged_on, in_transaction FROM v$dblink;');
    shell.dispose();
    expect(rows).toContain('FARLINK');
    expect(rows).toMatch(/FARLINK\s+YES\s+NO/);
  });

  it('un DML par le lien le marque en transaction', () => {
    const { client } = lan();
    const shell = linked(client);
    shell.processLine("INSERT INTO system.remote_marker@farlink VALUES ('DOUALA');");
    const rows = say(shell, 'SELECT db_link, in_transaction FROM v$dblink;');
    shell.processLine('COMMIT;');
    shell.dispose();
    expect(rows).toMatch(/FARLINK\s+YES/);
  });
});

describe('CLOSE DATABASE LINK a un effet, et refuse quand il le doit', () => {
  it('fermer un lien qui n est pas ouvert est refuse (ORA-02081)', () => {
    const { client } = lan();
    const shell = linked(client);
    const answer = say(shell, 'ALTER SESSION CLOSE DATABASE LINK ghostlink;');
    shell.dispose();
    expect(answer).toContain('ORA-02081');
    expect(answer).not.toContain('Session altered.');
  });

  it('fermer un lien ouvert le retire vraiment de V$DBLINK', () => {
    const { client } = lan();
    const shell = linked(client);
    shell.processLine('SELECT city FROM system.remote_marker@farlink;');
    const before = say(shell, 'SELECT db_link FROM v$dblink;');
    const closed = say(shell, 'ALTER SESSION CLOSE DATABASE LINK farlink;');
    const after = say(shell, 'SELECT db_link FROM v$dblink;');
    shell.dispose();
    expect(before).toContain('FARLINK');
    expect(closed).toContain('Session altered.');
    expect(after).toContain('no rows selected');
  });

  it('fermer un lien engage dans une transaction distribuee est refuse (ORA-02080)', () => {
    const { client } = lan();
    const shell = linked(client);
    shell.processLine("INSERT INTO system.remote_marker@farlink VALUES ('DOUALA');");
    const answer = say(shell, 'ALTER SESSION CLOSE DATABASE LINK farlink;');
    const still = say(shell, 'SELECT db_link FROM v$dblink;');
    shell.processLine('COMMIT;');
    shell.dispose();
    expect(answer).toContain('ORA-02080');
    expect(still).toContain('FARLINK');
  });

  it('COMMIT regle la transaction distante et referme le lien', () => {
    const { client } = lan();
    const shell = linked(client);
    shell.processLine("INSERT INTO system.remote_marker@farlink VALUES ('DOUALA');");
    const before = say(shell, 'SELECT db_link FROM v$dblink;');
    shell.processLine('COMMIT;');
    const after = say(shell, 'SELECT db_link FROM v$dblink;');
    shell.dispose();
    expect(before).toContain('FARLINK');
    expect(after).toContain('no rows selected');
  });
});
