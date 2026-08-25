import type { SnmpService, SnmpAccess, SnmpVersion } from '../../router/management/SnmpService';
import type { ErreurGrammaireVrp } from '../cli-utils';
import { isValidIPv4 } from '../../../core/ip';

export type ActionSnmpVrp =
  | { quoi: 'community'; nom: string; acces: SnmpAccess; vue?: string; acl?: string; alias?: string }
  | { quoi: 'contact'; texte: string }
  | { quoi: 'location'; texte: string }
  | { quoi: 'versions'; versions: SnmpVersion[] }
  | { quoi: 'target-host'; hote: string; communaute: string; version: SnmpVersion }
  | { quoi: 'trap-source'; nom: string }
  | { quoi: 'engine-id'; id: string }
  | { quoi: 'trap-enable'; fonction?: string }
  | { quoi: 'mib-view'; vue: string; oid: string; type: 'included' | 'excluded' }
  | { quoi: 'brut'; ligne: string }
  | { quoi: 'enable' };

export type AnalyseSnmpVrp =
  | { statut: 'ok'; action: ActionSnmpVrp }
  | { statut: 'refus'; err: ErreurGrammaireVrp };

const refus = (err: ErreurGrammaireVrp): AnalyseSnmpVrp => ({ statut: 'refus', err });
const mauvais = (token: string) => refus({ kind: 'wrong', token });
const incomplet = () => refus({ kind: 'incomplete' });
const ok = (action: ActionSnmpVrp): AnalyseSnmpVrp => ({ statut: 'ok', action });

const VERSIONS: Readonly<Record<string, SnmpVersion>> = Object.freeze({
  v1: '1', v2c: '2c', v3: '3',
});

function queueCommunity(nom: string, acces: SnmpAccess, reste: readonly string[]): AnalyseSnmpVrp {
  let vue: string | undefined;
  let acl: string | undefined;
  let alias: string | undefined;
  for (let i = 0; i < reste.length; i++) {
    const mot = reste[i].toLowerCase();
    if (mot === 'mib-view') {
      if (!reste[i + 1]) return incomplet();
      if (vue !== undefined) return mauvais(reste[i]);
      vue = reste[i + 1]; i++; continue;
    }
    if (mot === 'acl') {
      if (!reste[i + 1]) return incomplet();
      if (acl !== undefined) return mauvais(reste[i]);
      acl = reste[i + 1]; i++; continue;
    }
    if (mot === 'alias') {
      if (!reste[i + 1]) return incomplet();
      if (alias !== undefined) return mauvais(reste[i]);
      alias = reste[i + 1]; i++; continue;
    }
    return mauvais(reste[i]);
  }
  return ok({ quoi: 'community', nom, acces, vue, acl, alias });
}

function community(reste: readonly string[]): AnalyseSnmpVrp {
  if (!reste[0]) return incomplet();
  const droit = reste[0].toLowerCase();
  if (droit !== 'read' && droit !== 'write') return mauvais(reste[0]);
  const acces: SnmpAccess = droit === 'write' ? 'rw' : 'ro';
  if (!reste[1]) return incomplet();
  if (reste[1].toLowerCase() === 'cipher') {
    if (!reste[2]) return incomplet();
    return queueCommunity(reste[2], acces, reste.slice(3));
  }
  return queueCommunity(reste[1], acces, reste.slice(2));
}

function sysInfo(reste: readonly string[]): AnalyseSnmpVrp {
  if (!reste[0]) return incomplet();
  const quoi = reste[0].toLowerCase();
  if (quoi === 'contact') {
    if (!reste[1]) return incomplet();
    return ok({ quoi: 'contact', texte: reste.slice(1).join(' ') });
  }
  if (quoi === 'location') {
    if (!reste[1]) return incomplet();
    return ok({ quoi: 'location', texte: reste.slice(1).join(' ') });
  }
  if (quoi === 'version') {
    if (!reste[1]) return incomplet();
    if (reste[1].toLowerCase() === 'all') {
      if (reste[2]) return mauvais(reste[2]);
      return ok({ quoi: 'versions', versions: ['1', '2c', '3'] });
    }
    const versions: SnmpVersion[] = [];
    for (const mot of reste.slice(1)) {
      const v = VERSIONS[mot.toLowerCase()];
      if (!v) return mauvais(mot);
      if (!versions.includes(v)) versions.push(v);
    }
    return ok({ quoi: 'versions', versions });
  }
  return mauvais(reste[0]);
}

function targetHost(reste: readonly string[], args: readonly string[]): AnalyseSnmpVrp {
  if (!reste[0]) return incomplet();
  const forme = reste[0].toLowerCase();
  if (forme === 'trap-hostname' || forme === 'trap-paramsname') {
    if (!reste[1]) return incomplet();
    return ok({ quoi: 'brut', ligne: args.join(' ') });
  }
  if (forme !== 'trap') return mauvais(reste[0]);
  if (!reste[1]) return incomplet();
  if (reste[1].toLowerCase() !== 'address') return mauvais(reste[1]);
  if (!reste[2]) return incomplet();
  if (reste[2].toLowerCase() !== 'udp-domain') return mauvais(reste[2]);
  if (!reste[3]) return incomplet();
  if (!isValidIPv4(reste[3])) return mauvais(reste[3]);
  const hote = reste[3];
  let communaute: string | undefined;
  let version: SnmpVersion = '1';
  for (let i = 4; i < reste.length; i++) {
    const mot = reste[i].toLowerCase();
    if (mot === 'params') {
      if (!reste[i + 1]) return incomplet();
      if (reste[i + 1].toLowerCase() !== 'securityname') return mauvais(reste[i + 1]);
      if (!reste[i + 2]) return incomplet();
      communaute = reste[i + 2]; i += 2; continue;
    }
    if (mot === 'udp-port') {
      if (!reste[i + 1]) return incomplet();
      i++; continue;
    }
    const v = VERSIONS[mot];
    if (v) { version = v; continue; }
    return mauvais(reste[i]);
  }
  if (communaute === undefined) return incomplet();
  return ok({ quoi: 'target-host', hote, communaute, version });
}

const SANS_MOTEUR = Object.freeze([
  'group', 'usm-user', 'packet', 'notification-log', 'acl', 'extend',
]);

/**
 * Les noms de sous-arbre que VRP accepte a la place d'un OID. La liste
 * est celle des vues par defaut de VRP — `internet` et les trois MIB de
 * l'administration SNMPv3 — plus `iso`, la racine.
 */
const SOUS_ARBRES: Readonly<Record<string, string>> = Object.freeze({
  iso: '1',
  internet: '1.3.6.1',
  mib_2: '1.3.6.1.2.1',
  'mib-2': '1.3.6.1.2.1',
  system: '1.3.6.1.2.1.1',
  interfaces: '1.3.6.1.2.1.2',
  snmpvacmmib: '1.3.6.1.6.3.16',
  snmpusmmib: '1.3.6.1.6.3.15',
  snmpcommunitymib: '1.3.6.1.6.3.18',
});

function sousArbre(token: string): string | null {
  if (/^\d+(\.\d+)*$/.test(token)) return token;
  return SOUS_ARBRES[token.toLowerCase()] ?? null;
}

/**
 * `snmp-agent mib-view { included | excluded } <vue> <sous-arbre>` et sa
 * forme jumelle `<vue> { include | exclude } <sous-arbre>` : les deux
 * sont attestees, et VRP les traite comme une seule commande.
 */
function mibView(reste: readonly string[]): AnalyseSnmpVrp {
  const typeDe = (mot: string): 'included' | 'excluded' | null => {
    const m = mot.toLowerCase();
    if (m === 'included' || m === 'include') return 'included';
    if (m === 'excluded' || m === 'exclude') return 'excluded';
    return null;
  };

  if (reste.length === 0) return incomplet();
  const premier = typeDe(reste[0]);
  const vue = premier === null ? reste[0] : reste[1];
  const type = premier ?? (reste[1] === undefined ? null : typeDe(reste[1]));
  const cible = reste[2];

  if (vue === undefined || type === null && reste[1] === undefined) return incomplet();
  if (type === null) return mauvais(reste[1]);
  if (cible === undefined) return incomplet();
  if (reste.length > 3) return mauvais(reste[3]);

  const oid = sousArbre(cible);
  if (oid === null) return mauvais(cible);
  return ok({ quoi: 'mib-view', vue, oid, type });
}

function trap(reste: readonly string[], args: readonly string[]): AnalyseSnmpVrp {
  if (!reste[0]) return incomplet();
  const quoi = reste[0].toLowerCase();
  if (quoi === 'source') {
    if (!reste[1]) return incomplet();
    return ok({ quoi: 'trap-source', nom: reste[1] });
  }
  if (quoi === 'enable') {
    if (!reste[1]) return ok({ quoi: 'trap-enable' });
    if (reste[1].toLowerCase() !== 'feature-name') return mauvais(reste[1]);
    if (!reste[2]) return incomplet();
    return ok({ quoi: 'trap-enable', fonction: reste[2].toLowerCase() });
  }
  if (quoi === 'ip' || quoi === 'source-port') return ok({ quoi: 'brut', ligne: args.join(' ') });
  return mauvais(reste[0]);
}

function protocole(reste: readonly string[], args: readonly string[]): AnalyseSnmpVrp {
  if (!reste[0]) return incomplet();
  const quoi = reste[0].toLowerCase();
  if (quoi !== 'source-interface' && quoi !== 'version') return mauvais(reste[0]);
  if (!reste[1]) return incomplet();
  return ok({ quoi: 'brut', ligne: args.join(' ') });
}

export function analyserSnmpVrp(args: readonly string[]): AnalyseSnmpVrp {
  if (args.length === 0) return ok({ quoi: 'enable' });
  const tete = args[0].toLowerCase();
  const reste = args.slice(1);
  switch (tete) {
    case 'community': return community(reste);
    case 'sys-info': return sysInfo(reste);
    case 'target-host': return targetHost(reste, args);
    case 'trap': return trap(reste, args);
    case 'protocol': return protocole(reste, args);
    case 'trap-source':
      if (!reste[0]) return incomplet();
      return ok({ quoi: 'trap-source', nom: reste[0] });
    case 'local-engineid':
      if (!reste[0]) return incomplet();
      return ok({ quoi: 'engine-id', id: reste[0] });
    default:
      if (tete === 'mib-view') return mibView(reste);
      if (SANS_MOTEUR.includes(tete)) {
        if (!reste[0]) return incomplet();
        return ok({ quoi: 'brut', ligne: args.join(' ') });
      }
      return mauvais(args[0]);
  }
}

export function appliquerSnmpVrp(service: SnmpService, action: ActionSnmpVrp): void {
  switch (action.quoi) {
    case 'community':
      service.setCommunity({
        name: action.nom, access: action.acces, view: action.vue, aclName: action.acl,
      });
      break;
    case 'contact': service.setContact(action.texte); break;
    case 'location': service.setLocation(action.texte); break;
    case 'versions': service.setVersions(action.versions); break;
    case 'target-host':
      service.setTrapHost(action.hote, action.communaute, action.version);
      break;
    case 'trap-source': service.setTrapSourceInterface(action.nom); break;
    case 'engine-id': service.setEngineId(action.id); break;
    case 'trap-enable': service.enableTrap(action.fonction); break;
    case 'mib-view': service.setMibViewEntry(action.vue, action.oid, action.type); break;
    case 'brut': service.recordVrpLine(action.ligne); break;
    case 'enable': service.enable(); break;
  }
}

export function retirerSnmpVrp(service: SnmpService, action: ActionSnmpVrp): void {
  switch (action.quoi) {
    case 'community': service.removeCommunity(action.nom); break;
    case 'contact': service.setContact(''); break;
    case 'location': service.setLocation(''); break;
    case 'versions': service.setVersions([]); break;
    case 'target-host': service.removeTrapHost(action.hote); break;
    case 'trap-source': service.setTrapSourceInterface(''); break;
    case 'engine-id': service.setEngineId(''); break;
    case 'trap-enable': service.disableTrap(action.fonction); break;
    case 'brut': service.forgetVrpLine(action.ligne); break;
    case 'enable': service.disable(); break;
  }
}

const NOM_VERSION: Readonly<Record<SnmpVersion, string>> = Object.freeze({
  '1': 'v1', '2c': 'v2c', '3': 'v3',
});

export function lignesConfigSnmpVrp(service: SnmpService | undefined): string[] {
  if (!service || !service.isEnabled()) return [];
  const lignes: string[] = [];
  for (const c of service.getCommunities()) {
    lignes.push(`snmp-agent community ${c.access === 'rw' ? 'write' : 'read'} ${c.name}`
      + (c.view ? ` mib-view ${c.view}` : '')
      + (c.aclName ? ` acl ${c.aclName}` : ''));
  }
  if (service.hasConfiguredEngineId()) {
    lignes.push(`snmp-agent local-engineid ${service.getEngineId()}`);
  }
  const versions = service.getVersions();
  if (versions.length > 0) {
    lignes.push(`snmp-agent sys-info version ${versions.map((v) => NOM_VERSION[v]).join(' ')}`);
  }
  if (service.getContact()) lignes.push(`snmp-agent sys-info contact ${service.getContact()}`);
  if (service.getLocation()) lignes.push(`snmp-agent sys-info location ${service.getLocation()}`);
  if (service.getTrapSource()) lignes.push(`snmp-agent trap source ${service.getTrapSource()}`);
  for (const h of service.getHosts()) {
    lignes.push(`snmp-agent target-host trap address udp-domain ${h.host}`
      + ` params securityname ${h.community} ${NOM_VERSION[h.version]}`);
  }
  for (const t of service.getEnabledTraps()) {
    lignes.push(t === 'all' ? 'snmp-agent trap enable' : `snmp-agent trap enable feature-name ${t}`);
  }
  for (const [nom, entrees] of service.getViews()) {
    for (const e of entrees) lignes.push(`snmp-agent mib-view ${e.type} ${nom} ${e.oid}`);
  }
  for (const l of service.getVrpLines()) lignes.push(`snmp-agent ${l}`);
  if (lignes.length === 0) lignes.push('snmp-agent');
  return lignes;
}

export function displaySnmpSysInfoVrp(service: SnmpService | undefined): string {
  const versions = service?.getVersions() ?? [];
  return [
    `The contact person for this managed node: ${service?.getContact() || '<not set>'}`,
    `The physical location of this node: ${service?.getLocation() || '<not set>'}`,
    'SNMP version running in the system: '
      + (versions.length > 0 ? versions.map((v) => `SNMP${NOM_VERSION[v]}`).join(' ') : 'SNMPv3'),
  ].join('\n');
}
