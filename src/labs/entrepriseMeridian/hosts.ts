import type { Equipment } from '@/network';
import type { LabWorkbench } from '../LabWorkbench';
import { DOMAIN_PASSWORD, HQ, INTERNAL_DOMAIN } from './plan';

export async function configureLinux(
  bench: LabWorkbench, device: Equipment, address: string, gateway: string, dnsServer: string,
): Promise<void> {
  await bench.writeFile(device, '/etc/netplan/01-lab.yaml', [
    'network:',
    '  version: 2',
    '  ethernets:',
    '    eth0:',
    '      dhcp4: false',
    `      addresses: [${address}/24]`,
    '      routes:',
    '        - to: default',
    `          via: ${gateway}`,
    '      nameservers:',
    `        addresses: [${dnsServer}]`,
  ].join('\n'), '600');
  await bench.shell(device, 'sudo netplan apply');
}

export async function configureWindows(
  bench: LabWorkbench, device: Equipment, address: string, gateway: string, dnsServer: string,
): Promise<void> {
  await bench.powershell(
    device,
    `New-NetIPAddress -InterfaceAlias "Ethernet 0" -IPAddress ${address} -PrefixLength 24 -DefaultGateway ${gateway}`,
    `Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses ${dnsServer}`,
  );
}

export async function configureSiem(bench: LabWorkbench, siem: Equipment): Promise<void> {
  await bench.shell(
    siem,
    'sudo sed -i \'s/^#module(load="imudp")/module(load="imudp")/\' /etc/rsyslog.conf',
    'sudo sed -i \'s/^#input(type="imudp" port="514")/input(type="imudp" port="514")/\' /etc/rsyslog.conf',
    'sudo systemctl restart rsyslog',
  );
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

export async function configureDomainController(bench: LabWorkbench, dc: Equipment, addresses: Record<string, string>): Promise<void> {
  await bench.powershell(
    dc,
    'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools',
    'Install-WindowsFeature DNS -IncludeManagementTools',
    `Install-ADDSForest -DomainName ${INTERNAL_DOMAIN} -DomainNetBiosName MERIDIAN -SafeModeAdministratorPassword (ConvertTo-SecureString "${DOMAIN_PASSWORD}" -AsPlainText -Force) -Force:$true`,
    ...Object.entries(addresses).map(([name, address]) =>
      `Add-DnsServerResourceRecordA -ZoneName ${INTERNAL_DOMAIN} -Name ${name} -IPv4Address ${address}`),
    `Add-DnsServerResourceRecord -MX -ZoneName ${INTERNAL_DOMAIN} -Name "@" -MailExchange mail.${INTERNAL_DOMAIN} -Preference 10`,
  );
}

export async function joinDomainAndInstallExchange(bench: LabWorkbench, mail: Equipment): Promise<void> {
  await bench.powershell(
    mail,
    `Add-Computer -DomainName ${INTERNAL_DOMAIN} -Credential "Administrator:${DOMAIN_PASSWORD}" -Server ${HQ.dc1}`,
    'Install-ExchangeServer -Roles Mailbox -OrganizationName "Meridian"',
  );
}
