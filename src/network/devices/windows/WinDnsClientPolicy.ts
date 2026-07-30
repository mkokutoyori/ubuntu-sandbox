/**
 * La stratégie de résolution de noms multicast du client DNS Windows.
 *
 * Windows n'a pas de `resolvectl` : LLMNR et mDNS s'éteignent par la
 * base de registre, sous la clé de stratégie du client DNS. Les deux
 * valeurs sont les mêmes que celles que pose l'objet de stratégie de
 * groupe « Désactiver la résolution de noms multicast », et que celles
 * que tout guide de durcissement fait poser à la main :
 *
 *   HKLM\SOFTWARE\Policies\Microsoft\Windows NT\DNSClient
 *     EnableMulticast : REG_DWORD  0 → LLMNR éteint
 *     EnableMDNS      : REG_DWORD  0 → mDNS éteint
 *
 * L'absence de valeur vaut « activé » : c'est l'état d'un Windows sorti
 * de l'installation, et non un choix de ce simulateur. Les deux
 * protocoles écoutent donc par défaut, à l'inverse du côté Linux où
 * `resolvectl mdns <lien> yes` est nécessaire — cette asymétrie est
 * celle des deux systèmes, pas une incohérence.
 */

/**
 * Les restrictions que `Resolve-DnsName` sait poser sur l'ordre de
 * résolution. Ce sont les commutateurs réels de la cmdlet, pas une
 * invention : `-DnsOnly`, `-LlmnrOnly`, `-NoHostsFile`, `-CacheOnly`.
 */
export interface DnsClientQueryOptions {
  /** N'interroge pas le lien : le DNS unicast, et lui seul. */
  dnsOnly?: boolean;
  /** N'interroge que le lien : ni hosts, ni cache, ni serveur DNS. */
  llmnrOnly?: boolean;
  /** Ignore `%SystemRoot%\System32\drivers\etc\hosts`. */
  noHostsFile?: boolean;
  /** Ne va pas sur le fil : ce que le cache sait déjà, ou rien. */
  cacheOnly?: boolean;
}

export const DNS_CLIENT_POLICY_KEY =
  'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient';

export const ENABLE_MULTICAST_VALUE = 'EnableMulticast';
export const ENABLE_MDNS_VALUE = 'EnableMDNS';

export interface RegistryValueReader {
  getItemPropertyValues(path: string): Record<string, unknown> | null | undefined;
}

/**
 * Lit une valeur de la clé, sans distinguer la casse : `reg add` conserve
 * ce que l'opérateur a tapé, et un `enablemulticast` en minuscules
 * désigne la même valeur qu'un `EnableMulticast`.
 */
function readPolicyValue(registry: RegistryValueReader, name: string): unknown {
  const values = registry.getItemPropertyValues(DNS_CLIENT_POLICY_KEY);
  if (!values) return undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(values)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/**
 * Seul un zéro franc éteint. Une valeur absente, ou toute autre valeur,
 * laisse le protocole actif : la stratégie s'appelle « désactiver », et
 * une donnée qu'on ne sait pas lire n'est pas une instruction d'extinction.
 */
function enabledUnlessZero(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  if (typeof raw === 'number') return raw !== 0;
  const text = String(raw).trim().toLowerCase();
  if (text === '') return true;
  if (text === '0' || text === '0x0') return false;
  return true;
}

export function isLlmnrEnabled(registry: RegistryValueReader): boolean {
  return enabledUnlessZero(readPolicyValue(registry, ENABLE_MULTICAST_VALUE));
}

export function isMdnsEnabled(registry: RegistryValueReader): boolean {
  return enabledUnlessZero(readPolicyValue(registry, ENABLE_MDNS_VALUE));
}
