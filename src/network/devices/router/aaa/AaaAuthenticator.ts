import type { Router } from '../../Router';
import { getSecurityConfig } from '../../shells/cisco/CiscoSecurityCommands';
import type { AaaMethodEntry, AaaServerGroup, CiscoSecurityConfig, RadiusServer, TacacsServer } from '../security/CiscoSecurityConfig';
import { radiusAuthPort, tacacsServerPort } from '../security/CiscoSecurityConfig';
import type { RadiusClientAgent } from '../../../radius/RadiusClientAgent';
import type { TacacsClientAgent } from '../../../tacacs/TacacsClientAgent';
import type { TacacsAcctFlag } from '../../../tacacs/types';
import type { VtyLineConfig } from '../vty/VtyLineConfig';
import type { VtyLineConfigStore } from '../vty/VtyLineConfigStore';
import type { HuaweiAaaService } from './HuaweiAaaService';
import { ciscoPasswordMatches } from '../../shells/cisco/ciscoPasswordVerify';

export interface AccountingCounters {
  starts: number;
  stops: number;
  failed: number;
}

export interface AaaAuthenticationOutcome {
  accepted: boolean;
  method: string;
  listName: string;
  /** Privilege level granted by the authenticating server (TACACS+ `pass` → 15), when applicable. */
  privLvl?: number | null;
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

/**
 * Ce dont l'authentificateur a VRAIMENT besoin de la machine : deux
 * accesseurs, tous deux portes par `Equipment`. Il etait type contre
 * `Router`, ce qu'un commutateur n'est pas — d'ou l'absence de
 * `test aaa group` et de toute authentification AAA sur un Catalyst,
 * alors que le magasin de securite, lui, est attache par un symbole et
 * marchait deja sur les deux.
 */
export interface AaaAuthenticatorHost {
  getCredentialStore(): unknown;
  getEnableSecret(): { value: string; algo: string } | null;
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
    return { accepted: result.accepted, method: result.method, listName: entry.listName, privLvl: result.privLvl };
  }

  /** `test aaa group <name> <user> <password> legacy` — probes one server group directly, bypassing method-list resolution. */
  async testGroupAuthentication(groupName: string, username: string, password: string): Promise<MethodVerdict> {
    const sec = getSecurityConfig(this.router);
    const { verdict } = await this.tryGroup(sec, groupName, username, password);
    return verdict;
  }

  /** Kind of server-group backing `<groupName>` — used to render `test aaa`'s "using TACACS+"/"using radius" line. */
  groupKind(groupName: string): 'radius' | 'tacacs+' | undefined {
    return getSecurityConfig(this.router).aaaGroups.get(groupName)?.kind;
  }

  /**
   * `aaa authorization commands <privilegeLevel> default group X local` —
   * consults the configured method list for a command typed at the given
   * privilege level. Real IOS semantics: any method that reaches a verdict
   * (accept/reject) decides it; an unreachable/unconfigured group falls
   * through to the next method exactly like authentication does. `local`
   * has no per-command ACL concept in IOS (it always grants), so it — like
   * a fully exhausted chain — resolves to 'allowed'.
   */
  /**
   * `aaa authorization exec {default|<liste>} <methodes>` — a-t-on droit
   * a un shell, et a quel niveau ?
   *
   * C'est la commande par laquelle un serveur TACACS+ attribue le niveau
   * de privilege a l'OUVERTURE de session. Elle etait acceptee par
   * l'analyseur, rangee dans les methodes AAA, rendue dans la
   * configuration — et aucune methode ne la lisait : la moitie
   * « autorisation » du chapitre AAA etait decorative.
   *
   * `privilegeLevel` a `null` veut dire « la methode n'en designe
   * aucun », et l'appelant retombe alors sur la regle qu'il appliquait
   * deja (ligne, puis compte). Seul un groupe qui repond avec
   * `priv-lvl` impose le sien.
   *
   * Chaine epuisee sans verdict : on ACCORDE, comme le fait
   * `authorizeCommand` — c'est la convention de ce module, et refuser
   * fermerait une machine dont le serveur est simplement injoignable.
   */
  async authorizeExec(username: string): Promise<{ allowed: boolean; privilegeLevel: number | null }> {
    const sec = getSecurityConfig(this.router);
    if (!sec.aaaNewModel) return { allowed: true, privilegeLevel: null };
    const entries = sec.aaaMethods.filter(
      (m) => m.phase === 'authorization' && m.service === 'exec');
    if (entries.length === 0) return { allowed: true, privilegeLevel: null };
    for (const entry of entries) {
      for (const [i, token] of entry.methods.entries()) {
        if (token === 'group') continue;
        if (entry.methods[i - 1] === 'group') {
          const verdict = await this.tryGroupExec(sec, token, username);
          if (verdict.status === 'accept') {
            return { allowed: true, privilegeLevel: verdict.privLvl };
          }
          if (verdict.status === 'reject') return { allowed: false, privilegeLevel: null };
          continue;
        }
        // `local` ne designe pas de niveau ici : c'est l'appelant qui lit
        // le compte, et il le lisait deja. `if-authenticated` et `none`
        // accordent sans rien designer non plus.
        if (token === 'local' || token === 'local-case'
          || token === 'if-authenticated' || token === 'none') {
          return { allowed: true, privilegeLevel: null };
        }
      }
    }
    return { allowed: true, privilegeLevel: null };
  }

  private async tryGroupExec(
    sec: CiscoSecurityConfig, groupName: string, username: string,
  ): Promise<{ status: MethodVerdict; privLvl: number | null }> {
    const group = sec.aaaGroups.get(groupName);
    if (!group || group.kind !== 'tacacs+') return { status: 'continue', privLvl: null };
    const client = tacacsClientOf(this.router);
    if (!client) return { status: 'continue', privLvl: null };
    for (const memberName of group.members) {
      const server = sec.tacacsServers.get(memberName);
      if (!server || !server.address) continue;
      this.syncTacacsServer(client, server);
      const reply = await client.authorizeShell(username, server.address);
      if (reply.status === 'pass-add' || reply.status === 'pass-repl') {
        return { status: 'accept', privLvl: reply.privLvl };
      }
      if (reply.status === 'fail') return { status: 'reject', privLvl: null };
    }
    return { status: 'continue', privLvl: null };
  }

  /**
   * Une liste `aaa authorization commands <niveau>` gouverne-t-elle ce
   * niveau ?
   *
   * Ce predicat est SYNCHRONE, et c'est ce qui compte : la porte
   * d'autorisation est posee sur le chemin que TOUTE commande emprunte,
   * et y placer un `await` inconditionnel differerait l'execution d'un
   * tour de micro-taches — donc changerait le moment ou une commande
   * prend effet, pour toutes les machines, y compris celles qui n'ont
   * aucun AAA configure.
   */
  hasCommandAuthorization(privilegeLevel: number): boolean {
    const sec = getSecurityConfig(this.router);
    if (!sec.aaaNewModel) return false;
    return sec.aaaMethods.some((m) => m.phase === 'authorization' && m.service === 'commands'
      && (m.privilegeLevel ?? 15) === privilegeLevel);
  }

  async authorizeCommand(username: string, command: string, privilegeLevel: number): Promise<'allowed' | 'denied'> {
    const sec = getSecurityConfig(this.router);
    if (!sec.aaaNewModel) return 'allowed';
    const entries = sec.aaaMethods.filter((m) => m.phase === 'authorization' && m.service === 'commands'
      && (m.privilegeLevel ?? 15) === privilegeLevel);
    if (entries.length === 0) return 'allowed';
    for (const entry of entries) {
      const verdict = await this.runAuthorizationChain(sec, entry.methods, username, command);
      if (verdict === 'accept') return 'allowed';
      if (verdict === 'reject') return 'denied';
    }
    return 'allowed';
  }

  private async runAuthorizationChain(sec: CiscoSecurityConfig, methods: string[], username: string, command: string): Promise<MethodVerdict> {
    let i = 0;
    while (i < methods.length) {
      const token = methods[i];
      if (token === 'group') {
        const groupName = methods[i + 1];
        i += 2;
        const verdict = await this.tryGroupAuthorization(sec, groupName, username, command);
        if (verdict !== 'continue') return verdict;
        continue;
      }
      i += 1;
      // `local`/`local-case`/`none` have no per-command permission model in
      // this simulator (matching real IOS's `local` method, which never
      // denies a specific command) — they always grant.
      if (token === 'local' || token === 'local-case' || token === 'none') return 'accept';
    }
    return 'continue';
  }

  private async tryGroupAuthorization(sec: CiscoSecurityConfig, groupName: string | undefined, username: string, command: string): Promise<MethodVerdict> {
    if (!groupName) return 'continue';
    const group = sec.aaaGroups.get(groupName);
    if (!group || group.kind !== 'tacacs+') return 'continue';
    const client = tacacsClientOf(this.router);
    if (!client) return 'continue';
    for (const memberName of group.members) {
      const server = sec.tacacsServers.get(memberName);
      if (!server || !server.address) continue;
      this.syncTacacsServer(client, server);
      const status = await client.authorize(username, command, server.address);
      if (status === 'pass-add' || status === 'pass-repl') return 'accept';
      if (status === 'fail') return 'reject';
    }
    return 'continue';
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

  private activeLinePassword(): { value: string; algo: 'plain' | 'type-7' } | null {
    const store = vtyStoreOf(this.router);
    if (!store) return null;
    for (const line of store.all()) {
      if (line.linePassword !== null) return { value: line.linePassword, algo: line.linePasswordAlgo };
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

  private async runMethodChain(sec: CiscoSecurityConfig, methods: string[], username: string, password: string): Promise<{ accepted: boolean; method: string; privLvl?: number | null }> {
    let i = 0;
    while (i < methods.length) {
      const token = methods[i];
      if (token === 'group') {
        const groupName = methods[i + 1];
        i += 2;
        const { verdict, privLvl } = await this.tryGroup(sec, groupName, username, password);
        if (verdict === 'accept') return { accepted: true, method: `group ${groupName}`, privLvl };
        if (verdict === 'reject') return { accepted: false, method: `group ${groupName}` };
        continue;
      }
      i += 1;
      if (token === 'local' || token === 'local-case') {
        return { accepted: this.localAuthenticate(username, password), method: token };
      }
      if (token === 'enable') {
        const secret = this.router.getEnableSecret();
        return {
          accepted: secret !== null && password.length > 0
            && ciscoPasswordMatches(password, secret.value, secret.algo),
          method: 'enable',
        };
      }
      if (token === 'line') {
        const linePassword = this.activeLinePassword();
        return {
          accepted: linePassword !== null && password.length > 0
            && ciscoPasswordMatches(password, linePassword.value, linePassword.algo),
          method: 'line',
        };
      }
      if (token === 'none') {
        return { accepted: true, method: 'none' };
      }
    }
    return { accepted: false, method: 'exhausted' };
  }

  private async tryGroup(sec: CiscoSecurityConfig, groupName: string | undefined, username: string, password: string): Promise<{ verdict: MethodVerdict; privLvl?: number | null }> {
    if (!groupName) return { verdict: 'continue' };
    const group = sec.aaaGroups.get(groupName);
    if (!group) return { verdict: 'continue' };
    if (group.kind === 'radius') return { verdict: await this.tryRadiusGroup(sec, group, username, password) };
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

  private async tryTacacsGroup(sec: CiscoSecurityConfig, group: AaaServerGroup, username: string, password: string): Promise<{ verdict: MethodVerdict; privLvl?: number | null }> {
    const client = tacacsClientOf(this.router);
    if (!client) return { verdict: 'continue' };
    for (const memberName of group.members) {
      const server = sec.tacacsServers.get(memberName);
      if (!server || !server.address) continue;
      this.syncTacacsServer(client, server);
      // Les compteurs de `show tacacs` etaient uniquement LUS, jamais
      // incrementes : ils affichaient donc zero quoi qu'il arrive, et le
      // controle « echecs = 0 » d'une liste d'audit ne pouvait rien
      // distinguer. Ils sont mesures ici, au point ou l'echange a lieu.
      server.stats.socketOpens += 1;
      server.stats.authRequests += 1;
      const result = await client.authenticate(username, password, server.address);
      server.stats.socketCloses += 1;
      if (result.status === 'pass') {
        server.stats.authAccepts += 1;
        return { verdict: 'accept', privLvl: result.privLvl };
      }
      if (result.status === 'fail') {
        server.stats.authRejects += 1;
        return { verdict: 'reject' };
      }
      server.stats.socketAborts += 1;
    }
    return { verdict: 'continue' };
  }

  /**
   * L'accounting de commandes (`docs/PRD-Pistes-Audit-Cisco.md` §5).
   *
   * `TacacsClientAgent.accountCommand()` etait ecrit, correct, et n'avait
   * AUCUN appelant de production — seul un test l'appelait. `aaa
   * accounting commands 15 default start-stop group X` etait donc
   * accepte, rendu dans la configuration, et aucun paquet ne partait : le
   * mecanisme le plus puissant des pistes d'audit Cisco ne tracait rien.
   *
   * Rend le nombre d'enregistrements REELLEMENT emis, ce que
   * `show aaa accounting` compte ensuite — un compteur qui ne serait pas
   * celui des paquets partis serait la decoration qu'on vient de retirer
   * ailleurs.
   */
  async accountCommand(
    username: string, command: string, privilegeLevel: number,
  ): Promise<number> {
    return this.emitAccounting('commands', command, username, privilegeLevel);
  }

  /** L'accounting de session exec (`aaa accounting exec`). */
  async accountExec(username: string, event: 'start' | 'stop'): Promise<number> {
    return this.emitAccounting('exec', `exec-${event}`, username, undefined, event);
  }

  private async emitAccounting(
    service: string, command: string, username: string,
    privilegeLevel?: number, phase: 'start' | 'stop' = 'stop',
  ): Promise<number> {
    const sec = getSecurityConfig(this.router);
    if (!sec.aaaNewModel) return 0;
    const entries = sec.aaaMethods.filter((m) => m.phase === 'accounting'
      && m.service === service
      && (privilegeLevel === undefined || (m.privilegeLevel ?? privilegeLevel) === privilegeLevel));
    if (entries.length === 0) return 0;
    const client = tacacsClientOf(this.router);
    if (!client) return 0;

    // `start-stop` emet DEUX enregistrements, `stop-only` un seul : c'est
    // le mot-cle qui le dit, et le rendre identique ferait mentir la
    // configuration sur ce que le collecteur recoit.
    let emis = 0;
    let echecs = 0;
    for (const entry of entries) {
      const drapeaux: TacacsAcctFlag[] = entry.recordType === 'start-stop'
        ? (['start', 'stop'] as TacacsAcctFlag[])
        : (['stop'] as TacacsAcctFlag[]);
      for (let i = 0; i + 1 < entry.methods.length; i++) {
        if (entry.methods[i] !== 'group') continue;
        const group = sec.aaaGroups.get(entry.methods[i + 1]);
        if (!group || group.kind !== 'tacacs+') continue;
        for (const memberName of group.members) {
          const server = sec.tacacsServers.get(memberName);
          if (!server?.address) continue;
          this.syncTacacsServer(client, server);
          for (const flag of drapeaux) {
            if (phase === 'start' && flag === 'stop') continue;
            const statut = await client.accountCommand(
              username, command, [flag], server.address);
            if (statut === 'success') {
              emis += 1;
              const c = this.compteurs(service);
              if (flag === 'start') c.starts += 1; else c.stops += 1;
            } else {
              echecs += 1;
            }
          }
        }
      }
    }
    this.compteurs(service).failed += echecs;
    return emis;
  }

  /**
   * Ce que `show accounting` compte : des enregistrements REELLEMENT
   * partis, par service. Un compteur qui ne serait pas celui des paquets
   * emis serait la decoration que ce chantier retire ailleurs, et
   * `Failed accounting` — le controle A10 d'une liste d'audit — ne
   * pourrait rien distinguer.
   */
  private readonly accountingCounters = new Map<string, AccountingCounters>();

  private compteurs(service: string): AccountingCounters {
    let c = this.accountingCounters.get(service);
    if (!c) { c = { starts: 0, stops: 0, failed: 0 }; this.accountingCounters.set(service, c); }
    return c;
  }

  accountingTraffic(): ReadonlyMap<string, Readonly<AccountingCounters>> {
    return this.accountingCounters;
  }

  /** Le total d'echecs, que `show tacacs` rend comme `Failed accounting`. */
  failedAccounting(): number {
    let n = 0;
    for (const c of this.accountingCounters.values()) n += c.failed;
    return n;
  }

  private syncRadiusServer(client: RadiusClientAgent, server: RadiusServer): void {
    const defauts = getSecurityConfig(this.router).radiusDefaults;
    client.addServer(server.address as string, server.key ?? defauts.key ?? '', {
      port: radiusAuthPort(server, defauts),
      timeoutMs: (server.timeoutSec ?? defauts.timeoutSec ?? 5) * 1000,
      retransmit: server.retransmit ?? defauts.retransmit,
    });
  }

  private syncTacacsServer(client: TacacsClientAgent, server: TacacsServer): void {
    const defauts = getSecurityConfig(this.router).tacacsDefaults;
    client.addServer(server.address as string, server.key ?? defauts.key ?? '', {
      port: tacacsServerPort(server, defauts),
      timeoutMs: (server.timeoutSec ?? defauts.timeoutSec ?? 5) * 1000,
    });
  }

  private localAuthenticate(username: string, password: string): boolean {
    return this.router.getCredentialStore().authenticate(username, password);
  }
}
