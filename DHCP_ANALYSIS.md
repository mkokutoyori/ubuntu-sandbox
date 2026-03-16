# Analyse de l'implémentation DHCP

## Vue d'ensemble

L'implémentation DHCP couvre ~2400 lignes réparties sur 7 fichiers :
- `src/network/dhcp/types.ts` (338 lignes) — Types et interfaces
- `src/network/dhcp/DHCPServer.ts` (756 lignes) — Moteur serveur
- `src/network/dhcp/DHCPClient.ts` (681 lignes) — Machine à états client
- `src/network/dhcp/index.ts` (3 lignes) — Exports
- `src/network/devices/shells/cisco/CiscoDhcpCommands.ts` (123 lignes) — CLI Cisco IOS
- `src/network/devices/shells/huawei/HuaweiDhcpCommands.ts` (86 lignes) — CLI Huawei VRP
- `src/__tests__/unit/network-v2/dhcp_complete.test.ts` (611 lignes) — Tests

---

## Ce qui est réaliste et bien implémenté

### 1. Machine à états RFC 2131 complète
La machine à états client (INIT → SELECTING → REQUESTING → BOUND → RENEWING → REBINDING)
est fidèle au diagramme §4.4 de la RFC. Les transitions INIT-REBOOT/REBOOTING pour la
réutilisation de bail après redémarrage sont aussi implémentées.

### 2. Processus DORA complet
Le flux Discover→Offer→Request→Ack est correctement orchestré avec :
- Validation du XID sur chaque réponse (RFC 2131 §3.1)
- Option 54 (Server Identifier) dans OFFER/ACK
- Option 50 (Requested IP) dans REQUEST
- Option 61 (Client Identifier = 01 + MAC) correctement formaté
- Option 55 (Parameter Request List) envoyée dans DISCOVER

### 3. Gestion des offres pendantes (RFC 2131 §3.1.2)
Les IPs sont réservées entre DISCOVER et REQUEST via `pendingOffers` avec un timeout de 60s.

### 4. Détection de conflits ARP (RFC 2131 §3.1.5)
Le client effectue un ARP probe après ACK et envoie DHCPDECLINE si conflit.
Le serveur enregistre le conflit et libère le binding.

### 5. Timers T1/T2 corrects
T1 = 50% du bail (RENEWING, unicast au serveur d'origine),
T2 = 87.5% (REBINDING, broadcast) — conforme à RFC 2131 §4.4.5.

### 6. Validation MAC+IP sur RELEASE (RFC 2131 §3.4.4)
Le serveur vérifie que le client qui libère possède bien le binding.

---

## Ce qui est mal implémenté

### 1. Pas de vrai paquet DHCP — appels directs de méthodes
**Fichier** : `DHCPClient.ts:188-203`

Le client appelle directement `server.processDiscover()` au lieu de construire un vrai
paquet UDP broadcast sur port 67/68. Pas de structure BOOTP header
(op, htype, hlen, hops, xid, secs, flags, ciaddr, yiaddr, siaddr, giaddr, chaddr).

### 2. `autoAssignLease` : comportement irréaliste
**Fichier** : `DHCPClient.ts:540-582`

Quand aucun serveur n'est connecté en mode non-verbose, le client génère une IP
déterministe à partir du MAC (192.168.1.x). Un vrai client échouerait ou utiliserait
APIPA (169.254.x.x).

### 3. `allocateAddress` et `processDiscover` font doublon
**Fichier** : `DHCPServer.ts:179-221` vs `229-301`

`allocateAddress()` effectue une allocation et incrémente `stats.acks` directement,
contournant le processus DORA. Crée des incohérences si utilisé.

### 4. Statistiques décrémentées manuellement
**Fichier** : `DHCPServer.ts:326-327`

Quand un REQUEST est pour un autre serveur, `stats.requests--` est exécuté.
Un vrai serveur ignorerait le paquet sans incrémenter.

### 5. Timer d'expiration basé sur durée relative
**Fichier** : `DHCPClient.ts:667-673`

Le timer utilise `lease.leaseDuration * 1000` au lieu de `lease.expiration - Date.now()`.
Si le bail est renouvelé, le timer ne sera pas recalculé correctement.

### 6. T1/T2 calculés incorrectement dans initReboot
**Fichier** : `DHCPClient.ts:392-393`

Problème de priorité d'opérateurs dans le calcul du fallback T1/T2.

### 7. Le RENEWING ne relance pas les timers
**Fichier** : `DHCPClient.ts:614-633`

Après un renouvellement réussi à T1, `setupLeaseTimers` n'est pas appelé,
contrairement au REBINDING (ligne 659). Les timers T2 et expiration gardent
les anciennes valeurs.

---

## Ce qui manque

1. **Aucune structure de paquet DHCP** — Pas de sérialisation/désérialisation,
   pas de magic cookie, pas d'encodage TLV des options.

2. **Pas de DHCPINFORM** — Compté dans les stats mais aucune méthode `processInform()`.

3. **Pas de réservations statiques** — Le type `'manual'` existe mais aucun mécanisme
   de réservation IP-MAC.

4. **Pas de sélection de pool par interface/giaddr** — Le serveur itère les pools
   séquentiellement au lieu d'utiliser le giaddr.

5. **Pas de nettoyage des baux expirés côté serveur** — Les bindings restent en
   mémoire indéfiniment.

6. **DHCP Relay non fonctionnel** — Configuration stockée mais jamais utilisée.

7. **Pas de retransmission avec backoff exponentiel** — Un seul DISCOVER envoyé.
   La RFC 2131 §4.1 spécifie backoff 4s, 8s, 16s, 64s max.

8. **Pas de DHCPNAK explicite** — Le serveur retourne `null` au lieu d'un vrai NAK.

9. **Pas de TTL sur les conflits** — Une IP en conflit est bloquée éternellement.

10. **DHCP Snooping non fonctionnel** — Structures définies mais aucune logique
    de filtrage réelle.

---

## Améliorations recommandées

| Priorité | Amélioration | Impact |
|----------|-------------|--------|
| Haute | Ajouter une structure `DHCPPacket` avec sérialisation/désérialisation | Réalisme, extensibilité |
| Haute | Corriger les timers de renouvellement (relancer après T1, calculer temps restant) | Correctitude |
| Haute | Nettoyage des baux expirés côté serveur | Fuite mémoire |
| Moyenne | Sélection de pool par interface/giaddr | Conformité RFC |
| Moyenne | Implémenter le backoff exponentiel pour DISCOVER | Réalisme |
| Moyenne | Supprimer `autoAssignLease` ou le remplacer par APIPA (169.254.x.x) | Réalisme |
| Moyenne | Implémenter DHCPINFORM | Complétude RFC |
| Moyenne | Ajouter les réservations statiques (manual bindings) | Fonctionnalité |
| Basse | Rendre le DHCP Relay fonctionnel | Fonctionnalité |
| Basse | Implémenter le DHCP Snooping réel | Sécurité |
| Basse | Ajouter un TTL aux conflits | Correctitude |

---

## Conclusion

L'implémentation est une bonne **simulation fonctionnelle** du protocole DHCP avec une
machine à états conforme à la RFC 2131. Les types sont bien structurés et les CLI
Cisco/Huawei sont fidèles. Cependant, c'est une **abstraction de haut niveau** : pas de
vrais paquets réseau, pas de transport UDP, et plusieurs bugs subtils dans les timers et
le calcul des durées. Les fonctionnalités avancées (relay, snooping, INFORM, réservations
statiques) sont déclarées mais non implémentées.
