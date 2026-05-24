/**
 * SftpCommandScript — immutable list of SftpCommands parsed from a batch.
 *
 * Inputs accepted by `parse()`:
 *   - a here-doc body (one verb per line) as `sftp <<'EOF' ... EOF` produces
 *   - `-b batchfile` content
 *   - a single string of verbs joined by newlines
 *
 * Parse errors are kept alongside the commands so the executor can surface
 * them as the real sftp client does (`Invalid command.`) without aborting
 * the whole batch.
 */

import { parseSftpLine, type SftpCommand, type SftpCommandParseError } from './SftpCommand';

export interface SftpScriptEntry {
  readonly lineNumber: number;
  readonly raw: string;
  readonly command: SftpCommand | null;
  readonly error: SftpCommandParseError | null;
}

export class SftpCommandScript {
  private readonly entries: readonly SftpScriptEntry[];

  private constructor(entries: readonly SftpScriptEntry[]) {
    this.entries = Object.freeze([...entries]);
  }

  static parse(body: string): SftpCommandScript {
    const lines = body.split('\n');
    const entries: SftpScriptEntry[] = [];
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const parsed = parseSftpLine(raw);
      if (parsed === null) continue;
      if ('kind' in parsed && parsed.kind === 'parse') {
        entries.push({ lineNumber: i + 1, raw, command: null, error: parsed });
      } else {
        entries.push({ lineNumber: i + 1, raw, command: parsed as SftpCommand, error: null });
      }
    }
    return new SftpCommandScript(entries);
  }

  get commands(): readonly SftpScriptEntry[] {
    return this.entries;
  }

  get hasErrors(): boolean {
    return this.entries.some(e => e.error !== null);
  }

  /** Returns commands up to (and including) the first `bye`, mirroring sftp. */
  effective(): readonly SftpScriptEntry[] {
    const result: SftpScriptEntry[] = [];
    for (const e of this.entries) {
      result.push(e);
      if (e.command?.verb === 'bye') break;
    }
    return result;
  }
}
