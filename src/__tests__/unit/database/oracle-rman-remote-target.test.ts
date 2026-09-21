/**
 * Sonde — une sauvegarde annoncee vers une cible DISTANTE doit travailler
 * sur la machine distante, dans le laboratoire routeur + pare-feu.
 *
 *   ORA-PROD ── R-CORE (Cisco) ── FGT-DC (FortiGate) ── ORA-DR
 *   10.10.10.10    .1 / 10.10.30.1    .2 / 10.10.20.1    10.10.20.20
 *
 * Releve AVANT le correctif, deux bases portant chacune un marqueur :
 *
 *   dbid local PROD                          3496926858
 *   dbid distant DR                          3306707989
 *
 *   CONNECT TARGET sys/oracle@10.10.20.20:1521/ORCL
 *     annonce   : connected to target database: ORCL (DBID=3306707989)   <- bon
 *     BACKUP    : piece dans la FRA de PROD                              <- mauvais
 *     FRA de DR : aucune
 *
 *   rman target sys/oracle@10.10.20.20:1521/ORCL
 *     annonce   : connected to target database: ORCL (DBID=3496926858)   <- PROD !
 *     BACKUP    : piece dans la FRA de PROD
 *
 * Deux portes, deux mensonges differents. La ligne de commande jetait
 * purement sa cible (`connect(_target?: string)` ne lisait pas son
 * parametre), l'interactif resolvait bien en TCP mais ne rebasculait
 * jamais le contexte. Depuis que la piece porte de vraies donnees (lots
 * R1/R2), cela sauvegardait la mauvaise base sous le bon nom.
 *
 * Une troisieme consequence, mesuree en ecrivant la sonde et pire que
 * les deux autres : `rman target ...@injoignable` ne refusait RIEN. La
 * cible etant jetee, aucune resolution n'echouait, et la sauvegarde
 * partait sur la base LOCALE. Un operateur dont le lien est coupe
 * croyait sauvegarder son site distant.
 *
 * Discrimination par `git stash push -- src/terminal` (sans -u, pour que
 * RetargetableRmanContext reste chargeable) : 6 cas sur 7 tombent.
 *
 * Le septieme est le TEMOIN — « la poignee de main TNS traverse routeur
 * et pare-feu ». Elle passait deja (lot R7) et passe encore ; elle
 * prouve que le laboratoire achemine vraiment, donc que les six echecs
 * mesures au-dessus portent sur la CIBLE du travail et non sur un
 * reseau mort.
 *
 * LIMITE LEVEE (lot R7). Ce cas EPINGLAIT le defaut : il exigeait que
 * la difference de trames entre CONNECT seul et CONNECT + BACKUP soit
 * NULLE, ce qui contractualisait le fait que les commandes de RMAN
 * n'allaient pas sur le fil. Depuis que la cible distante repond par sa
 * session Oracle Net, la difference est POSITIVE, et c'est elle qu'on
 * mesure.
 *
 * Ce qui reste vrai, et qui n'est pas la meme chose : les DONNEES ne
 * traversent toujours pas, et ne doivent pas — un vrai RMAN fait ecrire
 * la piece par le processus serveur de la CIBLE, sur le disque de la
 * cible. C'est l'ALLER-RETOUR DE LA COMMANDE qui devait etre trame.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { resetAllOracleInstances } from '@/terminal/commands/database';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';
import { framesSentOn } from '../../support/wireWatch';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  resetAllOracleInstances();
  Logger.reset();
});

const DR_ALIAS = 'sys/oracle@10.10.20.20:1521/ORCL';
const FIND_PIECES = 'find /u01/app/oracle/fast_recovery_area -name "*.bkp" -type f';

function seedMarkers(lab: RmanLab): void {
  lab.sql(lab.prod, 'CREATE TABLE marqueur (site VARCHAR2(12));');
  lab.sql(lab.prod, "INSERT INTO marqueur VALUES ('SITE_PROD');");
  lab.sql(lab.prod, 'COMMIT;');
  lab.sql(lab.dr, 'CREATE TABLE marqueur (site VARCHAR2(12));');
  lab.sql(lab.dr, "INSERT INTO marqueur VALUES ('SITE_DR');");
  lab.sql(lab.dr, 'COMMIT;');
}

const dbidOf = (out: string): string =>
  /DBID=(\d+)/.exec(out)?.[1] ?? '';

describe('la ligne de commande `rman target ...@distant` vise la cible', () => {
  it('annonce le DBID de la cible, pas celui de la machine locale', async () => {
    const lab = await buildRmanLab();
    seedMarkers(lab);
    const local = /(\d{6,})/.exec(lab.sql(lab.prod, 'SELECT dbid FROM v$database;'))?.[1] ?? 'x';
    const remote = /(\d{6,})/.exec(lab.sql(lab.dr, 'SELECT dbid FROM v$database;'))?.[1] ?? 'y';
    expect(local).not.toBe(remote);

    const out = lab.sh(lab.prod, `echo "BACKUP DATABASE;" | rman target ${DR_ALIAS}`);
    expect(dbidOf(out)).toBe(remote);
    expect(dbidOf(out)).not.toBe(local);
  });

  it('depose la piece dans la FRA de la cible, pas dans la sienne', async () => {
    const lab = await buildRmanLab();
    seedMarkers(lab);
    lab.sh(lab.prod, `echo "BACKUP DATABASE;" | rman target ${DR_ALIAS}`);
    expect(lab.sh(lab.dr, FIND_PIECES).trim()).toContain('.bkp');
    expect(lab.sh(lab.prod, FIND_PIECES).trim()).toBe('');
  });

  it('la piece porte les donnees de la cible', async () => {
    const lab = await buildRmanLab();
    seedMarkers(lab);
    lab.sh(lab.prod, `echo "BACKUP DATABASE;" | rman target ${DR_ALIAS}`);
    const piece = lab.sh(lab.dr, `cat $(${FIND_PIECES} | head -1)`);
    expect(piece).toContain('SITE_DR');
    expect(piece).not.toContain('SITE_PROD');
  });
});

describe('le CONNECT TARGET interactif rebascule le contexte', () => {
  it('la sauvegarde qui suit ecrit sur la cible', async () => {
    const lab = await buildRmanLab();
    seedMarkers(lab);
    lab.sh(lab.prod,
      `printf 'CONNECT TARGET ${DR_ALIAS};\\nBACKUP DATABASE;\\n' | rman`);
    expect(lab.sh(lab.dr, FIND_PIECES).trim()).toContain('.bkp');
    expect(lab.sh(lab.prod, FIND_PIECES).trim()).toBe('');
  });
});

describe('ce que le fil porte vraiment', () => {
  it('TEMOIN — la poignee de main TNS traverse routeur et pare-feu', async () => {
    const lab = await buildRmanLab();
    await lab.prod.executeCommand('tcpdump -i eth0 -w /tmp/rman.pcap &');
    lab.sh(lab.prod, `printf 'CONNECT TARGET ${DR_ALIAS};\\n' | rman`);
    const dump = await lab.prod.executeCommand('tcpdump -r /tmp/rman.pcap -A 2>&1');
    expect(dump).toContain('10.10.20.20.1521');
    expect(dump).toMatch(/Flags \[S\]/);
    expect(dump).toMatch(/Flags \[S\.\]/);
  });

  it('le transfert des donnees ne traverse pas — la cible ecrit chez elle', async () => {
    const lab = await buildRmanLab();
    seedMarkers(lab);
    const frames = framesSentOn(lab.prod, 'eth0');
    const before = frames.length;
    lab.sh(lab.prod, `printf 'CONNECT TARGET ${DR_ALIAS};\\n' | rman`);
    const connectOnly = frames.length - before;
    const mid = frames.length;
    lab.sh(lab.prod,
      `printf 'CONNECT TARGET ${DR_ALIAS};\\nBACKUP DATABASE;\\n' | rman`);
    const connectPlusBackup = frames.length - mid;

    expect(connectOnly).toBeGreaterThan(0);
    expect(connectPlusBackup - connectOnly).toBeGreaterThan(0);
    expect(lab.sh(lab.dr, FIND_PIECES).trim()).toContain('.bkp');
  });

  it('une cible injoignable est refusee, au lieu de sauvegarder la base locale', async () => {
    const lab = await buildRmanLab();
    const out = lab.sh(lab.prod,
      'echo "BACKUP DATABASE;" | rman target sys/oracle@10.10.99.99:1521/ORCL');
    expect(out).toMatch(/ORA-12(170|541)|RMAN-04006/);
    expect(lab.sh(lab.prod, FIND_PIECES).trim()).toBe('');
  });
});
