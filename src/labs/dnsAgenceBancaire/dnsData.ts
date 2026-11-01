import { INTERNAL_DOMAIN, PLAN, PUBLIC_DOMAIN, SERIAL } from './plan';

const REVERSE_PUBLIC = '113.0.203.in-addr.arpa';

export const ROOT_ZONE = [
  '$TTL 86400',
  `. IN SOA a.root-servers.net. hostmaster.root-servers.net. ( ${SERIAL} 1800 900 604800 86400 )`,
  '. IN NS a.root-servers.net.',
  `a.root-servers.net. IN A ${PLAN.rootNs.address}`,
  'com. IN NS a.nic.com.',
  `a.nic.com. IN A ${PLAN.tldNs.address}`,
  `${REVERSE_PUBLIC}. IN NS ns1.${PUBLIC_DOMAIN}.`,
].join('\n');

export const ROOT_HINTS = [
  '. 3600000 IN NS a.root-servers.net.',
  `a.root-servers.net. 3600000 IN A ${PLAN.rootNs.address}`,
].join('\n');

export const ROOT_NAMED_CONF = [
  'options {',
  '    directory "/var/cache/bind";',
  '    recursion no;',
  '    allow-query { any; };',
  '};',
  'zone "." { type primary; file "/etc/bind/db.root"; };',
].join('\n');

export const BANK_NAMED_CONF = [
  'options {',
  '    directory "/var/cache/bind";',
  '    recursion no;',
  '    allow-query { any; };',
  '};',
  `zone "${PUBLIC_DOMAIN}" {`,
  '    type primary;',
  `    file "/etc/bind/db.${PUBLIC_DOMAIN}";`,
  `    allow-transfer { ${PLAN.ns2Bank.address}; };`,
  '    notify yes;',
  '};',
  `zone "${REVERSE_PUBLIC}" {`,
  '    type primary;',
  '    file "/etc/bind/db.203.0.113";',
  '};',
].join('\n');

export const BANK_ZONE = [
  '$TTL 3600',
  `$ORIGIN ${PUBLIC_DOMAIN}.`,
  `@ IN SOA ns1.${PUBLIC_DOMAIN}. hostmaster.${PUBLIC_DOMAIN}. ( ${SERIAL} 7200 900 1209600 3600 )`,
  `@ IN NS ns1.${PUBLIC_DOMAIN}.`,
  `@ IN NS ns2.${PUBLIC_DOMAIN}.`,
  `@ IN A ${PLAN.webBank.address}`,
  `@ IN MX 10 mail.${PUBLIC_DOMAIN}.`,
  `@ IN MX 20 mail2.${PUBLIC_DOMAIN}.`,
  '@ IN TXT "v=spf1 mx -all"',
  `ns1 IN A ${PLAN.ns1Bank.address}`,
  `ns2 IN A ${PLAN.ns2Bank.address}`,
  `web IN A ${PLAN.webBank.address}`,
  'www IN CNAME web',
  'ebanking IN CNAME web',
  'agences IN CNAME web',
  'api IN CNAME web',
  'mail IN A 203.0.113.25',
  'mail2 IN A 203.0.113.26',
  '_dmarc IN TXT "v=DMARC1; p=reject; rua=mailto:dmarc@banquehorizon.com"',
  '_imaps._tcp IN SRV 0 1 993 mail',
].join('\n');

export const BANK_REVERSE_ZONE = [
  '$TTL 3600',
  `$ORIGIN ${REVERSE_PUBLIC}.`,
  `@ IN SOA ns1.${PUBLIC_DOMAIN}. hostmaster.${PUBLIC_DOMAIN}. ( ${SERIAL} 7200 900 1209600 3600 )`,
  `@ IN NS ns1.${PUBLIC_DOMAIN}.`,
  `@ IN NS ns2.${PUBLIC_DOMAIN}.`,
  `10 IN PTR ns1.${PUBLIC_DOMAIN}.`,
  `11 IN PTR ns2.${PUBLIC_DOMAIN}.`,
  `20 IN PTR web.${PUBLIC_DOMAIN}.`,
  `25 IN PTR mail.${PUBLIC_DOMAIN}.`,
].join('\n');

export const RESOLVER_NAMED_CONF = [
  'acl "agence" { 10.20.0.0/16; 127.0.0.0/8; };',
  'options {',
  '    directory "/var/cache/bind";',
  '    recursion yes;',
  '    allow-query { agence; };',
  '    allow-recursion { agence; };',
  '    dnssec-validation no;',
  '};',
  'zone "." { type hint; file "/etc/bind/db.root.hints"; };',
  `zone "${INTERNAL_DOMAIN}" {`,
  '    type forward;',
  '    forward only;',
  `    forwarders { ${PLAN.dc1.address}; };`,
  '};',
].join('\n');
