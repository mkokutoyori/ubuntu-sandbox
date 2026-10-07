import type { ClientMechanism } from './saslTypes';
import { anonymousMechanism } from './mechanisms/anonymous';
import { cramMd5Mechanism } from './mechanisms/cramMd5';
import { createDigestMd5Mechanisms } from './digest/digestMd5';
import { externalMechanism } from './mechanisms/external';
import { gssapiMechanism } from './mechanisms/gssapi';
import { loginMechanism } from './mechanisms/login';
import { ntlmMechanism } from './mechanisms/ntlm';
import { plainMechanism } from './mechanisms/plain';
import { scramMechanisms } from './mechanisms/scram';

export { SASL_PLUGIN_DIRECTORY } from './saslFiles';

const PLUGIN_MECHANISMS: Readonly<Record<string, () => readonly ClientMechanism[]>> = {
  'libanonymous.so': () => [anonymousMechanism],
  'libcrammd5.so': () => [cramMd5Mechanism],
  'libdigestmd5.so': createDigestMd5Mechanisms,
  'libgssapiv2.so': () => [gssapiMechanism],
  'liblogin.so': () => [loginMechanism],
  'libntlm.so': () => [ntlmMechanism],
  'libplain.so': () => [plainMechanism],
  'libscram.so': () => scramMechanisms,
};

export function loadClientPlugins(directoryListing: readonly string[] | null): ClientMechanism[] {
  const plugins: ClientMechanism[] = [externalMechanism];
  if (directoryListing === null) return plugins;
  for (const name of directoryListing) {
    if (!name.endsWith('.so')) continue;
    const load = PLUGIN_MECHANISMS[name];
    if (load !== undefined) plugins.push(...load());
  }
  return plugins;
}
