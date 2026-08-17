/**
 * Rendu VRP d'une regle d'ACL.
 *
 * Ce code vivait dans `ACLEngine`, c'est-a-dire qu'une couche de
 * PRESENTATION propre a un vendeur habitait le moteur partage par tous.
 * C'est le meme melange qui avait fait cabler la numerotation Huawei
 * dans le moteur et casser les listes etendues Cisco (constat F-09) :
 * le moteur evalue, les couches vendeur presentent.
 */
import type { AccessList, ACLEntry, PortSpec } from '../../router/ACLEngine';

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
  if (entry.protocol) parts.push(entry.protocol);
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

/**
 * L'en-tete d'une liste, tel que VRP l'ecrit.
 *
 * Le type venait du NUMERO (`num >= 3000`) et le pas etait ecrit « 5 » en
 * dur, sur les DEUX plateformes et dans DEUX rendus differents. Ici il y
 * en a un seul, et il lit ce que la liste porte.
 */
export function formatHuaweiAclHeader(acl: AccessList, pasParDefaut: number): string[] {
  const type = acl.type === 'extended' ? 'Advanced' : 'Basic';
  const label = acl.name ?? String(acl.id ?? '');
  const lignes = [`${type} ACL ${label}, ${acl.entries.length} rule(s)`];
  if (acl.description) lignes.push(`Acl's description is "${acl.description}"`);
  lignes.push(`ACL's step is ${acl.step ?? pasParDefaut}`);
  return lignes;
}

/**
 * Les lignes de regles, numerotees par leur VRAIE sequence. Les deux
 * rendus les numerotaient par `index * 5` calcule a l'affichage, donc par
 * un nombre qui n'etait celui d'aucun magasin et changeait a chaque
 * insertion.
 */
export function formatHuaweiAclRules(
  acl: AccessList, opts: { showCounts?: boolean } = {},
): string[] {
  return acl.entries.map((e) => ` rule ${e.sequence ?? 0} ${formatHuaweiAclEntry(e, opts)}`);
}

/** La vue complete d'une liste : en-tete puis regles. */
export function formatHuaweiAcl(acl: AccessList, pasParDefaut: number): string {
  return [...formatHuaweiAclHeader(acl, pasParDefaut), ...formatHuaweiAclRules(acl)].join('\n');
}

/**
 * La forme CONFIGURATION d'une liste — ce que `display this` doit rendre.
 * Elle etait un ECHO du texte tape, stocke a cote du moteur : la meme
 * regle y portait un autre numero que dans la vue operationnelle.
 */
export function formatHuaweiAclConfig(acl: AccessList, pasParDefaut: number): string[] {
  const kind = acl.type === 'extended' ? 'advanced' : 'basic';
  const label = acl.name ?? String(acl.id ?? '');
  const lignes = [`acl ${kind} ${label}`];
  if (acl.step !== undefined && acl.step !== pasParDefaut) lignes.push(` step ${acl.step}`);
  if (acl.description) lignes.push(` description ${acl.description}`);
  lignes.push(...formatHuaweiAclRules(acl, { showCounts: false }));
  return lignes;
}
