/**
 * DNS-SD — DNS-Based Service Discovery (RFC 6763).
 *
 * Trois enregistrements suffisent à décrire un service, et c'est tout
 * l'intérêt du protocole : rien de nouveau sur le fil, seulement une
 * convention de nommage sur des types DNS qui existaient déjà.
 *
 * - `PTR` : `_http._tcp.local` → `Mon serveur._http._tcp.local`
 *   (« quelles instances de ce type existent ? »)
 * - `SRV` : l'instance → hôte et port
 * - `TXT` : l'instance → métadonnées, une chaîne `clé=valeur` par segment
 *
 * Le nom d'instance est libre — espaces et accents compris (§4.1.1) : il
 * est fait pour être lu par un humain, pas pour être un nom d'hôte.
 */

/** Le domaine des services découverts sur le lien. */
export const DNSSD_DOMAIN = 'local';

/**
 * §9 — le méta-service qui énumère les *types* présents sur le lien.
 * Un client qui l'interroge apprend quoi chercher ensuite.
 */
export const DNSSD_ENUM_NAME = `_services._dns-sd._udp.${DNSSD_DOMAIN}`;

/** RFC 6763 §6.1 — un segment TXT est un `clé=valeur`. */
export interface ServiceRegistration {
  /** Nom lisible, libre : « Mon serveur ». */
  readonly instance: string;
  /** Type et protocole : `_http._tcp`. */
  readonly type: string;
  readonly port: number;
  readonly txt: readonly string[];
}

/** `_http._tcp` → `_http._tcp.local`. */
export function serviceTypeName(type: string, domain: string = DNSSD_DOMAIN): string {
  const t = type.toLowerCase().replace(/\.$/, '');
  return t.endsWith(`.${domain}`) ? t : `${t}.${domain}`;
}

/** `Mon serveur` + `_http._tcp` → `Mon serveur._http._tcp.local`. */
export function instanceName(
  instance: string, type: string, domain: string = DNSSD_DOMAIN,
): string {
  return `${instance}.${serviceTypeName(type, domain)}`;
}

export interface ParsedInstance {
  instance: string;
  type: string;
  domain: string;
}

/**
 * Sépare `Mon serveur._http._tcp.local` en ses trois parties.
 *
 * Le découpage part de la fin, pas du début : un nom d'instance peut
 * contenir des points (§4.1.1), alors que le type est toujours les deux
 * labels qui précèdent le domaine.
 */
export function parseInstanceName(fqdn: string): ParsedInstance | null {
  const clean = fqdn.replace(/\.$/, '');
  const labels = clean.split('.');
  if (labels.length < 4) return null;
  const domain = labels[labels.length - 1];
  const proto = labels[labels.length - 2];
  const service = labels[labels.length - 3];
  if (!service.startsWith('_') || !proto.startsWith('_')) return null;
  const instance = labels.slice(0, labels.length - 3).join('.');
  if (!instance) return null;
  return { instance, type: `${service}.${proto}`, domain };
}

/** True pour `_http._tcp.local` — un type, pas une instance. */
export function isServiceTypeName(name: string): boolean {
  const labels = name.replace(/\.$/, '').split('.');
  return labels.length === 3
    && labels[0].startsWith('_')
    && labels[1].startsWith('_');
}

/** Ce qu'une résolution de service rend à l'appelant. */
export interface ResolvedService {
  instance: string;
  type: string;
  domain: string;
  /** Le nom d'hôte qui porte le service — `alpha.local`. */
  host: string;
  port: number;
  txt: string[];
  /** Les adresses de cet hôte, quand elles ont été apprises. */
  addresses: string[];
}
