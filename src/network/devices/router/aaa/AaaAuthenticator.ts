import type { Router } from '../../Router';
import { getSecurityConfig } from '../../shells/cisco/CiscoSecurityCommands';
import type { AaaMethodEntry, AaaServerGroup, CiscoSecurityConfig, RadiusServer, TacacsServer } from '../security/CiscoSecurityConfig';
import type { RadiusClientAgent } from '../../../radius/RadiusClientAgent';
import type { TacacsClientAgent } from '../../../tacacs/TacacsClientAgent';
import type { VtyLineConfig } from '../vty/VtyLineConfig';
import type { VtyLineConfigStore } from '../vty/VtyLineConfigStore';
import type { HuaweiAaaService } from './HuaweiAaaService';

export interface AaaAuthenticationOutcome {
  accepted: boolean;
  method: string;
  listName: string;
}

type MethodVerdict = 'accept' | 'reject' | 'continue';

interface AaaCapableRouter {
  getRadiusClient?(): RadiusClientAgent;
  getTacacsClient?(): TacacsClientAgent;
  getHuaweiAaaService?(): HuaweiAaaService;
}

function radiusClientOf(router: Router): RadiusClientAgent | undefined {
  return (router as unknown as AaaCapableRouter).getRadiusClient?.();
}

function tacacsClientOf(router: Router): TacacsClientAgent | undefined {
  return (router as unknown as AaaCapableRouter).getTacacsClient?.();
}

function huaweiAaaOf(router: Router): HuaweiAaaService | undefined {
  return (router as unknown as AaaCapableRouter).getHuaweiAaaService?.();
}

function vtyStoreOf(router: Router): VtyLineConfigStore | undefined {
  return (router as unknown as { _getVtyLineConfig?: () => VtyLineConfigStore })._getVtyLineConfig?.();
}

export class AaaAuthenticator {
  constructor(private readonly router: Router) {}

  async authenticate(username: string, password: string, methodListName?: string): Promise<AaaAuthenticationOutcome> {
    const sec = getSecurityConfig(this.router);
    if (!sec.aaaNewModel) {
      const huawei = await this.tryHuaweiAaa(username, password);
      if (huawei) return huawei;
      return { accepted: this.localAuthenticate(username, password), method: 'local', listName: 'default' };
    }
    const wanted = methodListName ?? this.activeAuthenticationListName();
    const entry = this.resolveMethodList(sec, wanted);
    if (!entry) {
      return { accepted: this.localAuthenticate(username, password), method: 'local', listName: wanted };
    }
    const result = await this.runMethodChain(sec, entry.methods, username, password);
    return { accepted: result.accepted, method: result.method, listName: entry.listName };
  }

  private resolveMethodList(sec: CiscoSecurityConfig, wanted: string): AaaMethodEntry | undefined {
    const lists = sec.aaaMethods.filter((m) => m.phase === 'authentication' && m.service === 'login');
    return lists.find((m) => m.listName === wanted) ?? lists.find((m) => m.listName === 'default');
  }

  /**
   * IOS's `login authentication <list-name>` isn't captured on
   * VtyLineConfig (only the `aaa`/`local`/`password`/`none` mode is), so a
   * line in AAA mode always resolves the `default` method list until that
   * field exists — this at least reflects the real `login` field instead
   * of a name the model never had.
   */
  private activeAuthenticationListName(): string {
    return 'default';
  }

  private activeLinePassword(): string | null {
    const store = vtyStoreOf(this.router);
    if (!store) return null;
    for (const line of store.all()) {
      if (line.linePassword !== null) return line.linePassword;
    }
    return null;
  }

  /**
   * Huawei VRP domain-based AAA — `authentication-mode aaa` on the active
   * VTY line routes the login through `domain <name> → authentication-scheme
   * → authentication-mode {radius|local|...}`, resolving a RADIUS template
   * via `radius-server group <template>` when the scheme calls for it.
   * Returns undefined (not `{accepted:false,...}`) when AAA mode isn't
   * active on any VTY line, so the caller falls back to plain local auth
   * exactly as before this existed.
   */
  private async tryHuaweiAaa(username: string, password: string): Promise<AaaAuthenticationOutcome | undefined> {
    const store = vtyStoreOf(this.router);
    const aaaLine = store?.all().find((line) => line.authenticationMode === 'aaa');
    if (!aaaLine) return undefined;
    const aaa = huaweiAaaOf(this.router);
    if (!aaa) return undefined;

    const at = username.indexOf('@');
    const domainName = at >= 0 ? username.slice(at + 1) : 'default';
    const localName = at >= 0 ? username.slice(0, at) : username;
    const domain = aaa.domains.get(domainName) ?? aaa.domains.get('default');
    const scheme = domain?.authenticationScheme
      ? aaa.authenticationSchemes.get(domain.authenticationScheme)
      : undefined;
    const modes = scheme?.mode ?? ['local'];

    for (const mode of modes) {
      if (mode === 'radius') {
        const verdict = await this.tryHuaweiRadius(aaa, domain?.radiusServerGroup, localName, password);
        if (verdict === 'accept') return { accepted: true, method: 'radius', listName: domainName };
        if (verdict === 'reject') return { accepted: false, method: 'radius', listName: domainName };
      } else if (mode === 'local' || mode === 'local-case') {
        return { accepted: this.localAuthenticate(localName, password), method: 'local', listName: domainName };
      } else if (mode === 'none') {
        return { accepted: true, method: 'none', listName: domainName };
      }
      // 'hwtacacs' isn't modeled here yet — falls through to the next mode.
    }
    return { accepted: this.localAuthenticate(localName, password), method: 'local', listName: domainName };
  }

  private async tryHuaweiRadius(
    aaa: HuaweiAaaService, templateName: string | undefined, username: string, password: string,
  ): Promise<MethodVerdict> {
    if (!templateName) return 'continue';
    const template = aaa.radiusTemplates.get(templateName);
    if (!template?.authentication?.ip) return 'continue';
    const client = radiusClientOf(this.router);
    if (!client) return 'continue';
    client.addServer(template.authentication.ip, template.sharedKey ?? '', {
      port: template.authentication.port,
      timeoutMs: (template.timeout ?? 5) * 1000,
      retransmit: template.retransmit,
    });
    const accepted = await client.authenticate(username, password, template.authentication.ip);
    return accepted ? 'accept' : 'reject';
  }

  private async runMethodChain(sec: CiscoSecurityConfig, methods: string[], username: string, password: string): Promise<{ accepted: boolean; method: string }> {
    let i = 0;
    while (i < methods.length) {
      const token = methods[i];
      if (token === 'group') {
        const groupName = methods[i + 1];
        i += 2;
        const verdict = await this.tryGroup(sec, groupName, username, password);
        if (verdict === 'accept') return { accepted: true, method: `group ${groupName}` };
        if (verdict === 'reject') return { accepted: false, method: `group ${groupName}` };
        continue;
      }
      i += 1;
      if (token === 'local' || token === 'local-case') {
        return { accepted: this.localAuthenticate(username, password), method: token };
      }
      if (token === 'enable') {
        const secret = this.router.getEnableSecret();
        return { accepted: secret !== null && password.length > 0 && secret.value === password, method: 'enable' };
      }
      if (token === 'line') {
        const linePassword = this.activeLinePassword();
        return { accepted: linePassword !== null && password.length > 0 && linePassword === password, method: 'line' };
      }
      if (token === 'none') {
        return { accepted: true, method: 'none' };
      }
    }
    return { accepted: false, method: 'exhausted' };
  }

  private async tryGroup(sec: CiscoSecurityConfig, groupName: string | undefined, username: string, password: string): Promise<MethodVerdict> {
    if (!groupName) return 'continue';
    const group = sec.aaaGroups.get(groupName);
    if (!group) return 'continue';
    if (group.kind === 'radius') return this.tryRadiusGroup(sec, group, username, password);
    return this.tryTacacsGroup(sec, group, username, password);
  }

  private async tryRadiusGroup(sec: CiscoSecurityConfig, group: AaaServerGroup, username: string, password: string): Promise<MethodVerdict> {
    const client = radiusClientOf(this.router);
    if (!client) return 'continue';
    let reachable = false;
    for (const memberName of group.members) {
      const server = sec.radiusServers.get(memberName);
      if (!server || !server.address) continue;
      reachable = true;
      this.syncRadiusServer(client, server);
      const accepted = await client.authenticate(username, password, server.address);
      if (accepted) return 'accept';
    }
    return reachable ? 'reject' : 'continue';
  }

  private async tryTacacsGroup(sec: CiscoSecurityConfig, group: AaaServerGroup, username: string, password: string): Promise<MethodVerdict> {
    const client = tacacsClientOf(this.router);
    if (!client) return 'continue';
    for (const memberName of group.members) {
      const server = sec.tacacsServers.get(memberName);
      if (!server || !server.address) continue;
      this.syncTacacsServer(client, server);
      const result = await client.authenticate(username, password, server.address);
      if (result.status === 'pass') return 'accept';
      if (result.status === 'fail') return 'reject';
    }
    return 'continue';
  }

  private syncRadiusServer(client: RadiusClientAgent, server: RadiusServer): void {
    client.addServer(server.address as string, server.key ?? '', {
      port: server.authPort,
      timeoutMs: server.timeoutSec * 1000,
      retransmit: server.retransmit,
    });
  }

  private syncTacacsServer(client: TacacsClientAgent, server: TacacsServer): void {
    client.addServer(server.address as string, server.key ?? '', {
      port: server.port,
      timeoutMs: server.timeoutSec * 1000,
    });
  }

  private localAuthenticate(username: string, password: string): boolean {
    return this.router.getCredentialStore().authenticate(username, password);
  }
}
