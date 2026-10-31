/**
 * `LIST BACKUP COMPLETED AFTER 'SYSDATE-30'` repondait « RMAN-01009: unknown command » : seul `DELETE BACKUP COMPLETED
 * BEFORE '...'` savait lire une date, avec son propre analyseur local a DeleteCommand, et seulement entre apostrophes.
 * Corrige : `core/completedTime.ts` porte la clause COMPLETED AFTER | BEFORE | BETWEEN a AND b (date litterale ou
 * SYSDATE+-n, apostrophes ou guillemets) et LIST BACKUP et DELETE BACKUP la partagent ; l'analyseur de DeleteCommand a
 * disparu. La date « maintenant » est celle de la machine (`rmanNowMs`), donc un saut d'horloge (`date -s`) deplace la
 * fenetre. Une clause illisible est refusee, pas ignoree.
 *
 * Discrimine par `git stash` sur src/terminal : 6 des 8 cas tombent avant ; « date illisible » passe des deux cotes (avant : « unknown command », meme code RMAN-01009, non-regression). Le TEMOIN (DELETE ... COMPLETED BEFORE
 * existait deja) passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { getOracleDatabase } from '@/terminal/commands/database';
import { createRmanRunner, type RmanShellRunner } from '../../debug/rman/_rman-dump';

let server: LinuxServer;
let rman: RmanShellRunner;

beforeEach(async () => {
  server = new LinuxServer('linux-server', 'ora-completed', 100, 100);
  await server.executeCommand('date -s "2026-01-10 08:00:00"');
  getOracleDatabase(server.id);
  rman = createRmanRunner(server);
  rman.execute('BACKUP DATABASE TAG january;');
  await server.executeCommand('date -s "2026-03-15 09:30:00"');
  rman.execute('BACKUP DATABASE TAG march;');
});

describe('LIST BACKUP et DELETE BACKUP COMPLETED', () => {
  it('TEMOIN — DELETE BACKUP COMPLETED BEFORE retire la sauvegarde de janvier', () => {
    rman.execute("DELETE NOPROMPT BACKUP COMPLETED BEFORE 'SYSDATE-30';");
    const listing = rman.execute('LIST BACKUP SUMMARY;');
    expect(listing).toContain('MARCH');
    expect(listing).not.toContain('JANUARY');
  });

  it('LIST BACKUP COMPLETED AFTER ne rend que la sauvegarde de mars', () => {
    const out = rman.execute("LIST BACKUP COMPLETED AFTER 'SYSDATE-30';");
    expect(out).toContain('MARCH');
    expect(out).not.toContain('JANUARY');
  });

  it('LIST BACKUP COMPLETED BEFORE ne rend que la sauvegarde de janvier', () => {
    const out = rman.execute("LIST BACKUP COMPLETED BEFORE 'SYSDATE-30';");
    expect(out).toContain('JANUARY');
    expect(out).not.toContain('MARCH');
  });

  it('LIST BACKUP COMPLETED BETWEEN borne les deux cotes, guillemets compris', () => {
    const out = rman.execute('LIST BACKUP COMPLETED BETWEEN "SYSDATE-90" AND "SYSDATE-30";');
    expect(out).toContain('JANUARY');
    expect(out).not.toContain('MARCH');
  });

  it('une fenetre qui ne contient rien le dit', () => {
    const out = rman.execute("LIST BACKUP COMPLETED AFTER 'SYSDATE+1';");
    expect(out).toContain('specification does not match any backup in the repository');
  });

  it('une date illisible est refusee, pas ignoree', () => {
    const out = rman.execute("LIST BACKUP COMPLETED AFTER 'not-a-date';");
    expect(out).toContain('RMAN-01009');
  });

  it('un saut d horloge deplace la fenetre', async () => {
    await server.executeCommand('date -s "2026-06-01 09:30:00"');
    const out = rman.execute("LIST BACKUP COMPLETED AFTER 'SYSDATE-30';");
    expect(out).not.toContain('MARCH');
    expect(out).toContain('specification does not match any backup');
  });

  it('DELETE BACKUP COMPLETED AFTER retire la plus recente et garde janvier', () => {
    rman.execute("DELETE NOPROMPT BACKUP COMPLETED AFTER 'SYSDATE-30';");
    const listing = rman.execute('LIST BACKUP SUMMARY;');
    expect(listing).toContain('JANUARY');
    expect(listing).not.toContain('MARCH');
  });
});
