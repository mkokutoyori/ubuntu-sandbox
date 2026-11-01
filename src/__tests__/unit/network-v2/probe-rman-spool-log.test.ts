/**
 * `SPOOL LOG TO <fichier> [APPEND]` et `SPOOL LOG OFF` de RMAN etaient refuses (« RMAN-01009 unknown command »). La commande
 * ne dit rien elle-meme ; elle fait copier dans le fichier ce que les commandes suivantes impriment, jusqu'a `SPOOL LOG
 * OFF`, `APPEND` ajoutant a un fichier existant au lieu de le remplacer. Aucun texte n'est invente : le fichier recoit les
 * lignes que la session affiche deja.
 * Non source (TODO.md [rman]) : l'erreur d'un fichier non inscriptible, ici le message du systeme de fichiers.
 *
 * Discrimine par `git stash` sur src/terminal : 4 des 5 cas tombent avant. TEMOIN : une session sans SPOOL n'ecrit aucun
 * fichier.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { buildRmanLab, type RmanLab } from '../../support/rmanLab';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { resetAllOracleInstances } from '@/terminal/commands/database';

let lab: RmanLab;

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); resetAllOracleInstances();
  lab = await buildRmanLab();
  lab.sql(lab.prod, 'SELECT 1 FROM dual;');
});

const rman = (...lines: string[]): string => lab.rman(lab.prod, ['CONNECT TARGET /;', ...lines].join('\n'));
const cat = async (path: string): Promise<string> => String(await lab.prod.executeCommand(`cat ${path}`));

describe('SPOOL LOG', () => {
  it('TEMOIN — a session without SPOOL leaves no file', async () => {
    rman('LIST BACKUP SUMMARY;');
    expect(await cat('/tmp/none.log')).toContain('No such file');
  });

  it('copies what the following commands print, and stays silent itself', async () => {
    const out = rman("SPOOL LOG TO '/tmp/s.log';", "BACKUP DATABASE TAG 'SP1';");
    expect(out).not.toContain('RMAN-01009');
    expect(await cat('/tmp/s.log')).toContain('SP1');
  });

  it('SPOOL LOG OFF stops the copy', async () => {
    rman("SPOOL LOG TO '/tmp/o.log';", "BACKUP DATABASE TAG 'IN';", 'SPOOL LOG OFF;', "BACKUP DATABASE TAG 'OUT';");
    const log = await cat('/tmp/o.log');
    expect(log).toContain('IN');
    expect(log).not.toContain('TAG=OUT');
    expect(log).not.toContain('tag=OUT');
  });

  it('without APPEND the file is replaced, with APPEND it is extended', async () => {
    rman("SPOOL LOG TO '/tmp/a.log';", "BACKUP DATABASE TAG 'ONE';", 'SPOOL LOG OFF;');
    rman("SPOOL LOG TO '/tmp/a.log' APPEND;", "BACKUP DATABASE TAG 'TWO';", 'SPOOL LOG OFF;');
    const appended = await cat('/tmp/a.log');
    expect(appended).toContain('ONE');
    expect(appended).toContain('TWO');
    rman("SPOOL LOG TO '/tmp/a.log';", 'LIST BACKUP SUMMARY;', 'SPOOL LOG OFF;');
    const replaced = await cat('/tmp/a.log');
    expect(replaced).toContain('List of Backups');
    expect(replaced).not.toContain('Starting backup');
  });

  it('works in a batch cmdfile too', async () => {
    await lab.prod.executeCommand(`printf "CONNECT TARGET /;\\nSPOOL LOG TO '/tmp/b.log';\\nLIST BACKUP SUMMARY;\\n" > /tmp/b.rman`);
    await lab.prod.executeCommand('rman target / cmdfile=/tmp/b.rman');
    expect(await cat('/tmp/b.log')).toContain('List of Backups');
  });
});
