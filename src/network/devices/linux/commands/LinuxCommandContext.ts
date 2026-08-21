/**
 * LinuxCommandContext - Narrow dependency surface passed to every
 * `LinuxCommand` implementation.
 *
 * The context intentionally exposes *only* what commands need:
 *   - `executor` for access to VFS, users, iptables, services, ...
 *   - `net` as a narrow façade over the `EndHost` L2/L3 stack
 *   - co-located L7 daemons (DNS)
 *   - the active `LinuxProfile`
 *   - formatting helpers shared across net commands
 *
 * Commands MUST NOT receive a reference to `LinuxMachine` itself — this is
 * what lets us test a command with a fake `LinuxNetKernel` and no
 * `Equipment` at all. See `linux_gap.md` §7.3.
 */

import type { LinuxCommandExecutor } from '../LinuxCommandExecutor';
import type { LinuxNetKernel } from '../LinuxNetKernel';
import type { DnsService } from '../LinuxDnsService';
import type { Bind9Service } from '../bind9/Bind9Service';
import type { IpXfrmContext, IpLinkOpsContext, IpMaddrContext } from '../LinuxIpCommand';
import type { LinuxProfile } from '../LinuxProfile';
import type { LinuxFormatHelpers } from '../LinuxFormatHelpers';
import type { RadiusClientAgent } from '@/network/radius/RadiusClientAgent';
import type { GreAgent } from '@/network/gre/GreAgent';
import type { LinuxNetworkConfigManager } from '../LinuxNetworkConfigManager';
import type { X509Certificate } from '@/network/pki/X509Certificate';
import type { SshdServerConfigSnapshot } from '@/network/protocols/ssh/server/SshdServerConfig';

export interface LinuxCommandContext {
  /** Kernel-level services: VFS, users, iptables, services, processes. */
  readonly executor: LinuxCommandExecutor;

  /** Narrow façade over the L2/L3 networking stack (EndHost). */
  readonly net: LinuxNetKernel;

  readonly netConfig: LinuxNetworkConfigManager;

  /** DNS daemon co-located with this machine (dnsmasq). */
  readonly dnsService: DnsService;

  /** BIND 9 daemon co-located with this machine (named). */
  readonly bind9: Bind9Service;

  /** XFRM SAD/SPD context for `ip xfrm` commands. */
  readonly xfrm: IpXfrmContext;

  /** Real GRE tunnel engine backing `ip tunnel` — absent on devices without GRE support. */
  readonly greAgent?: GreAgent;

  /** Virtual interface CRUD for `ip link add/delete` (veth, vlan, dummy). */
  readonly linkOps?: IpLinkOpsContext;

  /**
   * Network namespace CRUD + exec for `ip netns`. `exec` runs a nested
   * command with the namespace's own routing/ARP state swapped in, so it
   * is async even though every other `ip` subcommand is synchronous.
   */
  readonly netns?: {
    add(name: string): string;
    remove(name: string): string;
    list(): string[];
    exec(name: string, cmdLine: string): Promise<string>;
  };

  /** IPv4 multicast membership (IGMP) backing `ip maddr add/del/show`. */
  readonly maddr?: IpMaddrContext;

  /** Active machine profile (isServer, hostname, ...). */
  readonly profile: LinuxProfile;

  /** Shared formatting helpers for ping/traceroute/ifconfig output. */
  readonly fmt: LinuxFormatHelpers;

  /**
   * Backs the `radtest` CLI tool (freeradius-utils) — only present on a
   * `LinuxServer` (mirrors how the Oracle client tools are server-only).
   * A one-shot probe client, not persistent NAS configuration.
   */
  readonly radtestClient?: RadiusClientAgent;

  readonly tlsTrustAnchors: readonly X509Certificate[];

  /**
   * `update-ca-certificates` — la seule porte par laquelle un certificat
   * pose par l'operateur entre dans le magasin systeme.
   */
  readonly addTlsTrustAnchor?: (cert: X509Certificate) => void;

  /**
   * The sshd daemon's *live, cached* effective configuration — reflects
   * the last (re)load of `/etc/ssh/sshd_config`, not necessarily the
   * file's current on-disk content (real sshd only re-reads its config on
   * SIGHUP / `systemctl reload ssh`). Backs `sshd -T`.
   */
  readonly sshServerConfig: () => SshdServerConfigSnapshot;

  /**
   * Vrai quand la sortie standard de cette commande n'est pas un terminal
   * — étage suivant d'un tube, ou redirection vers un fichier. C'est le
   * `isatty(STDOUT_FILENO)` des vrais outils, que `ShellContext.isPiped`
   * offrait déjà aux commandes du grand `switch` et qui manquait ici :
   * `ip -c=auto` en dépend entièrement.
   */
  readonly outputPiped?: boolean;
}
