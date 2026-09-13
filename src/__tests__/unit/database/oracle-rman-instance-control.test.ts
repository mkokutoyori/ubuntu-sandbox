/**
 * Sonde — le cycle de restauration se joue ENTIEREMENT depuis RMAN,
 * dans le laboratoire routeur + pare-feu.
 *
 * Releve AVANT, chaque commande tapee dans `rman target /` :
 *
 *   SHUTDOWN IMMEDIATE          RMAN-00571/00569 (verbe inconnu)   etat OPEN
 *   STARTUP MOUNT               RMAN-00571/00569 (verbe inconnu)   etat OPEN
 *   STARTUP                     RMAN-00571/00569 (verbe inconnu)   etat OPEN
 *   ALTER DATABASE OPEN         RMAN-00571/00569 (verbe inconnu)   etat OPEN
 *   ALTER DATABASE OPEN RESETLOGS  « database opened »             etat OPEN
 *   SQL 'ALTER SYSTEM CHECKPOINT'  RMAN-00571/00569                etat OPEN
 *
 * Quatre verbes absents, deux qui impriment une phrase sans rien faire.
 * L'operateur devait sortir vers sqlplus au milieu de sa restauration,
 * ce qu'aucun runbook Oracle ne demande.
 *
 * Le libelle vient de transcriptions capturees (docs.oracle.com est
 * injoignable depuis cet environnement) : RMAN ecrit « database closed /
 * database dismounted / Oracle instance shut down » en minuscules, la ou
 * SQL*Plus ecrit « Database closed. » capitalise et pointe — deux vues,
 * deux libelles, un seul moteur.
 *
 * Discrimination par `git stash push -- src/terminal` : 5 cas sur 6
 * tombent avant le correctif.
 *
 * Le sixieme est le TEMOIN — « SWITCH DATAFILE et RESET DATABASE
 * impriment toujours sans agir ». Il passe des deux cotes et il est ecrit
 * pour cela : ces deux verbes appartiennent au lot des incarnations et
 * des copies d'image (R5), ils ne sont PAS fermes ici, et la sonde le
 * dit au lieu de laisser croire que R3 les couvre.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getRegisteredOracleDatabase } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  resetAllOracleInstances();
  Logger.reset();
  lab = await buildRmanLab();
});

const rman = (script: string): string =>
  lab.sh(lab.prod, `printf '${script}\\n' | rman target /`);

const instanceState = (): string =>
  getRegisteredOracleDatabase(lab.prod.getId())!.instance.state;

describe('RMAN conduit vraiment son instance', () => {
  it('SHUTDOWN IMMEDIATE arrete l instance et le dit comme RMAN le dit', () => {
    const out = rman('SHUTDOWN IMMEDIATE;');
    expect(out).toContain('database closed');
    expect(out).toContain('database dismounted');
    expect(out).toContain('Oracle instance shut down');
    expect(instanceState()).toBe('SHUTDOWN');
  });

  it('STARTUP MOUNT remonte jusqu a MOUNT, pas au-dela', () => {
    rman('SHUTDOWN IMMEDIATE;');
    const out = rman('STARTUP MOUNT;');
    expect(out).toContain('Oracle instance started');
    expect(out).toContain('database mounted');
    expect(out).not.toContain('database opened');
    expect(instanceState()).toBe('MOUNT');
  });

  it('ALTER DATABASE OPEN ouvre vraiment', () => {
    rman('SHUTDOWN IMMEDIATE;');
    rman('STARTUP MOUNT;');
    expect(rman('ALTER DATABASE OPEN;')).toContain('database opened');
    expect(instanceState()).toBe('OPEN');
  });

  it("SQL '...' execute l ordre au lieu de l imprimer", () => {
    const dbf = '/u01/app/oracle/oradata/ORCL/users01.dbf';
    lab.sql(lab.prod, 'CREATE TABLE jalon (x NUMBER);');
    lab.sql(lab.prod, 'INSERT INTO jalon VALUES (7);');
    lab.sql(lab.prod, 'COMMIT;');
    expect(lab.sh(lab.prod, `cat ${dbf}`)).not.toContain('JALON');
    expect(rman(`SQL "ALTER SYSTEM CHECKPOINT";`)).toContain('Statement processed');
    expect(lab.sh(lab.prod, `cat ${dbf}`)).toContain('JALON');
  });
});

describe('le cycle complet se joue sans quitter RMAN', () => {
  it('sauvegarder, detruire, arreter, monter, restaurer, ouvrir', () => {
    lab.sql(lab.prod, 'CREATE TABLE clients (id NUMBER, nom VARCHAR2(20));');
    lab.sql(lab.prod, "INSERT INTO clients VALUES (1, 'Dupont');");
    lab.sql(lab.prod, 'COMMIT;');

    expect(rman('BACKUP DATABASE;')).toContain('Finished backup');
    expect(lab.sql(lab.prod, 'DROP TABLE clients;')).toContain('Table dropped.');

    const out = rman(
      'SHUTDOWN IMMEDIATE;\\nSTARTUP MOUNT;\\nRESTORE DATABASE;\\nALTER DATABASE OPEN;');
    expect(out).toContain('Oracle instance shut down');
    expect(out).toContain('database mounted');
    expect(out).toContain('Finished restore');
    expect(out).toContain('database opened');
    expect(instanceState()).toBe('OPEN');

    const after = lab.sql(lab.prod, 'SELECT COUNT(*) FROM clients;');
    expect(after).not.toContain('ORA-00942');
    expect(after).toMatch(/\b1\b/);
  });

  it('RECOVER apres SHUTDOWN est refuse a voix haute', () => {
    const out = rman('SHUTDOWN IMMEDIATE;\\nRECOVER DATABASE;');
    expect(out).toContain('Oracle instance shut down');
    expect(out).toContain('RMAN-06403: database must be mounted or open');
  });

  it('TEMOIN — SWITCH DATAFILE et RESET DATABASE impriment encore sans agir', () => {
    expect(rman('SWITCH DATAFILE ALL;')).toContain('datafile names switched');
    expect(rman('RESET DATABASE;')).toContain('database reset to current incarnation');
  });
});
