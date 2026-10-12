import { isHashedKnownHostsToken, matchHashedHost } from '../SshPureUtils';

export function lineNamesHost(line: string, host: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return false;
  const fields = trimmed.split(/\s+/);
  const hostField = fields[0].startsWith('@') ? fields[1] : fields[0];
  if (hostField === undefined) return false;
  if (isHashedKnownHostsToken(hostField)) return matchHashedHost(hostField, host);
  return hostField.split(',').some(name => name === host || name === `[${host}]:22`);
}

export function knownHostsLineOf(content: string, host: string): number {
  const index = content.split('\n').findIndex(line => lineNamesHost(line, host));
  return index < 0 ? 1 : index + 1;
}

export function withoutHost(content: string, host: string): string {
  return content.split('\n').filter(line => !lineNamesHost(line, host)).join('\n');
}

export function appendKnownHostsLine(content: string, line: string): string {
  return `${content}${content === '' || content.endsWith('\n') ? '' : '\n'}${line}\n`;
}
