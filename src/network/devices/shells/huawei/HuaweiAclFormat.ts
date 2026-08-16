/**
 * Rendu VRP d'une regle d'ACL.
 *
 * Ce code vivait dans `ACLEngine`, c'est-a-dire qu'une couche de
 * PRESENTATION propre a un vendeur habitait le moteur partage par tous.
 * C'est le meme melange qui avait fait cabler la numerotation Huawei
 * dans le moteur et casser les listes etendues Cisco (constat F-09) :
 * le moteur evalue, les couches vendeur presentent.
 */
import type { ACLEntry, PortSpec } from '../../router/ACLEngine';

function formatPortSpecTokens(spec: PortSpec): string[] {
  if (spec.op === 'range') return ['range', String(spec.port), String(spec.endPort ?? spec.port)];
  return [spec.op, String(spec.port)];
}

/**
 * Render a VRP `display acl` rule line — action, protocol, source/destination
 * (with wildcard), ports, and a trailing `(N matches)` once traffic has hit
 * the entry. Shared by the router and switch shells so both surfaces show
 * the same fields the engine actually evaluates on.
 */
export function formatHuaweiAclEntry(entry: ACLEntry, opts: { showCounts?: boolean } = {}): string {
  const parts: string[] = [entry.action];
  if (entry.protocol && entry.protocol !== 'ip') parts.push(entry.protocol);
  if (entry.srcIP.toString() !== '0.0.0.0') {
    parts.push('source', entry.srcIP.toString(), entry.srcWildcard.toString());
  }
  if (entry.dstIP && entry.dstWildcard && entry.dstIP.toString() !== '0.0.0.0') {
    parts.push('destination', entry.dstIP.toString(), entry.dstWildcard.toString());
  }
  if (entry.srcPortSpec) parts.push('source-port', ...formatPortSpecTokens(entry.srcPortSpec));
  if (entry.dstPortSpec) parts.push('destination-port', ...formatPortSpecTokens(entry.dstPortSpec));
  let line = parts.join(' ');
  if (opts.showCounts !== false && entry.matchCount > 0) {
    line += ` (${entry.matchCount} matche${entry.matchCount === 1 ? '' : 's'})`;
  }
  return line;
}
