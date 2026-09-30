# DHCP : état de l'implémentation par RFC

Sources : les textes déposés dans `docs/rfc/dhcp/` (RFC 2131, 2132, 4388, 6926, 8156, 8415). Les serveurs
concernés partagent un même moteur (`DHCPServer` pour IPv4, `DHCPv6Server` pour IPv6) et un point d'entrée
unique par famille (`buildDhcpServerReply`, `buildDhcpv6ServerReply`) : une amélioration du moteur profite
à Cisco, Huawei, Windows Server, dhcpd Linux, aux SVI de commutateur et au FortiGate.

## Synthèse

| RFC | Objet | État | Où |
|---|---|---|---|
| 2131 | DHCPv4 : conformité du serveur | Fait : états SELECTING / INIT-REBOOT / RENEWING, NAK, serveur muet pour un client inconnu sauf `authoritative`, identité du client (option 61), siaddr / file, bail restant | moteur v4 |
| 2132 | Options DHCPv4 | Fait pour les options servies (60, 61, 82 lues ; 91, 92, 151 à 157 pour le leasequery). Le reste des options est stocké tel qu'annoncé par chaque plateforme | codec v4 |
| 4388 | Leasequery v4 (types 10 à 13) | Fait, activable par moteur ; commande d'activation seulement sur dhcpd (`leasequery on;`) | moteur v4, dhcpd |
| 6926 | Bulk leasequery (TCP 67) | Fait : cadrage sur 2 octets, types 14 et 15, options 151 à 157, statuts, plafond de 10 connexions, demandeurs autorisés | `DhcpBulkLeasequery.ts` |
| 8415 | DHCPv6 : serveur | Fait : validation §16, unicast §18.4, Rapid Commit, Solicit / Request / Confirm / Renew / Rebind / Release / Decline, statuts, IA_NA multiples, IA_PD (dynamique et statique), T1 / T2, ORO, préférence, réservations, exclusions | `dhcpv6/` |
| 8415 | DHCPv6 : client | Fait : Renew, Rebind, Confirm, Release, Decline, Rapid Commit, IA_PD, reprise par Request sur NoBinding | `EndHost` |
| 8415 | DHCPv6 : relais (§19) | Fait : Relay-forward re-emballé, relais en cascade, hop-count | `IPv6DataPlane` |
| 8156 | Failover DHCPv6 | Non fait (le failover v4 existe côté Windows) | |

## Par plateforme

| Plateforme | DHCPv4 | DHCPv6 | Remarques |
|---|---|---|---|
| Cisco IOS | Moteur commun | Commun : `rapid-commit`, `preference`, `prefix-delegation` (pool local et statique), `ipv6 local pool`, `show ipv6 dhcp binding` et `pool`, rendu dans `show running-config` | Formats de `show` repris de la documentation Cisco de mémoire, non vérifiés mot à mot |
| Huawei VRP | Moteur commun | Le moteur sert IA_NA et IA_PD sur le fil ; les commandes `display dhcpv6` existantes lisent une table libre et non le moteur | Syntaxe VRP de la délégation et formats d'affichage non sourcés : rien n'a été inventé |
| Windows Server | Moteur commun, failover | Cmdlets `DhcpServerv6*` : scopes, exclusions, réservations, options DNS et liste de recherche, baux ; durées par défaut Windows (8 j, 12 j, T1 4 j, T2 6,4 j) | Messages d'erreur exacts non vérifiés |
| dhcpd Linux | Moteur commun, `leasequery on;` | `dhcpd -6` : `subnet6`, `range6`, `prefix6`, `host` avec `fixed-address6` / `fixed-prefix6`, options `dhcp6.*`, unité `isc-dhcp-server6`, `dhcpd6.leases` | Syntaxe de `dhcpd.conf(5)` de mémoire ; pas de leasequery v6 (RFC 5007 absente du dépôt) |
| FortiGate | Moteur commun, nombreux attributs | Sert IA_NA sur le fil ; ni Rapid Commit ni IA_PD (aucune syntaxe FortiOS sourcée) | |

## Limites assumées

- Reconfigure (RFC 8415 §18.3.11, RKAP §20.4), Server Unicast (§21.12) et Information Refresh Time (§21.23) : implémentés dans le moteur, le client et les serveurs d'hôte. Le HMAC-MD5 est calculé sur les octets du codec `Dhcpv6Codec` (format du §8 et du §21), champ d'authentification à zéro ; la longueur UDP est celle du message encodé ; le serveur retransmet à REC_TIMEOUT en doublant, 8 fois au plus, sur l'ordonnanceur ; un client derrière un ou plusieurs relais reçoit le Reconfigure dans un Relay-reply. Le client résout le voisin du serveur (NDP) avant d'unicaster. Les messages circulent toujours sous forme d'objets dans les trames du simulateur ; le codec sert au calcul d'authentification et à la longueur. Commandes d'activation, avec leur source : Cisco `rapid-commit`, `preference`, `information refresh` ; Huawei `dhcpv6 rapid-commit` (vue système) et `information-refresh` (pool, 600 à 4294967295 s) ; FortiGate `set rapid-commit` (référence FortiOS 7.4.12 fournie) ; Windows options 12 et 32 ; dhcpd `dhcp6.unicast`, `dhcp6.info-refresh-time`. Il n'existe pas de commande de Reconfigure ni de Server Unicast sur Cisco (Reconfigure déclaré non pris en charge par la documentation consultée), ni sur FortiGate (absents de la référence) ; pour Huawei, seuls des extraits ont été lus et aucune commande serveur de Server Unicast ou de Reconfigure n'y figurait : le Reconfigure s'active par l'API du moteur.
- La limite de sauts d'un relais est de 8 (table du §7.6 de la RFC fournie, qui note la réduction de 32 à 8) : le code en utilisait 32.
- Relay-ID (RFC 6925) et VPN-ID (RFC 6607) ne sont pas dans `docs/rfc/dhcp` : une requête bulk par Relay-ID ne correspond à rien, une requête par VPN-ID est terminée par `QueryTerminated`.
- Les commandes d'activation du leasequery sur Cisco, Huawei, Windows et FortiGate ne sont pas sourcées : le moteur les porte, aucune commande n'a été inventée.
