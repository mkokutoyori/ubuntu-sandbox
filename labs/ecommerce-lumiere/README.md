# Lab — Lumière Boutique (e-commerce, site de reprise, Oracle et RMAN)

Lumière Boutique vend de la décoration lumineuse sur Internet. Sa boutique en ligne tourne sur une base **Oracle** : si la base s'arrête, on ne vend plus ; si elle est perdue, on perd les commandes. L'entreprise a donc un **siège** (le datacenter principal), un **site de reprise** (le datacenter de secours, relié au siège par un tunnel IPsec) et **deux agences** (un magasin à Paris, un entrepôt à Lyon). Internet est simulé par un commutateur, un routeur Cisco « opérateur » et quelques serveurs.

Ce lab est le terrain du tutoriel **[Oracle et RMAN : sauvegarder, restaurer, reprendre après sinistre](tutoriel-oracle-rman/README.md)**, qui est dans le sous-répertoire `tutoriel-oracle-rman/`.

## Importer

Barre d'outils → **Importer** → `topology.json`. Le fichier est généré par `src/labs/ecommerceLumiere/` : chaque équipement est configuré en tapant les mêmes commandes qu'un utilisateur (CLI FortiOS, IOS, VRP, PowerShell, bash, SQL*Plus). Rien n'est injecté dans les moteurs.

## Plan d'adressage

| Zone | Réseau | Passerelle | Remarque |
|------|--------|-----------|----------|
| Internet (opérateurs) | 203.0.113.0/24 | R-ISP `.254` | WAN de FGT-HQ `.1`, FGT-DR `.2`, FGT-AG1 `.11`, FGT-AG2 `.12` ; DNS public `.53` ; VIP de la boutique `.10` |
| Réseau des clients | 198.51.100.0/24 | R-ISP `.1` | PC-CLIENT `.50`, passerelle de paiement PAY-EXT `.80` |
| Siège — transit | 10.10.255.0/30 | FGT-HQ `.1`, R-HQ `.2` | |
| Siège — serveurs | 10.10.10.0/24 | R-HQ `.1` | DC1 `.10`, LOG-HQ `.40` |
| Siège — utilisateurs | 10.10.20.0/24 | R-HQ `.1` | DHCP de DC1 par relais, plage `.100`–`.200` |
| Siège — bases de données | 10.10.30.0/24 | R-HQ `.1` | ORA-PRD `.10`, BKP-HQ `.20` |
| Siège — DMZ | 172.16.10.0/24 | FGT-HQ `.1` | WEB-1 `.11`, WEB-2 `.12`, APP-1 `.21` |
| Reprise — transit | 10.20.255.0/30 | FGT-DR `.1`, R-DR `.2` | |
| Reprise — serveurs | 10.20.10.0/24 | R-DR `.1` | DC2 `.10` |
| Reprise — bases de données | 10.20.30.0/24 | R-DR `.1` | ORA-STB `.10`, BKP-DR `.20` |
| Reprise — DMZ | 172.17.10.0/24 | FGT-DR `.1` | WEB-DR `.11` |
| Agence 1 (Paris) | 10.1.0.0/24 | FGT-AG1 `.1` | PC-AG1 `.50` |
| Agence 2 (Lyon) | 10.2.0.0/24 | FGT-AG2 `.1` | PC-AG2 `.50` |

## Équipements

| Site | Équipement | Éditeur / système | Rôle |
|------|-----------|-------------------|------|
| Internet | SW-INTERNET, SW-CLIENTS | commutateurs génériques | opérateurs ; réseau des clients |
| Internet | R-ISP | Cisco IOS (routeur) | routeur de l'opérateur entre les deux réseaux |
| Internet | DNS-PUB | Linux + BIND | zone publique `lumiere-boutique.com` |
| Internet | PC-CLIENT, PAY-EXT | Linux | un client ; la passerelle de paiement (nginx) |
| Siège | FGT-HQ | FortiGate | pare-feu, VIP et équilibrage HTTPS, tunnels IPsec, journaux syslog |
| Siège | R-HQ | Cisco IOS (routeur) | routage entre serveurs, utilisateurs et bases ; relais DHCP |
| Siège | SW-HQ-SRV, SW-HQ-USR, SW-HQ-DB | Cisco IOS (commutateurs) | un VLAN par zone |
| Siège | DC1 | Windows Server | Active Directory `lumiere.local`, DNS, DHCP |
| Siège | LOG-HQ | Linux | collecteur rsyslog (UDP 514) et serveur FreeRADIUS (AAA) |
| Siège (DMZ) | WEB-1, WEB-2, APP-1 | Linux | frontaux web (nginx) et serveur d'application |
| Siège (bases) | ORA-PRD | Linux + Oracle 19c | la base de production `ORCL`, schéma `SHOP` |
| Siège (bases) | BKP-HQ | Linux + NFS | dépôt de sauvegardes `/srv/backup/rman` |
| Reprise | FGT-DR | FortiGate | pare-feu, tunnel vers le siège |
| Reprise | R-DR | Huawei VRP (routeur) | routage des serveurs et des bases |
| Reprise | SW-DR-SRV, SW-DR-DB | Huawei VRP (commutateurs) | VLAN serveurs et VLAN bases |
| Reprise | DC2 | Windows Server | second contrôleur de domaine, DNS |
| Reprise | ORA-STB, BKP-DR | Linux (+ Oracle, + NFS) | hôte de la base de reprise ; dépôt de sauvegardes du site de reprise |
| Reprise (DMZ) | WEB-DR | Linux | frontal web de secours |
| Agence 1-2 | FGT-AG1, FGT-AG2 | FortiGate | pare-feu et tunnel vers le siège |
| Agence 1-2 | SW-AG1 (Cisco), SW-AG2 (Huawei), PC-AG1, PC-AG2 | | poste d'agence |

Comptes : domaine `LUMIERE`, `Administrator` / `DSRM@Lum1ere!`. Administrateur réseau (AAA) : `netadmin` / `Net@Lum1ere!`. Clé pré-partagée des tunnels : `Lum1ere-VPN-2026`. Secret RADIUS des équipements : `Lum1ere-AAA` (clients `10.10.0.0/16` et `10.20.0.0/16`). Oracle : `SYS` par authentification système (`sqlplus / as sysdba`), `SYSTEM` / `oracle`, application `SHOP` / `Shop#2026`.

## Ce que le lab démontre

Les vérifications sont dans `src/labs/ecommerceLumiere/checks.ts` ; le test construit le lab, l'exporte, le **réimporte dans un canevas vierge** et exige que les mêmes vérifications passent sur les deux.

## Régénérer

```bash
UPDATE_LABS=1 npx vitest run src/__tests__/unit/labs/ecommerce-lumiere.test.ts
```
