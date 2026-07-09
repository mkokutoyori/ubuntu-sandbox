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
import type { IpXfrmContext, IpLinkOpsContext } from '../LinuxIpCommand';
import type { LinuxProfile } from '../LinuxProfile';
import type { LinuxFormatHelpers } from '../LinuxFormatHelpers';
import type { RadiusClientAgent } from '@/network/radius/RadiusClientAgent';
import type { GreAgent } from '@/network/gre/GreAgent';
import type { LinuxNetworkConfigManager } from '../LinuxNetworkConfigManager';

export interface LinuxCommandContext {
  /** Kernel-level services: VFS, users, iptables, services, processes. */
  readonly executor: LinuxCommandExecutor;

  /** Narrow façade over the L2/L3 networking stack (EndHost). */
  readonly net: LinuxNetKernel;

  /** Declared-vs-runtime network config: netplan/interfaces/NetworkManager. */
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
}
