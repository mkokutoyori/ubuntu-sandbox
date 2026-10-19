export type KerberosPreauth = 'encrypted-unix-timestamp' | 'encrypted-kerberos-timestamp' | 'none';

export interface KdcAddress {
  readonly host: string;
  readonly port: number;
}

export const KERBEROS_DEFAULT_PORT = 88;
export const KERBEROS_DEFAULT_RETRY = 4;
export const KERBEROS_DEFAULT_TIMEOUT_SECONDS = 5;
export const KERBEROS_DEFAULT_PROCESSES = 1;
export const KERBEROS_DEFAULT_PRIVILEGE = 1;

export class KerberosConfig {
  localRealm?: string;
  readonly realmMap = new Map<string, string>();
  readonly servers = new Map<string, KdcAddress[]>();
  preauth?: KerberosPreauth;
  retry?: number;
  timeout?: number;
  processes?: number;
  password?: string;
  credentialsForward = false;
  clientsMandatory = false;
  readonly instanceMap = new Map<string, number>();

  effectivePreauth(): 'encrypted-timestamp' | 'encrypted-unix-timestamp' | 'none' {
    if (this.preauth === 'encrypted-kerberos-timestamp') return 'encrypted-timestamp';
    return this.preauth ?? 'none';
  }
  readonly srvtabs = new Map<string, string>();

  effectiveRetry(): number { return this.retry ?? KERBEROS_DEFAULT_RETRY; }

  effectiveTimeoutSeconds(): number { return this.timeout ?? KERBEROS_DEFAULT_TIMEOUT_SECONDS; }

  principalOf(login: string): { user: string; instance?: string; realm?: string } {
    const at = login.lastIndexOf('@');
    const realm = at > 0 ? login.slice(at + 1) : this.localRealm;
    const name = at > 0 ? login.slice(0, at) : login;
    const slash = name.indexOf('/');
    return slash > 0
      ? { user: name.slice(0, slash), instance: name.slice(slash + 1), realm }
      : { user: name, realm };
  }

  privilegeOfInstance(instance: string | undefined): number {
    return (instance !== undefined ? this.instanceMap.get(instance) : undefined) ?? KERBEROS_DEFAULT_PRIVILEGE;
  }

  addServer(realm: string, address: KdcAddress): void {
    const known = this.servers.get(realm) ?? [];
    if (!known.some((k) => k.host === address.host && k.port === address.port)) known.push(address);
    this.servers.set(realm, known);
  }

  removeServer(realm: string, host: string): boolean {
    const known = this.servers.get(realm);
    if (!known) return false;
    const kept = known.filter((k) => k.host !== host);
    if (kept.length === known.length) return false;
    if (kept.length === 0) this.servers.delete(realm); else this.servers.set(realm, kept);
    return true;
  }

  isEmpty(): boolean {
    return this.localRealm === undefined && this.realmMap.size === 0 && this.servers.size === 0
      && this.preauth === undefined && this.retry === undefined && this.timeout === undefined
      && this.processes === undefined && this.password === undefined && !this.credentialsForward
      && !this.clientsMandatory && this.instanceMap.size === 0 && this.srvtabs.size === 0;
  }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    if (this.localRealm !== undefined) lines.push(`kerberos local-realm ${this.localRealm}`);
    for (const line of this.srvtabs.values()) lines.push(`kerberos srvtab entry ${line}`);
    for (const [domain, realm] of this.realmMap) lines.push(`kerberos realm ${domain} ${realm}`);
    for (const [realm, list] of this.servers) {
      for (const kdc of list) {
        lines.push(kdc.port === KERBEROS_DEFAULT_PORT
          ? `kerberos server ${realm} ${kdc.host}`
          : `kerberos server ${realm} ${kdc.host} ${kdc.port}`);
      }
    }
    for (const [instance, level] of this.instanceMap) lines.push(`kerberos instance map ${instance} ${level}`);
    if (this.preauth !== undefined) lines.push(`kerberos preauth ${this.preauth}`);
    if (this.password !== undefined) lines.push(`kerberos password ${this.password}`);
    if (this.credentialsForward) lines.push('kerberos credentials forward');
    if (this.clientsMandatory) lines.push('kerberos clients mandatory');
    if (this.retry !== undefined) lines.push(`kerberos retry ${this.retry}`);
    if (this.timeout !== undefined) lines.push(`kerberos timeout ${this.timeout}`);
    if (this.processes !== undefined) lines.push(`kerberos processes ${this.processes}`);
    return lines;
  }
}
