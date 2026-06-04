import type { Router } from '../../Router';

export interface ListeningSocket {
  protocol: 'tcp' | 'udp';
  port: number;
  service: string;
  source: 'configured' | 'default';
}

const SERVICE_PORT_DEFAULTS: ReadonlyArray<{ key: string; service: string; protocol: 'tcp' | 'udp'; port: number }> = [
  { key: 'http',         service: 'http',  protocol: 'tcp', port: 80 },
  { key: 'ftp',          service: 'ftp',   protocol: 'tcp', port: 21 },
];

export function collectListeningSockets(router: Router): readonly ListeningSocket[] {
  const mgmt = router.getManagementService();
  const sockets: ListeningSocket[] = [];

  const ssh = mgmt.getSsh();
  if (ssh.enabled) sockets.push({ protocol: 'tcp', port: ssh.port, service: 'ssh', source: 'configured' });

  const stelnet = mgmt.getStelnet();
  if (stelnet.enabled && stelnet.port !== ssh.port) {
    sockets.push({ protocol: 'tcp', port: stelnet.port, service: 'stelnet', source: 'configured' });
  }

  const telnet = mgmt.getTelnet();
  if (telnet.enabled) sockets.push({ protocol: 'tcp', port: telnet.port, service: 'telnet', source: 'configured' });

  const snmp = mgmt.getSnmp();
  if (snmp.enabled) sockets.push({ protocol: 'udp', port: 161, service: 'snmp', source: 'configured' });

  const ntp = mgmt.getNtp();
  if (ntp.enabled) sockets.push({ protocol: 'udp', port: 123, service: 'ntp', source: 'configured' });

  for (const { key, service, protocol, port } of SERVICE_PORT_DEFAULTS) {
    if (router._getGlobalToggle(key)) {
      sockets.push({ protocol, port, service, source: 'configured' });
    }
  }

  const dhcp = router._getDHCPServerInternal();
  if (dhcp.isEnabled?.()) {
    sockets.push({ protocol: 'udp', port: 67, service: 'dhcp-server', source: 'configured' });
  }

  return sockets;
}
