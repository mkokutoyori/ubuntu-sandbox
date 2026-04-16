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
import type { IpXfrmContext } from '../LinuxIpCommand';
import type { LinuxProfile } from '../LinuxProfile';
import type { LinuxFormatHelpers } from '../LinuxFormatHelpers';

export interface LinuxCommandContext {
  /** Kernel-level services: VFS, users, iptables, services, processes. */
  readonly executor: LinuxCommandExecutor;

  /** Narrow façade over the L2/L3 networking stack (EndHost). */
  readonly net: LinuxNetKernel;

  /** DNS daemon co-located with this machine (dnsmasq). */
  readonly dnsService: DnsService;

  /** XFRM SAD/SPD context for `ip xfrm` commands. */
  readonly xfrm: IpXfrmContext;

  /** Active machine profile (isServer, hostname, ...). */
  readonly profile: LinuxProfile;

  /** Shared formatting helpers for ping/traceroute/ifconfig output. */
  readonly fmt: LinuxFormatHelpers;
}
