/**
 * CatalogCommand — faire connaitre au repertoire RMAN un fichier deja
 * present sur le disque.
 *
 *   CATALOG BACKUPPIECE  '<chemin>'
 *   CATALOG DATAFILECOPY '<chemin>'
 *   CATALOG ARCHIVELOG   '<chemin>'
 *   CATALOG START WITH   '<prefixe>' [NOPROMPT]
 *   CATALOG RECOVERY AREA [NOPROMPT]
 */

import { ok, err, type Result } from '../core/Result';
import type { RmanError } from '../core/RmanError';
import type { IRmanCommand, RmanCommandContext } from './types';
import { BackupSetFactory } from '../catalog/BackupSetFactory';
import { Scn } from '../values/Scn';
import { classifyCatalogable, type CatalogableKind } from '../core/pieceValidation';
import { ORACLE_CONFIG } from '@/database/oracle/OracleConfig';

export type CatalogKind = 'DATAFILECOPY' | 'BACKUPPIECE' | 'ARCHIVELOG' | 'START_WITH' | 'RECOVERY_AREA';

const ETIQUETTE: Record<string, string> = {
  DATAFILECOPY: 'datafile copy',
  BACKUPPIECE:  'backup piece',
  ARCHIVELOG:   'archived log',
};

export class CatalogCommand implements IRmanCommand<string[]> {
  readonly name = 'CATALOG';

  constructor(private readonly _kind: CatalogKind) {}

  execute(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    if (this._kind === 'START_WITH' || this._kind === 'RECOVERY_AREA') {
      return this._balayer(args, cmdCtx);
    }
    const raw = (args[0] ?? '').trim();
    const m = raw.match(/^'([^']+)'$/);
    if (!m) {
      return err({
        code: 'RMAN_01009',
        message: `syntax error: CATALOG ${this._kind} expects a quoted path`,
      });
    }
    const path = m[1];
    if (!cmdCtx.ctx.vfs.fileExists(path)) {
      return err({ code: 'RMAN_06004', message: `RMAN-06004: backup piece not found: ${path}` });
    }
    // Ce que le fichier EST decide : un journal archive catalogue comme
    // piece de sauvegarde est un enregistrement qui ment au catalogue.
    const nature = classifyCatalogable(cmdCtx.ctx.vfs, path);
    if (nature !== null && nature !== this._kind) {
      return err({
        code: 'ERROR_STACK',
        message: `RMAN-07517: Reason: The file ${path} is not a ${ETIQUETTE[this._kind]}`,
      });
    }
    const ligne = this._enregistrer(path, this._kind, cmdCtx);
    if (ligne.ok === false) return ligne;
    return ok([ligne.value]);
  }

  private _enregistrer(
    path: string, nature: 'DATAFILECOPY' | 'BACKUPPIECE' | 'ARCHIVELOG', cmdCtx: RmanCommandContext,
  ): Result<string, RmanError> {
    if (nature === 'ARCHIVELOG') {
      cmdCtx.ctx.catalogArchivedLog?.(path);
      return ok(`cataloged archived log\narchived log file name=${path}`);
    }
    const ckp = Scn.of(1_892_354);
    const set = BackupSetFactory.createBackupSet({
      type:      nature === 'DATAFILECOPY' ? 'DATAFILECOPY' : 'FULL',
      level:     0,
      path,
      sizeBytes: 0,
      datafiles: nature === 'DATAFILECOPY' ? [Object.freeze({
        fileNo:  0,
        level:   0 as 0 | 1,
        ckpScn:  ckp.ok ? ckp.value : Scn.ZERO,
        ckpTime: Date.now(),
        path,
      })] : [],
    });
    const r = cmdCtx.catalog.recordBackupSet(set);
    if (!r.ok) return r as Result<string, RmanError>;
    return ok(`cataloged ${ETIQUETTE[nature]}: ${path}`);
  }

  private _balayer(args: string[], cmdCtx: RmanCommandContext): Result<string[], RmanError> {
    const prefixe = this._kind === 'RECOVERY_AREA'
      ? (cmdCtx.ctx.getSpfileParam('db_recovery_file_dest') ?? ORACLE_CONFIG.FRA)
      : ((args[0] ?? '').trim().match(/^'([^']+)'$/)?.[1] ?? '');
    if (!prefixe) {
      return err({
        code: 'RMAN_01009',
        message: 'syntax error: CATALOG START WITH expects a quoted path prefix',
      });
    }
    const lignes = [`searching for all files that match the pattern ${prefixe}`, ''];
    const trouves = cmdCtx.ctx.vfs.listFilesRecursively?.(prefixe) ?? [];
    const snap = cmdCtx.catalog.listAll();
    if (snap.ok === false) return snap;
    const deja = new Set<string>();
    for (const s of snap.value.sets) for (const p of s.pieces) deja.add(p.path);
    for (const l of cmdCtx.ctx.getArchivedLogs?.() ?? []) deja.add(l.path);

    const inconnus: Array<{ path: string; nature: Exclude<CatalogableKind, null> }> = [];
    for (const path of trouves) {
      if (deja.has(path)) continue;
      const nature = classifyCatalogable(cmdCtx.ctx.vfs, path);
      if (nature === null) continue;
      inconnus.push({ path, nature });
    }
    if (inconnus.length === 0) {
      lignes.push('no files found to be unknown to the database', '');
      return ok(lignes);
    }
    lignes.push('List of Files Unknown to the Database', '=====================================');
    for (const f of inconnus) lignes.push(`File Name: ${f.path}`);
    lignes.push('', 'cataloging files...', 'cataloging done', '');
    lignes.push('List of Cataloged Files', '=======================');
    for (const f of inconnus) {
      const ecrit = this._enregistrer(f.path, f.nature, cmdCtx);
      if (ecrit.ok === false) return ecrit;
      lignes.push(`File Name: ${f.path}`);
    }
    lignes.push('');
    return ok(lignes);
  }
}
