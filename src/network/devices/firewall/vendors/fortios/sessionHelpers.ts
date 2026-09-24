import type { SessionHelperEntry } from '../../session/SessionHelperTable';

export const FORTIOS_SESSION_HELPER_NAMES: readonly string[] = Object.freeze([
  'ftp', 'tftp', 'ras', 'h323', 'tns', 'mms', 'sip', 'pptp', 'rtsp', 'dns-udp',
  'dns-tcp', 'pmap', 'rsh', 'dcerpc', 'mgcp', 'gtp-c', 'gtp-u', 'gtp-b', 'pfcp',
]);

const TCP = 6;
const UDP = 17;

export const FORTIOS_DEFAULT_SESSION_HELPERS: readonly SessionHelperEntry[] = Object.freeze([
  { id: 1, name: 'pptp', protocol: TCP, port: 1723 },
  { id: 2, name: 'h323', protocol: TCP, port: 1720 },
  { id: 3, name: 'ras', protocol: UDP, port: 1719 },
  { id: 4, name: 'tns', protocol: TCP, port: 1521 },
  { id: 5, name: 'tftp', protocol: UDP, port: 69 },
  { id: 6, name: 'rtsp', protocol: TCP, port: 554 },
  { id: 7, name: 'rtsp', protocol: TCP, port: 7070 },
  { id: 8, name: 'rtsp', protocol: TCP, port: 8554 },
  { id: 9, name: 'ftp', protocol: TCP, port: 21 },
  { id: 10, name: 'mms', protocol: TCP, port: 1863 },
  { id: 11, name: 'pmap', protocol: TCP, port: 111 },
  { id: 12, name: 'pmap', protocol: UDP, port: 111 },
  { id: 13, name: 'sip', protocol: UDP, port: 5060 },
  { id: 14, name: 'dns-udp', protocol: UDP, port: 53 },
  { id: 15, name: 'rsh', protocol: TCP, port: 514 },
  { id: 16, name: 'rsh', protocol: TCP, port: 512 },
  { id: 17, name: 'dcerpc', protocol: TCP, port: 135 },
  { id: 18, name: 'dcerpc', protocol: UDP, port: 135 },
  { id: 19, name: 'mgcp', protocol: UDP, port: 2427 },
  { id: 20, name: 'mgcp', protocol: UDP, port: 2727 },
]);
