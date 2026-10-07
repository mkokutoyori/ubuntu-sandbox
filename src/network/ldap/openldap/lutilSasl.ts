import { LdapRc } from './ldapErrors';
import type { LdapOptions } from './ldapOptions';
import { SaslCb, type SaslInteract } from './sasl/saslTypes';

export const LDAP_SASL_AUTOMATIC = 0;
export const LDAP_SASL_INTERACTIVE = 1;
export const LDAP_SASL_QUIET = 2;

const INPUT_BUFFER_SIZE = 1024;
const encoder = new TextEncoder();

export interface SaslDefaults {
  mech: string | null;
  realm: string | null;
  authcid: string | null;
  passwd: Uint8Array | null;
  authzid: string | null;
  readonly responses: Uint8Array[];
}

export interface SaslTerminal {
  stderr(text: string): void;
  readLine(): string | null;
  getpass(prompt: string): string | null;
}

export function saslDefaults(
  options: LdapOptions['sasl'], mech: string | null, realm: string | null, authcid: string | null,
  passwd: Uint8Array | null, authzid: string | null,
): SaslDefaults {
  return {
    mech: mech ?? options.mech,
    realm: realm ?? options.realm,
    authcid: authcid ?? options.authcid,
    passwd,
    authzid: authzid ?? options.authzid,
    responses: [],
  };
}

function interaction(
  flags: number, interact: SaslInteract, defaults: SaslDefaults, terminal: SaslTerminal,
): number {
  let dflt: string | null = interact.defresult;
  let noecho = false;
  let challenge = false;
  switch (interact.id) {
    case SaslCb.GETREALM:
      dflt = defaults.realm;
      break;
    case SaslCb.AUTHNAME:
      dflt = defaults.authcid;
      break;
    case SaslCb.PASS:
      dflt = defaults.passwd === null ? null : new TextDecoder().decode(defaults.passwd);
      noecho = true;
      break;
    case SaslCb.USER:
      dflt = defaults.authzid;
      break;
    case SaslCb.NOECHOPROMPT:
      noecho = true;
      challenge = true;
      break;
    case SaslCb.ECHOPROMPT:
      challenge = true;
      break;
    default:
      break;
  }
  if (dflt !== null && dflt === '') dflt = null;

  if (flags !== LDAP_SASL_INTERACTIVE && (dflt !== null || interact.id === SaslCb.USER)) {
    interact.result = encoder.encode(dflt ?? '');
    return LdapRc.SUCCESS;
  }
  if (flags === LDAP_SASL_QUIET) return LdapRc.OTHER;

  if (challenge && interact.challenge !== null) terminal.stderr(`Challenge: ${interact.challenge}\n`);
  if (dflt !== null) terminal.stderr(`Default: ${dflt}\n`);

  const promptText = `${interact.prompt ?? 'Interact'}: `;
  let typed: string | null;
  if (noecho) {
    typed = terminal.getpass(promptText);
  } else {
    terminal.stderr(promptText);
    typed = terminal.readLine();
    if (typed === null) {
      interact.result = null;
      return LdapRc.UNAVAILABLE;
    }
    if (typed.length > INPUT_BUFFER_SIZE - 1) typed = typed.slice(0, INPUT_BUFFER_SIZE - 1);
  }
  const bytes = typed === null ? null : encoder.encode(typed);
  if (bytes !== null && bytes.length > 0) {
    defaults.responses.push(bytes);
    interact.result = bytes;
  } else {
    interact.result = encoder.encode(dflt ?? '');
  }
  return LdapRc.SUCCESS;
}

export function saslInteract(
  flags: number, defaults: SaslDefaults, prompts: SaslInteract[], terminal: SaslTerminal,
): number {
  if (flags === LDAP_SASL_INTERACTIVE) terminal.stderr('SASL Interaction\n');
  for (const interact of prompts) {
    if (interact.id === SaslCb.LIST_END) break;
    const rc = interaction(flags, interact, defaults, terminal);
    if (rc !== LdapRc.SUCCESS) return rc;
  }
  return LdapRc.SUCCESS;
}
