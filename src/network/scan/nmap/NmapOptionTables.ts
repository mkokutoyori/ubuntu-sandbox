/**
 * Ce que `nmap` CONNAIT — rien de plus, rien de moins.
 *
 * Les deux listes sont RELEVEES sur `nmap/nmap` et non rappelees : les
 * noms longs viennent de `long_options[]` (`nmap.cc:545`, cent entrees),
 * les noms courts de la chaine passee a `getopt_long_only`
 * (`nmap.cc:673`).
 *
 * Elles ne disent PAS quelles options prennent une valeur, et c'est
 * volontaire : une option connue et non implantee ici est refusee avant
 * qu'on ait a le savoir, donc une telle colonne ne serait lue par
 * personne — exactement le genre de donnee inerte que ce depot refuse.
 */

export const NMAP_LONG_OPTIONS: ReadonlySet<string> = new Set([
  'adler32', 'allports', 'append-output', 'badsum', 'data', 'data-length',
  'data-string', 'datadir', 'debug', 'defeat-icmp-ratelimit',
  'defeat-rst-ratelimit', 'deprecated-xml-osclass', 'disable-arp-ping',
  'discovery-ignore-rst', 'dns-servers', 'exclude', 'exclude-ports',
  'excludefile', 'ff', 'fuzzy', 'help', 'host-timeout', 'iL', 'iR', 'iflist',
  'initial-rtt-timeout', 'ip-options', 'log-errors', 'max-hostgroup',
  'max-os-tries', 'max-parallelism', 'max-rate', 'max-retries',
  'max-rtt-timeout', 'max-scan-delay', 'min-hostgroup', 'min-parallelism',
  'min-rate', 'min-rtt-timeout', 'mtu', 'no-stylesheet', 'nogcc',
  'noninteractive', 'nsock-engine', 'oA', 'oG', 'oH', 'oM', 'oN', 'oS', 'oX',
  'open', 'osscan-guess', 'osscan-limit', 'packet-trace', 'port-ratio',
  'privileged', 'proxies', 'proxy', 'rH', 'randomize-hosts', 'reason',
  'release-memory', 'resolve-all', 'resume', 'route-dst', 'sI', 'scan-delay',
  'scanflags', 'script', 'script-args', 'script-args-file', 'script-help',
  'script-timeout', 'script-trace', 'script-updatedb', 'send-eth', 'send-ip',
  'servicedb', 'source-port', 'spoof-mac', 'stats-every', 'stylesheet',
  'system-dns', 'thc', 'timing', 'top-ports', 'traceroute', 'ttl', 'unique',
  'unprivileged', 'verbose', 'version', 'version-all', 'version-intensity',
  'version-light', 'version-trace', 'versiondb', 'vv', 'webxml',
]);

export const NMAP_SHORT_OPTIONS: ReadonlySet<string> = new Set([
  '4', '6', 'A', 'b', 'D', 'd', 'e', 'F', 'f', 'g', 'h', 'I', 'i', 'M', 'm',
  'n', 'O', 'o', 'P', 'p', 'q', 'R', 'r', 'S', 's', 'T', 'V', 'v',
]);
