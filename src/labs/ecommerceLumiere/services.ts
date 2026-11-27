import type { Equipment } from '@/network';
import type { LabWorkbench } from '../LabWorkbench';
import { DOMAIN_PASSWORD, DR, HQ, INTERNAL_DOMAIN, INTERNET, NETBIOS, PUBLIC_DOMAIN, RADIUS_SECRET } from './plan';

const SERIAL = '2026010101';

export async function configureDomainControllers(bench: LabWorkbench, dc1: Equipment, dc2: Equipment): Promise<void> {
  await bench.powershell(
    dc1,
    'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools',
    'Install-WindowsFeature DNS -IncludeManagementTools',
    'Install-WindowsFeature DHCP -IncludeManagementTools',
    `Install-ADDSForest -DomainName ${INTERNAL_DOMAIN} -DomainNetBiosName ${NETBIOS} -SafeModeAdministratorPassword (ConvertTo-SecureString "${DOMAIN_PASSWORD}" -AsPlainText -Force) -Force:$true`,
    'Add-DnsServerPrimaryZone -NetworkId 10.10.0.0/16 -ZoneFile 10.10.in-addr.arpa.dns -DynamicUpdate NonsecureAndSecure',
    'Add-DnsServerPrimaryZone -NetworkId 10.20.0.0/16 -ZoneFile 20.10.in-addr.arpa.dns -DynamicUpdate NonsecureAndSecure',
    `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name dc1 -IPv4Address ${HQ.servers.dc1} -CreatePtr`,
    `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name log-hq -IPv4Address ${HQ.servers.log} -CreatePtr`,
    `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name ora-prd -IPv4Address ${HQ.db.oracle} -CreatePtr`,
    `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name bkp-hq -IPv4Address ${HQ.db.backup} -CreatePtr`,
    `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name web-1 -IPv4Address ${HQ.dmz.web1}`,
    `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name web-2 -IPv4Address ${HQ.dmz.web2}`,
    `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name app-1 -IPv4Address ${HQ.dmz.app}`,
    `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name ora-stb -IPv4Address ${DR.db.standby} -CreatePtr`,
    `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name bkp-dr -IPv4Address ${DR.db.backup} -CreatePtr`,
    `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name web-dr -IPv4Address ${DR.dmz.web}`,
    `Add-DnsServerResourceRecordCName -ZoneName ${INTERNAL_DOMAIN} -Name db -HostNameAlias ora-prd.${INTERNAL_DOMAIN}`,
    `Add-DnsServerResourceRecordCName -ZoneName ${INTERNAL_DOMAIN} -Name backup -HostNameAlias bkp-hq.${INTERNAL_DOMAIN}`,
    `Add-DnsServerConditionalForwarderZone -Name ${PUBLIC_DOMAIN} -MasterServers ${INTERNET.publicDns}`,
    `Add-DhcpServerInDC -DnsName dc1.${INTERNAL_DOMAIN} -IPAddress ${HQ.servers.dc1}`,
    'Add-DhcpServerv4Scope -Name UTILISATEURS-HQ -StartRange 10.10.20.100 -EndRange 10.10.20.200 -SubnetMask 255.255.255.0',
    `Set-DhcpServerv4OptionValue -ScopeId 10.10.20.0 -Router ${HQ.users.gateway} -DnsServer ${HQ.servers.dc1},${DR.servers.dc2} -DnsDomain ${INTERNAL_DOMAIN}`,
    'Set-DhcpServerv4DnsSetting -ScopeId 10.10.20.0 -DynamicUpdates Always',
    `New-ADOrganizationalUnit -Name Lumiere -Path "DC=lumiere,DC=local"`,
    `New-ADOrganizationalUnit -Name DBA -Path "OU=Lumiere,DC=lumiere,DC=local"`,
    `New-ADOrganizationalUnit -Name Exploitation -Path "OU=Lumiere,DC=lumiere,DC=local"`,
    `New-ADUser -Name "Awa Dba" -SamAccountName adba -Path "OU=DBA,OU=Lumiere,DC=lumiere,DC=local" -AccountPassword (ConvertTo-SecureString "Dba@Lum1ere!" -AsPlainText -Force) -Enabled $true`,
    `New-ADUser -Name "Paul Exploitation" -SamAccountName pexploit -Path "OU=Exploitation,OU=Lumiere,DC=lumiere,DC=local" -AccountPassword (ConvertTo-SecureString "Exp@Lum1ere!" -AsPlainText -Force) -Enabled $true`,
  );
  await bench.powershell(
    dc2,
    'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools',
    [
      'Install-ADDSDomainController',
      `-DomainName "${INTERNAL_DOMAIN}"`,
      `-Credential "Administrator:${DOMAIN_PASSWORD}"`,
      `-Server "${HQ.servers.dc1}"`,
      '-InstallDns:$true',
      '-CreateDnsDelegation:$false',
      '-DatabasePath "C:\\Windows\\NTDS"',
      '-LogPath "C:\\Windows\\NTDS"',
      '-SysvolPath "C:\\Windows\\SYSVOL"',
      `-SafeModeAdministratorPassword (ConvertTo-SecureString "${DOMAIN_PASSWORD}" -AsPlainText -Force)`,
      '-SiteName "Default-First-Site-Name"',
      '-Force:$true',
    ].join(' '),
  );
}

export async function configurePublicDns(bench: LabWorkbench, server: Equipment): Promise<void> {
  await bench.shell(server, 'sudo apt install -y bind9');
  await bench.writeFile(server, '/etc/bind/named.conf', [
    'options {',
    '    directory "/var/cache/bind";',
    '    recursion no;',
    '    allow-query { any; };',
    '};',
    `zone "${PUBLIC_DOMAIN}" { type primary; file "/etc/bind/db.${PUBLIC_DOMAIN}"; };`,
  ].join('\n'));
  await bench.writeFile(server, `/etc/bind/db.${PUBLIC_DOMAIN}`, [
    '$TTL 3600',
    `$ORIGIN ${PUBLIC_DOMAIN}.`,
    `@ IN SOA ns1.${PUBLIC_DOMAIN}. hostmaster.${PUBLIC_DOMAIN}. ( ${SERIAL} 7200 900 1209600 3600 )`,
    `@ IN NS ns1.${PUBLIC_DOMAIN}.`,
    `ns1 IN A ${INTERNET.publicDns}`,
    `@ IN A ${INTERNET.vipWeb}`,
    `www IN A ${INTERNET.vipWeb}`,
    `shop IN CNAME www`,
    `pay IN A ${INTERNET.payment}`,
    `@ IN MX 10 mail.${PUBLIC_DOMAIN}.`,
    `mail IN A ${INTERNET.vipWeb}`,
  ].join('\n'));
  await bench.shell(server, `sudo named-checkzone ${PUBLIC_DOMAIN} /etc/bind/db.${PUBLIC_DOMAIN}`, 'sudo systemctl restart named');
}

export async function publishWebSite(bench: LabWorkbench, server: Equipment, title: string): Promise<void> {
  await bench.shell(server, 'sudo apt install -y nginx', 'sudo mkdir -p /var/www/site');
  await bench.writeFile(server, '/var/www/site/index.html', `<html><body><h1>${title}</h1></body></html>`);
  await bench.writeFile(server, '/etc/nginx/sites-available/site.conf', [
    'server {',
    '    listen 80 default_server;',
    '    server_name _;',
    '    root /var/www/site;',
    '    index index.html;',
    '}',
  ].join('\n'));
  await bench.shell(
    server,
    'sudo rm -f /etc/nginx/sites-enabled/default',
    'sudo ln -s /etc/nginx/sites-available/site.conf /etc/nginx/sites-enabled/site.conf',
    'sudo nginx -t',
    'sudo systemctl restart nginx',
  );
}

export async function configureLogServer(bench: LabWorkbench, log: Equipment): Promise<void> {
  await bench.shell(
    log,
    'sudo sed -i \'s/^#module(load="imudp")/module(load="imudp")/\' /etc/rsyslog.conf',
    'sudo sed -i \'s/^#input(type="imudp" port="514")/input(type="imudp" port="514")/\' /etc/rsyslog.conf',
    'sudo systemctl restart rsyslog',
  );
  await bench.writeFile(log, '/etc/freeradius/3.0/clients.conf', [
    'client reseau-siege {', '  ipaddr = 10.10.0.0/16', `  secret = ${RADIUS_SECRET}`, '  shortname = siege', '}',
    'client reseau-reprise {', '  ipaddr = 10.20.0.0/16', `  secret = ${RADIUS_SECRET}`, '  shortname = reprise', '}',
  ].join('\n'));
  await bench.writeFile(log, '/etc/freeradius/3.0/users', [
    'netadmin Cleartext-Password := "Net@Lum1ere!"',
    '        Service-Type = NAS-Prompt-User,',
    '        Cisco-AVPair = "shell:priv-lvl=15"',
    'dba-ops Cleartext-Password := "Dba@Lum1ere!"',
    '        Service-Type = NAS-Prompt-User',
  ].join('\n'));
  await bench.shell(log, 'sudo systemctl restart freeradius');
}
