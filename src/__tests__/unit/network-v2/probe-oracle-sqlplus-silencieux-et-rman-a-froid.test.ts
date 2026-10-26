/**
 * Mesure (Node, LinuxServer neuf) de deux defauts releves par les epreuves de charge Chromium, dont la sortie etait jetee ou jamais lue :
 *
 * - `echo "SELECT 1 FROM dual;" | sqlplus -S / as sysdba` rendait « ORA-01012: not logged on » : l'option `-S` entrait dans le texte teste par l'expression
 *   `/ as sysdba`, qui n'etait plus reconnue ; `sqlplus / as sysdba` sans `-S` marchait. L'epreuve ora-local-parallel-100 « passait » depuis le debut sans
 *   avoir execute un seul ordre ;
 * - `echo "BACKUP DATABASE;" | rman target /` lance AVANT tout `sqlplus` sur un serveur neuf echouait en « ORA-19504: failed to create file … ORA-27040 » : RMAN ne
 *   creait pas l'instance Oracle (donc ni l'arborescence /u01, ni les fichiers de donnees) que `sqlplus` cree a la demande, et travaillait sur un contexte de demonstration
 *   sans disque. Une vraie machine n'a pas besoin de sqlplus pour que rman marche. rman cree maintenant l'instance comme sqlplus (`getOracleDatabase`).
 *
 * - un script `rman` de 300 sauvegardes lu sur l'entree standard s'executait d'une traite : 4,6 s sans cession de la boucle d'evenements dans Chromium (budget 3 s). La
 *   boucle passe maintenant par un generateur partage et la voie asynchrone de l'executeur (celle des commandes reseau) cede entre deux lignes.
 *
 * Discrimine par `git stash push -- src/terminal src/network` : 5 cas sur 8 tombent. Passent des deux cotes, TEMOINS : `sqlplus / as sysdba` sans -S, le script de 5 sauvegardes, et la presence de /u01 apres un simple LIST (la creation de l'arborescence n'etait pas en cause : c'est la sauvegarde qui travaillait sans instance).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

let server: LinuxServer;
const run = async (command: string): Promise<string> => String(await server.executeCommand(command));

beforeEach(() => {
  server = new LinuxServer('linux-server', 'ora-cold', 100, 100);
});

describe('sqlplus -S / as sysdba', () => {
  it('TEMOIN — sans -S la requete lue sur l\'entree standard s\'execute', async () => {
    expect(await run('echo "SELECT 1 FROM dual;" | sqlplus / as sysdba')).toContain('1 row selected.');
  });

  it('avec -S la requete lue sur l\'entree standard s\'execute', async () => {
    const out = await run('echo "SELECT 1 FROM dual;" | sqlplus -S / as sysdba');
    expect(out).not.toContain('ORA-01012');
    expect(out).toContain('1 row selected.');
  });

  it('avec -S un document ici s\'execute', async () => {
    const out = await run('sqlplus -S / as sysdba <<EOF\nSELECT 1 FROM dual;\nEOF');
    expect(out).not.toContain('ORA-01012');
    expect(out).toContain('1 row selected.');
  });
});

describe('un script rman long cede la main', () => {
  it('TEMOIN — toutes les sauvegardes du script sont executees', async () => {
    const out = await run('(for i in $(seq 1 5); do echo "BACKUP DATABASE;"; done; echo "EXIT;") | rman target / | grep -c "Finished backup"');
    expect(out.trim()).toBe('5');
  });

  it('60 sauvegardes de suite laissent la boucle d\'evenements respirer', async () => {
    let lastTick = performance.now();
    let longestGap = 0;
    const ticker = setInterval(() => {
      const now = performance.now();
      longestGap = Math.max(longestGap, now - lastTick);
      lastTick = now;
    }, 5);
    const out = await run('(for i in $(seq 1 60); do echo "BACKUP DATABASE;"; done; echo "EXIT;") | rman target / | grep -c "Finished backup"');
    clearInterval(ticker);
    expect(out.trim()).toBe('60');
    expect(longestGap).toBeLessThan(150);
  }, 60_000);
});

describe('rman sur un serveur neuf', () => {
  it('BACKUP DATABASE reussit sans sqlplus prealable', async () => {
    const out = await run('echo "BACKUP DATABASE;" | rman target / | tail -3');
    expect(out).not.toContain('ORA-19504');
    expect(out).toContain('Finished backup');
  });

  it('l\'arborescence Oracle existe apres le premier rman', async () => {
    await run('echo "LIST BACKUP SUMMARY;" | rman target / | tail -1');
    expect(await run('ls -d /u01/app/oracle')).toContain('/u01/app/oracle');
  });

  it('plusieurs sauvegardes de suite reussissent, la zone reprend la place des obsoletes', async () => {
    const out = await run('(for i in $(seq 1 6); do echo "BACKUP DATABASE;"; done; echo "EXIT;") | rman target / | grep -cE "RMAN-[0-9]+|ORA-[0-9]+"');
    expect(out.trim()).toBe('0');
  });
});
