/**
 * SshConfig — multi-host loader for ~/.ssh/config.
 *
 * Per BRD SSH-06: support directives Host, HostName, User, Port,
 * IdentityFile, StrictHostKeyChecking. Wildcard `Host *` provides defaults
 * merged into every match. CLI options (-p, -i, -o) override config.
 *
 * Reference: BRD-SSH-SFTP.md SSH-06.
 */

import { type StrictHostKeyChecking } from './SshConnectOptions';

export interface SshHostEntry {
  readonly host: string;
  readonly hostName?: string;
  readonly user?: string;
  readonly port?: number;
  readonly identityFile?: string;
  readonly strictHostKeyChecking?: StrictHostKeyChecking;
}

export class SshConfig {
  private constructor(private readonly entries: readonly SshHostEntry[]) {}

  static readonly empty: SshConfig = new SshConfig([]);

  static parse(content: string): SshConfig {
    const blocks: SshHostEntry[] = [];
    let current: { host?: string; rest: Record<string, string> } | null = null;
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.search(/\s/);
      if (idx === -1) continue;
      const key = line.slice(0, idx).toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (key === 'host') {
        if (current?.host) blocks.push(buildEntry(current.host, current.rest));
        current = { host: value, rest: {} };
      } else if (current) {
        current.rest[key] = value;
      }
    }
    if (current?.host) blocks.push(buildEntry(current.host, current.rest));
    return new SshConfig(blocks);
  }

  /**
   * Resolve the effective configuration for a target host name. Merges
   * matching `Host` blocks: most specific (exact name) wins over wildcard
   * `*`, with later directives overriding earlier ones. `undefined`
   * properties from a less specific block are preserved (a later block
   * cannot wipe a wildcard default by simply not declaring the directive).
   */
  resolve(targetHost: string): SshHostEntry {
    const matches = this.entries.filter((e) => matchesHost(e.host, targetHost));
    // Wildcards first (defaults), specific last (override).
    matches.sort((a, b) =>
      a.host === '*' ? -1 : b.host === '*' ? 1 : 0,
    );
    const result: Record<string, unknown> = { host: targetHost };
    for (const entry of matches) {
      for (const [key, value] of Object.entries(entry)) {
        if (value !== undefined) result[key] = value;
      }
    }
    result.host = targetHost;
    return result as SshHostEntry;
  }

  list(): readonly SshHostEntry[] {
    return this.entries;
  }
}

function buildEntry(host: string, raw: Record<string, string>): SshHostEntry {
  return Object.freeze({
    host,
    hostName: raw.hostname,
    user: raw.user,
    port: raw.port ? Number.parseInt(raw.port, 10) : undefined,
    identityFile: raw.identityfile,
    strictHostKeyChecking: raw.stricthostkeychecking as
      | StrictHostKeyChecking
      | undefined,
  });
}

/** Wildcard matching: `*` and `?` only, OpenSSH semantics. */
function matchesHost(pattern: string, name: string): boolean {
  if (pattern === '*' || pattern === name) return true;
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return re.test(name);
}
