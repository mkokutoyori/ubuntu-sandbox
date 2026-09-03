export const DEFAULT_TOP_COUNT = 1000;

const TCP_SERVICES: Record<number, string> = {
  7: 'echo', 9: 'discard', 13: 'daytime', 19: 'chargen', 20: 'ftp-data',
  21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 26: 'rsftp', 37: 'time',
  43: 'whois', 53: 'domain', 79: 'finger', 80: 'http', 81: 'hosts2-ns',
  88: 'kerberos-sec', 106: 'pop3pw', 110: 'pop3', 111: 'rpcbind',
  113: 'ident', 119: 'nntp', 135: 'msrpc', 139: 'netbios-ssn', 143: 'imap',
  144: 'news', 179: 'bgp', 199: 'smux', 389: 'ldap', 427: 'svrloc',
  443: 'https', 444: 'snpp', 445: 'microsoft-ds', 465: 'smtps', 513: 'login',
  514: 'shell', 515: 'printer', 543: 'klogin', 544: 'kshell', 548: 'afp',
  554: 'rtsp', 587: 'submission', 631: 'ipp', 636: 'ldapssl', 646: 'ldp',
  873: 'rsync', 990: 'ftps', 993: 'imaps', 995: 'pop3s', 1025: 'NFS-or-IIS',
  1026: 'LSA-or-nterm', 1027: 'IIS', 1080: 'socks', 1110: 'nfsd-status',
  1433: 'ms-sql-s', 1434: 'ms-sql-m', 1521: 'oracle-tns', 1720: 'h323q931',
  1723: 'pptp', 1755: 'wms', 1900: 'upnp', 2000: 'cisco-sccp', 2001: 'dc',
  2049: 'nfs', 2121: 'ccproxy-ftp', 2717: 'pn-requester', 3000: 'ppp',
  3128: 'squid-http', 3306: 'mysql', 3389: 'ms-wbt-server', 3986: 'mapper-ws_ethd',
  4899: 'radmin', 5000: 'upnp', 5009: 'airport-admin', 5051: 'ida-agent',
  5060: 'sip', 5101: 'admdog', 5190: 'aol', 5357: 'wsdapi', 5432: 'postgresql',
  5631: 'pcanywheredata', 5666: 'nrpe', 5800: 'vnc-http', 5900: 'vnc',
  6000: 'X11', 6001: 'X11:1', 6379: 'redis', 6646: 'unknown', 7070: 'realserver',
  8000: 'http-alt', 8008: 'http', 8009: 'ajp13', 8080: 'http-proxy',
  8081: 'blackice-icecap', 8443: 'https-alt', 8888: 'sun-answerbook',
  9100: 'jetdirect', 9999: 'abyss', 10000: 'snet-sensor-mgmt', 32768: 'filenet-tms',
  49152: 'unknown', 49153: 'unknown', 49154: 'unknown', 49155: 'unknown',
  49156: 'unknown', 49157: 'unknown',
};

const UDP_SERVICES: Record<number, string> = {
  7: 'echo', 9: 'discard', 17: 'qotd', 19: 'chargen', 37: 'time', 53: 'domain',
  67: 'dhcps', 68: 'dhcpc', 69: 'tftp', 111: 'rpcbind', 123: 'ntp',
  135: 'msrpc', 137: 'netbios-ns', 138: 'netbios-dgm', 139: 'netbios-ssn',
  161: 'snmp', 162: 'snmptrap', 445: 'microsoft-ds', 500: 'isakmp',
  514: 'syslog', 520: 'route', 631: 'ipp', 1434: 'ms-sql-m', 1701: 'L2TP',
  1900: 'upnp', 4500: 'nat-t-ike', 5353: 'zeroconf', 49152: 'unknown',
};

const FREQUENCY_ORDER: number[] = [
  80, 23, 443, 21, 22, 25, 3389, 110, 445, 139, 143, 53, 135, 3306, 8080,
  1723, 111, 995, 993, 5900, 1025, 587, 8888, 199, 1720, 465, 548, 113, 81,
  6001, 10000, 514, 5060, 179, 1026, 2000, 8443, 8000, 32768, 554, 26, 1433,
  49152, 2001, 515, 8008, 49154, 1027, 5666, 646, 5000, 5631, 631, 49153,
  8081, 2049, 88, 79, 5800, 106, 2121, 1110, 49155, 6000, 513, 990, 5357,
  427, 49156, 543, 544, 5101, 144, 7, 389, 8009, 3128, 444, 9999, 5009,
  7070, 5190, 3000, 5432, 1900, 3986, 13, 1029, 9, 5051, 6646, 49157, 1028,
  873, 1755, 2717, 4899, 9100, 119, 37,
];

function buildTopPorts(): number[] {
  const ordered: number[] = [];
  const seen = new Set<number>();
  const push = (port: number) => {
    if (port >= 1 && port <= 65535 && !seen.has(port)) {
      seen.add(port);
      ordered.push(port);
    }
  };
  for (const p of FREQUENCY_ORDER) push(p);
  for (const key of Object.keys(TCP_SERVICES)) push(Number(key));
  for (const key of Object.keys(UDP_SERVICES)) push(Number(key));
  for (let p = 1; ordered.length < DEFAULT_TOP_COUNT && p <= 65535; p++) push(p);
  return ordered;
}

const TOP_PORTS = buildTopPorts();

export function serviceName(port: number, protocol: 'tcp' | 'udp'): string {
  const table = protocol === 'udp' ? UDP_SERVICES : TCP_SERVICES;
  return table[port] ?? 'unknown';
}

export function topPorts(count: number): number[] {
  const n = Math.max(0, Math.min(count, TOP_PORTS.length));
  return TOP_PORTS.slice(0, n).sort((a, b) => a - b);
}

export function fastPorts(): number[] {
  return topPorts(100);
}
