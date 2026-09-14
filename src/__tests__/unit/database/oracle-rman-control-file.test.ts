/**
 * Sonde — la reprise DEPUIS RIEN : control file perdu, repertoire RMAN
 * perdu, et la base revient. Laboratoire routeur + pare-feu.
 *
 * Releve AVANT :
 *
 *   cat control01.ctl                       "[ORACLE CONTROL FILE 1]"   (23 octets)
 *   CONFIGURE CONTROLFILE AUTOBACKUP ON
 *   BACKUP DATABASE
 *   find ... -path "*autobackup*"           aucune
 *   rm control01.ctl control02.ctl
 *   STARTUP                                 « database mounted »  <- MENSONGE
 *   etat reel                               NOMOUNT
 *   RESTORE CONTROLFILE FROM AUTOBACKUP     transcript complet, « output file name=... »
 *   ls control01.ctl                        No such file or directory
 *
 * Le fichier de controle ne portait rien, l'autobackup n'ecrivait rien,
 * et la restauration annoncait un fichier qu'elle ne creait pas. Trois
 * theatres en serie, au bout desquels l'operateur croit sa base reprise.
 *
 * Un quatrieme defaut, celui-la introduit par le lot R3 et corrige ici :
 * STARTUP annoncait « database mounted » sans verifier l'etat atteint.
 * Les commandes d'instance derivent maintenant leurs lignes de l'etat
 * REEL, et l'ORA-00205 remonte a l'operateur.
 *
 * Discrimination par `git stash push -- src/terminal src/database` :
 * 5 cas sur 6 tombent avant le correctif.
 *
 * (Une premiere redaction n'en faisait tomber que 4 : l'existence du
 * fichier y etait verifiee par `ls`, dont le message d'erreur contient
 * lui-meme le chemin cherche. `test -f` decide vraiment.)
 *
 * Le sixieme est le TEMOIN — « sans autobackup, la restauration est
 * refusee ». Il passe des deux cotes : le refus RMAN-06172 existait deja
 * et devait survivre. Il prouve que les cinq reussites ne viennent pas
 * d'une commande devenue complaisante.
 *
 * LIMITE NOMMEE : au demarrage, avant toute sauvegarde, le fichier de
 * controle ne porte que sa banniere. Son contenu est ecrit par RMAN, qui
 * est le seul a connaitre le repertoire de sauvegarde ; faire ecrire
 * aussi l'adaptateur Oracle donnerait deux redacteurs pour un fichier,
 * ce que le §2 interdit. Une base sans sauvegarde n'a de toute facon
 * aucun repertoire a inscrire.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances, getRegisteredOracleDatabase } from '@/terminal/commands/database';
import { DeviceCatalogRegistry } from '@/terminal/subshells/rman';
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

const CTL1 = '/u01/app/oracle/oradata/ORCL/control01.ctl';
const CTL2 = '/u01/app/oracle/oradata/ORCL/control02.ctl';
const FIND_AUTOBACKUP =
  'find /u01/app/oracle/fast_recovery_area -path "*autobackup*" -type f';

const exists = (path: string): boolean =>
  lab.sh(lab.prod, `test -f ${path} && echo OUI || echo NON`).trim() === 'OUI';

const rman = (script: string): string =>
  lab.sh(lab.prod, `printf '${script}\\n' | rman target /`);

const instanceState = (): string =>
  getRegisteredOracleDatabase(lab.prod.getId())!.instance.state;

function seedAndBackup(): void {
  lab.sql(lab.prod, 'CREATE TABLE clients (id NUMBER, nom VARCHAR2(20));');
  lab.sql(lab.prod, "INSERT INTO clients VALUES (1, 'Dupont');");
  lab.sql(lab.prod, 'COMMIT;');
  rman('CONFIGURE CONTROLFILE AUTOBACKUP ON;');
  rman('BACKUP DATABASE;');
}

describe("l'autobackup du fichier de controle existe vraiment", () => {
  it('une piece atterrit dans le repertoire autobackup de la FRA', () => {
    seedAndBackup();
    const found = lab.sh(lab.prod, FIND_AUTOBACKUP).trim();
    expect(found).toContain('/autobackup/');
    expect(found).toMatch(/o1_mf_s_/);
  });

  it('la piece porte le repertoire de sauvegarde, pas une phrase', () => {
    seedAndBackup();
    const piece = lab.sh(lab.prod, `cat $(${FIND_AUTOBACKUP} | head -1)`);
    expect(piece).toContain('ORACLE-CONTROL-FILE-IMAGE');
    expect(piece).toContain('"dbName":"ORCL"');
  });
});

describe('STARTUP dit la verite sur l etat atteint', () => {
  it('sans fichier de controle, il annonce ORA-00205 et non « database mounted »', () => {
    seedAndBackup();
    lab.sh(lab.prod, `rm -f ${CTL1} ${CTL2}`);
    const out = rman('SHUTDOWN IMMEDIATE;\\nSTARTUP;');
    expect(out).toContain('ORA-00205');
    expect(out).not.toContain('database mounted');
    expect(instanceState()).toBe('NOMOUNT');
  });
});

describe('reprise depuis rien', () => {
  it('control file perdu ET repertoire RMAN perdu : la base remonte', () => {
    seedAndBackup();
    lab.sh(lab.prod, `rm -f ${CTL1} ${CTL2}`);
    rman('SHUTDOWN IMMEDIATE;\\nSTARTUP;');
    expect(instanceState()).toBe('NOMOUNT');

    DeviceCatalogRegistry._reset();
    expect(rman('LIST BACKUP;')).toContain('no backup found in the repository');

    const restored = rman('RESTORE CONTROLFILE FROM AUTOBACKUP;');
    expect(restored).toContain('control file restore from AUTOBACKUP complete');
    expect(exists(CTL1)).toBe(true);

    expect(rman('LIST BACKUP;')).toContain('BS Key');
    expect(rman('SQL "ALTER DATABASE MOUNT";')).toContain('Statement processed');
    expect(instanceState()).toBe('MOUNT');
  });

  it('les deux copies du fichier de controle sont reecrites', () => {
    seedAndBackup();
    lab.sh(lab.prod, `rm -f ${CTL1} ${CTL2}`);
    rman('SHUTDOWN IMMEDIATE;\\nSTARTUP;');
    rman('RESTORE CONTROLFILE FROM AUTOBACKUP;');
    expect(exists(CTL1)).toBe(true);
    expect(exists(CTL2)).toBe(true);
  });

  it('TEMOIN — sans autobackup, la restauration est refusee', () => {
    lab.sql(lab.prod, 'CREATE TABLE vide (x NUMBER);');
    lab.sh(lab.prod, `rm -f ${CTL1} ${CTL2}`);
    rman('SHUTDOWN IMMEDIATE;\\nSTARTUP;');
    const out = rman('RESTORE CONTROLFILE FROM AUTOBACKUP;');
    expect(out).toContain('RMAN-06172');
    expect(exists(CTL1)).toBe(false);
  });
});
