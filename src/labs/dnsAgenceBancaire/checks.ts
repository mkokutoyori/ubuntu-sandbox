import type { Equipment } from '@/network';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

export interface LabCheck {
  readonly id: string;
  readonly device: string;
  readonly shell: 'bash' | 'powershell';
  readonly command: string;
  readonly expects: readonly RegExp[];
  readonly lesson: string;
}

export interface LabCheckResult {
  readonly check: LabCheck;
  readonly output: string;
  readonly missing: readonly RegExp[];
}

export const LAB_CHECKS: readonly LabCheck[] = [
  {
    id: 'dhcp-client-options', device: 'PC-GUICHET1', shell: 'powershell', command: 'ipconfig /all',
    expects: [/DHCP Enabled[ .]*: Yes/, /DNS Servers[ .]*: 10\.20\.20\.10/, /Connection-specific DNS Suffix[ .]*: horizon\.local/, /DHCP Server[ .]*: 10\.20\.20\.10/],
    lesson: 'Le poste recoit de DC1 son adresse, ses deux serveurs DNS et le suffixe horizon.local (options 3, 6 et 15).',
  },
  {
    id: 'internal-name', device: 'PC-GUICHET1', shell: 'powershell', command: 'Resolve-DnsName dc1.horizon.local',
    expects: [/IPAddress\s*:\s*10\.20\.20\.10/],
    lesson: 'DC1 fait autorite pour la zone interne horizon.local.',
  },
  {
    id: 'suffix-search', device: 'PC-GUICHET1', shell: 'powershell', command: 'Resolve-DnsName intranet',
    expects: [/10\.20\.20\.10/],
    lesson: 'Un nom court est complete par le suffixe DNS de la connexion avant d\'etre envoye.',
  },
  {
    id: 'recursion-through-the-tree', device: 'PC-GUICHET1', shell: 'powershell', command: 'Resolve-DnsName www.banquehorizon.com',
    expects: [/IPAddress\s*:\s*203\.0\.113\.20/],
    lesson: 'Le poste interroge DC1, qui redirige vers DNS-RES, qui descend racine, com puis banquehorizon.com.',
  },
  {
    id: 'forwarder-of-dc1', device: 'PC-GUICHET1', shell: 'powershell', command: 'Resolve-DnsName www.banquehorizon.com -Server 10.20.20.10',
    expects: [/IPAddress\s*:\s*203\.0\.113\.20/],
    lesson: 'DC1 ne connait pas la zone publique : il la resout par son redirecteur (Set-DnsServerForwarder 10.20.20.53).',
  },
  {
    id: 'mail-exchangers', device: 'PC-GUICHET1', shell: 'powershell', command: 'Resolve-DnsName banquehorizon.com -Type MX',
    expects: [/NameExchange\s*:\s*mail\.banquehorizon\.com/, /Preference\s*:\s*10/, /NameExchange\s*:\s*mail2\.banquehorizon\.com/, /Preference\s*:\s*20/],
    lesson: 'Deux enregistrements MX, la preference la plus basse est essayee la premiere.',
  },
  {
    id: 'reverse-lookup', device: 'PC-GUICHET1', shell: 'powershell', command: 'Resolve-DnsName 203.0.113.20',
    expects: [/NameHost\s*:\s*web\.banquehorizon\.com/],
    lesson: 'Le PTR de 203.0.113.20 vit dans 113.0.203.in-addr.arpa, delegue par la racine du lab.',
  },
  {
    id: 'secondary-answers', device: 'PC-GUICHET1', shell: 'powershell', command: 'Resolve-DnsName www.banquehorizon.com -Server 203.0.113.11',
    expects: [/IPAddress\s*:\s*203\.0\.113\.20/],
    lesson: 'NS2-BANK (Windows) sert la zone qu\'il a recue de NS1-BANK (BIND) par transfert de zone.',
  },
  {
    id: 'dynamic-registration', device: 'PC-GUICHET1', shell: 'powershell', command: 'Resolve-DnsName pc-guichet2.horizon.local',
    expects: [/IPAddress\s*:\s*10\.20\.10\.51/],
    lesson: 'Le serveur DHCP inscrit chaque bail dans horizon.local (mise a jour dynamique).',
  },
  {
    id: 'tcp-443', device: 'PC-GUICHET1', shell: 'powershell', command: 'Test-NetConnection www.banquehorizon.com -Port 443',
    expects: [/RemoteAddress\s*:\s*203\.0\.113\.20/, /TcpTestSucceeded\s*:\s*True/],
    lesson: 'Le nom est resolu puis le port 443 de WEB-BANK repond a travers R-AGENCE (NAT) et R-ISP.',
  },
  {
    id: 'linux-resolver', device: 'PC-CONSEILLER', shell: 'bash', command: 'dig www.banquehorizon.com +short',
    expects: [/web\.banquehorizon\.com\./, /203\.0\.113\.20/],
    lesson: 'Le poste Linux lit les serveurs DNS donnes par DHCP et suit le CNAME www vers web.',
  },
  {
    id: 'trace-from-the-root', device: 'PC-CONSEILLER', shell: 'bash', command: 'dig +trace @10.20.20.53 www.banquehorizon.com',
    expects: [/a\.root-servers\.net/, /a\.nic\.com/, /ns1\.banquehorizon\.com/, /web\.banquehorizon\.com\.\s+3600\s+IN\s+A\s+203\.0\.113\.20/],
    lesson: 'dig +trace refait a la main ce que fait un resolveur : racine, puis com, puis banquehorizon.com.',
  },
  {
    id: 'http-to-https', device: 'PC-CONSEILLER', shell: 'bash', command: 'curl -sI http://www.banquehorizon.com/',
    expects: [/301 Moved Permanently/, /Location: https:\/\/www\.banquehorizon\.com\//],
    lesson: 'Le port 80 ne sert que de redirection vers HTTPS.',
  },
  {
    id: 'https-site', device: 'PC-CONSEILLER', shell: 'bash', command: 'curl -sk https://www.banquehorizon.com/',
    expects: [/Accueil - Banque Horizon/, /<link rel="stylesheet" href="css\/site\.css">/],
    lesson: 'nginx choisit le bloc server d\'apres le nom demande (SNI et en-tete Host) et sert le site.',
  },
  {
    id: 'api-behind-the-vhost', device: 'PC-CONSEILLER', shell: 'bash', command: 'curl -sk https://ebanking.banquehorizon.com/api/taux.json',
    expects: [/"produits"/, /"Livret Horizon"/],
    lesson: 'Le site e-banking appelle une API servie par un autre bloc server de la meme machine.',
  },
  {
    id: 'dhcp-leases', device: 'DC1', shell: 'powershell', command: 'Get-DhcpServerv4Lease -ScopeId 10.20.10.0',
    expects: [/10\.20\.10\.50/, /10\.20\.10\.51/, /10\.20\.10\.52/],
    lesson: 'Trois baux : PC-GUICHET1, PC-GUICHET2 et PC-CONSEILLER.',
  },
  {
    id: 'tld-does-not-recurse', device: 'TLD-NS', shell: 'powershell', command: 'Get-DnsServerRecursion',
    expects: [/False/],
    lesson: 'Un serveur de TLD est purement faisant autorite : la recursion y est coupee.',
  },
  {
    id: 'web-listeners', device: 'WEB-BANK', shell: 'bash', command: 'ss -ltn',
    expects: [/0\.0\.0\.0:80\s/, /0\.0\.0\.0:443\s/],
    lesson: 'nginx ecoute reellement sur 80 et 443 : `systemctl status` ne suffit pas, ss le prouve.',
  },
];

export async function runLabChecks(devices: ReadonlyMap<string, Equipment>): Promise<LabCheckResult[]> {
  const shells = new Map<string, (line: string) => Promise<string>>();
  const powershellOf = (name: string): ((line: string) => Promise<string>) => {
    let run = shells.get(name);
    if (run === undefined) {
      const shell = PowerShellSubShell.create(devices.get(name) as never).subShell;
      run = async (line) => (await shell.processLine(line)).output.join('\n');
      shells.set(name, run);
    }
    return run;
  };
  const results: LabCheckResult[] = [];
  for (const check of LAB_CHECKS) {
    const device = devices.get(check.device);
    const output = device === undefined
      ? `missing device ${check.device}`
      : check.shell === 'bash' ? await device.executeCommand(check.command) : await powershellOf(check.device)(check.command);
    results.push({ check, output, missing: check.expects.filter((expected) => !expected.test(output)) });
  }
  return results;
}
