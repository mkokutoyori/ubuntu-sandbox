export interface AuthenticationScheme {
  name: string;
  mode?: string[];
}

export interface AuthorizationScheme {
  name: string;
  mode?: string[];
}

export interface AccountingScheme {
  name: string;
  mode?: string;
  startFail?: 'online' | 'offline';
  realtime?: number;
}

export interface AaaDomain {
  name: string;
  authenticationScheme?: string;
  authorizationScheme?: string;
  accountingScheme?: string;
  radiusServerGroup?: string;
  hwtacacsServerTemplate?: string;
}

export interface RadiusTemplate {
  name: string;
  authentication?: { ip: string; port?: number; secondary?: boolean };
  accounting?: { ip: string; port?: number; secondary?: boolean };
  sharedKey?: string;
  sharedKeyHidden?: 'cipher' | 'simple';
  retransmit?: number;
  timeout?: number;
}

export interface HwtacacsTemplate {
  name: string;
  authentication?: { ip: string; port?: number; secondary?: boolean };
  authorization?: { ip: string; port?: number; secondary?: boolean };
  accounting?: { ip: string; port?: number; secondary?: boolean };
  sharedKey?: string;
  sharedKeyHidden?: 'cipher' | 'simple';
}

export class HuaweiAaaService {
  readonly authenticationSchemes: Map<string, AuthenticationScheme> = new Map();
  readonly authorizationSchemes: Map<string, AuthorizationScheme> = new Map();
  readonly accountingSchemes: Map<string, AccountingScheme> = new Map();
  readonly domains: Map<string, AaaDomain> = new Map();
  readonly radiusTemplates: Map<string, RadiusTemplate> = new Map();
  readonly hwtacacsTemplates: Map<string, HwtacacsTemplate> = new Map();

  ensureAuthenticationScheme(name: string): AuthenticationScheme {
    let s = this.authenticationSchemes.get(name);
    if (!s) { s = { name }; this.authenticationSchemes.set(name, s); }
    return s;
  }
  ensureAuthorizationScheme(name: string): AuthorizationScheme {
    let s = this.authorizationSchemes.get(name);
    if (!s) { s = { name }; this.authorizationSchemes.set(name, s); }
    return s;
  }
  ensureAccountingScheme(name: string): AccountingScheme {
    let s = this.accountingSchemes.get(name);
    if (!s) { s = { name }; this.accountingSchemes.set(name, s); }
    return s;
  }
  ensureDomain(name: string): AaaDomain {
    let d = this.domains.get(name);
    if (!d) { d = { name }; this.domains.set(name, d); }
    return d;
  }
  ensureRadiusTemplate(name: string): RadiusTemplate {
    let t = this.radiusTemplates.get(name);
    if (!t) { t = { name }; this.radiusTemplates.set(name, t); }
    return t;
  }
  ensureHwtacacsTemplate(name: string): HwtacacsTemplate {
    let t = this.hwtacacsTemplates.get(name);
    if (!t) { t = { name }; this.hwtacacsTemplates.set(name, t); }
    return t;
  }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    const hasAaa = this.authenticationSchemes.size + this.authorizationSchemes.size
      + this.accountingSchemes.size + this.domains.size;
    if (hasAaa > 0) {
      lines.push('aaa');
      for (const s of this.authenticationSchemes.values()) {
        lines.push(` authentication-scheme ${s.name}`);
        if (s.mode?.length) lines.push(`  authentication-mode ${s.mode.join(' ')}`);
      }
      for (const s of this.authorizationSchemes.values()) {
        lines.push(` authorization-scheme ${s.name}`);
        if (s.mode?.length) lines.push(`  authorization-mode ${s.mode.join(' ')}`);
      }
      for (const s of this.accountingSchemes.values()) {
        lines.push(` accounting-scheme ${s.name}`);
        if (s.mode) lines.push(`  accounting-mode ${s.mode}`);
        if (s.realtime) lines.push(`  accounting realtime ${s.realtime}`);
        if (s.startFail) lines.push(`  accounting start-fail ${s.startFail}`);
      }
      for (const d of this.domains.values()) {
        lines.push(` domain ${d.name}`);
        if (d.authenticationScheme) lines.push(`  authentication-scheme ${d.authenticationScheme}`);
        if (d.authorizationScheme) lines.push(`  authorization-scheme ${d.authorizationScheme}`);
        if (d.accountingScheme) lines.push(`  accounting-scheme ${d.accountingScheme}`);
        if (d.radiusServerGroup) lines.push(`  radius-server group ${d.radiusServerGroup}`);
        if (d.hwtacacsServerTemplate) lines.push(`  hwtacacs-server ${d.hwtacacsServerTemplate}`);
      }
      lines.push('#');
    }
    for (const t of this.radiusTemplates.values()) {
      lines.push(`radius-server template ${t.name}`);
      if (t.authentication) lines.push(` radius-server authentication ${t.authentication.ip}${t.authentication.port ? ' ' + t.authentication.port : ''}${t.authentication.secondary ? ' secondary' : ''}`);
      if (t.accounting) lines.push(` radius-server accounting ${t.accounting.ip}${t.accounting.port ? ' ' + t.accounting.port : ''}${t.accounting.secondary ? ' secondary' : ''}`);
      if (t.sharedKey) lines.push(` radius-server shared-key ${t.sharedKeyHidden ?? 'cipher'} ${t.sharedKey}`);
      if (t.retransmit !== undefined) lines.push(` radius-server retransmit ${t.retransmit}`);
      if (t.timeout !== undefined) lines.push(` radius-server timeout ${t.timeout}`);
      lines.push('#');
    }
    for (const t of this.hwtacacsTemplates.values()) {
      lines.push(`hwtacacs-server template ${t.name}`);
      if (t.authentication) lines.push(` hwtacacs-server authentication ${t.authentication.ip}${t.authentication.port ? ' ' + t.authentication.port : ''}${t.authentication.secondary ? ' secondary' : ''}`);
      if (t.authorization) lines.push(` hwtacacs-server authorization ${t.authorization.ip}${t.authorization.port ? ' ' + t.authorization.port : ''}${t.authorization.secondary ? ' secondary' : ''}`);
      if (t.accounting) lines.push(` hwtacacs-server accounting ${t.accounting.ip}${t.accounting.port ? ' ' + t.accounting.port : ''}${t.accounting.secondary ? ' secondary' : ''}`);
      if (t.sharedKey) lines.push(` hwtacacs-server shared-key ${t.sharedKeyHidden ?? 'cipher'} ${t.sharedKey}`);
      lines.push('#');
    }
    return lines;
  }
}
