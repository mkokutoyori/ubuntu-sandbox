import { registerInfoCenterCommands } from './HuaweiInfoCenterCommands';
import { InfoCenterConfig } from '../../router/management/InfoCenterConfig';
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
import { getNtpAgent } from '../../../equipment/RouterServiceCapabilities';
import { rendreErreurVrp } from '../cli-utils';
import {
  displayNtpServiceStatus, displayNtpServiceSessions, displayNtpStatisticsPacket,
} from './huaweiNtpCommands';
import { analyserNtpVrp, appliquerNtpVrp, retirerNtpVrp } from './huaweiNtpCommands';

export interface LocalUser {
  password?: string;
  privilege?: string;
  serviceType?: string;
}

/** `display local-user` table. */
export function displayLocalUser(users: ReadonlyMap<string, LocalUser>): string {
  const head = [
    '  ----------------------------------------------------------------------',
    '  User-name                State  AuthMask  AdminLevel',
    '  ----------------------------------------------------------------------',
  ];
  const rows = users.size === 0
    ? ['  (no local users configured)']
    : [...users.entries()].map(([n, u]) =>
        `  ${n.padEnd(24)}A      ${(u.serviceType ?? '-').padEnd(9)} ${u.privilege ?? '-'}`);
  return [...head, ...rows,
    '  ----------------------------------------------------------------------',
    `  Total ${users.size} user(s)`].join('\n');
}

export function displaySshServerStatus(): string {
  return [
    'SSH version                     : 2.0',
    'SSH connection timeout          : 60 seconds',
    'SSH server key generating interval : 0 hours',
    'SSH authentication retries      : 3 times',
    'SFTP server                     : Disable',
    'STELNET server                  : Enable',
  ].join('\n');
}

export function displaySnmpSysInfo(): string {
  return [
    'The contact person for this managed node: R&D Beijing, Huawei',
    'The physical location of this node: Beijing China',
    'SNMP version running in the system: SNMPv2c SNMPv3',
  ].join('\n');
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
): void {
  const dispatch = (feature: 'stelnet' | 'telnet' | 'ssh' | 'snmp-agent' | 'ntp-service' | 'clock' | 'sflow', args: string[]) => {
    if (!getRouter) return '';
    const mgmt = getRouter().getManagementService();
    switch (feature) {
      case 'stelnet': {
        mgmt.configureStelnet(args);
        const head = (args[0] ?? '').toLowerCase();
        const verb = (args[1] ?? '').toLowerCase();
        if (head === 'server' && (verb === 'enable' || verb === 'disable')) {
          const dev = getRouter() as unknown as { _setSshServerEnabled?: (on: boolean) => void };
          dev._setSshServerEnabled?.(verb === 'enable');
        }
        break;
      }
      case 'telnet': mgmt.configureTelnet(args); break;
      case 'ssh': mgmt.configureSsh(args); break;
      case 'snmp-agent': mgmt.configureSnmp(args); break;
      case 'ntp-service': mgmt.configureNtp(args); break;
      case 'clock': mgmt.configureClock(args); break;
      case 'sflow': mgmt.configureSflow(args); break;
    }
    return '';
  };
  trie.registerGreedy('stelnet', 'STelnet configuration', (args) => dispatch('stelnet', args));
  trie.registerGreedy('telnet', 'Telnet configuration', (args) => dispatch('telnet', args));
  trie.registerGreedy('ssh', 'SSH configuration', (args) => dispatch('ssh', args));
  trie.registerGreedy('snmp-agent', 'SNMP agent configuration', (args) => dispatch('snmp-agent', args));
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
  getUsers: () => ReadonlyMap<string, LocalUser>,
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
): void {
  trie.register('display local-user', 'Display local users', () =>
    displayLocalUser(getUsers()));
  trie.registerGreedy('display ssh', 'Display SSH server status', () =>
    displaySshServerStatus());
  trie.registerGreedy('display snmp-agent', 'Display SNMP agent info', () =>
    displaySnmpSysInfo());
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
