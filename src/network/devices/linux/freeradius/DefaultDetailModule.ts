export const DEFAULT_DETAIL_MODULE = [
  'detail {',
  '\tfilename = ${radacctdir}/%{%{Packet-Src-IP-Address}:-%{Packet-Src-IPv6-Address}}/detail-%Y%m%d',
  '\tescape_filenames = no',
  '\tpermissions = 0600',
  '\theader = "%t"',
  '}',
  '',
].join('\n');
