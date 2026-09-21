/**
 * Un lien de base de donnees traverse-t-il le reseau ?
 *
 * Mesure AVANT (base mise de cote par `git stash push -- src/database
 * src/network src/terminal`) : `SELECT ... FROM t@lien' mettait bien des
 * trames sur le fil, mais c'etait la POIGNEE DE MAIN seule — le lot
 * precedent l'avait rendue reelle. Les lignes, elles, etaient lues en
 * memoire sur l'objet du pair (`remote.connect()' puis
 * `remote.executeSql()'). Compte des octets ENTRANTS sur le port du
 * client :
 *
 *     1 ligne distante   ->  524 octets
 *   200 lignes distantes ->  460 octets
 *
 * Moins pour deux cents lignes que pour une : le jeu de resultats ne
 * traversait pas, et le compte ne mesurait que le bruit de la connexion.
 *
 * Mesure APRES :
 *
 *     1 ligne distante   ->  1212 octets
 *   200 lignes distantes ->  3496 octets
 *
 * Le volume suit le nombre de lignes, ce qui n'est possible que si elles
 * voyagent.
 *
 * Les trois sites portaient la meme faute : `fetchDbLinkRows' (SELECT),
 * `execDbLinkDml' (INSERT/UPDATE/DELETE, qui passait un noeud d'AST a
 * l'executeur distant) et `settleDbLinkTransactions' (COMMIT/ROLLBACK).
 * Ils partagent desormais un port `DbLinkSession' a deux implantations :
 * en memoire quand le lien pointe sur la machine locale — un lien local
 * ne traverse legitimement aucun reseau — et sur le fil sinon.
 *
 * Autorite : la meme qu'au lot precedent, et la meme limite. Le cadrage
 * NS vient du dissecteur TNS de Wireshark ; ce qui est transporte DANS
 * un paquet DATA est propre a ce simulateur, la couche TTC d'Oracle
 * n'etant documentee nulle part d'accessible. L'AST voyage donc
 * serialise plutot que re-rendu en SQL : ecrire un rendu AST -> SQL a
 * cote du parseur serait une seconde grammaire pour un seul fait.
 *
 * Discrimination : 2 cas sur 6, mesures par `git stash push -- src/database
 * src/network src/terminal'. Ce sont les deux qui COMPTENT des octets ; le
 * reste du banc garde des reponses que la base rendait deja, par un autre
 * chemin. Les quatre, nommes :
 *
 *   - « la ligne inseree par le lien est visible sur la machine
 *     distante » : NON-REGRESSION. La base inserait en memoire sur le
 *     meme objet, la ligne etait donc visible aussi. Le cas garde que
 *     faire voyager le DML la depose toujours au bon endroit.
 *   - « un mot de passe faux revient en ORA-01017 » : NON-REGRESSION.
 *     La base verifiait le mot de passe en memoire sur l'objet du pair ;
 *     la reponse est la meme, c'est le CHEMIN qui a change — et cela, ce
 *     cas ne peut pas le voir.
 *   - « listener arrete : ORA-12541 » : NON-REGRESSION, et deja rendue
 *     reelle par le lot precedent, qui a mis la poignee de main sur le
 *     fil. Le cas garde l'echelle d'erreurs.
 *   - « temoin : la table distante existe bien chez le pair » : le
 *     TEMOIN. Sans lui, un banc fait de refus ne prouverait rien.
 *
 * Une precaution de mesure, apprise en la ratant : le PREMIER ordre passe
 * par un lien paie la poignee de main complete. Le cas de l'INSERT
 * echauffe donc la session mise en cache avant de comparer deux charges
 * utiles, faute de quoi il mesure la connexion et non l'ordre — la
 * premiere version rendait -1116 octets pour un ordre plus long.
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

const BULK_ROWS = 200;

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
  far.processLine('CREATE TABLE system.big_marker (city VARCHAR2(30));');
  for (let i = 0; i < BULK_ROWS; i++) {
    far.processLine(`INSERT INTO system.big_marker VALUES ('CITY${i}');`);
  }
  far.processLine('COMMIT;');
  far.dispose();

  SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']).subShell.dispose();
  return { client, dbhost };
}

function linked(client: LinuxServer) {
  const shell = SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']).subShell;
  shell.processLine(
    "CREATE DATABASE LINK farlink CONNECT TO system IDENTIFIED BY oracle USING '//10.0.0.2/ORCL';");
  return shell;
}

describe('les lignes d un lien de base traversent le reseau', () => {
  it('les octets entrants suivent le nombre de lignes distantes', () => {
    const { client } = lan();
    const shell = linked(client);
    const port = client.getPorts()[0];

    const beforeOne = port.getCounters().bytesIn;
    shell.processLine('SELECT city FROM system.remote_marker@farlink;');
    const afterOne = port.getCounters().bytesIn;
    shell.processLine('SELECT city FROM system.big_marker@farlink;');
    const afterMany = port.getCounters().bytesIn;
    shell.dispose();

    const oneRow = afterOne - beforeOne;
    const manyRows = afterMany - afterOne;
    expect(oneRow).toBeGreaterThan(0);
    expect(manyRows).toBeGreaterThan(oneRow * 2);
  });

  it('les octets sortants d un INSERT distant suivent la longueur de la valeur', () => {
    const { client } = lan();
    const shell = linked(client);
    const port = client.getPorts()[0];
    const longCity = 'D'.repeat(28);

    shell.processLine("INSERT INTO system.remote_marker@farlink VALUES ('X');");
    const beforeShort = port.getCounters().bytesOut;
    const inserted = shell.processLine(
      "INSERT INTO system.remote_marker@farlink VALUES ('DO');");
    const afterShort = port.getCounters().bytesOut;
    shell.processLine(
      `INSERT INTO system.remote_marker@farlink VALUES ('${longCity}');`);
    const afterLong = port.getCounters().bytesOut;
    shell.processLine('COMMIT;');
    shell.dispose();

    const shortBytes = afterShort - beforeShort;
    const longBytes = afterLong - afterShort;
    expect(shortBytes).toBeGreaterThan(0);
    expect(longBytes - shortBytes).toBeGreaterThanOrEqual(longCity.length - 'DO'.length);
    expect(inserted.output.join('\n')).toContain('1 row created.');
  });

  it('la ligne inseree par le lien est visible sur la machine distante', () => {
    const { client, dbhost } = lan();
    const shell = linked(client);
    shell.processLine("INSERT INTO system.remote_marker@farlink VALUES ('DOUALA');");
    shell.processLine('COMMIT;');
    shell.dispose();

    const far = SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']).subShell;
    const rows = far.processLine('SELECT city FROM system.remote_marker;').output ?? [];
    far.dispose();
    expect(rows.join('\n')).toContain('DOUALA');
  });
});

describe('le lien porte ses propres identifiants, verifies chez le serveur', () => {
  it('un mot de passe faux revient en ORA-01017', () => {
    const { client } = lan();
    const shell = SqlPlusSubShell.create(client, ['/', 'as', 'sysdba']).subShell;
    shell.processLine(
      "CREATE DATABASE LINK badlink CONNECT TO system IDENTIFIED BY wrong USING '//10.0.0.2/ORCL';");
    const rows = shell.processLine('SELECT city FROM system.remote_marker@badlink;');
    shell.dispose();
    expect(rows.output.join('\n')).toContain('ORA-01017');
  });

  it('listener arrete : le lien rend ORA-12541 sans jamais lire le pair', () => {
    const { client, dbhost } = lan();
    const shell = linked(client);
    const stop = SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']).subShell;
    stop.dispose();
    void dbhost.executeCommand('ip link set eth0 down');
    const rows = shell.processLine('SELECT city FROM system.remote_marker@farlink;');
    shell.dispose();
    expect(rows.output.join('\n')).toMatch(/ORA-12170|ORA-12541|ORA-03113/);
  });

  it('temoin : le labo est sain, la table distante existe bien chez le pair', () => {
    const { dbhost } = lan();
    const far = SqlPlusSubShell.create(dbhost, ['/', 'as', 'sysdba']).subShell;
    const rows = far.processLine('SELECT city FROM system.remote_marker;').output ?? [];
    far.dispose();
    expect(rows.join('\n')).toContain('YAOUNDE');
  });
});
