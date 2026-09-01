/**
 * La base de paquets de la machine — une seule table, et `installed` en
 * est DÉRIVÉ.
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

import { commandsOfPackage } from '../commands/LinuxCommandPackages';

export interface PackageEntry {
  readonly name: string;
  readonly version: string;
  readonly arch: string;
  /** Résumé d'une ligne — c'est ce que `apt-cache search` filtre. */
  readonly summary: string;
  /** Les unités systemd que ce paquet livre, s'il en a. */
  readonly units?: readonly string[];
}

const CATALOGUE: readonly PackageEntry[] = [
  { name: 'anacron', version: '2.3-31ubuntu2', arch: 'amd64',
    summary: 'cron-like program that does not go by time', units: ['anacron'] },
  { name: 'apache2', version: '2.4.52-1ubuntu4', arch: 'amd64',
    summary: 'Apache HTTP Server',
    units: ['apache2'] },
  { name: 'at', version: '3.2.5-1ubuntu1', arch: 'amd64',
    summary: 'Delayed job execution and batch processing', },
  { name: 'auditd', version: '1:3.0.7-1build1', arch: 'amd64',
    summary: 'User space tools for security auditing', },
  { name: 'bash', version: '5.1-6ubuntu1', arch: 'amd64',
    summary: 'GNU Bourne Again SHell', },
  { name: 'bind9', version: '9.18.12-0ubuntu0.22.04.1', arch: 'amd64',
    summary: 'Internet Domain Name Server', units: ['named'] },
  { name: 'ca-certificates', version: '20230311ubuntu0.22.04.1', arch: 'amd64',
    summary: 'Common CA certificates', },
  { name: 'chrony', version: '4.2-2ubuntu2', arch: 'amd64',
    summary: 'Versatile implementation of the Network Time Protocol', units: ['chrony'] },
  { name: 'conntrack', version: '1:1.4.6-2build2', arch: 'amd64',
    summary: 'Program to modify the conntrack tables', },
  { name: 'coreutils', version: '8.32-4.1ubuntu1', arch: 'amd64',
    summary: 'GNU core utilities', },
  { name: 'cron', version: '3.0pl1-137ubuntu3', arch: 'amd64',
    summary: 'process scheduling daemon', units: ['cron'] },
  { name: 'curl', version: '7.81.0-1ubuntu1.15', arch: 'amd64',
    summary: 'command line tool for transferring data with URL syntax', },
  { name: 'debianutils', version: '5.5-1ubuntu2', arch: 'amd64',
    summary: 'Miscellaneous utilities specific to Debian', },
  { name: 'dnsutils', version: '9.18.12-0ubuntu0.22.04.1', arch: 'amd64',
    summary: 'Clients provided with BIND 9', },
  { name: 'e2fsprogs', version: '1.46.5-2ubuntu1.1', arch: 'amd64',
    summary: 'ext2/ext3/ext4 file system utilities', },
  { name: 'findutils', version: '4.8.0-1ubuntu3', arch: 'amd64',
    summary: 'utilities for finding files', },
  { name: 'gawk', version: '1:5.1.0-1ubuntu0.1', arch: 'amd64',
    summary: 'GNU awk, a pattern scanning and processing language', },
  { name: 'grep', version: '3.7-1build1', arch: 'amd64',
    summary: 'GNU grep, egrep and fgrep', },
  { name: 'gzip', version: '1.10-4ubuntu4.1', arch: 'amd64',
    summary: 'GNU compression utilities', },
  { name: 'iproute2', version: '5.15.0-1ubuntu2', arch: 'amd64',
    summary: 'networking and traffic control tools', },
  { name: 'iptables', version: '1.8.7-1ubuntu5', arch: 'amd64',
    summary: 'administration tools for packet filtering and NAT', },
  { name: 'iputils-ping', version: '3:20211215-1', arch: 'amd64',
    summary: 'Tools to test the reachability of network hosts', },
  { name: 'isc-dhcp-server', version: '4.4.1-2.3ubuntu2.4', arch: 'amd64',
    summary: 'ISC DHCP server for automatic IP address assignment', units: ['isc-dhcp-server'] },
  { name: 'kmod', version: '29-1ubuntu1', arch: 'amd64',
    summary: 'tools for managing Linux kernel modules', },
  { name: 'libuser', version: '1:0.62~dfsg-0.1ubuntu2', arch: 'amd64',
    summary: 'user and group account administration library', },
  { name: 'lldpd', version: '1.0.16-1', arch: 'amd64',
    summary: 'implementation of IEEE 802.1ab (LLDP)', units: ['lldpd'] },
  { name: 'logrotate', version: '3.19.0-1ubuntu1.1', arch: 'amd64',
    summary: 'Log rotation utility', },
  { name: 'lsof', version: '4.93.2+dfsg-1.1build2', arch: 'amd64',
    summary: 'Utility to list open files', },
  { name: 'mtr-tiny', version: '0.95-1', arch: 'amd64',
    summary: 'Full screen ncurses traceroute tool', },
  { name: 'ncal', version: '12.1.7+nmu3', arch: 'amd64',
    summary: 'Unix calendar and calculator utility', },
  { name: 'net-tools', version: '1.60+git20181103.0eebece-1ubuntu5',
    arch: 'amd64', summary: 'NET-3 networking toolkit', },
  { name: 'nginx', version: '1.18.0-6ubuntu14.4', arch: 'amd64',
    summary: 'small, powerful, scalable web/proxy server', units: ['nginx'] },
  { name: 'ntpsec', version: '1.2.1+dfsg1-4', arch: 'amd64',
    summary: 'Network Time Protocol daemon and utility programs', },
  { name: 'openssh-client', version: '1:8.9p1-3ubuntu0.1', arch: 'amd64',
    summary: 'secure shell (SSH) client, for secure access to remote machines', },
  { name: 'openssh-server', version: '1:8.9p1-3ubuntu0.1', arch: 'amd64',
    summary: 'secure shell (SSH) server, for secure access from remote machines', units: ['ssh'] },
  { name: 'openssl', version: '3.0.2-0ubuntu1', arch: 'amd64',
    summary: 'Secure Sockets Layer toolkit - cryptographic utility', },
  { name: 'passwd', version: '1:4.8.1-2ubuntu2.1', arch: 'amd64',
    summary: 'change and administer password and group data', },
  { name: 'pciutils', version: '1:3.7.0-6', arch: 'amd64',
    summary: 'PCI utilities', },
  { name: 'procps', version: '2:3.3.17-6ubuntu2', arch: 'amd64',
    summary: '/proc file system utilities', },
  { name: 'psmisc', version: '23.4-2build3', arch: 'amd64',
    summary: 'utilities that use the proc file system', },
  { name: 'rsyslog', version: '8.2112.0-2ubuntu2', arch: 'amd64',
    summary: 'reliable system and kernel logging daemon', units: ['rsyslog'] },
  { name: 'sed', version: '4.8-1ubuntu2', arch: 'amd64',
    summary: 'GNU stream editor for filtering/transforming text', },
  { name: 'strongswan', version: '5.9.5-2ubuntu2', arch: 'amd64',
    summary: 'IPsec VPN solution', },
  { name: 'sudo', version: '1.9.9-1ubuntu2.4', arch: 'amd64',
    summary: 'Provide limited super user privileges to specific users', },
  { name: 'systemd', version: '249.11-0ubuntu3', arch: 'amd64',
    summary: 'system and service manager', },
  { name: 'systemd-sysv', version: '249.11-0ubuntu3', arch: 'amd64',
    summary: 'system and service manager - SysV links', },
  { name: 'tar', version: '1.34+dfsg-1ubuntu0.1.22.04.2', arch: 'amd64',
    summary: 'GNU version of the tar archiving utility', },
  { name: 'tcpdump', version: '4.99.1-3build2', arch: 'amd64',
    summary: 'command-line network traffic analyzer', },
  { name: 'traceroute', version: '1:2.1.0-2', arch: 'amd64',
    summary: 'Traces the route taken by packets over an IPv4/IPv6 network', },
  { name: 'tree', version: '2.0.2-1', arch: 'amd64',
    summary: 'displays an indented directory tree, in color', },
  { name: 'util-linux', version: '2.37.2-4ubuntu3', arch: 'amd64',
    summary: 'miscellaneous system utilities', },
  { name: 'vim', version: '2:8.2.3995-1ubuntu2', arch: 'amd64',
    summary: 'Vi IMproved - enhanced vi editor', },
  { name: 'wget', version: '1.21.2-2ubuntu1', arch: 'amd64',
    summary: 'retrieves files from the web', },
];

/**
 * `installed` n'est pas stocké : il est LU sur la machine. Un paquet est
 * présent quand cette image livre au moins une des commandes qu'il
 * fournit — c'est-à-dire quand quelque chose répond derrière son nom.
 * Deux écritures d'un même fait finiraient par se contredire, et c'est
 * exactement le défaut que cette table a déjà fermé une fois entre
 * `apt`, `dpkg` et `apt-cache`.
 */
export function packageIsInstalled(entry: PackageEntry): boolean {
  return packageProvides(entry.name).length > 0;
}

/** Les commandes que ce paquet livre, LUES sur les commandes elles-mêmes. */
export function packageProvides(name: string): string[] {
  return commandsOfPackage(name);
}

export type InstalledPackage = PackageEntry & { readonly installed: boolean };

export const PACKAGE_DB: readonly InstalledPackage[] =
  CATALOGUE.map(p => ({ ...p, installed: packageIsInstalled(p) }));

/** `apt-cache search` : le motif est cherché dans le nom **et** le résumé. */
export function searchPackages(pattern: string): InstalledPackage[] {
  let rx: RegExp;
  try { rx = new RegExp(pattern, 'i'); } catch { return []; }
  return PACKAGE_DB.filter((p) => rx.test(p.name) || rx.test(p.summary));
}

export function findPackage(name: string): InstalledPackage | undefined {
  return PACKAGE_DB.find((p) => p.name === name);
}
