/**
 * La base de paquets de la machine — une seule table, trois vues.
 *
 * `apt list --installed`, `dpkg -l` et `apt-cache` répondaient chacun
 * depuis une chaîne codée en dur, dans trois endroits différents.
 * Trois listes qui n'avaient aucune raison de rester d'accord, et qui
 * ne l'étaient déjà pas : `dpkg -l` en montrait trois, `apt list` les
 * mêmes trois, `apt-cache` n'existait pas.
 *
 * Cette table est délibérément **courte et honnête** : elle ne nomme que
 * les paquets qui correspondent à quelque chose que la machine simule
 * vraiment (le shell, les coreutils, sshd, cron, at, anacron, …). Un
 * catalogue Debian complet serait une fiction de plusieurs milliers de
 * lignes que rien ne soutient — et `apt-cache search` y trouverait des
 * paquets qu'`apt install` ne saurait pas installer.
 */

export interface PackageEntry {
  readonly name: string;
  readonly version: string;
  readonly arch: string;
  /** Résumé d'une ligne — c'est ce que `apt-cache search` filtre. */
  readonly summary: string;
  readonly installed: boolean;
}

export const PACKAGE_DB: readonly PackageEntry[] = [
  { name: 'anacron', version: '2.3-31ubuntu2', arch: 'amd64', installed: true,
    summary: 'cron-like program that does not go by time' },
  { name: 'at', version: '3.2.5-1ubuntu1', arch: 'amd64', installed: true,
    summary: 'Delayed job execution and batch processing' },
  { name: 'bash', version: '5.1-6ubuntu1', arch: 'amd64', installed: true,
    summary: 'GNU Bourne Again SHell' },
  { name: 'bind9', version: '9.18.12-0ubuntu0.22.04.1', arch: 'amd64', installed: false,
    summary: 'Internet Domain Name Server' },
  { name: 'lldpd', version: '1.0.16-1', arch: 'amd64', installed: true,
    summary: 'implementation of IEEE 802.1ab (LLDP)' },
  { name: 'isc-dhcp-server', version: '4.4.1-2.3ubuntu2.4', arch: 'amd64', installed: false,
    summary: 'ISC DHCP server for automatic IP address assignment' },
  // `chronyd`/`chronyc` tournent sur cette image depuis le lot N3 et
  // `ntpq` depuis le lot N11 : sans ces deux lignes, `dpkg -l` niait des
  // logiciels que la machine exécute — la forme de défaut exactement
  // inverse de celle que cette table a fermée (des paquets déclarés
  // installés dont rien n'existait).
  { name: 'chrony', version: '4.2-2ubuntu2', arch: 'amd64', installed: true,
    summary: 'Versatile implementation of the Network Time Protocol' },
  { name: 'coreutils', version: '8.32-4.1ubuntu1', arch: 'amd64', installed: true,
    summary: 'GNU core utilities' },
  { name: 'cron', version: '3.0pl1-137ubuntu3', arch: 'amd64', installed: true,
    summary: 'process scheduling daemon' },
  { name: 'dnsutils', version: '9.18.12-0ubuntu0.22.04.1', arch: 'amd64', installed: true,
    summary: 'Clients provided with BIND 9' },
  { name: 'iproute2', version: '5.15.0-1ubuntu2', arch: 'amd64', installed: true,
    summary: 'networking and traffic control tools' },
  { name: 'iptables', version: '1.8.7-1ubuntu5', arch: 'amd64', installed: true,
    summary: 'administration tools for packet filtering and NAT' },
  { name: 'iputils-ping', version: '3:20211215-1', arch: 'amd64', installed: true,
    summary: 'Tools to test the reachability of network hosts' },
  { name: 'mtr-tiny', version: '0.95-1', arch: 'amd64', installed: true,
    summary: 'Full screen ncurses traceroute tool' },
  // Le paquet qui fournit `/usr/bin/ntpq` sur Jammy. Il est nommé plutôt
  // que `ntp` parce que c'est celui qu'Ubuntu 22.04 maintient, et
  // installé sans son démon : `ntpq` est un CLIENT, il n'a besoin
  // d'aucun `ntpd` local pour interroger un routeur.
  { name: 'ntpsec', version: '1.2.1+dfsg1-4', arch: 'amd64', installed: true,
    summary: 'Network Time Protocol daemon and utility programs' },
  { name: 'openssh-client', version: '1:8.9p1-3ubuntu0.1', arch: 'amd64', installed: true,
    summary: 'secure shell (SSH) client, for secure access to remote machines' },
  { name: 'openssh-server', version: '1:8.9p1-3ubuntu0.1', arch: 'amd64', installed: true,
    summary: 'secure shell (SSH) server, for secure access from remote machines' },
  { name: 'openssl', version: '3.0.2-0ubuntu1', arch: 'amd64', installed: true,
    summary: 'Secure Sockets Layer toolkit - cryptographic utility' },
  { name: 'psmisc', version: '23.4-2build3', arch: 'amd64', installed: true,
    summary: 'utilities that use the proc file system' },
  { name: 'rsyslog', version: '8.2112.0-2ubuntu2', arch: 'amd64', installed: true,
    summary: 'reliable system and kernel logging daemon' },
  { name: 'systemd', version: '249.11-0ubuntu3', arch: 'amd64', installed: true,
    summary: 'system and service manager' },
  { name: 'tcpdump', version: '4.99.1-3build2', arch: 'amd64', installed: true,
    summary: 'command-line network traffic analyzer' },
  { name: 'traceroute', version: '1:2.1.0-2', arch: 'amd64', installed: true,
    summary: 'Traces the route taken by packets over an IPv4/IPv6 network' },
  { name: 'vim', version: '2:8.2.3995-1ubuntu2', arch: 'amd64', installed: true,
    summary: 'Vi IMproved - enhanced vi editor' },
];

/** `apt-cache search` : le motif est cherché dans le nom **et** le résumé. */
export function searchPackages(pattern: string): PackageEntry[] {
  let rx: RegExp;
  try { rx = new RegExp(pattern, 'i'); } catch { return []; }
  return PACKAGE_DB.filter((p) => rx.test(p.name) || rx.test(p.summary));
}

export function findPackage(name: string): PackageEntry | undefined {
  return PACKAGE_DB.find((p) => p.name === name);
}
