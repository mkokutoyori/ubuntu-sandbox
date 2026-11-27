import type { Equipment } from '@/network';
import { runChecks, type LabCheck, type LabCheckResult } from '../LabChecks';
import { DR, HQ, INTERNET } from './plan';

export const LUMIERE_CHECKS: readonly LabCheck[] = [
  {
    id: 'database-zone-reaches-recovery-site', device: 'ORA-PRD', shell: 'bash', command: `ping -c 2 ${DR.db.standby}`,
    expects: [/2 received/],
    lesson: 'Le tunnel IPsec FGT-HQ - FGT-DR transporte la zone des bases du siege vers celle du site de reprise : c\'est le chemin du redo Data Guard et des copies de sauvegarde.',
  },
  {
    id: 'tunnels-up', device: 'FGT-HQ', shell: 'bash', command: 'get vpn ipsec tunnel summary',
    expects: [/'to-dr'.*selectors\(total,up\): 1\/1/, /'to-ag1'.*selectors\(total,up\): 1\/1/, /'to-ag2'.*selectors\(total,up\): 1\/1/],
    lesson: 'Le siege voit ses trois tunnels : le site de reprise et les deux agences.',
  },
  {
    id: 'agency-reaches-dmz-web', device: 'PC-AG1', shell: 'bash', command: `curl -s http://${HQ.dmz.web1}/`,
    expects: [/Lumiere Boutique - frontal web 1/],
    lesson: 'Une agence atteint la DMZ du siege par le tunnel avec l\'adresse privee.',
  },
  {
    id: 'customer-reaches-shop-through-vip', device: 'PC-CLIENT', shell: 'bash', command: 'curl -s http://www.lumiere-boutique.com/',
    expects: [/Lumiere Boutique - frontal web 1/],
    lesson: 'Un client sur un autre reseau passe par R-ISP, resout www dans la zone publique de DNS-PUB et atteint le VIP du FortiGate, qui le traduit vers WEB-1.',
  },
  {
    id: 'customer-reaches-shop-over-tls', device: 'PC-CLIENT', shell: 'bash', command: `curl -sk https://${INTERNET.vipWeb}/`,
    expects: [/Lumiere Boutique - frontal web/],
    lesson: 'Le VIP HTTPS (server-load-balance, ssl-mode half) termine le TLS au FortiGate et repartit vers WEB-1 et WEB-2.',
  },
  {
    id: 'public-dns-zone', device: 'PC-CLIENT', shell: 'bash', command: 'nslookup www.lumiere-boutique.com',
    expects: [/203\.0\.113\.10/],
    lesson: 'La zone publique lumiere-boutique.com est servie par BIND sur DNS-PUB.',
  },
  {
    id: 'payment-gateway-through-nat', device: 'PC-HQ', shell: 'bash', command: 'curl -s http://pay.lumiere-boutique.com/',
    expects: [/Passerelle de paiement/],
    lesson: 'Le poste du siege resout pay.lumiere-boutique.com par la redirection conditionnelle de DC1 et atteint la passerelle externe en etant traduit (NAT) par FGT-HQ.',
  },
  {
    id: 'dhcp-relay-lease', device: 'DC1', shell: 'powershell', command: 'Get-DhcpServerv4Lease -ScopeId 10.10.20.0',
    expects: [/10\.10\.20\.100/],
    lesson: 'PC-HQ obtient son bail du DHCP de DC1 a travers le relais (ip helper-address) du routeur Cisco R-HQ : le serveur doit etre autorise dans l\'AD (Add-DhcpServerInDC) pour repondre.',
  },
  {
    id: 'internal-dns-from-dhcp-client', device: 'PC-HQ', shell: 'bash', command: 'nslookup ora-prd.lumiere.local',
    expects: [/10\.10\.30\.10/],
    lesson: 'Le client DHCP recoit DC1 comme serveur DNS et resout les noms des serveurs de base de donnees.',
  },
  {
    id: 'domain-has-two-controllers', device: 'DC2', shell: 'powershell', command: 'Get-ADDomainController -Filter *',
    expects: [/DC1/, /DC2/],
    lesson: 'DC2, au site de reprise, est un controleur de domaine supplementaire : le domaine survit a la perte du siege.',
  },
  {
    id: 'aaa-server-answers-network-admin', device: 'LOG-HQ', shell: 'bash', command: 'radtest netadmin Net@Lum1ere! 127.0.0.1 0 testing123',
    expects: [/Received Access-Accept/, /Cisco-AVPair = "shell:priv-lvl=15"/],
    lesson: 'FreeRADIUS sur LOG-HQ authentifie les administrateurs reseau et renvoie leur niveau de privilege IOS (Cisco-AVPair).',
  },
  {
    id: 'oracle-shop-schema', device: 'ORA-PRD', shell: 'bash', command: 'sqlplus -s / as sysdba @/home/oracle/scripts/health.sql',
    expects: [/SHOP_DATA/, /SHOP_IDX/, /NOARCHIVELOG/, /SHIPPED/],
    lesson: 'La base ORCL du siege porte le schema SHOP (tablespaces SHOP_DATA et SHOP_IDX, 12 commandes) : elle est livree en mode NOARCHIVELOG, ce que le tutoriel corrigera.',
  },
  {
    id: 'oracle-listener-from-app-tier', device: 'APP-1', shell: 'bash', command: `nc -zv -w 3 ${HQ.db.oracle} 1521`,
    expects: [/succeeded|open/i],
    lesson: 'Le serveur d\'application de la DMZ atteint le listener Oracle de la zone des bases a travers le FortiGate.',
  },
  {
    id: 'backup-share-exported', device: 'BKP-HQ', shell: 'bash', command: 'exportfs -v',
    expects: [/\/srv\/backup\/rman\s+10\.10\.30\.0\/24\(.*rw.*no_root_squash/, /\/srv\/backup\/rman\s+10\.20\.30\.0\/24\(.*ro/],
    lesson: 'BKP-HQ exporte le depot de sauvegardes en ecriture aux bases du siege et en lecture seule a la zone des bases du site de reprise.',
  },
  {
    id: 'backup-owner-matches-database-owner', device: 'BKP-HQ', shell: 'bash', command: 'id oracle',
    expects: [/uid=54321\(oracle\) gid=54321\(oinstall\)/],
    lesson: 'NFS identifie les proprietaires par numero : le serveur de sauvegarde porte le meme oracle (54321) que les hotes de bases, sans quoi RMAN ne peut pas ecrire.',
  },
];

export async function runLumiereChecks(devices: ReadonlyMap<string, Equipment>): Promise<LabCheckResult[]> {
  return runChecks(LUMIERE_CHECKS, devices);
}
