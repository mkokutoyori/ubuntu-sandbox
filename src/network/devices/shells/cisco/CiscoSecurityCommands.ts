import type { Router } from '../../Router';
import { CommandTrie } from '../CommandTrie';
import {
  CiscoSecurityConfig,
  type AaaServiceKind,
  type AaaPhase,
} from '../../router/security/CiscoSecurityConfig';
import type { CiscoShellContext, CiscoShellMode } from './CiscoConfigCommands';

const SECURITY_KEY = Symbol.for('CiscoSecurityConfig');

export function getSecurityConfig(router: Router): CiscoSecurityConfig {
  const r = router as unknown as Record<symbol, CiscoSecurityConfig>;
  if (!r[SECURITY_KEY]) r[SECURITY_KEY] = new CiscoSecurityConfig();
  return r[SECURITY_KEY];
}

export interface CiscoSecurityShellContext extends CiscoShellContext {
  setClassMap?(name: string | null): void;
  getClassMap?(): string | null;
  setPolicyMap?(name: string | null): void;
  getPolicyMap?(): string | null;
  setPolicyClass?(name: string | null): void;
  getPolicyClass?(): string | null;
  setZone?(name: string | null): void;
  getZone?(): string | null;
  setZonePair?(name: string | null): void;
  getZonePair?(): string | null;
  setTimeRange?(name: string | null): void;
  getTimeRange?(): string | null;
  setControlPlane?(active: boolean): void;
  getControlPlane?(): boolean;
  setRadiusServer?(name: string | null): void;
  getRadiusServer?(): string | null;
  setTacacsServer?(name: string | null): void;
  getTacacsServer?(): string | null;
  setAaaGroup?(name: string | null): void;
  getAaaGroup?(): string | null;
}

export function buildSecurityConfigCommands(trie: CommandTrie, ctx: CiscoSecurityShellContext): void {
  const sec = () => getSecurityConfig(ctx.r());

  trie.registerGreedy('aaa', 'AAA configuration', (args) => {
    if (args[0] === 'new-model') { sec().aaaNewModel = true; return ''; }
    if (args[0] === 'session-id' && args[1]) { sec().aaaSessionId = args[1]; return ''; }
    if (args[0] === 'authentication' || args[0] === 'authorization' || args[0] === 'accounting') {
      return parseAaaMethod(sec(), args[0] as AaaPhase, args.slice(1));
    }
    if (args[0] === 'group' && args[1] === 'server' && args[2] && args[3]) {
      const kind = args[2] === 'tacacs+' ? 'tacacs+' : 'radius';
      const name = args[3];
      const existing = sec().aaaGroups.get(name) ?? { name, kind: kind as 'radius' | 'tacacs+', members: [] };
      sec().aaaGroups.set(name, existing);
      ctx.setAaaGroup?.(name);
      ctx.setMode('config-aaa-group' as CiscoShellMode);
      return '';
    }
    return '';
  });

  trie.registerGreedy('radius', 'Radius configuration', (args) => {
    if (args[0] === 'server' && args[1]) {
      const name = args[1];
      const s = sec().radiusServers.get(name) ?? {
        name, authPort: 1645, acctPort: 1646, retransmit: 3, timeoutSec: 5,
      };
      sec().radiusServers.set(name, s);
      ctx.setRadiusServer?.(name);
      ctx.setMode('config-radius-server' as CiscoShellMode);
      return '';
    }
    return '';
  });

  trie.registerGreedy('tacacs', 'TACACS+ configuration', (args) => {
    if (args[0] === 'server' && args[1]) {
      const name = args[1];
      const s = sec().tacacsServers.get(name) ?? {
        name, port: 49, timeoutSec: 5, singleConnection: false,
      };
      sec().tacacsServers.set(name, s);
      ctx.setTacacsServer?.(name);
      ctx.setMode('config-tacacs-server' as CiscoShellMode);
      return '';
    }
    return '';
  });

  trie.registerGreedy('radius-server', 'Legacy radius host', (args) => {
    if (args[0] === 'host' && args[1]) {
      const host = args[1];
      let key: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === 'key' && args[i + 1]) { key = args[i + 1]; break; }
      }
      sec().legacyHosts.push({ kind: 'radius', host, key });
    }
    return '';
  });

  trie.registerGreedy('tacacs-server', 'Legacy tacacs host', (args) => {
    if (args[0] === 'host' && args[1]) {
      const host = args[1];
      let key: string | undefined;
      for (let i = 2; i < args.length; i++) {
        if (args[i] === 'key' && args[i + 1]) { key = args[i + 1]; break; }
      }
      sec().legacyHosts.push({ kind: 'tacacs', host, key });
    }
    return '';
  });

  trie.registerGreedy('username', 'Local user', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    const name = args[0];
    let privilege: number | undefined;
    let secret: string | undefined;
    let secretAlgo: 'plain' | 'md5' | 'sha256' | 'type-7' = 'plain';
    let nopassword = false;
    let description: string | undefined;
    for (let i = 1; i < args.length; i++) {
      const t = args[i];
      if (t === 'privilege' && args[i + 1]) { privilege = parseInt(args[i + 1], 10); i++; }
      else if (t === 'nopassword') { nopassword = true; }
      else if (t === 'description') { description = args.slice(i + 1).join(' '); break; }
      else if (t === 'secret') {
        const next = args[i + 1];
        if (next === '0') { secret = args.slice(i + 2).join(' '); secretAlgo = 'plain'; break; }
        if (next === '5') { secret = args.slice(i + 2).join(' '); secretAlgo = 'md5'; break; }
        if (next === '8') { secret = args.slice(i + 2).join(' '); secretAlgo = 'sha256'; break; }
        if (next === '9') { secret = args.slice(i + 2).join(' '); secretAlgo = 'sha256'; break; }
        if (next === '4') { secret = args.slice(i + 2).join(' '); secretAlgo = 'sha256'; break; }
        secret = args.slice(i + 1).join(' '); secretAlgo = 'plain'; break;
      }
      else if (t === 'password') {
        const next = args[i + 1];
        if (next === '0') { secret = args.slice(i + 2).join(' '); secretAlgo = 'plain'; break; }
        if (next === '7') { secret = args.slice(i + 2).join(' '); secretAlgo = 'type-7'; break; }
        secret = args.slice(i + 1).join(' '); secretAlgo = 'plain'; break;
      }
    }
    const router = ctx.r() as unknown as {
      _upsertCiscoUsername?: (n: string, kv: {
        privilege?: number; secret?: string;
        secretAlgo?: 'plain' | 'md5' | 'sha256' | 'type-7';
        nopassword?: boolean; description?: string;
      }) => void;
    };
    if (router._upsertCiscoUsername) {
      router._upsertCiscoUsername(name, { privilege, secret, secretAlgo, nopassword, description });
    }
    sec().usernames.set(name, { name, privilege: privilege ?? 1, secret, password: undefined });
    return '';
  });

  trie.registerGreedy('enable secret', 'Set enable secret', (args) => {
    sec().enableSecret = args.join(' ');
    return '';
  });

  trie.registerGreedy('enable password', 'Set enable password', (args) => {
    sec().enableSecret = args.join(' ');
    return '';
  });

  trie.registerGreedy('service password-encryption', 'Enable password encryption', () => {
    sec().servicePasswordEncryption = true;
    return '';
  });

  trie.registerGreedy('security passwords min-length', 'Min password length', (args) => {
    const n = parseInt(args[0], 10);
    if (!isNaN(n)) sec().passwords.minLength = n;
    return '';
  });

  trie.registerGreedy('login block-for', 'Login block', (args) => {
    const seconds = parseInt(args[0], 10);
    let attempts = 0, withinSeconds = 0;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === 'attempts' && args[i + 1]) attempts = parseInt(args[i + 1], 10);
      if (args[i] === 'within' && args[i + 1]) withinSeconds = parseInt(args[i + 1], 10);
    }
    if (!isNaN(seconds)) sec().login.blockFor = { seconds, attempts, withinSeconds };
    const r = ctx.r() as unknown as { _configureLoginBlock?: (s: number, a: number, w: number) => void };
    if (r._configureLoginBlock && !isNaN(seconds)) r._configureLoginBlock(seconds, attempts, withinSeconds);
    return '';
  });

  trie.registerGreedy('login quiet-mode access-class', 'Quiet mode ACL', (args) => {
    if (args[0]) sec().login.quietModeAcl = args[0];
    return '';
  });

  trie.registerGreedy('login delay', 'Login delay', (args) => {
    const d = parseInt(args[0], 10);
    if (!isNaN(d)) sec().login.delay = d;
    return '';
  });

  trie.register('login on-failure log', 'Log failures', () => { sec().login.onFailureLog = true; return ''; });
  trie.register('login on-success log', 'Log successes', () => { sec().login.onSuccessLog = true; return ''; });

  trie.registerGreedy('hostname', 'Set hostname', (args) => {
    if (args[0]) {
      sec().hostname = args[0];
      try { (ctx.r() as any).setHostname?.(args[0]); } catch { /* ignore */ }
    }
    return '';
  });

  trie.registerGreedy('ip domain-name', 'Set domain name', (args) => {
    if (args[0]) sec().domainName = args[0];
    return '';
  });

  trie.registerGreedy('ip domain name', 'Set domain name', (args) => {
    if (args[0]) sec().domainName = args[0];
    return '';
  });

  trie.registerGreedy('crypto key generate rsa', 'Generate RSA key', (args) => {
    let modulus = 1024;
    let label = 'default';
    let general = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'modulus' && args[i + 1]) modulus = parseInt(args[i + 1], 10);
      if (args[i] === 'label' && args[i + 1]) label = args[i + 1];
      if (args[i] === 'general-keys') general = true;
    }
    sec().cryptoKeys.push({ label, modulus, general });
    return `The key modulus size is ${modulus} bits\n% Generating ${modulus} bit RSA keys, keys will be non-exportable...\n[OK] (elapsed time was 1 seconds)`;
  });

  trie.registerGreedy('ip ssh', 'SSH config', (args) => {
    if (args[0] === 'version' && args[1]) { sec().ssh.version = parseInt(args[1], 10); return ''; }
    if (args[0] === 'time-out' && args[1]) { sec().ssh.timeoutSec = parseInt(args[1], 10); return ''; }
    if (args[0] === 'authentication-retries' && args[1]) {
      const n = parseInt(args[1], 10);
      sec().ssh.authRetries = n;
      const r = ctx.r() as unknown as { _configureSshAuthRetries?: (n: number) => void };
      if (r._configureSshAuthRetries && !isNaN(n)) r._configureSshAuthRetries(n);
      return '';
    }
    if (args[0] === 'source-interface' && args[1]) { sec().ssh.sourceInterface = args[1]; return ''; }
    if (args[0] === 'dh' && args[1] === 'min' && args[2] === 'size' && args[3]) { sec().ssh.dhMinBits = parseInt(args[3], 10); return ''; }
    if (args[0] === 'logging' && args[1] === 'events') { sec().ssh.loggingEvents = true; return ''; }
    return '';
  });

  trie.registerGreedy('ip cef', 'Enable CEF', () => { sec().ipCef = true; return ''; });

  trie.registerGreedy('time-range', 'Define time-range', (args) => {
    if (!args[0]) return '% Incomplete command.';
    sec().ensureTimeRange(args[0]);
    ctx.setTimeRange?.(args[0]);
    ctx.setMode('config-time-range' as CiscoShellMode);
    return '';
  });

  trie.registerGreedy('class-map', 'Define class map', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    let kind: 'qos' | 'inspect' = 'qos';
    let matchAll = true;
    let i = 0;
    if (args[i] === 'type' && args[i + 1] === 'inspect') { kind = 'inspect'; i += 2; }
    if (args[i] === 'match-all') { matchAll = true; i++; }
    else if (args[i] === 'match-any') { matchAll = false; i++; }
    const name = args[i];
    if (!name) return '% Incomplete command.';
    sec().ensureClassMap(name, kind, matchAll);
    ctx.setClassMap?.(name);
    ctx.setMode('config-cmap' as CiscoShellMode);
    return '';
  });

  trie.registerGreedy('policy-map', 'Define policy map', (args) => {
    if (args.length < 1) return '% Incomplete command.';
    let kind: 'qos' | 'inspect' = 'qos';
    let i = 0;
    if (args[i] === 'type' && args[i + 1] === 'inspect') { kind = 'inspect'; i += 2; }
    const name = args[i];
    if (!name) return '% Incomplete command.';
    sec().ensurePolicyMap(name, kind);
    ctx.setPolicyMap?.(name);
    ctx.setMode('config-pmap' as CiscoShellMode);
    return '';
  });

  trie.register('control-plane', 'Enter control-plane', () => {
    ctx.setControlPlane?.(true);
    ctx.setMode('config-cp' as CiscoShellMode);
    return '';
  });

  trie.registerGreedy('zone security', 'Define security zone', (args) => {
    if (!args[0]) return '% Incomplete command.';
    sec().zones.set(args[0], { name: args[0] });
    ctx.setZone?.(args[0]);
    ctx.setMode('config-zone' as CiscoShellMode);
    return '';
  });

  trie.registerGreedy('zone-pair security', 'Define zone-pair', (args) => {
    if (args.length < 5) return '% Incomplete command.';
    const name = args[0];
    let src = '', dst = '';
    for (let i = 1; i < args.length; i++) {
      if (args[i] === 'source' && args[i + 1]) src = args[i + 1];
      if (args[i] === 'destination' && args[i + 1]) dst = args[i + 1];
    }
    sec().zonePairs.set(name, { name, source: src, destination: dst });
    ctx.setZonePair?.(name);
    ctx.setMode('config-zone-pair' as CiscoShellMode);
    return '';
  });
}

function parseAaaMethod(sec: CiscoSecurityConfig, phase: AaaPhase, args: string[]): string {
  if (args.length < 2) return '';
  const service = args[0] as AaaServiceKind;
  let i = 1;
  let privilegeLevel: number | undefined;
  if (service === 'commands' && args[i] !== undefined) {
    const lvl = parseInt(args[i], 10);
    if (!isNaN(lvl)) { privilegeLevel = lvl; i++; }
  }
  const listName = args[i++];
  let recordType: 'start-stop' | 'stop-only' | 'wait-start' | 'none' | undefined;
  if (phase === 'accounting' && (args[i] === 'start-stop' || args[i] === 'stop-only' || args[i] === 'wait-start' || args[i] === 'none')) {
    recordType = args[i] as 'start-stop' | 'stop-only' | 'wait-start' | 'none';
    i++;
  }
  const methods = args.slice(i);
  sec.aaaMethods.push({ phase, service, listName, privilegeLevel, recordType, methods });
  return '';
}

export function buildSecuritySubmodeCommands(
  cmapTrie: CommandTrie,
  pmapTrie: CommandTrie,
  pmapClassTrie: CommandTrie,
  cpTrie: CommandTrie,
  zoneTrie: CommandTrie,
  zonePairTrie: CommandTrie,
  trTrie: CommandTrie,
  radiusTrie: CommandTrie,
  tacacsTrie: CommandTrie,
  aaaGroupTrie: CommandTrie,
  ctx: CiscoSecurityShellContext,
): void {
  const sec = () => getSecurityConfig(ctx.r());

  cmapTrie.registerGreedy('match', 'Match criteria', (args) => {
    const name = ctx.getClassMap?.();
    if (!name) return '';
    const cm = sec().classMaps.get(name);
    if (!cm) return '';
    if (args[0] === 'access-group') {
      if (args[1] === 'name' && args[2]) cm.matches.push({ kind: 'access-group-name', value: args[2] });
      else if (args[1]) cm.matches.push({ kind: 'access-group-num', value: args[1] });
    } else if (args[0] === 'protocol' && args[1]) {
      cm.matches.push({ kind: 'protocol', value: args[1] });
    } else if (args[0] === 'any') {
      cm.matches.push({ kind: 'any' });
    }
    return '';
  });

  pmapTrie.registerGreedy('class', 'Class for policy', (args) => {
    const pname = ctx.getPolicyMap?.();
    if (!pname) return '';
    const pm = sec().policyMaps.get(pname);
    if (!pm) return '';
    let cname: string;
    let kind: 'class-default' | 'named' | 'inspect' = 'named';
    let i = 0;
    if (args[i] === 'type' && args[i + 1] === 'inspect') { kind = 'inspect'; i += 2; }
    cname = args[i] ?? '';
    if (cname === 'class-default') kind = 'class-default';
    let cls = pm.classes.find(c => c.className === cname);
    if (!cls) {
      cls = { className: cname, kind, actions: [] };
      pm.classes.push(cls);
    }
    ctx.setPolicyClass?.(cname);
    ctx.setMode('config-pmap-c' as CiscoShellMode);
    return '';
  });

  pmapClassTrie.registerGreedy('police', 'Police traffic', (args) => {
    addAction(ctx, 'police', args);
    return '';
  });
  pmapClassTrie.register('inspect', 'Inspect', () => { addAction(ctx, 'inspect', []); return ''; });
  pmapClassTrie.registerGreedy('drop', 'Drop', (args) => { addAction(ctx, 'drop', args); return ''; });
  pmapClassTrie.register('pass', 'Pass', () => { addAction(ctx, 'pass', []); return ''; });
  pmapClassTrie.registerGreedy('set dscp', 'Set DSCP', (args) => { addAction(ctx, 'set-dscp', args); return ''; });
  pmapClassTrie.registerGreedy('set precedence', 'Set precedence', (args) => { addAction(ctx, 'set-precedence', args); return ''; });

  cpTrie.registerGreedy('service-policy', 'Apply policy', (args) => {
    if (args[0] === 'input' && args[1]) sec().controlPlane.servicePolicyInput = args[1];
    if (args[0] === 'output' && args[1]) sec().controlPlane.servicePolicyOutput = args[1];
    return '';
  });

  zoneTrie.registerGreedy('description', 'Zone description', () => '');

  zonePairTrie.registerGreedy('service-policy', 'Apply policy', (args) => {
    const name = ctx.getZonePair?.();
    if (!name) return '';
    const zp = sec().zonePairs.get(name);
    if (!zp) return '';
    if (args[0] === 'type' && args[1] === 'inspect' && args[2]) zp.servicePolicy = args[2];
    return '';
  });

  trTrie.registerGreedy('periodic', 'Periodic time-range', (args) => {
    const name = ctx.getTimeRange?.();
    if (!name) return '';
    const tr = sec().ensureTimeRange(name);
    let days = '';
    let i = 0;
    while (i < args.length && args[i] !== 'to' && !/^\d/.test(args[i])) {
      days += (days ? ' ' : '') + args[i];
      i++;
    }
    if (i >= args.length) return '';
    const [sh, sm] = parseHourMinute(args[i]);
    if (args[i + 1] !== 'to' || !args[i + 2]) return '';
    const [eh, em] = parseHourMinute(args[i + 2]);
    tr.periodic.push({ days, startHour: sh, startMinute: sm, endHour: eh, endMinute: em });
    return '';
  });
  trTrie.registerGreedy('absolute', 'Absolute time-range', (args) => {
    const name = ctx.getTimeRange?.();
    if (!name) return '';
    const tr = sec().ensureTimeRange(name);
    const parsed = parseAbsolute(args);
    if (parsed) tr.absolute = parsed;
    return '';
  });

  radiusTrie.registerGreedy('address', 'Radius address', (args) => {
    const name = ctx.getRadiusServer?.();
    if (!name) return '';
    const s = sec().radiusServers.get(name);
    if (!s) return '';
    if (args[0] === 'ipv4' && args[1]) s.address = args[1];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'auth-port' && args[i + 1]) s.authPort = parseInt(args[i + 1], 10);
      if (args[i] === 'acct-port' && args[i + 1]) s.acctPort = parseInt(args[i + 1], 10);
    }
    return '';
  });
  radiusTrie.registerGreedy('key', 'Radius key', (args) => {
    const name = ctx.getRadiusServer?.();
    if (!name) return '';
    const s = sec().radiusServers.get(name);
    if (s) s.key = args.join(' ');
    return '';
  });

  tacacsTrie.registerGreedy('address', 'Tacacs address', (args) => {
    const name = ctx.getTacacsServer?.();
    if (!name) return '';
    const s = sec().tacacsServers.get(name);
    if (!s) return '';
    if (args[0] === 'ipv4' && args[1]) s.address = args[1];
    return '';
  });
  tacacsTrie.registerGreedy('key', 'Tacacs key', (args) => {
    const name = ctx.getTacacsServer?.();
    if (!name) return '';
    const s = sec().tacacsServers.get(name);
    if (s) s.key = args.join(' ');
    return '';
  });

  aaaGroupTrie.registerGreedy('server', 'Add server', (args) => {
    const name = ctx.getAaaGroup?.();
    if (!name) return '';
    const g = sec().aaaGroups.get(name);
    if (!g) return '';
    if (args[0] === 'name' && args[1]) g.members.push(args[1]);
    return '';
  });
}

function addAction(
  ctx: CiscoSecurityShellContext,
  kind: import('../../router/security/CiscoSecurityConfig').PolicyMapAction['kind'],
  args: string[],
): void {
  const pname = ctx.getPolicyMap?.();
  const cname = ctx.getPolicyClass?.();
  if (!pname || !cname) return;
  const sec = getSecurityConfig(ctx.r());
  const pm = sec.policyMaps.get(pname);
  if (!pm) return;
  const cls = pm.classes.find(c => c.className === cname);
  if (!cls) return;
  cls.actions.push({ kind, args });
}

function parseHourMinute(token: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(token);
  if (!m) return [0, 0];
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

const MONTH_MAP: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function parseAbsolute(args: string[]): import('../../router/security/CiscoSecurityConfig').TimeRangeAbsolute | null {
  const result: import('../../router/security/CiscoSecurityConfig').TimeRangeAbsolute = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === 'start' || args[i] === 'end') {
      const which = args[i];
      const [h, m] = parseHourMinute(args[i + 1] ?? '');
      const day = parseInt(args[i + 2] ?? '', 10);
      const month = MONTH_MAP[args[i + 3]?.toLowerCase() ?? ''] ?? 0;
      const year = parseInt(args[i + 4] ?? '', 10);
      if (isNaN(day) || isNaN(year) || month === 0) continue;
      const entry = { year, month, day, hour: h, minute: m };
      if (which === 'start') result.start = entry;
      else result.end = entry;
      i += 4;
    }
  }
  return result;
}

export function buildSecurityInterfaceCommands(trie: CommandTrie, ctx: CiscoSecurityShellContext): void {
  const sec = () => getSecurityConfig(ctx.r());

  trie.register('no ip unreachables', 'Disable ICMP unreachables', () => {
    const i = ctx.getSelectedInterface(); if (!i) return '';
    sec().ifaceFlags(i).noUnreachables = true;
    return '';
  });
  trie.register('no ip redirects', 'Disable ICMP redirects', () => {
    const i = ctx.getSelectedInterface(); if (!i) return '';
    sec().ifaceFlags(i).noRedirects = true;
    return '';
  });
  trie.register('no ip proxy-arp', 'Disable proxy-ARP', () => {
    const i = ctx.getSelectedInterface(); if (!i) return '';
    sec().ifaceFlags(i).noProxyArp = true;
    return '';
  });
  trie.registerGreedy('ip verify unicast', 'Configure uRPF', (args) => {
    const i = ctx.getSelectedInterface(); if (!i) return '';
    if (args[0] === 'reverse-path') {
      sec().ifaceFlags(i).urpf = { mode: 'strict' };
    } else if (args[0] === 'source' && args[1] === 'reachable-via' && args[2]) {
      sec().ifaceFlags(i).urpf = { mode: args[2] === 'any' ? 'loose' : 'strict' };
    }
    return '';
  });
  trie.registerGreedy('zone-member security', 'Assign zone', (args) => {
    const i = ctx.getSelectedInterface(); if (!i || !args[0]) return '';
    sec().ifaceFlags(i).zoneMember = args[0];
    return '';
  });
  trie.registerGreedy('ipv6 traffic-filter', 'Apply IPv6 ACL', (args) => {
    const i = ctx.getSelectedInterface(); if (!i || args.length < 2) return '';
    const dir = args[1] === 'out' ? 'out' : 'in';
    sec().ifaceFlags(i).ipv6TrafficFilter = { name: args[0], direction: dir };
    return '';
  });
}

export function buildSecurityShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  const sec = () => getSecurityConfig(getRouter());

  trie.register('show aaa servers', 'Display AAA servers', () => {
    const s = sec();
    const lines: string[] = [];
    for (const r of s.radiusServers.values()) {
      lines.push(`RADIUS: id ${lines.length + 1}, priority 1, host ${r.address ?? '<no address>'}, auth-port ${r.authPort}, acct-port ${r.acctPort}`);
    }
    for (const t of s.tacacsServers.values()) {
      lines.push(`TACACS+: id ${lines.length + 1}, host ${t.address ?? '<no address>'}, port ${t.port}`);
    }
    return lines.length ? lines.join('\n') : 'No AAA servers configured';
  });

  trie.register('show aaa sessions', 'Display AAA sessions', () => 'Total sessions since last reload: 0');

  trie.register('show radius statistics', 'Display Radius stats', () => {
    const s = sec();
    const lines = ['  Radius Statistics:'];
    for (const r of s.radiusServers.values()) {
      lines.push(`  Server: ${r.name} (${r.address ?? 'unconfigured'})`);
      lines.push('    Auth requests: 0, retransmits: 0, accepts: 0, rejects: 0');
      lines.push('    Acct requests: 0, retransmits: 0, responses: 0');
    }
    return lines.join('\n');
  });

  trie.register('show tacacs', 'Display TACACS', () => {
    const s = sec();
    const lines: string[] = [];
    for (const t of s.tacacsServers.values()) {
      lines.push(`Tacacs+ Server : ${t.address ?? t.name}/${t.port}`);
      lines.push('Socket opens: 0, closes: 0');
    }
    return lines.length ? lines.join('\n') : 'No TACACS+ servers configured';
  });

  trie.register('show login', 'Display login config', () => {
    const s = sec();
    const lines = ['A login delay of ' + (s.login.delay ?? 0) + ' seconds is applied.'];
    if (s.login.blockFor) {
      lines.push(`Quiet-Mode access list ${s.login.quietModeAcl ?? 'None'}`);
      lines.push(`Block-for: ${s.login.blockFor.seconds} sec, attempts ${s.login.blockFor.attempts}, within ${s.login.blockFor.withinSeconds} sec`);
    } else {
      lines.push('No login failure tracking');
    }
    return lines.join('\n');
  });

  trie.register('show login failures', 'Display login failures', () => 'Information about login failure\'s with the device\n\nNo failures recorded');

  trie.register('show crypto key mypubkey rsa', 'Show RSA keys', () => {
    const s = sec();
    if (s.cryptoKeys.length === 0) return '% No RSA key generated.';
    return s.cryptoKeys.map(k =>
      `Key name: ${k.label}\n Storage Device: not specified\n Usage: General Purpose Key\n Key is not exportable.\n Key Data:\n  ${'0'.repeat(64)}`
    ).join('\n\n');
  });

  trie.register('show ssh', 'Display SSH connections', () => 'No SSHv2 server connections running.');

  trie.register('show policy-map control-plane', 'Show CoPP policy', () => {
    const s = sec();
    const pm = s.controlPlane.servicePolicyInput;
    if (!pm) return '';
    return `Control Plane\n\n  Service-policy input: ${pm}`;
  });

  trie.registerGreedy('show parameter-map type inspect', 'Show parameter-map', () => 'parameter-map type inspect default\n  audit-trail off\n  alert on\n  max-incomplete low unlimited\n  max-incomplete high unlimited');

  trie.register('show zone security', 'Display zones', () => {
    const s = sec();
    if (s.zones.size === 0) return 'No zones configured';
    return [...s.zones.values()].map(z => `Zone: ${z.name}\n  Description: ${z.name} security zone\n  Member Interfaces:`).join('\n');
  });

  trie.register('show zone-pair security', 'Display zone-pairs', () => {
    const s = sec();
    if (s.zonePairs.size === 0) return 'No zone-pairs configured';
    return [...s.zonePairs.values()].map(zp => `Zone-pair name: ${zp.name}\n  Source-Zone: ${zp.source}  Destination-Zone: ${zp.destination}\n  service-policy ${zp.servicePolicy ?? 'not configured'}`).join('\n');
  });

  trie.register('show policy-map type inspect zone-pair', 'Show inspect policy', () => {
    const s = sec();
    return [...s.zonePairs.values()].map(zp => `policy exists on zp ${zp.name}`).join('\n');
  });

  trie.register('show ip traffic', 'IP traffic statistics', () =>
    [
      'IP statistics:',
      '  Rcvd:  0 total, 0 local destination',
      '         0 format errors, 0 checksum errors, 0 bad hop count',
      '         0 unknown protocol, 0 not a gateway, 0 security failures',
      '         0 bad options, 0 with options',
      '  Frags: 0 reassembled, 0 timeouts, 0 couldn\'t reassemble',
      '  Bcast: 0 received, 0 sent',
      '  Mcast: 0 received, 0 sent',
      '  Sent:  0 generated, 0 forwarded',
    ].join('\n')
  );

  trie.registerGreedy('show ip cef', 'Display CEF table', () => {
    if (!sec().ipCef) return 'IP CEF is not enabled';
    return 'Prefix              Next Hop             Interface\n0.0.0.0/0           drop                 Null0';
  });

  trie.registerGreedy('show policy-map interface', 'Show policy-map applied on interfaces', () => {
    const s = sec();
    const lines: string[] = [];
    for (const [iface, f] of s.interfaceFlags) {
      if (f.zoneMember) lines.push(` ${iface}\n  Zone member: ${f.zoneMember}`);
    }
    return lines.length ? lines.join('\n') : '';
  });
  trie.registerGreedy('show policy-map', 'Show policy-map', (args) => {
    const s = sec();
    const target = args[0];
    const pms = target ? [s.policyMaps.get(target)].filter((x): x is NonNullable<typeof x> => !!x) : [...s.policyMaps.values()];
    if (pms.length === 0) return '';
    const lines: string[] = [];
    for (const pm of pms) {
      lines.push(`Policy Map ${pm.name}`);
      for (const cls of pm.classes) {
        lines.push(`  Class ${cls.className}`);
        for (const a of cls.actions) lines.push(`    ${a.kind}${a.args.length ? ' ' + a.args.join(' ') : ''}`);
      }
    }
    return lines.join('\n');
  });
  trie.registerGreedy('show class-map', 'Show class-map', (args) => {
    const s = sec();
    const target = args[0];
    const cms = target ? [s.classMaps.get(target)].filter((x): x is NonNullable<typeof x> => !!x) : [...s.classMaps.values()];
    if (cms.length === 0) return '';
    return cms.map(cm => {
      const lines = [`Class Map ${cm.matchAll ? 'match-all' : 'match-any'} ${cm.name}`];
      for (const m of cm.matches) {
        if (m.kind === 'access-group-name') lines.push(`  Match access-group name ${m.value}`);
        else if (m.kind === 'access-group-num') lines.push(`  Match access-group ${m.value}`);
        else if (m.kind === 'protocol') lines.push(`  Match protocol ${m.value}`);
        else if (m.kind === 'any') lines.push('  Match any');
      }
      return lines.join('\n');
    }).join('\n');
  });
  trie.registerGreedy('show time-range', 'Show time-range', (args) => {
    const s = sec();
    const list = args[0] ? [s.timeRanges.get(args[0])].filter((x): x is NonNullable<typeof x> => !!x) : [...s.timeRanges.values()];
    if (list.length === 0) return '';
    const lines: string[] = [];
    for (const tr of list) {
      lines.push(`time-range entry: ${tr.name} (inactive)`);
      for (const p of tr.periodic) lines.push(`   periodic ${p.days} ${p.startHour}:${pad2(p.startMinute)} to ${p.endHour}:${pad2(p.endMinute)}`);
    }
    return lines.join('\n');
  });
}

function pad2(n: number): string { return n < 10 ? '0' + n : '' + n; }
