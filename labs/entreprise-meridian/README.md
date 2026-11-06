# Lab — Entreprise Meridian (FortiGate, VPN en étoile, Internet simulé)

Meridian Industries a un siège et trois agences. Chaque site est protégé par un **FortiGate**. Les agences sont reliées au siège par des tunnels **IPsec IKEv2** (topologie en étoile) ; Internet est simulé par un commutateur sur lequel se trouvent les WAN, un serveur web public et un poste visiteur.

## Importer

Barre d'outils → **Importer** → `topology.json`. Le fichier est généré par `src/labs/entrepriseMeridian/` : chaque équipement est configuré en tapant les mêmes commandes qu'un utilisateur (CLI FortiOS, PowerShell, bash).

## Équipements (17)

| Site | Équipement | Rôle | Adresse |
|------|-----------|------|---------|
| Internet | SW-INTERNET | commutateur d'Internet simulé | — |
| Internet | WEB-INTERNET | serveur web public (nginx) | 203.0.113.80 |
| Internet | PC-VISITEUR | client externe | 203.0.113.99 |
| Internet | PC-AUDIT | poste du prestataire d'audit de sécurité mandaté par la banque (scripts dans `/opt/audit`) | 203.0.113.90 |
| Siège | FGT-HQ | FortiGate : WAN `wan1`, LAN `port1`, DMZ `port2` | 203.0.113.1 / 10.0.0.1 / 172.16.0.1 |
| Siège | DC1 | Windows Server : AD DS + DNS `meridian.local` | 10.0.0.10 |
| Siège | ORA-DB | Linux : listener Oracle (1521) | 10.0.0.30 |
| Siège | PC-HQ | poste du siège | 10.0.0.50 |
| Siège (DMZ) | WEB-DMZ | Linux + nginx | 172.16.0.10 |
| Siège (DMZ) | MAIL-DMZ | Windows Server + **Microsoft Exchange** (rôle Mailbox), membre de `meridian.local` | 172.16.0.25 |
| Agence 1-3 | FGT-AGENCE1..3 | FortiGate : WAN `wan1` (203.0.113.2-4), LAN `port1` | 10.n.0.1 |
| Agence 1-3 | PC-AGENCE1..3 | poste d'agence | 10.n.0.50 |

Comptes : domaine `MERIDIAN`, `Administrator` / `DSRM@Mer1dian!`. Clé pré-partagée des tunnels : `Mer1dian-VPN-2026`.

## Ce que le lab démontre

| Vérification | Leçon |
|--------------|-------|
| `agency-to-headquarters-lan` | Le tunnel IPsec IKEv2 transporte le LAN de l'agence vers le LAN du siège. |
| `agency-to-domain-controller-dns` | Les agences interrogent le DNS de DC1 à travers le tunnel. |
| `agency-to-oracle-listener` | Le listener Oracle n'est atteignable depuis une agence que par le VPN. |
| `agency-to-dmz-web` | Une agence atteint la DMZ avec l'adresse privée, sans NAT. |
| `spoke-to-spoke-through-hub` | Deux agences se parlent par le siège : le concentrateur retransmet de tunnel à tunnel. |
| `tunnels-up` | `get vpn ipsec tunnel summary` montre un sélecteur monté par agence. |
| `hub-routing-entry-details` | `get router info routing-table details` : la route vers l'agence 1 sort par l'interface IPsec `to-ag1`. |
| `hub-originates-into-tunnel` | `execute ping` depuis le pare-feu vers la passerelle d'une agence traverse le tunnel. |
| `ipsec-crypto-counters` | `get vpn ipsec stats crypto` compte le trafic AES-256 / SHA-256 reellement echange. |
| `external-security-assessment` | Le prestataire d'audit déroule `/opt/audit/run-all.sh` depuis Internet : seuls les VIP web (80) et mail (25) répondent, ni SSH sur le VIP mail, ni Oracle 1521, ni le LAN privé. |
| `management-plane-not-on-wan` | Constat d'audit corrigé : le plan d'administration (GUI HTTPS, SSH) est retiré de `allowaccess` sur `wan1` ; seul `ping` reste. Sans ce durcissement, le script échoue. |
| `flood-resistance` | Deuxième durcissement issu de l'audit : la DoS-policy `wan-flood-protection` (icmp_flood 50/s, tcp_syn_flood 500/s, action block) freine une rafale visant le pare-feu lui-même, sans interrompre le site publié. Sans elle, le script échoue. |
| `visitor-reaches-published-web` | VIP `vip-web` (203.0.113.10:80 → WEB-DMZ) et politique `internet-to-web`. |
| `visitor-reaches-published-mail` | VIP `vip-mail` (:25 → MAIL-DMZ) ; Exchange écoute dès l'installation (connecteur *Default Frontend*). |
| `visitor-cannot-reach-oracle` | Seuls les ports publiés par un VIP traversent. |
| `visitor-cannot-reach-lan` | Le LAN privé n'est pas joignable depuis Internet. |
| `lan-to-internet-nat` | Le LAN sort sous l'adresse WAN (SNAT de la politique `lan-to-internet`). |
| `internal-dns-from-lan` | Les postes résolvent `www.meridian.local` auprès de DC1. |

Le premier paquet d'un tunnel déclenche la négociation IKE : lancer un ping depuis l'agence avant de regarder `get vpn ipsec tunnel summary`.

## Régénérer

```bash
UPDATE_LABS=1 npx vitest run src/__tests__/unit/labs/entreprise-meridian.test.ts
```

Le test construit le lab, l'exporte, le **réimporte dans un canevas vierge** et exige que les mêmes vérifications passent sur les deux.
