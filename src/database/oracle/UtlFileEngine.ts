/**
 * UtlFileEngine — a real UTL_FILE backed by directory objects and the
 * database server's host filesystem.
 *
 * Until now UTL_FILE was a pure stub: FOPEN/PUT_LINE/GET_LINE all returned
 * null and never touched a file, so PL/SQL that exported a report or read
 * an input file silently did nothing — and there was no coherence between
 * the database and the host filesystem the rest of the simulator models.
 *
 * This engine resolves the first FOPEN argument as a *directory object*
 * (19c semantics — the desupported utl_file_dir path form is not accepted)
 * via the catalog, joins it with the filename, and reads/writes through the
 * injected host VFS hooks. A file written by UTL_FILE.PUT_LINE is therefore
 * immediately visible to `cat` in the Linux shell on the same server, and a
 * file created with vi/echo can be read back by UTL_FILE.GET_LINE.
 *
 * Design:
 *   - Open files are kept in a handle table keyed by an opaque integer
 *     (Oracle's FILE_TYPE is a record the PL/SQL code only passes around).
 *   - Write/append buffer the whole content and flush it to the host on
 *     every mutation, so the file is coherent even without an explicit
 *     FCLOSE (the simulator has no process to flush at session end).
 *   - Errors use the canonical ORA-292xx codes UTL_FILE raises, so the
 *     interpreter surfaces them as catchable PL/SQL exceptions.
 */

import { OracleError } from '../engine/types/DatabaseError';
import type { UtlFileApi } from './plsql/PlsqlValue';

/** Directory-object lookup the engine needs (catalog-backed). */
export interface DirectoryResolver {
  (name: string): { path: string } | undefined;
}

/** Host VFS hooks — injected so the engine never imports network/Equipment. */
export interface UtlFileHostFs {
  read(path: string): string | null;
  write(path: string, content: string): boolean;
  remove(path: string): boolean;
}

type FileMode = 'R' | 'W' | 'A';

interface OpenFile {
  path: string;
  mode: FileMode;
  /** Lines available to GET_LINE (read mode). */
  lines: string[];
  /** Read cursor into `lines`. */
  pos: number;
  /** Accumulated content (write / append mode). */
  buffer: string;
  open: boolean;
}

export class UtlFileEngine implements UtlFileApi {
  private readonly handles = new Map<number, OpenFile>();
  private nextHandle = 1;

  constructor(
    private readonly resolveDirectory: DirectoryResolver,
    private readonly fs: UtlFileHostFs,
  ) {}

  fopen(dir: string, filename: string, mode: string, _maxLineSize?: number): number {
    const path = this.resolvePath(dir, filename);
    const m = this.normalizeMode(mode);
    const file: OpenFile = { path, mode: m, lines: [], pos: 0, buffer: '', open: true };

    if (m === 'R') {
      const content = this.fs.read(path);
      if (content === null) {
        throw new OracleError(29283, 'invalid file operation: file not found or insufficient privileges');
      }
      file.lines = this.splitLines(content);
    } else if (m === 'A') {
      // Append seeds the buffer with the existing content (empty if absent).
      file.buffer = this.fs.read(path) ?? '';
      this.flush(file);
    } else {
      // Write truncates immediately, so an FOPEN('W') alone yields an empty file.
      this.flush(file);
    }

    const handle = this.nextHandle++;
    this.handles.set(handle, file);
    return handle;
  }

  isOpen(handle: number): boolean {
    const f = this.handles.get(handle);
    return !!f && f.open;
  }

  getLine(handle: number): string {
    const f = this.requireReadable(handle);
    if (f.pos >= f.lines.length) {
      throw new OracleError(1403, 'no data found');
    }
    return f.lines[f.pos++];
  }

  putLine(handle: number, text: string): void {
    this.put(handle, text);
    this.newLine(handle, 1);
  }

  put(handle: number, text: string): void {
    const f = this.requireWritable(handle);
    f.buffer += text ?? '';
    this.flush(f);
  }

  newLine(handle: number, count: number): void {
    const f = this.requireWritable(handle);
    f.buffer += '\n'.repeat(Math.max(1, count || 1));
    this.flush(f);
  }

  fflush(handle: number): void {
    const f = this.requireOpen(handle);
    if (f.mode !== 'R') this.flush(f);
  }

  fclose(handle: number): void {
    const f = this.handles.get(handle);
    if (!f || !f.open) throw new OracleError(29282, 'invalid file handle');
    if (f.mode !== 'R') this.flush(f);
    f.open = false;
    this.handles.delete(handle);
  }

  fcloseAll(): void {
    for (const [handle, f] of this.handles) {
      if (f.mode !== 'R') this.flush(f);
      f.open = false;
      this.handles.delete(handle);
    }
  }

  fremove(dir: string, filename: string): void {
    const path = this.resolvePath(dir, filename);
    if (!this.fs.remove(path)) {
      throw new OracleError(29283, 'invalid file operation: file not found or could not be removed');
    }
  }

  frename(srcDir: string, srcFile: string, destDir: string, destFile: string, overwrite: boolean): void {
    const src = this.resolvePath(srcDir, srcFile);
    const dest = this.resolvePath(destDir, destFile);
    const content = this.fs.read(src);
    if (content === null) throw new OracleError(29283, 'invalid file operation: source file not found');
    if (!overwrite && this.fs.read(dest) !== null) {
      throw new OracleError(29292, 'file rename operation failed: destination exists');
    }
    if (!this.fs.write(dest, content)) throw new OracleError(29285, 'file write error');
    this.fs.remove(src);
  }

  fcopy(srcDir: string, srcFile: string, destDir: string, destFile: string): void {
    const src = this.resolvePath(srcDir, srcFile);
    const dest = this.resolvePath(destDir, destFile);
    const content = this.fs.read(src);
    if (content === null) throw new OracleError(29283, 'invalid file operation: source file not found');
    if (!this.fs.write(dest, content)) throw new OracleError(29285, 'file write error');
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private flush(f: OpenFile): void {
    // Best-effort: an engine-only setup with no device VFS keeps the
    // buffer in memory but cannot materialise it on disk.
    this.fs.write(f.path, f.buffer);
  }

  private resolvePath(dir: string, filename: string): string {
    const directory = this.resolveDirectory(dir.toUpperCase());
    if (!directory) {
      throw new OracleError(29280, 'invalid directory path');
    }
    // UTL_FILE forbids path components in the filename — it must be a leaf
    // name resolved against the directory object (ORA-29280 otherwise).
    if (/[\\/]/.test(filename)) {
      throw new OracleError(29280, 'invalid directory path');
    }
    return `${directory.path.replace(/\/+$/, '')}/${filename}`;
  }

  private normalizeMode(mode: string): FileMode {
    // Byte/append-byte variants (RB/WB/AB) collapse onto the text mode —
    // the simulator stores text content only.
    const m = (mode ?? '').trim().toUpperCase().replace(/B$/, '');
    if (m === 'R' || m === 'W' || m === 'A') return m;
    throw new OracleError(29281, 'invalid file open mode');
  }

  private splitLines(content: string): string[] {
    if (content === '') return [];
    const lines = content.split('\n');
    // A trailing newline produces a spurious empty final element — a real
    // file ending in "\n" has no extra empty line to GET_LINE.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  private requireOpen(handle: number): OpenFile {
    const f = this.handles.get(handle);
    if (!f || !f.open) throw new OracleError(29282, 'invalid file handle');
    return f;
  }

  private requireReadable(handle: number): OpenFile {
    const f = this.requireOpen(handle);
    if (f.mode !== 'R') throw new OracleError(29283, 'invalid file operation: file not open for reading');
    return f;
  }

  private requireWritable(handle: number): OpenFile {
    const f = this.requireOpen(handle);
    if (f.mode === 'R') throw new OracleError(29283, 'invalid file operation: file not open for writing');
    return f;
  }
}
