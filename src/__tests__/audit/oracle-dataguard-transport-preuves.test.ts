/**
 * Sonde — le redo traverse le FIL jusqu'a la standby.
 *
 * CLAUDE.md nommait la limite : « Data Guard switchover() swaps two
 * role fields; there is no redo transport. » Le banc
 * `debug/rman/dataguard-transport-redo` a mesure qu'elle etait plus
 * profonde encore :
 *
 *   - `ALTER SYSTEM SET LOG_ARCHIVE_DEST_2 = 'SERVICE=... '` etait
 *     accepte, STOCKE, et rendu par SHOW PARAMETER comme par
 *     V$ARCHIVE_DEST — qui annoncait meme STATUS = VALID, une assertion
 *     que rien n'avait verifiee. Aucune standby n'apparaissait dans
 *     V$DATAGUARD_CONFIG, V$DATAGUARD_STATS ne rendait aucune ligne, et
 *     apres un switch le journal restait sur le primaire. La forme la
 *     plus pure de la regle 6 : lu, rendu, sans effet.
 *   - `ALTER DATABASE RECOVER MANAGED STANDBY DATABASE` et `ALTER
 *     DATABASE ADD STANDBY LOGFILE` repondaient « Database altered. »
 *     sans rien faire non plus.
 *
 * CE LOT FERME LE TRANSPORT (le premier des trois morceaux : transport,
 * application, bascule). Le chemin est celui d'un vrai Data Guard :
 * LNS -> RFS. L'identifiant TNS se resout comme celui d'un sqlplus, une
 * session Oracle Net s'ouvre VRAIMENT, et l'appel traverse. La regle 4
 * l'exige : rien ne va chercher la reponse sur l'objet du pair.
 *
 * LE TEMOIN QUI DECIDE est donc celui du FIL : la meme expedition, une
 * fois le pare-feu ferme entre les deux sites, ECHOUE et rien n'arrive.
 * C'est la DIFFERENCE entre les deux qui prouve le chemin.
 *
 * UN DEFAUT PREEXISTANT DECOUVERT EN CHEMIN, ferme ici : le corps de
 * tout appel Oracle Net etait encode en LATIN-1 (`charCodeAt & 0xff`).
 * Tout caractere au-dela de U+00FF etait tronque a un octet qui pouvait
 * tomber sur un guillemet ou une barre oblique inverse, et le JSON
 * arrivait illisible — `ORA-03137: malformed TTC packet`. Cela ne
 * touchait pas que le redo : une requete SQL portant un tel caractere
 * se cassait de la meme facon. Le corps voyage desormais en UTF-8.
 *
 * ET UNE CONTRAINTE REELLE, mesuree : l'en-tete NS porte sa longueur
 * sur 16 bits, donc un journal entier ne tient pas dans un paquet.
 * L'envoi se DECOUPE, comme Oracle Net decoupe toute donnee plus
 * grande que la SDU negociee, et le RFS rassemble.
 *
 * Discrimination par `git stash push -- src/database src/adapters
 * src/network/oracle-net src/terminal` : 7 cas sur 9 tombent avant.
 *
 * Les DEUX qui ne discriminent pas, nommes avec leur raison :
 *  - « TEMOIN — sans destination SERVICE, le journal reste local » :
 *    TEMOIN. Il passe avant ET apres ; c'est lui qui interdit de fermer
 *    le defaut en expediant vers n'importe quoi.
 *  - « TEMOIN — le journal local est ecrit dans tous les cas » :
 *    TEMOIN. L'archivage local ne doit pas dependre du transport, sinon
 *    une standby injoignable ferait perdre le journal au primaire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { LinuxServer } from '@/network/devices/LinuxServer';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { getOracleDatabase, resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../support/rmanLab';

const ARC_DIR = '/u01/app/oracle/archivelog';
let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

const sh = (srv: LinuxServer, cmd: string) => srv.executeShellCommandSync(cmd);

function enArchivelog(srv: LinuxServer): void {
  const db = getOracleDatabase(srv.getId());
  (db.instance as unknown as { _archiveLogMode: boolean })._archiveLogMode = true;
}

function primaireVersDr(etat: 'ENABLE' | 'DEFER' = 'ENABLE'): { prod: LinuxServer; dr: LinuxServer } {
  const { prod, dr } = lab;
  enArchivelog(prod);
  enArchivelog(dr);
  lab.sql(prod,
    `ALTER SYSTEM SET LOG_ARCHIVE_DEST_2 = 'SERVICE=${lab.drIp}:1521/ORCL ASYNC DB_UNIQUE_NAME=DR';`);
  lab.sql(prod, `ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_2 = ${etat};`);
  return { prod, dr };
}

const listeArc = (srv: LinuxServer): string => sh(srv, `ls ${ARC_DIR}`).trim();

describe('le transport du redo', () => {
  it('le journal archive arrive sur le disque de la standby', () => {
    const { prod, dr } = primaireVersDr();
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(listeArc(prod)).toContain('1_1_arc.arc');
    expect(listeArc(dr)).toContain('1_1_arc.arc');
  });

  it('le corps recu est CELUI du primaire, octet pour octet', () => {
    const { prod, dr } = primaireVersDr();
    lab.sql(prod, 'CREATE TABLE marqueur_dg (id NUMBER);');
    lab.sql(prod, 'INSERT INTO marqueur_dg VALUES (1);');
    lab.sql(prod, 'COMMIT;');
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    const cote = (s: LinuxServer) => sh(s, `cat ${ARC_DIR}/1_1_arc.arc`);
    expect(cote(dr)).toBe(cote(prod));
    expect(cote(dr).toUpperCase()).toContain('MARQUEUR_DG');
  });

  it('la standby ENREGISTRE le journal dans son fichier de controle', () => {
    const { prod, dr } = primaireVersDr();
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(lab.sql(dr, 'SELECT sequence#, name FROM v$archived_log;'))
      .toMatch(/^\s*1\s+\/u01\S+1_1_arc\.arc/m);
    expect(sh(dr, 'grep RFS /u01/app/oracle/diag/rdbms/orcl/ORCL/trace/alert_ORCL.log'))
      .toMatch(/RFS: Archived log thread 1 sequence 1/);
  });

  it('TEMOIN DU FIL — pare-feu ferme, rien n arrive et la destination le dit', async () => {
    const { prod, dr } = primaireVersDr();
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(listeArc(dr)).toContain('1_1_arc.arc');

    for (const ligne of [
      'config firewall policy', 'edit 1', 'set action deny', 'next', 'end',
    ]) await lab.firewall.executeCommand(ligne);

    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(listeArc(prod)).toContain('1_2_arc.arc');
    expect(listeArc(dr)).not.toContain('1_2_arc.arc');
    expect(lab.sql(prod, 'SELECT status FROM v$archive_dest WHERE dest_id = 2;'))
      .toContain('ERROR');
  });

  it('V$ARCHIVE_DEST rapporte le RESULTAT, pas la declaration', () => {
    const { prod } = primaireVersDr();
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(lab.sql(prod,
      'SELECT dest_id, status, log_sequence FROM v$archive_dest WHERE dest_id = 2;'))
      .toMatch(/^\s*2\s+VALID\s+1/m);
  });

  it('une destination injoignable porte son ORA- dans V$ARCHIVE_DEST_STATUS', () => {
    const { prod } = primaireVersDr();
    lab.sql(prod, "ALTER SYSTEM SET LOG_ARCHIVE_DEST_3 = 'SERVICE=fantome ASYNC';");
    lab.sql(prod, 'ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_3 = ENABLE;');
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    const vue = lab.sql(prod, 'SELECT dest_id, status, error FROM v$archive_dest_status WHERE dest_id = 3;');
    expect(vue).toContain('ERROR');
    expect(vue).toContain('ORA-12154');
  });

  it('DEFER n expedie rien, et le dit', () => {
    const { prod, dr } = primaireVersDr('DEFER');
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(listeArc(dr)).not.toContain('1_1_arc.arc');
    expect(lab.sql(prod, 'SELECT status FROM v$archive_dest WHERE dest_id = 2;'))
      .toContain('DEFERRED');
  });

  it('TEMOIN — sans destination SERVICE, le journal reste local', () => {
    const { prod, dr } = lab;
    enArchivelog(prod);
    enArchivelog(dr);
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(listeArc(prod)).toContain('1_1_arc.arc');
    expect(listeArc(dr)).toBe('');
  });

  it('TEMOIN — le journal local est ecrit dans tous les cas', () => {
    const { prod } = primaireVersDr();
    lab.sql(prod, "ALTER SYSTEM SET LOG_ARCHIVE_DEST_3 = 'SERVICE=fantome ASYNC';");
    lab.sql(prod, 'ALTER SYSTEM SET LOG_ARCHIVE_DEST_STATE_3 = ENABLE;');
    lab.sql(prod, 'ALTER SYSTEM SWITCH LOGFILE;');
    expect(listeArc(prod)).toContain('1_1_arc.arc');
  });
});
