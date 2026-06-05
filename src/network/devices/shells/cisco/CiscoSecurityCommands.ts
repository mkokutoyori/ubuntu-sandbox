import type { Router } from '../../Router';
import { CommandTrie } from '../CommandTrie';
import {
  CiscoSecurityConfig,
  newRadiusServerStats,
  newTacacsServerStats,
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
  setPkiTrustpoint?(name: string | null): void;
  getPkiTrustpoint?(): string | null;
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
        stats: newRadiusServerStats(),
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
        stats: newTacacsServerStats(),
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
    let algo: 'plain' | 'md5' | 'sha256' | 'type-7' = 'md5';
    let secret: string;
    if (args[0] === '0') { algo = 'plain'; secret = args.slice(1).join(' '); }
    else if (args[0] === '5') { algo = 'md5'; secret = args.slice(1).join(' '); }
    else if (args[0] === '7') { algo = 'type-7'; secret = args.slice(1).join(' '); }
    else if (args[0] === '8' || args[0] === '9') { algo = 'sha256'; secret = args.slice(1).join(' '); }
    else if (args[0] === 'level' && /^\d+$/.test(args[1] ?? '')) { secret = args.slice(2).join(' '); }
    else { secret = args.join(' '); }
    sec().enableSecret = secret;
    const r = ctx.r() as unknown as { _setEnableSecret?: (s: string, a: 'plain' | 'md5' | 'sha256' | 'type-7') => void };
    r._setEnableSecret?.(secret, algo);
    return '';
  });

  trie.registerGreedy('enable password', 'Set enable password', (args) => {
    let algo: 'plain' | 'type-7' = 'plain';
    let password: string;
    if (args[0] === '0') { algo = 'plain'; password = args.slice(1).join(' '); }
    else if (args[0] === '7') { algo = 'type-7'; password = args.slice(1).join(' '); }
    else { password = args.join(' '); }
    sec().enableSecret = password;
    const r = ctx.r() as unknown as { _setEnablePassword?: (p: string, a: 'plain' | 'type-7') => void };
    r._setEnablePassword?.(password, algo);
    return '';
  });

  trie.registerGreedy('service password-encryption', 'Enable password encryption', () => {
    sec().servicePasswordEncryption = true;
    const r = ctx.r() as unknown as { _setServiceFlag?: (n: string, on: boolean) => void };
    r._setServiceFlag?.('password-encryption', true);
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
    const generatedAtMs = Date.now();
    sec().cryptoKeys.push({ label, modulus, general, generatedAtMs });
    const elapsedSec = Math.max(1, Math.round(modulus / 1024));
    return `The key modulus size is ${modulus} bits\n% Generating ${modulus} bit RSA keys, keys will be non-exportable...\n[OK] (elapsed time was ${elapsedSec} seconds)`;
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
  trie.registerGreedy('no ip cef', 'Disable CEF', () => { sec().ipCef = false; return ''; });

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

  trie.registerGreedy('crypto pki trustpoint', 'Declare a PKI trustpoint', (args) => {
    if (!args[0]) return '% Incomplete command.';
    sec().ensurePkiTrustpoint(args[0]);
    ctx.setPkiTrustpoint?.(args[0]);
    ctx.setMode('config-ca-trustpoint' as CiscoShellMode);
    return '';
  });

  trie.registerGreedy('no crypto pki trustpoint', 'Remove a PKI trustpoint', (args) => {
    if (!args[0]) return '% Incomplete command.';
    sec().pkiTrustpoints.delete(args[0]);
    return '';
  });

  trie.registerGreedy('crypto pki enroll', 'Enroll trustpoint', (args) => {
    const name = args[0];
    if (!name) return '% Incomplete command.';
    const tp = sec().pkiTrustpoints.get(name);
    if (!tp) return `% Trustpoint ${name} not configured`;
    return `% Start certificate enrollment for trustpoint ${name}\n% Certificate request sent to Certificate Authority`;
  });
  trie.registerGreedy('crypto pki authenticate', 'Authenticate trustpoint CA', (args) => {
    const name = args[0];
    if (!name) return '% Incomplete command.';
    const tp = sec().pkiTrustpoints.get(name);
    if (!tp) return `% Trustpoint ${name} not configured`;
    return `% Trustpoint ${name} CA certificate accepted`;
  });
  trie.registerGreedy('crypto pki import', 'Import certificate', (args) => {
    const name = args[0];
    if (!name) return '% Incomplete command.';
    const tp = sec().pkiTrustpoints.get(name);
    if (!tp) return `% Trustpoint ${name} not configured`;
    const what = args[1]?.toLowerCase();
    if (what === 'certificate' || what === 'pem') {
      (tp as unknown as { importedCertificate?: { format: string; importedAtMs: number } }).importedCertificate = {
        format: what,
        importedAtMs: Date.now(),
      };
      return `% Certificate imported into trustpoint ${name}`;
    }
    return `% Unknown import type "${what}"`;
  });

  trie.registerGreedy('parameter-map type inspect', 'Define parameter-map', (args) => {
    if (!args[0]) return '% Incomplete command.';
    sec().ensureParameterMapInspect(args[0]);
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
  trustpointTrie: CommandTrie,
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
  pmapClassTrie.registerGreedy('priority', 'Reserve bandwidth for priority', (args) => { addAction(ctx, 'priority', args); return ''; });
  pmapClassTrie.registerGreedy('bandwidth', 'Reserve bandwidth', (args) => { addAction(ctx, 'bandwidth', args); return ''; });
  pmapClassTrie.register('fair-queue', 'Enable WFQ', () => { addAction(ctx, 'fair-queue', []); return ''; });
  pmapClassTrie.register('random-detect', 'Enable WRED', () => { addAction(ctx, 'random-detect', []); return ''; });
  pmapClassTrie.registerGreedy('random-detect', 'WRED configuration', (args) => { addAction(ctx, 'random-detect', args); return ''; });
  pmapClassTrie.registerGreedy('shape', 'Traffic shape', (args) => { addAction(ctx, 'shape', args); return ''; });
  pmapClassTrie.registerGreedy('service-policy', 'Nested service-policy', (args) => { addAction(ctx, 'service-policy', args); return ''; });
  pmapClassTrie.registerGreedy('queue-limit', 'Queue depth', (args) => { addAction(ctx, 'queue-limit', args); return ''; });
  pmapClassTrie.registerGreedy('compression', 'Compression', (args) => { addAction(ctx, 'compression', args); return ''; });

  cpTrie.registerGreedy('service-policy', 'Apply policy', (args) => {
    if (args[0] === 'input' && args[1]) sec().controlPlane.servicePolicyInput = args[1];
    if (args[0] === 'output' && args[1]) sec().controlPlane.servicePolicyOutput = args[1];
    return '';
  });

  zoneTrie.registerGreedy('description', 'Zone description', (args) => {
    const name = ctx.getZone?.();
    if (!name) return '';
    const z = sec().zones.get(name);
    if (z) (z as unknown as { description?: string }).description = args.join(' ');
    return '';
  });

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

  const tp = () => {
    const name = ctx.getPkiTrustpoint?.();
    return name ? sec().pkiTrustpoints.get(name) ?? null : null;
  };
  trustpointTrie.registerGreedy('enrollment', 'Enrollment configuration', (args) => {
    const t = tp(); if (!t) return '';
    if (args[0] === 'url' && args[1]) t.enrollmentUrl = args[1];
    else if (args[0] === 'selfsigned' || args[0] === 'self-signed') t.source = 'self-signed';
    else if (args[0] === 'terminal') t.source = 'terminal';
    else if (args[0] === 'profile' && args[1]) t.source = 'scep';
    return '';
  });
  trustpointTrie.registerGreedy('subject-name', 'Set subject name', (args) => {
    const t = tp(); if (!t) return '';
    t.subjectName = args.join(' ');
    return '';
  });
  trustpointTrie.registerGreedy('revocation-check', 'Set revocation check method', (args) => {
    const t = tp(); if (!t) return '';
    const mode = args.join(' ').toLowerCase();
    if (mode === 'crl' || mode === 'none' || mode === 'ocsp' || mode === 'crl-or-ocsp' || mode === 'crl-then-ocsp') {
      t.revocationCheck = mode as 'crl' | 'none' | 'ocsp' | 'crl-or-ocsp' | 'crl-then-ocsp';
    }
    return '';
  });
  trustpointTrie.registerGreedy('rsakeypair', 'Bind RSA keypair', (args) => {
    const t = tp(); if (!t) return '';
    t.rsaKeypair = args[0];
    return '';
  });
  trustpointTrie.registerGreedy('fqdn', 'Set FQDN', (args) => {
    const t = tp(); if (!t) return '';
    t.fqdn = args[0];
    return '';
  });
  trustpointTrie.registerGreedy('ip-address', 'Set IP', (args) => {
    const t = tp(); if (!t) return '';
    t.ipAddress = args[0];
    return '';
  });
  trustpointTrie.registerGreedy('serial-number', 'Set serial number', (args) => {
    const t = tp(); if (!t) return '';
    t.serialNumber = args[0];
    return '';
  });
  trustpointTrie.registerGreedy('auto-enroll', 'Auto-enrollment', (args) => {
    const t = tp(); if (!t) return '';
    const cfg: { percent?: number; regenerate?: boolean } = {};
    for (let i = 0; i < args.length; i++) {
      const n = parseInt(args[i], 10);
      if (!isNaN(n)) cfg.percent = n;
      if (args[i] === 'regenerate') cfg.regenerate = true;
    }
    t.autoEnroll = cfg;
    return '';
  });
  trustpointTrie.registerGreedy('fingerprint', 'Set fingerprint', (args) => {
    const t = tp(); if (!t) return '';
    t.fingerprint = args.join(' ');
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
    let idx = 1;
    for (const r of s.radiusServers.values()) {
      const st = r.stats;
      lines.push(`RADIUS: id ${idx++}, priority 1, host ${r.address ?? '<no address>'}, auth-port ${r.authPort}, acct-port ${r.acctPort}`);
      lines.push(`    State: current UP, duration ${secondsSince(st.upSinceMs)}s, previous duration 0s`);
      lines.push(`    Authen: request ${st.authRequests}, timeouts ${st.authTimeouts}, retransmission ${st.authRetransmits}`);
      lines.push(`            Response: accept ${st.authAccepts}, reject ${st.authRejects}, challenge 0`);
      lines.push(`    Account: request ${st.acctRequests}, timeouts ${st.acctTimeouts}, retransmission ${st.acctRetransmits}`);
      lines.push(`            Response: ${st.acctResponses}`);
    }
    for (const t of s.tacacsServers.values()) {
      const st = t.stats;
      lines.push(`TACACS+: id ${idx++}, host ${t.address ?? '<no address>'}, port ${t.port}`);
      lines.push(`    Socket opens: ${st.socketOpens}, closes: ${st.socketCloses}, aborts: ${st.socketAborts}, errors: ${st.socketErrors}`);
      lines.push(`    Authen: request ${st.authRequests}, success ${st.authAccepts}, fail ${st.authRejects}`);
    }
    return lines.length ? lines.join('\n') : 'No AAA servers configured';
  });

  trie.register('show aaa sessions', 'Display AAA sessions', () => {
    const reg = (getRouter() as unknown as { getSshSessionRegistry?: () =>{ list: () => readonly { id: string; user: string; fromIp: string; line: string; loginAt: number }[]; history: () => readonly { id: string }[] } }).getSshSessionRegistry?.();
    if (!reg) return 'Total sessions since last reload: 0';
    const active = reg.list();
    const past = reg.history();
    const lines = [`Total sessions since last reload: ${active.length + past.length}`];
    if (active.length > 0) {
      lines.push('Session-Id Unique Id User       IP Address    Session Type');
      for (const s of active) lines.push(`${s.id.padEnd(11)}1          ${s.user.padEnd(11)}${s.fromIp.padEnd(14)}${s.line}`);
    }
    return lines.join('\n');
  });

  trie.register('show radius statistics', 'Display Radius stats', () => {
    const s = sec();
    if (s.radiusServers.size === 0) return 'No RADIUS servers configured';
    const lines = ['  Radius Statistics:'];
    for (const r of s.radiusServers.values()) {
      const st = r.stats;
      lines.push(`  Server: ${r.name} (${r.address ?? 'unconfigured'})`);
      lines.push(`    Auth requests: ${st.authRequests}, retransmits: ${st.authRetransmits}, accepts: ${st.authAccepts}, rejects: ${st.authRejects}`);
      lines.push(`    Acct requests: ${st.acctRequests}, retransmits: ${st.acctRetransmits}, responses: ${st.acctResponses}`);
    }
    return lines.join('\n');
  });

  trie.register('show tacacs', 'Display TACACS', () => {
    const s = sec();
    const lines: string[] = [];
    for (const t of s.tacacsServers.values()) {
      const st = t.stats;
      lines.push(`Tacacs+ Server : ${t.address ?? t.name}/${t.port}`);
      lines.push(`Socket opens: ${st.socketOpens}, closes: ${st.socketCloses}`);
      lines.push(`Authen: request ${st.authRequests}, success ${st.authAccepts}, fail ${st.authRejects}`);
    }
    return lines.length ? lines.join('\n') : 'No TACACS+ servers configured';
  });

  trie.register('show crypto pki trustpoints', 'PKI trustpoints', () => {
    const tps = [...sec().pkiTrustpoints.values()];
    if (tps.length === 0) return 'No trustpoints configured';
    return tps.map(tp => [
      `Trustpoint ${tp.name}:`,
      `    Subject Name: ${tp.subjectName ?? '<not configured>'}`,
      `    Enrollment URL: ${tp.enrollmentUrl ?? 'terminal'}`,
      `    Revocation Check: ${tp.revocationCheck ?? 'crl'}`,
      `    RSA Keypair: ${tp.rsaKeypair ?? '<auto>'}`,
      tp.fqdn ? `    FQDN: ${tp.fqdn}` : '',
      tp.serialNumber ? `    Serial Number: ${tp.serialNumber}` : '',
    ].filter(Boolean).join('\n')).join('\n');
  });
  trie.register('show crypto pki certificates', 'PKI certificates', () => {
    const tps = [...sec().pkiTrustpoints.values()];
    if (tps.length === 0) return 'No PKI certificates installed';
    return tps.map(tp => `Certificate (Trustpoint ${tp.name}):\n  Status: Pending enrollment`).join('\n\n');
  });

  trie.register('show login', 'Display login config', () => {
    const s = sec();
    const r = getRouter() as unknown as { getLoginBlocker?: () => { isBlocked: (ip: string) => boolean } | null };
    const blocker = r.getLoginBlocker?.();
    const lines = [`A login delay of ${s.login.delay ?? 0} seconds is applied.`];
    if (s.login.blockFor) {
      lines.push(`Quiet-Mode access list ${s.login.quietModeAcl ?? 'None'}`);
      lines.push(`Block-for: ${s.login.blockFor.seconds} sec, attempts ${s.login.blockFor.attempts}, within ${s.login.blockFor.withinSeconds} sec`);
      lines.push(`Router ${blocker ? 'NOT' : 'NOT'} enabled to watch for login attacks`);
    } else {
      lines.push('No login failure tracking');
    }
    return lines.join('\n');
  });

  trie.register('show login failures', 'Display login failures', () => {
    const r = getRouter() as unknown as { getSecurityAuditLog?: () => { entries: () => readonly { mnemonic: string; message: string; at: number }[] } | null };
    const audit = r.getSecurityAuditLog?.();
    if (!audit) return "Information about login failure's with the device\n\n*** No failures recorded ***";
    const failures = audit.entries().filter(e => e.mnemonic === 'LOGIN_FAILED');
    if (failures.length === 0) return "Information about login failure's with the device\n\n*** No failures recorded ***";
    const lines = ["Information about login failure's with the device", '', 'Username   SourceIPAddr  lPort Count  TimeStamp'];
    const groups = new Map<string, { count: number; last: number; ip: string }>();
    for (const e of failures) {
      const ip = /\[Source: ([^\]]+)\]/.exec(e.message)?.[1] ?? 'unknown';
      const user = /\[user: ([^\]]+)\]/.exec(e.message)?.[1] ?? 'unknown';
      const key = `${user}@${ip}`;
      const g = groups.get(key) ?? { count: 0, last: 0, ip };
      g.count++;
      g.last = e.at;
      groups.set(key, g);
    }
    for (const [k, g] of groups) {
      const user = k.split('@')[0];
      lines.push(`${user.padEnd(11)}${g.ip.padEnd(14)}22    ${String(g.count).padEnd(7)}${new Date(g.last).toISOString().replace('T', ' ').slice(0, 19)}`);
    }
    return lines.join('\n');
  });

  trie.register('show crypto key mypubkey rsa', 'Show RSA keys', () => {
    const s = sec();
    if (s.cryptoKeys.length === 0) return '% No RSA key generated.';
    return s.cryptoKeys.map(k => [
      `% Key pair was generated at: ${new Date(k.generatedAtMs).toISOString().replace('T', ' ').slice(0, 19)}`,
      `Key name: ${k.label}`,
      ` Storage Device: not specified`,
      ` Usage: ${k.general ? 'General Purpose' : 'Signature'} Key`,
      ` Key is not exportable.`,
      ` Key Data:`,
      ` ${rsaPublicKeyMaterial(k.label, k.modulus, k.generatedAtMs)}`,
    ].join('\n')).join('\n\n');
  });

  trie.register('show ssh', 'Display SSH connections', () => {
    const reg = (getRouter() as unknown as { getSshSessionRegistry?: () =>{ list: () => readonly { line: string; lineIndex: number; user: string; fromIp: string; loginAt: number; idleSeconds: number }[] } | null }).getSshSessionRegistry?.();
    if (!reg) return 'No SSHv2 server connections running.';
    const active = reg.list();
    if (active.length === 0) return 'No SSHv2 server connections running.';
    const header = 'Connection Version Mode Encryption           Hmac      State                 Username';
    const rows = active.map(s =>
      `${String(s.lineIndex).padEnd(11)}2.0     IN   aes256-ctr           sha256    Session started       ${s.user}`
    );
    return [header, ...rows].join('\n');
  });

  trie.register('show policy-map control-plane', 'Show CoPP policy', () => {
    const s = sec();
    const pm = s.controlPlane.servicePolicyInput;
    if (!pm) return '';
    return `Control Plane\n\n  Service-policy input: ${pm}`;
  });

  trie.registerGreedy('show parameter-map type inspect', 'Show parameter-map', (args) => {
    const s = sec();
    const all = [...s.parameterMapsInspect.values()];
    const target = args[0];
    const list = target ? all.filter(p => p.name === target) : all;
    if (list.length === 0) {
      return 'parameter-map type inspect default\n  audit-trail off\n  alert on\n  max-incomplete low unlimited\n  max-incomplete high unlimited';
    }
    return list.map(pm => [
      `parameter-map type inspect ${pm.name}`,
      `  audit-trail ${pm.auditTrail ? 'on' : 'off'}`,
      `  alert ${pm.alert !== false ? 'on' : 'off'}`,
      `  max-incomplete low ${pm.maxIncompleteLow ?? 'unlimited'}`,
      `  max-incomplete high ${pm.maxIncompleteHigh ?? 'unlimited'}`,
      `  one-minute low ${pm.oneMinuteLow ?? 'unlimited'}`,
      `  one-minute high ${pm.oneMinuteHigh ?? 'unlimited'}`,
      `  tcp idle-time ${pm.tcpIdleTimeSec ?? 3600}`,
      `  udp idle-time ${pm.udpIdleTimeSec ?? 30}`,
      `  dns-timeout ${pm.dnsTimeoutSec ?? 5}`,
    ].join('\n')).join('\n');
  });

  trie.register('show zone security', 'Display zones', () => {
    const s = sec();
    if (s.zones.size === 0) return 'No zones configured';
    return [...s.zones.values()].map(z => {
      const description = (z as unknown as { description?: string }).description ?? `${z.name} security zone`;
      const members: string[] = [];
      for (const [iface, f] of s.interfaceFlags) {
        if (f.zoneMember === z.name) members.push(`    ${iface}`);
      }
      return [
        `Zone: ${z.name}`,
        `  Description: ${description}`,
        '  Member Interfaces:',
        ...(members.length === 0 ? ['    None'] : members),
      ].join('\n');
    }).join('\n');
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

  trie.register('show ip traffic', 'IP traffic statistics', () => {
    const ports = getRouter()._getPortsInternal();
    let rxFrames = 0, txFrames = 0, errsIn = 0, errsOut = 0, dropsIn = 0, dropsOut = 0;
    for (const p of ports.values()) {
      const c = p.getCounters();
      rxFrames += c.framesIn;
      txFrames += c.framesOut;
      errsIn += c.errorsIn;
      errsOut += c.errorsOut;
      dropsIn += c.dropsIn;
      dropsOut += c.dropsOut;
    }
    return [
      'IP statistics:',
      `  Rcvd:  ${rxFrames} total, ${rxFrames} local destination`,
      `         ${errsIn} format errors, 0 checksum errors, 0 bad hop count`,
      '         0 unknown protocol, 0 not a gateway, 0 security failures',
      `         0 bad options, 0 with options, ${dropsIn} dropped`,
      '  Frags: 0 reassembled, 0 timeouts, 0 couldn\'t reassemble',
      '  Bcast: 0 received, 0 sent',
      '  Mcast: 0 received, 0 sent',
      `  Sent:  ${txFrames} generated, ${txFrames} forwarded, ${errsOut} errors, ${dropsOut} dropped`,
    ].join('\n');
  });

  trie.registerGreedy('show ip cef', 'Display CEF FIB', () => {
    if (!sec().ipCef) return 'IP CEF is not enabled';
    const router = getRouter();
    const table = router._getRoutingTableInternal();
    const lines = ['Prefix               Next Hop             Interface'];
    lines.push('0.0.0.0/0            no route');
    for (const r of table) {
      const dst = `${r.network}/${r.mask.toCIDR()}`;
      const next = r.nextHop ? r.nextHop.toString() : 'attached';
      const iface = r.iface ?? '';
      lines.push(`${dst.padEnd(21)}${next.padEnd(21)}${iface}`);
    }
    return lines.join('\n');
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

function secondsSince(ms: number): number {
  return Math.max(0, Math.floor((Date.now() - ms) / 1000));
}

function rsaPublicKeyMaterial(label: string, modulus: number, generatedAtMs: number): string {
  let h1 = 2166136261 >>> 0;
  let h2 = 0x811C9DC5 >>> 0;
  const seed = `${label}|${modulus}|${generatedAtMs}`;
  for (let i = 0; i < seed.length; i++) {
    h1 ^= seed.charCodeAt(i);
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  }
  const blocks = Math.max(4, Math.floor(modulus / 64));
  const out: string[] = [];
  for (let i = 0; i < blocks; i++) {
    h1 = Math.imul(h1 ^ (i + 1), 0x9E3779B1) >>> 0;
    h2 = Math.imul(h2 ^ (i + 1), 0xBB67AE85) >>> 0;
    out.push(h1.toString(16).padStart(8, '0').toUpperCase());
    out.push(h2.toString(16).padStart(8, '0').toUpperCase());
  }
  const hex = out.join('');
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += 64) {
    lines.push(hex.slice(i, i + 64));
  }
  return lines.join('\n  ');
}
