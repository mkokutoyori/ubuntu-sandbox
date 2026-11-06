import type { Equipment } from '@/network';
import { runChecks, type LabCheck, type LabCheckResult } from '../LabChecks';
import { HQ, INTERNET } from './plan';

export const MERIDIAN_CHECKS: readonly LabCheck[] = [
  {
    id: 'agency-to-headquarters-lan', device: 'PC-AGENCE1', shell: 'bash', command: `ping -c 2 ${HQ.workstation}`,
    expects: [/2 received/],
    lesson: 'Le tunnel IPsec IKEv2 AGENCE1 - siege transporte le LAN de l\'agence vers le LAN du siege.',
  },
  {
    id: 'agency-to-domain-controller-dns', device: 'PC-AGENCE2', shell: 'bash', command: `nslookup oracle.meridian.local ${HQ.dc1}`,
    expects: [/10\.0\.0\.30/],
    lesson: 'Les agences interrogent le DNS de DC1 a travers le tunnel (UDP 53 traverse la politique tunnel -> LAN).',
  },
  {
    id: 'agency-to-oracle-listener', device: 'PC-AGENCE3', shell: 'bash', command: `nc -zv -w 3 ${HQ.oracle} 1521`,
    expects: [/succeeded|open/i],
    lesson: 'Le listener Oracle du siege n\'est joignable depuis une agence que par le VPN.',
  },
  {
    id: 'agency-to-dmz-web', device: 'PC-AGENCE1', shell: 'bash', command: `curl -s http://${HQ.web}/`,
    expects: [/Meridian Industries/],
    lesson: 'Une agence atteint le serveur web de la DMZ par le tunnel, sans NAT, avec l\'adresse privee.',
  },
  {
    id: 'spoke-to-spoke-through-hub', device: 'PC-AGENCE1', shell: 'bash', command: 'ping -c 2 10.2.0.50',
    expects: [/2 received/],
    lesson: 'Deux agences se parlent en passant par le siege : le concentrateur retransmet de tunnel a tunnel.',
  },
  {
    id: 'tunnels-up', device: 'FGT-HQ', shell: 'bash', command: 'get vpn ipsec tunnel summary',
    expects: [/'to-ag1'.*selectors\(total,up\): 1\/1/, /'to-ag2'.*selectors\(total,up\): 1\/1/, /'to-ag3'.*selectors\(total,up\): 1\/1/],
    lesson: 'Le siege voit ses trois tunnels etablis, un selecteur par agence.',
  },
  {
    id: 'hub-routing-entry-details', device: 'FGT-HQ', shell: 'bash', command: 'get router info routing-table details 10.1.0.50',
    expects: [/Routing entry for 10\.1\.0\.0\/24/, /Known via "static", distance 10, metric 0, best/, /directly connected, to-ag1/],
    lesson: 'La route vers le LAN de l\'agence 1 est une statique qui sort par l\'interface IPsec to-ag1.',
  },
  {
    id: 'hub-originates-into-tunnel', device: 'FGT-HQ', shell: 'bash', command: 'execute ping 10.1.0.1',
    expects: [/5 packets received/],
    lesson: 'Le pare-feu atteint lui-meme la passerelle de l\'agence par le tunnel : la source est celle de l\'interface liee a la phase 1.',
  },
  {
    id: 'ipsec-crypto-counters', device: 'FGT-HQ', shell: 'bash', command: 'get vpn ipsec stats crypto',
    expects: [/aes:\s+[1-9]\d*\s+[1-9]\d*/, /sha256:\s+[1-9]\d*\s+[1-9]\d*/],
    lesson: 'Les compteurs de chiffrement sont ceux du trafic reellement echange (AES-256 / SHA-256 de la proposition).',
  },
  {
    id: 'flood-resistance', device: 'PC-AUDIT', shell: 'bash', command: 'bash /opt/audit/check-flood-resistance.sh',
    expects: [/PASS: ICMP flood throttled/, /PASS: published site still served after the burst/],
    lesson: 'La DoS-policy wan-flood-protection (icmp_flood a 50/s, tcp_syn_flood a 500/s, action block) freine une rafale visant le pare-feu lui-meme, sans interrompre le service publie.',
  },
  {
    id: 'visitor-reaches-published-web', device: 'PC-VISITEUR', shell: 'bash', command: `curl -s http://${INTERNET.web.replace(/\d+$/, '10')}/`,
    expects: [/Meridian Industries/],
    lesson: 'Le VIP vip-web publie 203.0.113.10:80 vers WEB-DMZ ; la politique internet-to-web l\'autorise.',
  },
  {
    id: 'visitor-reaches-published-mail', device: 'PC-VISITEUR', shell: 'bash', command: `nc -zv -w 3 ${HQ.wanVip.mail} 25`,
    expects: [/succeeded|open/i],
    lesson: 'Le VIP vip-mail publie le port 25 vers MAIL-DMZ (Exchange) ; le connecteur Default Frontend ecoute des l\'installation.',
  },
  {
    id: 'visitor-cannot-reach-oracle', device: 'PC-VISITEUR', shell: 'bash', command: `nc -zv -w 3 ${HQ.wanVip.web} 1521`,
    expects: [/refused|timed out|failed|unreachable/i],
    lesson: 'Seuls les ports publies par un VIP traversent : 1521 n\'est pas publie.',
  },
  {
    id: 'visitor-cannot-reach-lan', device: 'PC-VISITEUR', shell: 'bash', command: `ping -c 2 ${HQ.workstation}`,
    expects: [/100% packet loss|Network is unreachable/],
    lesson: 'Le LAN prive n\'est pas routable depuis Internet.',
  },
  {
    id: 'lan-to-internet-nat', device: 'PC-HQ', shell: 'bash', command: `curl -s http://${INTERNET.web}/`,
    expects: [/Internet - site de demonstration/],
    lesson: 'Le LAN sort vers Internet sous l\'adresse WAN du pare-feu (SNAT de la politique lan-to-internet).',
  },
  {
    id: 'internal-dns-from-lan', device: 'PC-HQ', shell: 'bash', command: 'nslookup www.meridian.local',
    expects: [/172\.16\.0\.10/],
    lesson: 'Les postes du siege resolvent les noms internes aupres de DC1.',
  },
  {
    id: 'external-security-assessment', device: 'PC-AUDIT', shell: 'bash', command: 'bash /opt/audit/run-all.sh',
    expects: [/PASS: site identified/, /PASS: SMTP reachable as scoped/, /PASS: SSH not exposed/, /PASS: database port not exposed/, /PASS: internal LAN not routable/],
    lesson: 'Le prestataire d\'audit mandate par la banque verifie depuis Internet que seul le perimetre publie (VIP web et mail) repond, et que rien d\'autre n\'est expose.',
  },
  {
    id: 'management-plane-not-on-wan', device: 'PC-AUDIT', shell: 'bash', command: 'bash /opt/audit/check-mgmt-exposure.sh',
    expects: [/PASS: admin HTTPS not exposed on WAN/, /PASS: admin SSH not exposed on WAN/],
    lesson: 'Suite au constat d\'audit, le plan d\'administration (GUI HTTPS, SSH) est retire de allowaccess sur wan1 : seul ping reste, l\'admin passe par le LAN ou le VPN.',
  },
];

export function runMeridianChecks(devices: ReadonlyMap<string, Equipment>): Promise<LabCheckResult[]> {
  return runChecks(MERIDIAN_CHECKS, devices);
}
