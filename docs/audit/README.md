# Dossier d'audit — Ubuntu Sandbox

Audit de bout en bout du simulateur (protocoles, équipements, systèmes de
fichiers, langages, base de données, UI, architecture logicielle), réalisé
le 2026-07-22.

## Périmètre et découpage

| Rapport | Domaine | Périmètre principal |
|---|---|---|
| [00-synthese.md](00-synthese.md) | Synthèse consolidée | Classement global, feuille de route priorisée |
| [01-protocoles-L2.md](01-protocoles-L2.md) | Couche 2 | STP/RSTP, VLAN/VTP/DTP, LACP, CDP/LLDP, UDLD, ARP, IGMP-snooping, 802.1X, port-security |
| [02-protocoles-L3-routage.md](02-protocoles-L3-routage.md) | Couche 3 / routage | OSPF, BGP, EIGRP, RIP, BFD, HSRP/VRRP/GLBP, PIM/IGMP, NAT, ACL, IPv6, table de routage |
| [03-transport-services.md](03-transport-services.md) | Transport & services | TCP/UDP, SSH/SCP/SFTP, DHCP, DNS, NTP, SNMP, syslog, NetFlow, RADIUS/TACACS+, IPSec/GRE/VXLAN/NHRP |
| [04-equipements-data-plane.md](04-equipements-data-plane.md) | Équipements & data plane | Equipment/Port/Cable, cycle de vie des trames, EquipmentRegistry, devices stubbés, pont store↔simulation |
| [05-simulation-linux.md](05-simulation-linux.md) | Simulation Linux | Interpréteur bash, VFS, processus, IAM, coreutils, /proc, systemd, double dispatch |
| [06-windows-powershell.md](06-windows-powershell.md) | Simulation Windows | Interpréteur PowerShell (pipeline objet), cmdlets, registre, event log, services, cmd.exe |
| [07-oracle-sql.md](07-oracle-sql.md) | Oracle / SQL | Moteur SQL, transactions/ACID, architecture instance, PL/SQL, Data Guard/Flashback/CDB, listener |
| [08-genie-logiciel.md](08-genie-logiciel.md) | Génie logiciel | Métriques, anti-patterns, frontières architecturales, asynchronisme, stratégie de test, dette |
| [09-interface-utilisateur.md](09-interface-utilisateur.md) | UI | React/Zustand, canvas, performance, UX, accessibilité, fidélité du terminal |
| [10-rman.md](10-rman.md) | RMAN | Matrice de couverture des commandes vs Oracle 19c, scénarios backup/restore/recover |
| [11-transcripts-debug-2026-08.md](11-transcripts-debug-2026-08.md) | Transcripts de debug | Régénération des 125 transcripts (2026-08-03) et dépouillement des manques, vérifiés sur équipement |

## Méthodologie

- **Lecture de code en profondeur** avec vérification croisée : état interne
  des engines ↔ sorties des commandes `show`/`display` ↔ tests existants
  (~14 500 tests unitaires dans `src/__tests__/`).
- **Exécution ciblée de tests** quand un comportement devait être confirmé
  empiriquement plutôt que supposé.
- **Traçage de chemins de code complets** pour la question structurante de
  l'audit (voir ci-dessous), étape par étape avec référence `fichier:ligne`.
- Chaque constat est **sourcé** (`src/chemin/Fichier.ts:ligne`) et **justifié**
  par une référence externe : RFC, standard IEEE 802.x, POSIX, comportement
  documenté Cisco IOS / Huawei VRP / Ubuntu / PowerShell 5.1-7 / Oracle 19c.
- Les points **bien implémentés** sont aussi relevés, pour calibrer la
  confiance et éviter de refactorer ce qui fonctionne.

## Question structurante : la communication par paquets

Exigence produit : **toute communication entre machines doit passer par de
véritables échanges de paquets à travers le réseau simulé** (trames Ethernet
transmises Port→Cable→Port, avec ARP, encapsulation IP/TCP/UDP), jamais par
appel direct de méthode sur l'objet distant ni par résolution via un
registre global.

Chaque rapport concerné rend un verdict par service selon la grille :

| Verdict | Signification |
|---|---|
| **réel** | Le trafic est encapsulé et transite trame par trame par le data plane |
| **hybride** | Une partie du dialogue passe par le réseau, le reste court-circuite |
| **magique** | Le résultat est obtenu par accès direct à l'objet distant, sans paquet |

## Grille de sévérité

| Sévérité | Critère |
|---|---|
| **CRITIQUE** | Contredit le principe fondateur du simulateur (communication par paquets, réalisme observable par l'utilisateur) ou fausse massivement le comportement pédagogique |
| **MAJEUR** | Écart significatif au standard/à la réalité, visible dans les cas d'usage courants |
| **MINEUR** | Écart cosmétique ou cas limite, faible impact pédagogique |

Marqueurs utilisés dans les rapports : ✅ solide · ❌ non conforme / irréaliste ·
⚠️ manquant · 💡 amélioration proposée.
