/**
 * ArpInspectionEngine — pure Dynamic ARP Inspection verdict generator.
 *
 * The decision tree mirrors Cisco IOS' DAI feature:
 *
 *   1. ARP inspection disabled on this VLAN              → pass (no-inspection)
 *   2. Ingress port is trusted                           → pass (trusted)
 *   3. Per-VLAN ARP ACL filter:
 *        - matched entry (permit / deny)                 → pass / drop
 *        - no match + static-mode filter                 → drop
 *        - no match + non-static filter                  → fall through to DHCP bindings
 *   4. Additional `validate` checks (src-mac, dst-mac, ip)
 *   5. DHCP snooping binding compare (sender-ip ↔ sender-mac ↔ ingress port ↔ vlan)
 *        - exact match                                   → pass (binding-match)
 *        - mismatch                                      → drop (binding-mismatch)
 *        - no binding for sender-ip                      → drop (binding-mismatch)
 *
 * The engine never mutates state — it returns a verdict that the
 * caller turns into counters, log lines and bus events. This keeps the
 * core deterministic and trivially unit-testable.
 */
import type {
  ArpAccessList, ArpInspectionConfig, ArpInspectionContext, ArpInspectionVerdict,
} from './types';
import type { DHCPSnoopingBinding } from '../dhcp/types';

export class ArpInspectionEngine {
  inspect(
    ctx: ArpInspectionContext,
    config: ArpInspectionConfig,
    acls: ReadonlyMap<string, ArpAccessList>,
    bindings: readonly DHCPSnoopingBinding[],
  ): ArpInspectionVerdict {
    if (!config.vlans.has(ctx.vlan)) {
      return { kind: 'pass', reason: 'no-inspection' };
    }

    if (config.trustedPorts.has(ctx.ingressPort)) {
      return { kind: 'pass', reason: 'trusted' };
    }

    const filter = config.vlanAclFilters.get(ctx.vlan);
    if (filter) {
      const acl = acls.get(filter.aclName);
      if (acl) {
        const aclVerdict = this.matchAcl(ctx, acl);
        if (aclVerdict) return aclVerdict;
      }
      if (filter.staticMode) {
        return {
          kind: 'drop', reason: 'acl-deny',
          detail: `no match in static ARP ACL '${filter.aclName}'`,
        };
      }
    }

    const validation = this.validate(ctx, config);
    if (validation) return validation;

    return this.matchBinding(ctx, bindings);
  }

  // ── private helpers ────────────────────────────────────────────────

  private matchAcl(
    ctx: ArpInspectionContext, acl: ArpAccessList,
  ): ArpInspectionVerdict | null {
    const senderIp = ctx.senderIp.toString();
    const senderMac = ctx.senderMac.toString().toLowerCase();
    for (const entry of acl.entries) {
      const ipMatch = entry.senderIp === null || entry.senderIp === senderIp;
      const macMatch = entry.senderMac === null || entry.senderMac === senderMac;
      if (ipMatch && macMatch) {
        return entry.action === 'permit'
          ? { kind: 'pass', reason: 'acl-permit' }
          : {
              kind: 'drop', reason: 'acl-deny',
              detail: `denied by '${acl.name}' rule: ${entry.raw}`,
            };
      }
    }
    return null;
  }

  private validate(
    ctx: ArpInspectionContext, config: ArpInspectionConfig,
  ): ArpInspectionVerdict | null {
    const v = config.validate;
    if (v.srcMac) {
      const ethSrc = ctx.ethSrcMac.toString().toLowerCase();
      const arpSnd = ctx.senderMac.toString().toLowerCase();
      if (ethSrc !== arpSnd) {
        return {
          kind: 'drop', reason: 'src-mac-mismatch',
          detail: `eth-src ${ethSrc} != arp sender ${arpSnd}`,
        };
      }
    }
    if (v.dstMac && ctx.operation === 'reply') {
      const ethDst = ctx.ethDstMac.toString().toLowerCase();
      const arpTgt = ctx.targetMac.toString().toLowerCase();
      if (ethDst !== arpTgt) {
        return {
          kind: 'drop', reason: 'dst-mac-mismatch',
          detail: `eth-dst ${ethDst} != arp target ${arpTgt}`,
        };
      }
    }
    if (v.ip) {
      const bad = (ip: string): boolean =>
        ip === '0.0.0.0' || ip === '255.255.255.255' ||
        ip.startsWith('224.') || ip.startsWith('225.') ||
        ip.startsWith('226.') || ip.startsWith('227.') ||
        ip.startsWith('228.') || ip.startsWith('229.') ||
        ip.startsWith('230.') || ip.startsWith('231.') ||
        ip.startsWith('232.') || ip.startsWith('233.') ||
        ip.startsWith('234.') || ip.startsWith('235.') ||
        ip.startsWith('236.') || ip.startsWith('237.') ||
        ip.startsWith('238.') || ip.startsWith('239.');
      const sIp = ctx.senderIp.toString();
      const tIp = ctx.targetIp.toString();
      if (bad(sIp) || (ctx.operation === 'reply' && bad(tIp))) {
        return {
          kind: 'drop', reason: 'invalid-ip',
          detail: `invalid IP in ARP (sender=${sIp}, target=${tIp})`,
        };
      }
    }
    return null;
  }

  private matchBinding(
    ctx: ArpInspectionContext, bindings: readonly DHCPSnoopingBinding[],
  ): ArpInspectionVerdict {
    const senderIp = ctx.senderIp.toString();
    const senderMac = ctx.senderMac.toString().toLowerCase();
    for (const b of bindings) {
      if (b.ipAddress !== senderIp) continue;
      const bMac = b.macAddress.toLowerCase();
      if (bMac !== senderMac) {
        return {
          kind: 'drop', reason: 'binding-mismatch',
          detail: `binding has ${bMac} for ${senderIp}, frame says ${senderMac}`,
        };
      }
      if (b.vlan !== ctx.vlan) {
        return {
          kind: 'drop', reason: 'binding-mismatch',
          detail: `binding vlan ${b.vlan} != ingress vlan ${ctx.vlan}`,
        };
      }
      if (b.port !== ctx.ingressPort) {
        return {
          kind: 'drop', reason: 'binding-mismatch',
          detail: `binding port ${b.port} != ingress port ${ctx.ingressPort}`,
        };
      }
      return { kind: 'pass', reason: 'binding-match' };
    }
    return {
      kind: 'drop', reason: 'binding-mismatch',
      detail: `no DHCP snooping binding for ${senderIp} on ${ctx.ingressPort}`,
    };
  }
}
