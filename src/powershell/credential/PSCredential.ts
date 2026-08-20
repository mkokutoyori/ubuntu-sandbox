/**
 * PSCredential (PRD-Nslookup-Dig-Rndc-Runas.md §4.3/P13) — a minimal,
 * data-only model of .NET's `System.Management.Automation.PSCredential`.
 *
 * `Password` mirrors the existing `ConvertTo-SecureString` result shape
 * (`{ SecureString, Length }` — see MiscCmdlets.ts): a plain string, not a
 * real DPAPI-encrypted SecureString. This simulator has no SecureString
 * encryption to reuse, and building one is explicitly out of scope (PRD
 * §2.2's accepted simplification) — the value that matters here is a real,
 * structured credential object instead of the bare `"user:password"`
 * strings `-Credential` accepted everywhere before this phase.
 *
 * The PS interpreter has no method-call support (`$cred.GetNetworkCredential()`
 * isn't reachable PS syntax in this simulator), so `getNetworkCredential`
 * below is a plain TS helper for cmdlets that accept `-Credential` to call
 * internally — not a live PowerShell method on the object itself.
 */

export const PS_CREDENTIAL_TYPE_NAME = 'System.Management.Automation.PSCredential';

export interface PSCredentialValue {
  readonly PSTypeName: typeof PS_CREDENTIAL_TYPE_NAME;
  readonly UserName: string;
  readonly Password: { readonly SecureString: string; readonly Length: number };
}

export function makePSCredential(userName: string, password: string): PSCredentialValue {
  return {
    PSTypeName: PS_CREDENTIAL_TYPE_NAME,
    UserName: userName,
    Password: { SecureString: password, Length: password.length },
  };
}

export function isPSCredential(value: unknown): value is PSCredentialValue {
  return typeof value === 'object' && value !== null
    && (value as Record<string, unknown>).PSTypeName === PS_CREDENTIAL_TYPE_NAME;
}

export interface NetworkCredential {
  readonly userName: string;
  readonly password: string;
}

/** The TS-level equivalent of `$cred.GetNetworkCredential()` — see file header. */
export function getNetworkCredential(cred: PSCredentialValue): NetworkCredential {
  return { userName: cred.UserName, password: cred.Password.SecureString };
}

/** Real PowerShell's default (unbound) table rendering of a PSCredential — the password is never shown in plain text. */
export function formatPSCredentialTable(cred: PSCredentialValue): string[] {
  const pad = Math.max(1, 29 - cred.UserName.length);
  return [
    'UserName                     Password',
    '--------                     --------',
    `${cred.UserName}${' '.repeat(pad)}System.Security.SecureString`,
  ];
}
