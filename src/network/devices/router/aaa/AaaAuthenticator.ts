import type { Router } from '../../Router';
import { getSecurityConfig } from '../../shells/cisco/CiscoSecurityCommands';
import type { AaaMethodEntry, AaaServerGroup, CiscoSecurityConfig, RadiusServer, TacacsServer } from '../security/CiscoSecurityConfig';
import type { RadiusClientAgent } from '../../../radius/RadiusClientAgent';
import type { TacacsClientAgent } from '../../../tacacs/TacacsClientAgent';

export interface AaaAuthenticationOutcome {
  accepted: boolean;
  method: string;
  listName: string;
}

type MethodVerdict = 'accept' | 'reject' | 'continue';

interface AaaCapableRouter {
  getRadiusClient?(): RadiusClientAgent;
  getTacacsClient?(): TacacsClientAgent;
}

interface VtyLineSnapshot {
  loginMode: string;
  aaaAuthenticationList: string | null;
  password: string | null;
}

interface VtyLineConfigStoreLike {
  all(): readonly VtyLineSnapshot[];
}

function radiusClientOf(router: Router): RadiusClientAgent | undefined {
  return (router as unknown as AaaCapableRouter).getRadiusClient?.();
}

function tacacsClientOf(router: Router): TacacsClientAgent | undefined {
  return (router as unknown as AaaCapableRouter).getTacacsClient?.();
}

function vtyStoreOf(router: Router): VtyLineConfigStoreLike | undefined {
  return (router as unknown as { _getVtyLineConfig?: () => VtyLineConfigStoreLike })._getVtyLineConfig?.();
}

export class AaaAuthenticator {
  constructor(private readonly router: Router) {}

  async authenticate(username: string, password: string, methodListName?: string): Promise<AaaAuthenticationOutcome> {
    const sec = getSecurityConfig(this.router);
    if (!sec.aaaNewModel) {
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

  private activeAuthenticationListName(): string {
    const store = vtyStoreOf(this.router);
    if (store) {
      for (const line of store.all()) {
        if (line.loginMode === 'aaa' && line.aaaAuthenticationList) return line.aaaAuthenticationList;
      }
    }
    return 'default';
  }

  private activeLinePassword(): string | null {
    const store = vtyStoreOf(this.router);
    if (!store) return null;
    for (const line of store.all()) {
      if (line.password !== null) return line.password;
    }
    return null;
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
