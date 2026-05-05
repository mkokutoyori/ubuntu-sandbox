/**
 * SshSshdConfig — pure parser/serializer for /etc/ssh/sshd_config.
 *
 * Covers the directives required by BRD SSH-07-R4/R5: PermitRootLogin,
 * PasswordAuthentication, PubkeyAuthentication, Port, AllowUsers, Banner.
 *
 * Reference: BRD-SSH-SFTP.md SSH-07.
 */

import type { SshServerConfig } from './ISshServerContext';

export interface SshdConfig extends SshServerConfig {
  readonly allowUsers: readonly string[];
  readonly banner: string | null;
}

export const DEFAULT_SSHD_CONFIG: SshdConfig = Object.freeze({
  listenPort: 22,
  maxAuthTries: 6,
  permitRootLogin: false,
  passwordAuthentication: true,
  pubkeyAuthentication: true,
  allowUsers: Object.freeze([]),
  banner: null,
});

const DIRECTIVE_PARSERS: Record<string, (value: string) => Partial<SshdConfig>> = {
  port: (v) => ({ listenPort: Number.parseInt(v, 10) }),
  maxauthtries: (v) => ({ maxAuthTries: Number.parseInt(v, 10) }),
  permitrootlogin: (v) => ({ permitRootLogin: parseBool(v) }),
  passwordauthentication: (v) => ({ passwordAuthentication: parseBool(v) }),
  pubkeyauthentication: (v) => ({ pubkeyAuthentication: parseBool(v) }),
  allowusers: (v) => ({ allowUsers: v.split(/\s+/).filter(Boolean) }),
  banner: (v) => ({ banner: v.trim() === 'none' ? null : v.trim() }),
};

export function parseSshdConfig(content: string): SshdConfig {
  const cfg: Partial<SshdConfig> = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.search(/\s/);
    if (idx === -1) continue;
    const key = line.slice(0, idx).toLowerCase();
    const value = line.slice(idx + 1).trim();
    const parser = DIRECTIVE_PARSERS[key];
    if (parser) Object.assign(cfg, parser(value));
  }
  return Object.freeze({ ...DEFAULT_SSHD_CONFIG, ...cfg });
}

export function serializeSshdConfig(cfg: SshdConfig): string {
  const lines = [
    `Port ${cfg.listenPort}`,
    `MaxAuthTries ${cfg.maxAuthTries}`,
    `PermitRootLogin ${cfg.permitRootLogin ? 'yes' : 'no'}`,
    `PasswordAuthentication ${cfg.passwordAuthentication ? 'yes' : 'no'}`,
    `PubkeyAuthentication ${cfg.pubkeyAuthentication ? 'yes' : 'no'}`,
  ];
  if (cfg.allowUsers.length > 0) {
    lines.push(`AllowUsers ${cfg.allowUsers.join(' ')}`);
  }
  if (cfg.banner) lines.push(`Banner ${cfg.banner}`);
  return lines.join('\n') + '\n';
}

function parseBool(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === 'yes' || v === 'true' || v === '1';
}
