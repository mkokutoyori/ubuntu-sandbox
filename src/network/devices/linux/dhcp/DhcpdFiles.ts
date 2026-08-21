export const DHCPD_CONF_PATH = '/etc/dhcp/dhcpd.conf';
export const DHCPD_DEFAULTS_PATH = '/etc/default/isc-dhcp-server';
export const DHCPD_LEASES_PATH = '/var/lib/dhcp/dhcpd.leases';
export const DHCPD_PID_PATH = '/run/dhcp-server/dhcpd.pid';
export const DHCPD_BINARY = '/usr/sbin/dhcpd';

export const DHCPD_VERSION = '4.4.1';

export const DHCPD_BANNER: readonly string[] = [
  `Internet Systems Consortium DHCP Server ${DHCPD_VERSION}`,
  'Copyright 2004-2018 Internet Systems Consortium.',
  'All rights reserved.',
  'For info, please visit https://www.isc.org/software/dhcp/',
];

export const DHCPD_CONF_DEFAULT = `# Sample configuration file for ISC dhcpd
#

# option definitions common to all supported networks...
#option domain-name "example.org";
#option domain-name-servers ns1.example.org, ns2.example.org;

#default-lease-time 600;
#max-lease-time 7200;

# The ddns-updates-style parameter controls whether or not the server will
# attempt to do a DNS update when a lease is confirmed.
ddns-update-style none;

# If this DHCP server is the official DHCP server for the local
# network, the authoritative directive should be uncommented.
#authoritative;

# Use this to send dhcp log messages to a different log file (you also
# have to hack syslog.conf to complete the redirection).
log-facility local7;

# A slightly different configuration for an internal subnet.
#subnet 10.5.5.0 netmask 255.255.255.224 {
#  range 10.5.5.26 10.5.5.30;
#  option domain-name-servers ns1.internal.example.org;
#  option domain-name "internal.example.org";
#  option routers 10.5.5.1;
#  option broadcast-address 10.5.5.31;
#  default-lease-time 600;
#  max-lease-time 7200;
#}
`;

export const DHCPD_DEFAULTS_CONTENT = `# Defaults for isc-dhcp-server (sourced by /etc/init.d/isc-dhcp-server)

# Path to dhcpd's config file (default: /etc/dhcp/dhcpd.conf).
#DHCPDv4_CONF=/etc/dhcp/dhcpd.conf
#DHCPDv6_CONF=/etc/dhcp/dhcpd6.conf

# Path to dhcpd's PID file (default: /var/run/dhcpd.pid).
#DHCPDv4_PID=/var/run/dhcpd.pid
#DHCPDv6_PID=/var/run/dhcpd6.pid

# Additional options to start dhcpd with.
#OPTIONS=""

# On what interfaces should the DHCP server (dhcpd) serve DHCP requests?
INTERFACESv4=""
INTERFACESv6=""
`;

export const DHCPD_LEASES_HEADER = `# The format of this file is documented in the dhcpd.leases(5) manual page.
# This lease file was written by isc-dhcp-${DHCPD_VERSION}
`;

export interface DhcpdSeedFs {
  exists(path: string): boolean;
  mkdirp(path: string): void;
  write(path: string, content: string): void;
}

export function seedDhcpdFiles(fs: DhcpdSeedFs): void {
  fs.mkdirp('/etc/dhcp');
  fs.mkdirp('/etc/default');
  fs.mkdirp('/var/lib/dhcp');
  if (!fs.exists(DHCPD_CONF_PATH)) fs.write(DHCPD_CONF_PATH, DHCPD_CONF_DEFAULT);
  if (!fs.exists(DHCPD_DEFAULTS_PATH)) fs.write(DHCPD_DEFAULTS_PATH, DHCPD_DEFAULTS_CONTENT);
  if (!fs.exists(DHCPD_LEASES_PATH)) fs.write(DHCPD_LEASES_PATH, DHCPD_LEASES_HEADER);
}
