import { registerInfoCenterCommands } from './HuaweiInfoCenterCommands';
import { HUAWEI_ERRORS, resolveHuaweiInterfaceName } from '../cli-utils';
import { InfoCenterConfig } from '../../router/management/InfoCenterConfig';
import {
  SSH_DEFAULT_PORT, SSH_DEFAULT_TIMEOUT_SEC, SSH_DEFAULT_AUTH_RETRIES, TELNET_DEFAULT_PORT,
  type RouterManagementService,
} from '../../router/management/RouterManagementService';
import { SSH_SERVER_IDENTIFICATION } from '../../../protocols/ssh/serverIdentification';
/**
 * HuaweiCommonSecurity — management-plane commands common to the Huawei
 * switch and router CLIs: SSH/Telnet servers, SNMP, NTP, info-center
 * (syslog), sFlow, clock timezone, DHCP(-snooping), ARP/IP source guard.
 *
 * The simulator does not model these control protocols, so the commands
 * are recognised and acknowledged (VRP returns no output on success).
 * Single source of truth + a shared registrar so HuaweiSwitchShell and
 * HuaweiVRPShell don't duplicate the wiring (DRY).
 */
import type { CommandTrie } from '../CommandTrie';
import {
  getNtpAgent, getManagementService, getSessionRegistry, getCredentialStore,
} from '../../../equipment/RouterServiceCapabilities';
import { rendreErreurVrp } from '../cli-utils';
import {
  displayNtpServiceStatus, displayNtpServiceSessions, displayNtpStatisticsPacket,
} from './huaweiNtpCommands';
import { analyserNtpVrp, appliquerNtpVrp, retirerNtpVrp } from './huaweiNtpCommands';
import {
  analyserSnmpVrp, appliquerSnmpVrp, retirerSnmpVrp, displaySnmpSysInfoVrp,
} from './huaweiSnmpCommands';
import { projectSnmpServiceOntoAgent } from '../../../snmp/snmpProjection';
import { getSnmpAgent } from '../../../equipment/RouterServiceCapabilities';
import type { SnmpService } from '../../router/management/SnmpService';

export function displayLocalUser(device: unknown): string {
  const accounts = getCredentialStore(device)?.list() ?? [];
  const head = [
    '  ----------------------------------------------------------------------',
    '  User-name                State  AuthMask  AdminLevel',
    '  ----------------------------------------------------------------------',
  ];
  const rows = accounts.length === 0
    ? ['  (no local users configured)']
    : accounts.map((a) => {
        const services = a.serviceTypes.length > 0 ? a.serviceTypes.join(',') : '-';
        return `  ${a.name.padEnd(24)}${a.disabled ? 'B' : 'A'}      ${services.padEnd(9)} ${a.privilege}`;
      });
  return [...head, ...rows,
    '  ----------------------------------------------------------------------',
    `  Total ${accounts.length} user(s)`].join('\n');
}

export function remoteAccessConfigBlocksVrp(mgmt: RouterManagementService): string[][] {
  const telnet = mgmt.getTelnet();
  const ssh = mgmt.getSsh();
  const telnetBlock = [
    ...(telnet.enabled ? ['telnet server enable'] : []),
    ...(telnet.port !== TELNET_DEFAULT_PORT ? [`telnet server port ${telnet.port}`] : []),
    ...(telnet.acl ? [`telnet server acl ${telnet.acl}`] : []),
    ...(telnet.source ? [`telnet server-source -i ${telnet.source}`] : []),
    ...(telnet.ipv6Enabled ? ['telnet ipv6 server enable'] : []),
  ];
  const stelnetBlock = [
    ...(ssh.enabled ? ['stelnet server enable'] : []),
    ...(ssh.port !== SSH_DEFAULT_PORT ? [`ssh server port ${ssh.port}`] : []),
    ...(ssh.timeout !== SSH_DEFAULT_TIMEOUT_SEC ? [`ssh server timeout ${ssh.timeout}`] : []),
    ...(ssh.retries !== SSH_DEFAULT_AUTH_RETRIES ? [`ssh server authentication-retries ${ssh.retries}`] : []),
  ];
  return [telnetBlock, stelnetBlock].filter((block) => block.length > 0);
}

export function displayTelnetServerStatusVrp(device: unknown): string {
  const telnet = getManagementService(device)?.getTelnet();
  const row = (label: string, value: string | number): string => ` ${label.padEnd(41)}:${value}`;
  const sourceIp = telnet?.source
    ? (device as { getPort?: (name: string) => { getIPAddress(): { toString(): string } | null } | undefined })
      .getPort?.(telnet.source)?.getIPAddress()?.toString()
    : undefined;
  return [
    row('TELNET IPv4 server', telnet?.enabled ? 'Enable' : 'Disable'),
    row('TELNET IPv6 server', telnet?.ipv6Enabled ? 'Enable' : 'Disable'),
    row('TELNET server port', telnet?.port ?? TELNET_DEFAULT_PORT),
    row('TELNET server source address', sourceIp ?? '0.0.0.0'),
    row('ACL4 number', telnet?.acl ?? 0),
    row('ACL6 number', 0),
  ].join('\n');
}

export function displaySshServerStatusVrp(device: unknown): string {
  const ssh = getManagementService(device)?.getSsh();
  return [
    `SSH version                     : ${SSH_SERVER_IDENTIFICATION.split('-')[1]}`,
    `SSH connection timeout          : ${ssh?.timeout ?? SSH_DEFAULT_TIMEOUT_SEC} seconds`,
    'SSH server key generating interval : 0 hours',
    `SSH authentication retries      : ${ssh?.retries ?? SSH_DEFAULT_AUTH_RETRIES} times`,
    'SFTP server                     : Disable',
    `Stelnet server                  : ${ssh?.enabled ? 'Enable' : 'Disable'}`,
  ].join('\n');
}

export function displaySshServerSessionVrp(device: unknown): string {
  const ssh = getManagementService(device)?.getSsh();
  if (!ssh?.enabled) return 'SSH server is not enabled.';
  const header = 'Conn   Ver  Idle    User       IP';
  const sessions = getSessionRegistry(device)?.list() ?? [];
  if (sessions.length === 0) return `${header}\n(none) ${ssh.version}    --      --         --`;
  const rows = sessions.map((s, i) => {
    const h = Math.floor(s.idleSeconds / 3600).toString().padStart(2, '0');
    const m = Math.floor((s.idleSeconds % 3600) / 60).toString().padStart(2, '0');
    const sec = Math.floor(s.idleSeconds % 60).toString().padStart(2, '0');
    return `${(i + 1).toString().padEnd(6)} ${ssh.version}    ${h}:${m}:${sec}  ${s.user.padEnd(10)} ${s.fromIp}`;
  });
  return [header, ...rows].join('\n');
}

export function displayNtpStatus(): string {
  return [
    ' clock status: unsynchronized',
    ' clock stratum: 16',
    ' reference clock ID: none',
    ' nominal frequency: 100.0000 Hz',
    ' actual frequency: 100.0000 Hz',
    ' clock precision: 2^18',
    ' clock offset: 0.0000 ms',
  ].join('\n');
}

export function displayDhcpSnooping(): string {
  return [
    'DHCP snooping running information :',
    ' DHCP snooping                : Enable',
    ' Static user max number       : 0',
    ' Check dhcp-giaddr            : Disable',
    ' Check dhcp-chaddr            : Disable',
  ].join('\n');
}

/**
 * Register the recognised (acknowledged) management commands shared by
 * both the switch and the router. Wired into the system-view trie of
 * each shell — single source so the list isn't duplicated (DRY).
 */
export function registerHuaweiCommonSecurity(
  trie: CommandTrie,
  getRouter?: () => { getManagementService: () => import('../../router/management/RouterManagementService').RouterManagementService },
  /**
   * L'agent NTP de la machine, quand elle n'est pas un routeur.
   *
   * Le seul chemin vers le moteur passait par `getRouter`, absent sur un
   * commutateur : ses commandes `ntp-service` retombaient donc sur le
   * `dispatch` mort du service de gestion. La CLI etait acceptee, les
   * vues rendaient une constante, et rien ne se synchronisait — le lot
   * N2 avait ferme ce defaut pour le routeur et l'avait laisse ouvert
   * ici.
   */
  getNtpAgentDirect?: () => import('../../../ntp/NtpAgent').NtpAgent | undefined,
  getSnmpServiceDirect?: () => SnmpService | undefined,
  setSystemClock?: (epochMs: number) => void,
): void {
  const resyncListeners = (): void => {
    (getRouter?.() as unknown as { _refreshSshAvailability?: () => void })._refreshSshAvailability?.();
  };
  const dispatch = (feature: 'stelnet' | 'telnet' | 'ssh' | 'ntp-service' | 'clock' | 'sflow', args: string[]) => {
    if (!getRouter) return '';
    const mgmt = getRouter().getManagementService();
    switch (feature) {
      case 'stelnet': {
        const refuse = mgmt.configureStelnet(args);
        if (refuse !== null) return HUAWEI_ERRORS.WRONG(refuse, 0);
        resyncListeners();
        break;
      }
      case 'telnet': {
        if ((args[0] ?? '').toLowerCase() === 'server-source' && args[1]?.toLowerCase() === '-i') {
          const ports = (getRouter() as unknown as { getPorts?: () => { getName(): string }[] })
            .getPorts?.().map((p) => p.getName()) ?? [];
          const named = resolveHuaweiInterfaceName(ports, args.slice(2).join(''));
          if (!named) return HUAWEI_ERRORS.WRONG(args.slice(2).join(' '), 0);
          args = ['server-source', '-i', named];
        }
        const refuse = mgmt.configureTelnet(args);
        if (refuse !== null) return HUAWEI_ERRORS.WRONG(refuse, 0);
        resyncListeners();
        break;
      }
      case 'ssh': {
        const refuse = mgmt.configureSsh(args);
        if (refuse !== null) return HUAWEI_ERRORS.WRONG(refuse, 0);
        resyncListeners();
        break;
      }
      case 'ntp-service': mgmt.configureNtp(args); break;
      case 'clock': {
        const verdict = mgmt.configureClock(args);
        if (typeof verdict === 'string') return HUAWEI_ERRORS.WRONG(args.join(' '), 0);
        if (verdict !== null) setSystemClock?.(verdict);
        break;
      }
      case 'sflow': mgmt.configureSflow(args); break;
    }
    return '';
  };
  const registerUndoForms = (
    root: string, description: string,
    forms: ReadonlyArray<readonly string[]>,
    keywords: ReadonlyArray<{ keyword: string; description: string }>,
    apply: (form: readonly string[]) => string | null,
  ): void => {
    trie.registerGreedy(`undo ${root}`, description, (args, raw) => {
      const line = raw ?? `undo ${root} ${args.join(' ')}`;
      const words = args.map((a) => a.toLowerCase());
      const form = forms.find((f) => f.length === words.length && f.every((w, i) => w === words[i]));
      if (form) {
        const refuse = apply(form);
        if (refuse !== null) return HUAWEI_ERRORS.WRONG(refuse, 0);
        resyncListeners();
        return '';
      }
      if (forms.some((f) => f.length > words.length && words.every((w, i) => w === f[i]))) {
        return HUAWEI_ERRORS.INCOMPLETE(line);
      }
      const wrongAt = words.findIndex((w, i) => !forms.some(
        (f) => f[i] === w && words.slice(0, i).every((p, j) => p === f[j])));
      const wrong = args[Math.max(wrongAt, 0)] ?? '';
      return HUAWEI_ERRORS.UNRECOGNIZED(line, line.toLowerCase().lastIndexOf(wrong.toLowerCase()));
    });
    trie.requireArgs(`undo ${root}`, 1);
    trie.addCompletionKeywords(`undo ${root}`, [...keywords]);
  };
  trie.registerGreedy('stelnet', 'STelnet configuration', (args) => dispatch('stelnet', args));
  registerUndoForms('stelnet', 'Disable the STelnet server', [['server', 'enable']],
    [{ keyword: 'server', description: 'STelnet server' }],
    (form) => getRouter().getManagementService().configureStelnet([...form], true));
  trie.registerGreedy('telnet', 'Telnet configuration', (args) => dispatch('telnet', args));
  registerUndoForms('telnet', 'Disable the Telnet server', [
    ['server', 'enable'], ['server', 'port'], ['server', 'acl'],
    ['server-source'], ['ipv6', 'server', 'enable'],
  ], [
    { keyword: 'server', description: 'Telnet server' },
    { keyword: 'server-source', description: 'Source interface of the Telnet server' },
    { keyword: 'ipv6', description: 'IPv6 Telnet server' },
  ], (form) => getRouter().getManagementService().configureTelnet([...form], true));
  trie.registerGreedy('ssh', 'SSH configuration', (args) => dispatch('ssh', args));
  registerUndoForms('ssh', 'Restore the SSH server defaults', [
    ['server', 'enable'], ['server', 'port'], ['server', 'timeout'], ['server', 'authentication-retries'],
  ], [{ keyword: 'server', description: 'SSH server' }],
  (form) => getRouter().getManagementService().configureSsh([...form], true));
  const snmpService = (): SnmpService | undefined =>
    (getRouter?.() as unknown as { getSnmpService?: () => SnmpService })?.getSnmpService?.()
    ?? getSnmpServiceDirect?.();
  const projeterSnmp = (service: SnmpService) => {
    const agent = getRouter ? getSnmpAgent(getRouter()) : undefined;
    if (agent) projectSnmpServiceOntoAgent(service, agent);
  };
  trie.registerGreedy('snmp-agent', 'SNMP agent configuration', (args, raw) => {
    const service = snmpService();
    if (!service) return '';
    const a = analyserSnmpVrp(args);
    if (a.statut === 'refus') return rendreErreurVrp(a.err, raw ?? `snmp-agent ${args.join(' ')}`);
    appliquerSnmpVrp(service, a.action);
    projeterSnmp(service);
    return '';
  });
  trie.registerGreedy('undo snmp-agent', 'Remove SNMP agent configuration', (args, raw) => {
    const service = snmpService();
    if (!service) return '';
    const a = analyserSnmpVrp(args);
    if (a.statut === 'refus') return rendreErreurVrp(a.err, raw ?? `undo snmp-agent ${args.join(' ')}`);
    retirerSnmpVrp(service, a.action);
    projeterSnmp(service);
    return '';
  });
  // Lot N2 : `ntp-service` ecrivait dans le service de gestion — pour
  // `unicast-server`, dans un simple sac de chaines brutes — tandis que
  // les vues lisaient le `NtpAgent`. Aucune commande NTP tapee sur un
  // Huawei n'atteignait donc le moteur. Elle l'atteint.
  trie.registerGreedy('ntp-service', 'NTP service configuration', (args, raw) => {
    const agent = (getRouter && getNtpAgent(getRouter())) ?? getNtpAgentDirect?.();
    if (!agent) return dispatch('ntp-service', args);
    const a = analyserNtpVrp(args);
    if (a.statut === 'refus') return rendreErreurVrp(a.err, raw ?? `ntp-service ${args.join(' ')}`);
    appliquerNtpVrp(agent, a.action);
    return '';
  });
  trie.registerGreedy('undo ntp-service', 'Remove NTP service configuration', (args) => {
    const agent = (getRouter && getNtpAgent(getRouter())) ?? getNtpAgentDirect?.();
    if (!agent) return '';
    const a = analyserNtpVrp(args);
    if (a.statut === 'ok') retirerNtpVrp(agent, a.action);
    return '';
  });
  trie.registerGreedy('clock', 'Clock configuration', (args) => dispatch('clock', args));
  // `info-center` a maintenant son propre arbre
  // (`HuaweiInfoCenterCommands`) : un nœud glouton n'a pas de sous-arbre,
  // donc son aide ne pouvait rien descendre.
  const infoCenterDeSecours = new InfoCenterConfig();
  registerInfoCenterCommands(trie, {
    config: () => getRouter?.().getManagementService?.().getInfoCenter()
      ?? infoCenterDeSecours,
  });
  trie.registerGreedy('sflow', 'sFlow configuration', (args) => dispatch('sflow', args));
}

/** Register the shared management `display` commands. */
export function registerHuaweiCommonSecurityDisplay(
  trie: CommandTrie,
  /**
   * L'agent NTP, quand la machine en a un.
   *
   * `display ntp-service` rendait `displayNtpStatus()`, une CONSTANTE
   * sans agent : sur un commutateur la vue annoncait donc
   * `clock status: unsynchronized` quelle que soit la realite, y compris
   * apres une synchronisation reussie. Avec l'agent, ce sont les memes
   * rendus que le routeur — un seul texte pour un seul fait.
   */
  getNtpAgentDirect?: () => import('../../../ntp/NtpAgent').NtpAgent | undefined,
  getSnmpServiceDirect?: () => SnmpService | undefined,
  getDevice?: () => unknown,
): void {
  trie.register('display local-user', 'Display local users', () =>
    displayLocalUser(getDevice?.()));
  trie.register('display telnet server status', 'Display Telnet server status', () =>
    displayTelnetServerStatusVrp(getDevice?.()));
  trie.register('display ssh server status', 'Display SSH server status', () =>
    displaySshServerStatusVrp(getDevice?.()));
  trie.register('display ssh server session', 'Display SSH server sessions', () =>
    displaySshServerSessionVrp(getDevice?.()));
  trie.registerGreedy('display snmp-agent', 'Display SNMP agent info', () =>
    displaySnmpSysInfoVrp(getSnmpServiceDirect?.()));
  trie.registerGreedy('display ntp-service', 'Display NTP status', (args) => {
    const agent = getNtpAgentDirect?.();
    if (!agent) return displayNtpStatus();
    const mot = (args[0] ?? 'status').toLowerCase();
    if (mot === 'sessions') return displayNtpServiceSessions(agent);
    if (mot === 'statistics') return displayNtpStatisticsPacket(agent);
    return displayNtpServiceStatus(agent);
  });
  trie.registerGreedy('display dhcp', 'Display DHCP snooping', () =>
    displayDhcpSnooping());
}
