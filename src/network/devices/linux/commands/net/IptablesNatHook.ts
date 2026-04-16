/**
 * `iptables -t nat ... -j MASQUERADE -o <iface>` hook.
 *
 * The full iptables semantics are handled by `LinuxIptablesManager`,
 * but the routing layer also needs to know which interfaces should
 * masquerade outgoing traffic. This helper inspects an iptables
 * argv and, if it matches the MASQUERADE / DNAT / SNAT POSTROUTING /
 * PREROUTING idiom, registers the interface on the supplied kernel.
 *
 * Not exposed as a `LinuxCommand`: it is a *hook* invoked alongside
 * the regular `iptables` dispatch. See `linux_gap.md` §8.6 (option 2:
 * the iptables command itself wraps both the executor call and this
 * hook).
 *
 * Extracted from `LinuxPC.handleIptablesNat`. PR 10.
 */

import type { LinuxNetKernel } from '../../LinuxNetKernel';

export function applyIptablesNatHook(net: LinuxNetKernel, args: string[]): void {
  // -t nat — only the nat table interests us
  const tIdx = args.indexOf('-t');
  const table = tIdx !== -1 ? args[tIdx + 1] : 'filter';
  if (table !== 'nat') return;

  const aIdx = args.indexOf('-A');
  const chain = aIdx !== -1 ? args[aIdx + 1] : null;
  if (chain !== 'POSTROUTING') return;

  const jIdx = args.indexOf('-j');
  const jump = jIdx !== -1 ? args[jIdx + 1] : null;

  const oIdx = args.indexOf('-o');
  const outIface = oIdx !== -1 ? args[oIdx + 1] : null;

  if (jump === 'MASQUERADE' && outIface) {
    net.addMasqueradeInterface(outIface);
  }
}
