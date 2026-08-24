import {
  icmpService, ipProtocolService, tcpService, udpService, makeService,
  type ServiceObject,
} from '../../../model/ServiceObject';
import {
  anyAddress, anyAddress6, type AddressObject,
} from '../../../model/AddressObject';

const OPTIONS = { predefined: true };

function predefine(service: ServiceObject): ServiceObject {
  return makeService(service.name, service.entries, OPTIONS);
}

export const PREDEFINED_SERVICES: readonly ServiceObject[] = Object.freeze([
  predefine(ipProtocolService('ALL', 0)),
  predefine(tcpService('ALL_TCP', { from: 1, to: 65535 })),
  predefine(udpService('ALL_UDP', { from: 1, to: 65535 })),
  predefine(icmpService('ALL_ICMP')),
  predefine(icmpService('PING', 8)),
  predefine(tcpService('HTTP', 80)),
  predefine(tcpService('HTTPS', 443)),
  predefine(tcpService('SSH', 22)),
  predefine(tcpService('TELNET', 23)),
  predefine(tcpService('FTP', 21)),
  predefine(udpService('TFTP', 69)),
  predefine(makeService('DNS', [
    { protocol: 'tcp', destinationPorts: [{ from: 53, to: 53 }] },
    { protocol: 'udp', destinationPorts: [{ from: 53, to: 53 }] },
  ])),
  predefine(udpService('DHCP', { from: 67, to: 68 })),
  predefine(udpService('NTP', 123)),
  predefine(tcpService('SMTP', 25)),
  predefine(tcpService('POP3', 110)),
  predefine(tcpService('IMAP', 143)),
  predefine(udpService('SNMP', { from: 161, to: 162 })),
  predefine(udpService('SYSLOG', 514)),
  predefine(tcpService('LDAP', 389)),
  predefine(udpService('RADIUS', { from: 1812, to: 1813 })),
  predefine(tcpService('TACACS+', 49)),
  predefine(tcpService('SMB', 445)),
  predefine(tcpService('RDP', 3389)),
  predefine(tcpService('MYSQL', 3306)),
  predefine(tcpService('SQL', 1433)),
  predefine(tcpService('ORACLE', 1521)),
  predefine(udpService('IKE', 500, 4500)),
  predefine(ipProtocolService('ESP', 50)),
  predefine(ipProtocolService('AH', 51)),
  predefine(ipProtocolService('GRE', 47)),
  predefine(udpService('L2TP', 1701)),
  predefine(tcpService('PPTP', 1723)),
  predefine(makeService('SIP', [
    { protocol: 'tcp', destinationPorts: [{ from: 5060, to: 5060 }] },
    { protocol: 'udp', destinationPorts: [{ from: 5060, to: 5060 }] },
  ])),
  predefine(makeService('TRACEROUTE', [
    { protocol: 'udp', destinationPorts: [{ from: 33434, to: 33534 }] },
  ])),
]);

export const PREDEFINED_SERVICE_NAMES: readonly string[] =
  Object.freeze(PREDEFINED_SERVICES.map(service => service.name));

export const PREDEFINED_ADDRESSES: readonly AddressObject[] =
  Object.freeze([anyAddress('all'), anyAddress6('all6')]);
