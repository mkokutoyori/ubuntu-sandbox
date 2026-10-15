import { hashKnownHostsToken, isHashedKnownHostsToken, matchHashedHost } from '../SshPureUtils';
import { matchesPatternList } from '../client/SshClientConfigFile';

export type KnownHostsMarker = 'ca' | 'revoke' | null;

export interface KnownHostsLine {
  readonly number: number;
  readonly raw: string;
  readonly status: 'ok' | 'invalid' | 'skipped';
  readonly marker: KnownHostsMarker;
  readonly hosts: string;
  readonly keyType: string;
  readonly keyBlob: string;
  readonly comment: string;
}

const KEY_TYPES = new Set([
  'ssh-ed25519', 'ssh-rsa', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com',
]);

export function parseKnownHostsLines(text: string): KnownHostsLine[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((raw, index): KnownHostsLine => {
    const number = index + 1;
    const trimmed = raw.trim();
    const blank = { number, raw, marker: null, hosts: '', keyType: '', keyBlob: '', comment: '' } as const;
    if (trimmed === '' || trimmed.startsWith('#')) return { ...blank, status: 'skipped' };
    const fields = trimmed.split(/\s+/);
    let marker: KnownHostsMarker = null;
    if (fields[0].startsWith('@')) {
      if (fields[0] === '@cert-authority') marker = 'ca';
      else if (fields[0] === '@revoked') marker = 'revoke';
      else return { ...blank, status: 'invalid' };
      fields.shift();
    }
    if (fields.length < 3 || !KEY_TYPES.has(fields[1])) return { ...blank, status: 'invalid' };
    return {
      number, raw, status: 'ok', marker, hosts: fields[0], keyType: fields[1], keyBlob: fields[2],
      comment: fields.slice(3).join(' '),
    };
  });
}

export function lineMatchesName(line: KnownHostsLine, name: string): boolean {
  if (line.status !== 'ok') return false;
  if (isHashedKnownHostsToken(line.hosts)) return matchHashedHost(line.hosts, name.toLowerCase());
  return matchesPatternList(line.hosts, name);
}

export function hashedLineFor(line: KnownHostsLine): string[] {
  if (line.status !== 'ok' || line.marker !== null || isHashedKnownHostsToken(line.hosts) || /[*?!]/.test(line.hosts)) {
    return [line.raw];
  }
  return line.hosts.split(',').filter(Boolean).map((host) => (
    `${hashKnownHostsToken(host.toLowerCase())} ${line.keyType} ${line.keyBlob}${line.comment === '' ? '' : ` ${line.comment}`}`
  ));
}
