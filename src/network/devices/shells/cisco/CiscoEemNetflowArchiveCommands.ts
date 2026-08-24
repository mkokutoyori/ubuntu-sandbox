import type { Router } from '../../Router';
import { CommandTrie } from '../CommandTrie';
import type { CiscoShellContext, CiscoShellMode } from './CiscoConfigCommands';
import { buildArchiveSubmodeOn, buildArchiveLogSubmodeOn } from './CiscoArchiveCommands';
import type { CommandSpec } from '@/cli/CommandTable';
import type { ArgumentSpec } from '@/cli/ArgumentTypes';
import type { AdapterKeyword } from '@/cli/commands/trieAdapter';
import { specsFromTrieRegistrations } from '@/cli/commands/trieAdapter';
import { CISCO_ERRORS } from '../cli-utils';
import { MODES_INTERFACE } from './CiscoConfigCommands';

/** Les niveaux qu'EEM accepte derrière `priority` : l'indice EST la sévérité. */
const EEM_SEVERITES: readonly string[] = [
  'emergencies', 'alerts', 'critical', 'errors',
  'warnings', 'notifications', 'informational', 'debugging',
];

export interface CiscoEemNetflowArchiveContext extends CiscoShellContext {
  setApplet?(name: string | null): void;
  getApplet?(): string | null;
  setFlowExporter?(name: string | null): void;
  getFlowExporter?(): string | null;
  setFlowRecord?(name: string | null): void;
  getFlowRecord?(): string | null;
  setFlowMonitor?(name: string | null): void;
  getFlowMonitor?(): string | null;
  syncNetflowAgent?(): void;
}

export function buildEemNetflowArchiveConfigCommands(
  trie: CommandTrie, ctx: CiscoEemNetflowArchiveContext,
): void {
  const eem = () => ctx.r().getEemService();
  const nf = () => ctx.r().getNetflowService();
  const ar = () => ctx.r().getArchiveService();

  trie.registerGreedy('event manager applet', 'EEM applet', (args) => {
    if (!args[0]) return '% Incomplete command.';
    const applet = eem().ensureApplet(args[0]);
    for (let i = 1; i < args.length; i++) {
      if (args[i] === 'authorization' && args[i + 1]) { applet.authorization = args[i + 1]; i++; }
    }
    ctx.setApplet?.(args[0]);
    ctx.setMode('config-applet' as CiscoShellMode);
    return '';
  });
  trie.registerGreedy('no event manager applet', 'Remove EEM applet', (args) => {
    if (args[0]) eem().removeApplet(args[0]);
    return '';
  });
  trie.registerGreedy('event manager environment', 'EEM environment variable', (args) => {
    if (args[0] && args[1] !== undefined) eem().setEnvironment(args[0], args.slice(1).join(' '));
    return '';
  });

  trie.registerGreedy('flow exporter', 'Define a Flexible NetFlow exporter', (args) => {
    if (!args[0]) return '% Incomplete command.';
    nf().ensureExporter(args[0]);
    ctx.setFlowExporter?.(args[0]);
    ctx.setMode('config-flow-exporter' as CiscoShellMode);
    return '';
  });
  trie.registerGreedy('flow record', 'Define a Flexible NetFlow record', (args) => {
    if (!args[0]) return '% Incomplete command.';
    nf().ensureRecord(args[0]);
    ctx.setFlowRecord?.(args[0]);
    ctx.setMode('config-flow-record' as CiscoShellMode);
    return '';
  });
  trie.registerGreedy('flow monitor', 'Define a Flexible NetFlow monitor', (args) => {
    if (!args[0]) return '% Incomplete command.';
    nf().ensureMonitor(args[0]);
    ctx.setFlowMonitor?.(args[0]);
    ctx.setMode('config-flow-monitor' as CiscoShellMode);
    return '';
  });

  trie.registerGreedy('ip flow-export', 'Legacy NetFlow export', (args) => {
    if (args[0] === 'destination' && args[1] && args[2]) {
      nf().setLegacyDestination(args[1], parseInt(args[2], 10));
    } else if (args[0] === 'source' && args[1]) {
      nf().setLegacySource(args[1]);
    } else if (args[0] === 'version' && args[1]) {
      nf().setLegacyVersion(parseInt(args[1], 10));
    }
    ctx.syncNetflowAgent?.();
    return '';
  });
  trie.registerGreedy('ip flow-cache', 'NetFlow cache timeout', (args) => {
    if (args[0] === 'timeout' && args[1] === 'active' && args[2]) {
      nf().setLegacyCacheActiveMin(parseInt(args[2], 10));
    } else if (args[0] === 'timeout' && args[1] === 'inactive' && args[2]) {
      nf().setLegacyCacheInactiveSec(parseInt(args[2], 10));
    }
    ctx.syncNetflowAgent?.();
    return '';
  });
  trie.register('ip route-cache flow', 'Enable NetFlow on all interfaces', () => '');

  trie.register('archive', 'Enter archive configuration', () => {
    ctx.setMode('config-archive' as CiscoShellMode);
    return '';
  });
  void ar;
}

export function buildEemAppletSubmode(trie: CommandTrie, ctx: CiscoEemNetflowArchiveContext): void {
  const get = () => {
    const name = ctx.getApplet?.();
    return name ? ctx.r().getEemService().ensureApplet(name) : null;
  };
  trie.registerGreedy('description', 'Applet description', (args) => {
    const a = get(); if (a) a.description = args.join(' ');
    return '';
  });
  trie.registerGreedy('event syslog', 'Syslog trigger', (args) => {
    const a = get(); if (!a) return '';
    if (args[0]?.toLowerCase() === 'pattern' && args[1]) {
      a.triggers.push({ kind: 'syslog', pattern: stripQuotes(args.slice(1).join(' ')) });
    }
    return '';
  });
  trie.registerGreedy('event timer', 'Timer trigger', (args) => {
    const a = get(); if (!a) return '';
    if (args[0]?.toLowerCase() === 'cron') {
      const idx = args.indexOf('cron-entry');
      if (idx >= 0 && args[idx + 1]) {
        a.triggers.push({ kind: 'timer.cron', cronEntry: stripQuotes(args.slice(idx + 1).join(' ')) });
      }
    } else if (args[0]?.toLowerCase() === 'watchdog' && args[1] === 'time' && args[2]) {
      a.triggers.push({ kind: 'timer.watchdog', intervalSec: parseInt(args[2], 10) });
    } else if (args[0]?.toLowerCase() === 'countdown' && args[1] === 'time' && args[2]) {
      a.triggers.push({ kind: 'timer.countdown', intervalSec: parseInt(args[2], 10) });
    }
    return '';
  });
  trie.registerGreedy('event snmp', 'SNMP trigger', (args) => {
    const a = get(); if (!a) return '';
    let oid = '', op = 'eq', value = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === 'oid' && args[i + 1]) { oid = args[i + 1]; i++; }
      else if (args[i] === 'get-type' && args[i + 1]) { op = args[i + 1]; i++; }
      else if (args[i] === 'entry-val' && args[i + 1]) { value = args[i + 1]; i++; }
    }
    if (oid) a.triggers.push({ kind: 'snmp-object', oid, op, value });
    return '';
  });
  trie.registerGreedy('event snmp-notification', 'SNMP-notification trigger', (args) => {
    const a = get(); if (!a) return '';
    if (args[0] === 'oid' && args[1]) a.triggers.push({ kind: 'snmp-notification', oid: args[1] });
    return '';
  });
  trie.registerGreedy('event cli', 'CLI trigger', (args) => {
    const a = get(); if (!a) return '';
    if (args[0]?.toLowerCase() === 'pattern' && args[1]) {
      a.triggers.push({ kind: 'cli', pattern: stripQuotes(args.slice(1).join(' ')) });
    }
    return '';
  });
  trie.registerGreedy('event none', 'No-event trigger', () => {
    const a = get(); if (a) a.triggers.push({ kind: 'none' });
    return '';
  });
  trie.registerGreedy('action', 'Applet action', (args) => {
    const a = get(); if (!a || !args[0]) return '';
    const id = args[0];
    const kind = args[1]?.toLowerCase();
    if (kind === 'cli' && args[2] === 'command') {
      a.actions.push({ id, kind: 'cli', command: stripQuotes(args.slice(3).join(' ')) });
    } else if (kind === 'syslog') {
      // `action <id> syslog [priority <niveau>] msg "<texte>"`.
      //
      // Seule la forme sans `priority` était analysée ; celle du
      // tutoriel, avec, tombait dans le `return ''` final et l'action
      // n'était PAS enregistrée — l'applet se déclenchait avec zéro
      // action et n'écrivait rien. `EemAction` portait déjà le champ
      // `severity` que personne ne remplissait.
      let i = 2;
      let severity: number | undefined;
      if (args[i]?.toLowerCase() === 'priority') {
        const niveau = EEM_SEVERITES.indexOf((args[i + 1] ?? '').toLowerCase());
        if (niveau < 0) return CISCO_ERRORS.INVALID_INPUT;
        severity = niveau;
        i += 2;
      }
      if (args[i] !== 'msg') return CISCO_ERRORS.INVALID_INPUT;
      const message = stripQuotes(args.slice(i + 1).join(' '));
      if (!message) return CISCO_ERRORS.INCOMPLETE;
      a.actions.push({ id, kind: 'syslog', severity, message });
    } else if (kind === 'mail') {
      const m: { to?: string; subject?: string; body?: string } = {};
      for (let i = 2; i < args.length; i++) {
        if (args[i] === 'to' && args[i + 1]) { m.to = stripQuotes(args[i + 1]); i++; }
        else if (args[i] === 'subject' && args[i + 1]) { m.subject = stripQuotes(args[i + 1]); i++; }
        else if (args[i] === 'body' && args[i + 1]) { m.body = stripQuotes(args.slice(i + 1).join(' ')); i = args.length; }
      }
      a.actions.push({ id, kind: 'mail', to: m.to ?? '', subject: m.subject ?? '', body: m.body ?? '' });
    } else if (kind === 'puts') {
      a.actions.push({ id, kind: 'puts', message: stripQuotes(args.slice(2).join(' ')) });
    } else if (kind === 'wait' && args[2]) {
      a.actions.push({ id, kind: 'wait', seconds: parseInt(args[2], 10) });
    } else if (kind === 'snmp-trap') {
      a.actions.push({ id, kind: 'snmp-trap', oid: stripQuotes(args.slice(2).join(' ')) });
    } else {
      // Une forme d'action qu'on ne sait pas lire était AVALÉE : la
      // ligne répondait comme si de rien n'était, l'applet restait sans
      // action, et rien ne le disait avant le jour où il aurait dû
      // agir. Un refus est la seule réponse honnête.
      return CISCO_ERRORS.INVALID_INPUT;
    }
    return '';
  });
  trie.registerGreedy('notify syslog contenttype', 'Notify syslog format', (args) => {
    const a = get(); if (!a) return '';
    a.notifySyslog = { content: (args[0] === 'xml' ? 'xml' : 'plaintext') };
    return '';
  });
}

export function buildFlowExporterSubmode(trie: CommandTrie, ctx: CiscoEemNetflowArchiveContext): void {
  const get = () => {
    const name = ctx.getFlowExporter?.();
    return name ? ctx.r().getNetflowService().ensureExporter(name) : null;
  };
  trie.registerGreedy('destination', 'Exporter destination', (args) => {
    const e = get(); if (e && args[0]) e.destination = args[0];
    ctx.syncNetflowAgent?.();
    return '';
  });
  trie.registerGreedy('source', 'Exporter source interface', (args) => {
    const e = get(); if (e && args[0]) e.source = args[0];
    ctx.syncNetflowAgent?.();
    return '';
  });
  trie.registerGreedy('transport udp', 'Exporter transport port', (args) => {
    const e = get(); if (e && args[0]) { e.transportProtocol = 'udp'; e.transportPort = parseInt(args[0], 10); }
    ctx.syncNetflowAgent?.();
    return '';
  });
  trie.registerGreedy('export-protocol', 'Exporter protocol', (args) => {
    const e = get();
    if (e && (args[0] === 'netflow-v9' || args[0] === 'ipfix' || args[0] === 'netflow-v5')) e.exportProtocol = args[0];
    ctx.syncNetflowAgent?.();
    return '';
  });
  trie.registerGreedy('template data timeout', 'Template timeout', (args) => {
    const e = get(); if (e && args[0]) e.templateDataTimeoutSec = parseInt(args[0], 10);
    return '';
  });
}

export function buildFlowRecordSubmode(trie: CommandTrie, ctx: CiscoEemNetflowArchiveContext): void {
  const get = () => {
    const name = ctx.getFlowRecord?.();
    return name ? ctx.r().getNetflowService().ensureRecord(name) : null;
  };
  trie.registerGreedy('match', 'Record match field', (args) => {
    const r = get(); if (r) r.matches.push(args.join(' '));
    return '';
  });
  trie.registerGreedy('collect', 'Record collect field', (args) => {
    const r = get(); if (r) r.collects.push(args.join(' '));
    return '';
  });
}

export function buildFlowMonitorSubmode(trie: CommandTrie, ctx: CiscoEemNetflowArchiveContext): void {
  const get = () => {
    const name = ctx.getFlowMonitor?.();
    return name ? ctx.r().getNetflowService().ensureMonitor(name) : null;
  };
  trie.registerGreedy('record', 'Monitor record', (args) => {
    const m = get(); if (m && args[0]) m.recordName = args[0];
    return '';
  });
  trie.registerGreedy('exporter', 'Monitor exporter', (args) => {
    const m = get(); if (m && args[0] && !m.exporterNames.includes(args[0])) m.exporterNames.push(args[0]);
    ctx.syncNetflowAgent?.();
    return '';
  });
  trie.registerGreedy('cache timeout active', 'Cache active timeout', (args) => {
    const m = get(); if (m && args[0]) m.cacheTimeoutActiveSec = parseInt(args[0], 10);
    ctx.syncNetflowAgent?.();
    return '';
  });
  trie.registerGreedy('cache timeout inactive', 'Cache inactive timeout', (args) => {
    const m = get(); if (m && args[0]) m.cacheTimeoutInactiveSec = parseInt(args[0], 10);
    ctx.syncNetflowAgent?.();
    return '';
  });
  trie.registerGreedy('cache entries', 'Cache max entries', (args) => {
    const m = get(); if (m && args[0]) m.maximumFlows = parseInt(args[0], 10);
    return '';
  });
}

// Les deux sous-modes `archive` vivent dans `CiscoArchiveCommands.ts`,
// partagés avec le switch : une seule implémentation, donc pas de
// divergence possible entre les deux plateformes.
export function buildArchiveSubmode(trie: CommandTrie, ctx: CiscoEemNetflowArchiveContext): void {
  buildArchiveSubmodeOn(trie, () => ctx.r().getArchiveService(),
    () => ctx.setMode('config-archive-log' as CiscoShellMode));
}

export function buildArchiveLogSubmode(trie: CommandTrie, ctx: CiscoEemNetflowArchiveContext): void {
  buildArchiveLogSubmodeOn(trie, () => ctx.r().getArchiveService());
}

export function netflowInterfaceSpecs(
  ctx: CiscoEemNetflowArchiveContext,
): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildEemNetflowArchiveInterfaceCommands(
      collector as unknown as CommandTrie, ctx),
    {
      modes: MODES_INTERFACE, minPrivilege: 15,
      undoFromNegatedPaths: true,
      argumentFor: (path) => path === 'ip flow monitor'
        ? [{ name: 'moniteur', type: 'WORD', description: 'Name of the flow monitor' },
          { name: 'sens', type: 'ENUM', optional: true,
            description: 'Direction the monitor watches',
            values: [
              { keyword: 'input', description: 'Ingress traffic' },
              { keyword: 'output', description: 'Egress traffic' },
            ] }]
        : null,
    },
  );
}

export function buildEemNetflowArchiveInterfaceCommands(trie: CommandTrie, ctx: CiscoEemNetflowArchiveContext): void {
  const nf = () => ctx.r().getNetflowService();
  trie.register('ip route-cache flow', 'Enable legacy NetFlow on interface', () => {
    const i = ctx.getSelectedInterface();
    if (i) nf().setLegacyInterfaceMode(i, 'ingress', true);
    ctx.syncNetflowAgent?.();
    return '';
  });
  trie.register('ip flow ingress', 'Enable ingress NetFlow', () => {
    const i = ctx.getSelectedInterface();
    if (i) nf().setLegacyInterfaceMode(i, 'ingress', true);
    ctx.syncNetflowAgent?.();
    return '';
  });
  trie.register('ip flow egress', 'Enable egress NetFlow', () => {
    const i = ctx.getSelectedInterface();
    if (i) nf().setLegacyInterfaceMode(i, 'egress', true);
    ctx.syncNetflowAgent?.();
    return '';
  });
  trie.registerGreedy('ip flow monitor', 'Attach Flexible NetFlow monitor', (args) => {
    const i = ctx.getSelectedInterface();
    if (!i || !args[0]) return '';
    const dir = args[1] === 'output' ? 'output' : 'input';
    nf().attachToInterface(i, args[0], dir);
    ctx.syncNetflowAgent?.();
    return '';
  });
}

/*
 * Un nom de reserve, d'enregistreur ou de moniteur est LIBRE : la place
 * le nomme et la vue dit elle-meme qu'elle n'a rien a montrer quand il
 * ne designe rien. `show flow monitor` accepte en plus le mot `cache`,
 * que le gestionnaire distingue d'un nom — il est donc annonce comme un
 * mot-cle, ce que `?` d'un vrai IOS fait aussi.
 */
const NETFLOW_EEM_SHOW_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  'show flow exporter': { name: 'nom', type: 'WORD', optional: true,
    description: 'Name of the Flexible NetFlow exporter' },
  'show flow record': { name: 'nom', type: 'WORD', optional: true,
    description: 'Name of the Flexible NetFlow record' },
  'show flow monitor': { name: 'nom', type: 'WORD', optional: true,
    description: 'Name of the Flexible NetFlow monitor' },
  'show ip cache flow': null,
  'show ip flow export': null,
  'event manager run': { name: 'nom', type: 'WORD', description: 'Name of the EEM policy' },
};

export function netflowEemShowSpecs(getRouter: () => Router): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildEemNetflowArchiveShowCommands(
      collector as unknown as CommandTrie, getRouter),
    {
      modes: ['user', 'privileged'], minPrivilege: 1,
      argumentFor: (path) => NETFLOW_EEM_SHOW_ARGUMENTS[path],
      keywordsFor: (path) => path === 'show flow monitor'
        ? [{ keyword: 'cache', description: 'Display the flow cache', argument: null }]
        : undefined,
    },
  );
}

export function buildEemNetflowArchiveShowCommands(trie: CommandTrie, getRouter: () => Router): void {
  trie.registerGreedy('event manager run', 'Run an EEM applet manually', (args) => {
    if (!args[0]) return '% Incomplete command.';
    if (!getRouter().getEemService().getApplet(args[0])) return `% Policy '${args[0]}' not found`;
    void getRouter().getEemEngine().runByName(args[0]).catch(() => {});
    return '';
  });
  trie.register('show event manager environment', 'Display EEM environment', () => {
    const env = getRouter().getEemService().getEnvironment();
    if (env.size === 0) return 'No EEM environment variables';
    return [...env.values()].map(e => `  ${e.name} : ${e.value}`).join('\n');
  });
  trie.register('show event manager policy registered', 'Display EEM policies', () => {
    const applets = getRouter().getEemService().listApplets();
    if (applets.length === 0) return 'No EEM policies registered';
    return applets.map(a => `  applet ${a.name}  triggers=${a.triggers.length}  actions=${a.actions.length}  hits=${a.recordTriggerCount}`).join('\n');
  });
  trie.registerGreedy('show flow exporter', 'Display Flexible NetFlow exporter', (args) => {
    const list = getRouter().getNetflowService().getExporters();
    const target = args[0];
    const items = target ? list.filter(e => e.name === target) : list;
    if (items.length === 0) return 'No flow exporters configured';
    return items.map(e => [
      `Flow Exporter ${e.name}:`,
      `  Destination IP: ${e.destination ?? 'not set'}`,
      `  Source: ${e.source ?? 'unspecified'}`,
      `  Transport: udp/${e.transportPort ?? 2055}`,
      `  Export protocol: ${e.exportProtocol ?? 'netflow-v9'}`,
    ].join('\n')).join('\n\n');
  });
  trie.registerGreedy('show flow record', 'Display Flexible NetFlow record', (args) => {
    const list = getRouter().getNetflowService().getRecords();
    const target = args[0];
    const items = target ? list.filter(r => r.name === target) : list;
    if (items.length === 0) return 'No flow records configured';
    return items.map(r => [
      `Flow Record ${r.name}:`,
      ...r.matches.map(m => `  match ${m}`),
      ...r.collects.map(c => `  collect ${c}`),
    ].join('\n')).join('\n\n');
  });
  trie.registerGreedy('show flow monitor', 'Display Flexible NetFlow monitor', (args) => {
    const list = getRouter().getNetflowService().getMonitors();
    const target = args[0]?.toLowerCase() === 'cache' ? null : args[0];
    const items = target ? list.filter(m => m.name === target) : list;
    if (items.length === 0) return 'No flow monitors configured';
    return items.map(m => [
      `Flow Monitor ${m.name}:`,
      `  Record: ${m.recordName ?? '<not set>'}`,
      `  Exporters: ${m.exporterNames.join(', ') || '<none>'}`,
      `  Cache active timeout: ${m.cacheTimeoutActiveSec ?? 1800}s`,
      `  Cache inactive timeout: ${m.cacheTimeoutInactiveSec ?? 15}s`,
      `  Maximum flows: ${m.maximumFlows ?? 4096}`,
    ].join('\n')).join('\n\n');
  });
  trie.registerGreedy('show ip cache flow', 'Display legacy NetFlow cache', () => {
    const agent = getRouter().getNetFlowAgent();
    if (!agent) return 'IP packet size distribution (0 total packets):\n  (sim: cache empty)';
    const flows = agent.listActiveFlows();
    const cfg = agent.getConfig();
    const totalPackets = flows.reduce((sum, f) => sum + f.packets, 0);
    const lines = [
      `IP packet size distribution (${totalPackets} total packets):`,
      '',
      'IP Flow Switching Cache, 278544 bytes',
      `  ${flows.length} active, 0 inactive, ${flows.length} added`,
      '  0 ager polls, 0 flow alloc failures',
      `  Active flows timeout in ${Math.max(1, Math.round(cfg.activeTimeoutSec / 60))} minutes`,
      `  Inactive flows timeout in ${cfg.inactiveTimeoutSec} seconds`,
      '',
    ];
    if (flows.length === 0) {
      lines.push('(sim: cache empty)');
      return lines.join('\n');
    }
    lines.push('SrcIPaddress    DstIPaddress    Pr SrcP DstP  Pkts');
    for (const f of flows) {
      lines.push(
        `${f.sourceIp.padEnd(15)} ${f.destinationIp.padEnd(15)} `
        + `${f.protocol.toString(16).padStart(2, '0')} `
        + `${f.sourcePort.toString(16).padStart(4, '0')} ${f.destinationPort.toString(16).padStart(4, '0')} `
        + `${String(f.packets).padStart(5)}`,
      );
    }
    return lines.join('\n');
  });
  trie.registerGreedy('show ip flow export', 'Display legacy NetFlow export', () => {
    const legacy = getRouter().getNetflowService().getLegacy();
    if (legacy.destinations.length === 0) return 'Flow export is not configured';
    const lines = ['Flow export v' + (legacy.version ?? 5) + ' is enabled'];
    for (const d of legacy.destinations) lines.push(`  Destination ${d.ip}:${d.port}`);
    if (legacy.source) lines.push(`  Source ${legacy.source}`);
    return lines.join('\n');
  });
  // `show archive` / `show archive config differences` / `archive config`
  // sont enregistrées une seule fois par `CiscoShellBase`, pour le
  // routeur ET le switch (`registerArchiveExecCommands`) — les
  // enregistrer ici aussi ferait taire l'une des deux définitions, ce que
  // `command-trie-hygiene.test.ts` interdit à juste titre.
}

function stripQuotes(s: string): string {
  const trimmed = s.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

const EEM_APPLET_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  description: {
    name: 'texte', type: 'REST', literal: 'LINE', description: 'Description of the applet',
  },
  'event syslog': [{
    name: 'critere', type: 'ENUM', description: 'What the syslog event matches',
    values: [{ keyword: 'pattern', description: 'Regular expression the message must match' }],
  }, { name: 'valeur', type: 'REST', description: 'Regular expression' }],
  'event cli': [{
    name: 'critere', type: 'ENUM', description: 'What the CLI event matches',
    values: [{ keyword: 'pattern', description: 'Regular expression the command must match' }],
  }, { name: 'valeur', type: 'REST', description: 'Regular expression' }],
  'event timer': [{
    name: 'genre', type: 'ENUM', description: 'Kind of timer',
    values: [
      { keyword: 'countdown', description: 'Fire once after the interval' },
      { keyword: 'cron', description: 'Fire on a cron schedule' },
      { keyword: 'watchdog', description: 'Fire at every interval' },
    ],
  }, { name: 'reste', type: 'REST', description: 'Timer parameters' }],
  'event none': null,
  'event snmp': { name: 'criteres', type: 'REST', description: 'OID and comparison to watch' },
  'event snmp-notification': { name: 'criteres', type: 'REST', description: 'OID to watch' },
  action: { name: 'etiquette', type: 'WORD', description: 'Label that orders the actions' },
  'notify syslog contenttype': {
    name: 'format', type: 'ENUM', description: 'Format of the syslog notification',
    values: [
      { keyword: 'plaintext', description: 'Plain text notification' },
      { keyword: 'xml', description: 'XML notification' },
    ],
  },
};

const EEM_APPLET_KEYWORDS:
Readonly<Record<string, ReadonlyArray<AdapterKeyword>>> = {
  action: [
    { keyword: 'cli', description: 'Run a CLI command', afterArguments: true },
    { keyword: 'mail', description: 'Send an e-mail', afterArguments: true },
    { keyword: 'puts', description: 'Write to the applet output', afterArguments: true },
    { keyword: 'snmp-trap', description: 'Send an SNMP trap', afterArguments: true },
    { keyword: 'syslog', description: 'Write a syslog message', afterArguments: true },
    {
      keyword: 'wait', description: 'Pause before the next action', afterArguments: true,
      argument: { name: 'secondes', type: 'INT', range: [1, 3600], description: 'Seconds to wait' },
    },
  ],
};

const FLOW_EXPORTER_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  destination: { name: 'adresse', type: 'IP_ADDR', description: 'Address of the collector' },
  source: { name: 'interface', type: 'INTERFACE', description: 'Interface whose address the packets carry' },
  'transport udp': {
    name: 'port', type: 'INT', range: [1, 65535],
    description: 'UDP port of the collector',
  },
  'export-protocol': {
    name: 'protocole', type: 'ENUM', description: 'Export protocol',
    values: [
      { keyword: 'ipfix', description: 'IPFIX (RFC 7011)' },
      { keyword: 'netflow-v5', description: 'NetFlow version 5' },
      { keyword: 'netflow-v9', description: 'NetFlow version 9' },
    ],
  },
  'template data timeout': {
    name: 'secondes', type: 'INT', range: [1, 86400],
    description: 'Seconds between template resends',
  },
};

const FLOW_MONITOR_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  record: { name: 'nom', type: 'WORD', description: 'Name of the flow record' },
  exporter: { name: 'nom', type: 'WORD', description: 'Name of the flow exporter' },
  'cache timeout active': {
    name: 'secondes', type: 'INT', range: [1, 604800],
    description: 'Seconds a flow may stay active before it is exported',
  },
  'cache timeout inactive': {
    name: 'secondes', type: 'INT', range: [1, 604800],
    description: 'Seconds of silence before a flow is exported',
  },
  'cache entries': {
    name: 'entrees', type: 'INT', range: [16, 1000000],
    description: 'Maximum number of flows the cache holds',
  },
};

export function eemAppletSpecs(ctx: CiscoEemNetflowArchiveContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildEemAppletSubmode(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-applet'], minPrivilege: 15,
      argumentFor: (path) => EEM_APPLET_ARGUMENTS[path],
      keywordsFor: (path) => EEM_APPLET_KEYWORDS[path],
    },
  );
}

export function flowExporterSpecs(ctx: CiscoEemNetflowArchiveContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildFlowExporterSubmode(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-flow-exporter'], minPrivilege: 15,
      argumentFor: (path) => FLOW_EXPORTER_ARGUMENTS[path],
    },
  );
}

const FLOW_RECORD_ARGUMENTS:
Readonly<Record<string, ArgumentSpec | readonly ArgumentSpec[] | null>> = {
  match: { name: 'champ', type: 'REST', description: 'Key field that identifies a flow' },
  collect: { name: 'champ', type: 'REST', description: 'Non-key field the record gathers' },
};

export function flowRecordSpecs(ctx: CiscoEemNetflowArchiveContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildFlowRecordSubmode(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-flow-record'], minPrivilege: 15,
      argumentFor: (path) => FLOW_RECORD_ARGUMENTS[path],
    },
  );
}

export function flowMonitorSpecs(ctx: CiscoEemNetflowArchiveContext): CommandSpec[] {
  return specsFromTrieRegistrations(
    (collector) => buildFlowMonitorSubmode(collector as unknown as CommandTrie, ctx),
    {
      modes: ['config-flow-monitor'], minPrivilege: 15,
      argumentFor: (path) => FLOW_MONITOR_ARGUMENTS[path],
    },
  );
}
