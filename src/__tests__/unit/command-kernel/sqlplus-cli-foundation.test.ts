import { describe, it, expect, beforeEach } from 'vitest';
import { OracleDatabase } from '@/database/oracle/OracleDatabase';
import { SQLPlusSession } from '@/database/oracle/commands/SQLPlusSession';
import { createSqlPlusKernel, recognizeSqlPlusKernelVerb } from '@/database/oracle/command-kernel/createSqlPlusKernel';
import { PipeBuffer } from '@/command-kernel/io/pipe-buffer';
import type { CommandIO } from '@/command-kernel/io/types';

let db: OracleDatabase;
let session: SQLPlusSession;
let kernel: ReturnType<typeof createSqlPlusKernel>;

beforeEach(() => {
  db = new OracleDatabase();
  db.instance.startup();
  session = new SQLPlusSession(db);
  session.login('SYS', 'oracle', true);
  kernel = createSqlPlusKernel(session, 'orcl-host');
});

/** Fait tourner une ligne à travers le pipeline command-kernel (single-gate) et récupère le texte accumulé. */
async function run(line: string): Promise<string> {
  const recognized = recognizeSqlPlusKernelVerb(line);
  expect(recognized, `"${line}" devrait être reconnue comme un verbe kernel`).not.toBeNull();
  const stdout = new PipeBuffer();
  const io: CommandIO = { stdin: new PipeBuffer(), stdout, stderr: stdout };
  const code = await kernel.interpreter.runResolved(recognized!.name, recognized!.argv, kernel.session, io);
  expect(code, `"${line}" doit résoudre une commande enregistrée`).not.toBeNull();
  await stdout.close();
  return (await stdout.readAll()).replace(/\n$/, '');
}

describe('SQL*Plus CLI foundation — command-kernel single-gate pipeline (Wave 1: session/réglages)', () => {
  it('SHOW USER reflète le schéma connecté', async () => {
    expect(await run('SHOW USER')).toBe('USER is "SYS"');
  });

  it('SET LINESIZE mute les réglages, visible via SHOW LINESIZE', async () => {
    expect(await run('SET LINESIZE 200')).toBe('');
    expect(await run('SHOW LINESIZE')).toBe('linesize 200');
    expect(kernel.machine.oracle.settings().linesize).toBe(200);
  });

  it('SET PAGESIZE / SERVEROUTPUT / FEEDBACK / TIMING / HEADING / AUTOCOMMIT mutent les réglages attendus', async () => {
    await run('SET PAGESIZE 50');
    await run('SET SERVEROUTPUT ON');
    await run('SET FEEDBACK OFF');
    await run('SET TIMING ON');
    await run('SET HEADING OFF');
    await run('SET AUTOCOMMIT ON');
    const s = kernel.machine.oracle.settings();
    expect(s.pagesize).toBe(50);
    expect(s.serveroutput).toBe(true);
    expect(s.feedback).toBe(false);
    expect(s.timing).toBe(true);
    expect(s.heading).toBe(false);
    expect(s.autocommit).toBe(true);
  });

  it('SET avec une option inconnue renvoie SP2-0158 (parité vendeur)', async () => {
    expect(await run('SET FOOBAR baz')).toBe('SP2-0158: unknown SET option "FOOBAR"');
  });

  it('SHOW ALL liste tous les réglages', async () => {
    const out = await run('SHOW ALL');
    expect(out).toContain('linesize 80');
    expect(out).toContain('pagesize 14');
    expect(out).toContain('autocommit OFF');
  });

  it('SHOW SGA lit les infos SGA réelles de instance', async () => {
    const out = await run('SHOW SGA');
    expect(out).toMatch(/Total System Global Area\s+\S+/);
    expect(out).toMatch(/Database Buffers\s+\S+/);
  });

  it('SHOW PARAMETER <nom> filtre les paramètres réels de instance', async () => {
    const out = await run('SHOW PARAMETER db_name');
    expect(out).toMatch(/db_name/);
  });

  it('SHOW CON_NAME / CON_ID reflètent le conteneur courant', async () => {
    expect(await run('SHOW CON_NAME')).toContain('CDB$ROOT');
    expect(await run('SHOW CON_ID')).toContain('1');
  });

  it('SHOW avec une option inconnue renvoie SP2-0158 (parité vendeur)', async () => {
    expect(await run('SHOW NOTATHING')).toBe('SP2-0158: unknown SHOW option "NOTATHING"');
  });

  it('HELP liste les commandes SQL*Plus', async () => {
    const out = await run('HELP');
    expect(out).toContain('SET           Set a SQL*Plus system variable');
    expect(out).toContain('EXIT          Exit SQL*Plus');
  });

  it('CLEAR est un no-op silencieux', async () => {
    expect(await run('CLEAR SCR')).toBe('');
    expect(await run('CLEAR BUFFER')).toBe('');
  });

  it('DISCONNECT ferme la connexion puis rapporte "Not connected." au second appel', async () => {
    expect(await run('DISCONNECT')).toBe(
      'Disconnected from Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production',
    );
    expect(session.isConnected()).toBe(false);
    expect(await run('DISCONNECT')).toBe('Not connected.');
  });

  it('DISC (alias) se comporte comme DISCONNECT', async () => {
    expect(await run('DISC')).toContain('Disconnected from Oracle Database');
  });

  it('EXIT et son alias QUIT déconnectent la session', async () => {
    expect(await run('EXIT')).toContain('Disconnected from Oracle Database');
    expect(session.isConnected()).toBe(false);

    session.login('SYS', 'oracle', true);
    expect(await run('QUIT')).toContain('Disconnected from Oracle Database');
    expect(session.isConnected()).toBe(false);
  });

  it('les quirks de reconnaissance legacy sont préservés — SET/CLEAR nus, DISCONNECT/HELP avec texte final', () => {
    expect(recognizeSqlPlusKernelVerb('SET')).toBeNull();
    expect(recognizeSqlPlusKernelVerb('CLEAR')).toBeNull();
    expect(recognizeSqlPlusKernelVerb('DISCONNECT now')).toBeNull();
    expect(recognizeSqlPlusKernelVerb('HELP foo')).toBeNull();
    expect(recognizeSqlPlusKernelVerb('SHOW')).not.toBeNull();
    expect(recognizeSqlPlusKernelVerb('EXIT')).not.toBeNull();
  });

  it('une instruction SQL brute (non migrée) reste hors du pipeline kernel — signal de migration', () => {
    expect(recognizeSqlPlusKernelVerb('SELECT * FROM DUAL')).toBeNull();
    expect(recognizeSqlPlusKernelVerb('CONNECT scott/tiger')).toBeNull();
    expect(recognizeSqlPlusKernelVerb('SPOOL out.lst')).toBeNull();
  });
});
