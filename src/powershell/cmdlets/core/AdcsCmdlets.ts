/**
 * AdcsCmdlets — AD CS (Certificate Services) role cmdlets
 * (PRD-Windows-Server-Advanced.md §5 P13, §2.1.13): Install-
 * AdcsCertificationAuthority, Get-CATemplate, Get-Certificate. No new
 * cryptographic primitive — these delegate entirely to the
 * `CertificateAuthority` instance a `WindowsAdcsRole` already owns
 * (`src/network/pki/`, already mature).
 */

import type { ICmdlet } from '../ICmdlet';
import type { CmdletContext } from '../CmdletContext';
import { PSRuntimeError } from '@/powershell/runtime/PSRuntime';
import type { PSValue } from '@/powershell/runtime/PSEnvironment';
import type { IAdcsProvider, CaTemplateInfo, IssuedCertInfo } from '@/powershell/providers/PSProviders';
import { psValueToString } from '@/powershell/runtime/PSExpansion';
import { commandNotFoundMessage } from '@/powershell/commandNotFound';

function requireAdcs(ctx: CmdletContext, cmdletName: string): IAdcsProvider {
  if (!ctx.providers.adcs) {
    throw new PSRuntimeError(commandNotFoundMessage(cmdletName));
  }
  return ctx.providers.adcs;
}

function templateToPSObject(t: CaTemplateInfo): Record<string, PSValue> {
  return { Name: t.name, DisplayName: t.displayName, ExtendedKeyUsage: [...t.eku], ValidityPeriodDays: t.validityDays };
}

function certToPSObject(c: IssuedCertInfo): Record<string, PSValue> {
  return {
    SerialNumber: c.serialNumber, Subject: c.subject, Issuer: c.issuer,
    NotBefore: new Date(c.notBefore).toISOString(), NotAfter: new Date(c.notAfter).toISOString(),
  };
}

// ── Install-AdcsCertificationAuthority ──────────────────────────────────

export class InstallAdcsCertificationAuthorityCmdlet implements ICmdlet {
  readonly name = 'install-adcscertificationauthority';
  readonly aliases = [] as const;
  readonly parameters = ['CACommonName', 'CAType', 'Force'] as const;

  execute(ctx: CmdletContext): PSValue {
    const adcs = requireAdcs(ctx, 'Install-AdcsCertificationAuthority');
    const caCommonName = psValueToString(ctx.named['cacommonname'] ?? ctx.positional[0] ?? '');
    if (!caCommonName) {
      ctx.emitError('Install-AdcsCertificationAuthority : Cannot process command because of one or more missing mandatory parameters: CACommonName.');
      return null;
    }
    const res = adcs.installCA(caCommonName);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return { Message: res.message, RebootRequired: false } as Record<string, PSValue>;
  }
}

// ── Get-CATemplate ───────────────────────────────────────────────────────

export class GetCATemplateCmdlet implements ICmdlet {
  readonly name = 'get-catemplate';
  readonly aliases = [] as const;
  readonly parameters = ['Name'] as const;

  execute(ctx: CmdletContext): PSValue {
    const adcs = requireAdcs(ctx, 'Get-CATemplate');
    const templates = adcs.listTemplates();
    const name = ctx.named['name'] !== undefined ? psValueToString(ctx.named['name']) : psValueToString(ctx.positional[0] ?? '');
    const filtered = name ? templates.filter(t => t.name.toLowerCase() === name.toLowerCase()) : templates;
    if (name && filtered.length === 0) { ctx.emitError(`Get-CATemplate : Cannot find a template with name: '${name}'.`); return null; }
    const objs = filtered.map(templateToPSObject);
    return objs.length === 1 ? objs[0] : objs;
  }
}

// ── Add-CATemplate ───────────────────────────────────────────────────────

export class AddCATemplateCmdlet implements ICmdlet {
  readonly name = 'add-catemplate';
  readonly displayName = 'Add-CATemplate';
  readonly aliases = [] as const;
  readonly parameters = ['TemplateName', 'Force'] as const;

  execute(ctx: CmdletContext): PSValue {
    const adcs = requireAdcs(ctx, 'Add-CATemplate');
    const templateName = psValueToString(ctx.named['templatename'] ?? ctx.positional[0] ?? '');
    if (!templateName) {
      ctx.emitError('Add-CATemplate : Cannot process command because of one or more missing mandatory parameters: TemplateName.');
      return null;
    }
    const res = adcs.addTemplate(templateName);
    if (!res.ok) { ctx.emitError(res.message); return null; }
    return null;
  }
}

// ── Get-Certificate ──────────────────────────────────────────────────────

export class GetCertificateCmdlet implements ICmdlet {
  readonly name = 'get-certificate';
  readonly aliases = [] as const;
  readonly parameters = ['Template', 'DnsName', 'Eku'] as const;

  execute(ctx: CmdletContext): PSValue {
    const adcs = requireAdcs(ctx, 'Get-Certificate');
    const template = psValueToString(ctx.named['template'] ?? ctx.positional[0] ?? '');
    if (!template) {
      ctx.emitError('Get-Certificate : Cannot process command because of one or more missing mandatory parameters: Template.');
      return null;
    }
    const subject = psValueToString(ctx.named['dnsname'] ?? ctx.positional[1] ?? '');
    if (!subject) {
      ctx.emitError('Get-Certificate : Cannot process command because of one or more missing mandatory parameters: DnsName.');
      return null;
    }
    const eku = ctx.named['eku'] !== undefined ? psValueToString(ctx.named['eku']) : undefined;
    const res = adcs.getCertificate(template, subject, eku);
    if (!res.ok) { ctx.emitError(`Get-Certificate : ${res.message}`); return null; }
    return { Status: 'Issued', Certificate: certToPSObject(res.certificate!) } as Record<string, PSValue>;
  }
}
