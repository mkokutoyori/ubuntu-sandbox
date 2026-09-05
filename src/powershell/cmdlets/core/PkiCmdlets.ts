/**
 * PkiCmdlets — the minimal personal-certificate-store surface
 * (PRD-Windows-Server-Advanced.md §5 P14): `New-SelfSignedCertificate`,
 * for a working TLS binding without needing AD CS (§5 P13) installed.
 * Available on every Windows host (client or server) — the PKI client
 * module ships on every SKU.
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IPkiProvider, IssuedCertInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requirePki(ctx: CmdletContext, cmdletName: string): IPkiProvider {
  if (!ctx.providers.pki) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.pki;
}

function certToPSObject(c: IssuedCertInfo & { thumbprint: string }): Record<string, PSValue> {
  return {
    Thumbprint: c.thumbprint, Subject: c.subject, Issuer: c.issuer,
    NotBefore: new Date(c.notBefore).toISOString(), NotAfter: new Date(c.notAfter).toISOString(),
  };
}

export class NewSelfSignedCertificateCmdlet implements ICmdlet {
  readonly name = 'new-selfsignedcertificate';
  readonly aliases = [] as const;
  readonly parameters = ['DnsName', 'CertStoreLocation'] as const;

  execute(ctx: CmdletContext): PSValue {
    const pki = requirePki(ctx, 'New-SelfSignedCertificate');
    const dnsName = psValueToString(ctx.named['dnsname'] ?? ctx.positional[0] ?? '');
    if (!dnsName) {
      ctx.emitError('New-SelfSignedCertificate : Cannot process command because of one or more missing mandatory parameters: DnsName.');
      return null;
    }
    return certToPSObject(pki.newSelfSignedCertificate(dnsName));
  }
}
