# PRD — resolvectl : un stub qui écoute sans répondre

**Version** : 1.0
**Date** : 2026-07-28
**Projet** : Ubuntu Sandbox — Résolution de noms
**Auteur** : Claude Code
**Références normatives** : `resolvectl(1)`, `systemd-resolved.service(8)`, `resolved.conf(5)`, `nss-resolve(8)`, RFC 1034/1035, RFC 6762 (mDNS), RFC 4795 (LLMNR)

---

## 0. Contexte et portée du document

Ce PRD ferme la série ouverte par `networkctl` (l'état des liens) et
`networkd` (leur configuration). Il traite le dernier maillon : la
résolution de noms telle que systemd la rend.

Le constat mesuré est plus gênant que les deux précédents, parce que le
système **affirme** quelque chose de faux plutôt que de rester muet :

```
$ systemctl is-active systemd-resolved
active
$ ss -ulnp
UNCONN 0 0 127.0.0.53:53 0.0.0.0:*  users:(("systemd-resolved",pid=540,fd=3))
$ resolvectl status
resolvectl: command not found
```

Le service est déclaré actif, `ss` montre un stub à l'écoute sur
`127.0.0.53:53` — et ce socket ne répond à rien. C'est un `bind()` sans
gestionnaire, posé pour que `ss` et `netstat` aient l'air justes. Le
client qui interrogerait ce stub, `resolvectl`, n'existe pas du tout.

Corollaire déjà rencontré : le résolveur NSS **filtre explicitement toute
adresse `127.*`** de `/etc/resolv.conf` (`LinuxMachine`, commentaire
« loopback = systemd-resolved stub, modelled by the legacy fallback »).
C'est ce qui a justifié, dans `docs/PRD-networkd.md` §7, d'écrire les
serveurs en clair plutôt que de pointer vers le stub. Ce PRD lève la
cause : une fois le stub réel, pointer vers lui devient possible.

Le périmètre est : faire exister `resolvectl`, puis rendre le stub
honnête, puis la configuration par lien, puis les fichiers d'exécution.
Aucune ligne de code n'est écrite dans le cadre de ce document.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Lignes |
|---|---|---|
| `src/network/dns/resolver/DnsCache.ts` | **Cache réel** : positif/négatif, décroissance TTL, `flush()` | ~85 |
| `src/network/dns/resolver/RecursiveResolver.ts` | Résolution récursive réelle | — |
| `src/network/dns/resolver/AuthoritativeServer.ts` | Serveur autoritatif | — |
| `src/network/dns/dnssec/` | `DnsValidator`, `DnsSigner`, `DnsKey`, `Nsec`, `Digest` | — |
| `src/network/dns/wire/` | Encodage/décodage de messages DNS réels | — |
| `src/network/devices/LinuxMachine.ts` | `setWireResolver` (NSS `dns` → UDP/53 réel), `initDefaultSockets` (l. 1337, le stub creux) | — |
| `src/network/devices/linux/LinuxDnsService.ts` | dnsmasq de l'hôte : enregistrements, `query`, `reverseQuery` | — |
| `src/network/devices/linux/LinuxServiceManager.ts` | Unité `systemd-resolved.service` (l. 206) | — |
| `src/network/devices/linux/commands/dns/DigRunner.ts` | `dig`, qui consomme déjà `DnsCache` | — |

### 1.2 Ce qui existe déjà et est réutilisable

- **Le cache est réel et complet** : `DnsCache` gère le positif, le
  négatif avec TTL du SOA, la décroissance du TTL à la lecture et le
  vidage. C'est exactement le socle de `resolvectl statistics`,
  `flush-caches` et `show-cache` — il ne lui manque que des compteurs.
- **Le moteur DNS est réel** : encodage/décodage de messages sur le fil,
  résolution récursive, DNSSEC (validateur, signataire, NSEC).
  `dig` s'en sert déjà.
- **NSS est réel** : `/etc/nsswitch.conf` porte `hosts: files dns`, la
  source `files` lit `/etc/hosts`, la source `dns` fait de vraies
  requêtes UDP/53 sur le câble.
- **L'unité `systemd-resolved.service` existe**, tourne, et a son
  utilisateur dédié — le point d'ancrage du cycle de vie est déjà là,
  comme il l'était pour networkd.
- **`networkd` écrit désormais `/etc/resolv.conf`** (livré) : les
  serveurs déclarés et ceux du bail y arrivent déjà, dans l'ordre de
  systemd.

### 1.3 Ce qui manque ou court-circuite (analyse d'écart)

| # | Écart constaté | Comportement réel attendu | Sévérité |
|---|---|---|---|
| 1 | `127.0.0.53:53` est un `bind()` sans gestionnaire : le stub écoute et ne répond à rien, alors que `ss` l'annonce | Le stub répond aux requêtes, en cache ou en amont | Bloquant |
| 2 | `resolvectl` : commande inconnue | La commande existe, avec ses verbes | Bloquant |
| 3 | `systemd-resolve` (alias hérité) : commande inconnue | Alias de `resolvectl` | Faible |
| 4 | Le résolveur NSS filtre toute adresse `127.*` — le stub est inutilisable **par construction** | Une fois le stub réel, `nameserver 127.0.0.53` fonctionne | Élevée |
| 5 | Aucun cache côté hôte Linux : `DnsCache` n'est instancié que par bind9, `dig` et Windows | Le résolveur du système garde ses réponses | Élevée |
| 6 | Aucune notion de serveur DNS **par lien** | `resolvectl dns <lien> <ip>` ; chaque lien a ses serveurs | Élevée |
| 7 | `/etc/systemd/resolved.conf` n'existe pas (`ls /etc/systemd/` → `network system`) | Le fichier existe et gouverne les réglages globaux | Moyenne |
| 8 | `/run/systemd/resolve/` n'existe pas : ni `stub-resolv.conf`, ni `resolv.conf` | Les deux fichiers d'exécution existent | Moyenne |
| 9 | Aucune statistique : ni transactions, ni succès/échecs, ni taille de cache | `resolvectl statistics` rend des compteurs réels | Moyenne |
| 10 | Aucune bascule de protocole (LLMNR, mDNS, DNSSEC, DNSoverTLS) | Réglables et rapportées — voir §7 sur ce qui est réellement fait | Moyenne |
| 11 | `DnsCache` n'a aucun compteur de hits/misses | Nécessaire pour #9 | Faible |
| 12 | Aucun `resolvectl query` : pour interroger, il faut `dig` ou `getent` | `query` résout par le même chemin que le système | Élevée |

**Ce qui est déjà juste et ne doit pas régresser** : `getent hosts` via
`files`, `dig` via le moteur DNS réel, l'écriture de `/etc/resolv.conf`
par networkd, et le comportement « aucun serveur configuré ⇒ `dig` expire »
qui est correct.

---

## 2. Modèle

### 2.1 `ResolvedState` — global et par lien

systemd-resolved tient deux niveaux : une configuration globale
(`resolved.conf`) et une configuration par lien (posée par networkd ou
par `resolvectl dns`). Une requête consulte le lien d'abord, le global
ensuite.

| Champ | Portée | Source |
|---|---|---|
| `dnsServers: string[]` | global + lien | `resolved.conf` `DNS=`, `resolvectl dns` |
| `fallbackDns: string[]` | global | `FallbackDNS=` |
| `domains: string[]` | global + lien | `Domains=` ; un `~domaine` est routage seul |
| `defaultRoute: boolean` | lien | `resolvectl default-route` |
| `llmnr`, `mdns` | global + lien | `yes\|no\|resolve` |
| `dnssec` | global + lien | `yes\|no\|allow-downgrade` |
| `dnsOverTls` | global + lien | `yes\|no\|opportunistic` |

**Règle de sélection** : pour un nom donné, le lien dont un `Domains=`
correspond au suffixe gagne ; à défaut, les liens marqués
`default-route` ; à défaut, le global ; à défaut, `FallbackDNS`. C'est la
règle de systemd, et c'est elle qui rend `resolvectl status` lisible.

### 2.2 Le stub

Un vrai gestionnaire sur `127.0.0.53:53` qui, pour chaque requête :
consulte `DnsCache`, sinon interroge le serveur sélectionné (§2.1) sur le
câble réel, met en cache, répond. Les compteurs de transactions et de
hits vivent là.

---

## 3. Phase 1 — `resolvectl` existe

1. `resolvectl status [LIEN]` — global puis par lien : serveurs, domaines,
   protocoles, et le lien dont ils viennent.
2. `resolvectl query NOM|ADRESSE` — résout par **le même chemin que le
   système**, jamais par un raccourci propre à la commande, et rend la
   ligne de systemd (`nom: adresse -- link: eth0`) avec l'origine
   (`authenticated`/`cache`/`network`).
3. `resolvectl --help`, `--version`, `--no-pager`, `--legend`.
4. `systemd-resolve` comme alias, avec `--status` et `--flush-caches`.
5. Verbe inconnu ⇒ erreur et code de retour non nul.

**Critère d'acceptation** : `resolvectl query <nom>` et `getent hosts
<nom>` doivent s'accorder sur la même machine au même instant — la
corrélation de deux commandes plutôt qu'une chaîne figée, comme pour les
deux PRD précédents.

---

## 4. Phase 2 — Le stub répond enfin

**C'est la phase qui corrige un mensonge ; elle passe avant le confort.**

1. Un gestionnaire réel derrière `127.0.0.53:53`, branché sur la pile UDP
   déjà existante — plus un `bind()` décoratif.
2. Un `DnsCache` par hôte, consulté avant toute requête sortante et
   alimenté par les réponses.
3. Le filtre `127.*` du résolveur NSS est levé **pour la seule adresse
   `127.0.0.53`** : elle désigne désormais un stub qui répond. Les autres
   adresses de bouclage restent filtrées, faute de service derrière.
4. `resolvectl flush-caches` vide réellement le cache, et une requête
   suivante repart sur le fil.
5. `resolvectl statistics` rend des compteurs réels ; `DnsCache` gagne
   hits, misses et taille.

**Ce que cela débloque** : `/etc/resolv.conf` peut enfin porter
`nameserver 127.0.0.53` comme sur un vrai Ubuntu, sans casser la
résolution — la limite assumée dans `PRD-networkd` §7 disparaît.

**Choix assumé** : networkd continue d'écrire les serveurs en clair par
défaut. Basculer le défaut vers le stub changerait le comportement de
toutes les maquettes existantes ; le stub devient *possible*, il ne
devient pas obligatoire.

---

## 5. Phase 3 — Configuration par lien

1. `resolvectl dns LIEN [SERVEUR…]`, `domain`, `default-route`,
   `revert` — pose et retire la configuration d'un lien.
2. `/etc/systemd/resolved.conf` est lu : `DNS=`, `FallbackDNS=`,
   `Domains=`, `LLMNR=`, `MulticastDNS=`, `DNSSEC=`, `DNSOverTLS=`,
   `Cache=`.
3. networkd pose la configuration par lien qu'il tire des `.network`
   (`DNS=`, `Domains=`) au lieu d'écrire seulement `resolv.conf` — les
   deux voies deviennent cohérentes.
4. La règle de sélection §2.1 est appliquée par le stub.

---

## 6. Phase 4 — Les fichiers d'exécution

1. `/run/systemd/resolve/stub-resolv.conf` — `nameserver 127.0.0.53` plus
   les `search`.
2. `/run/systemd/resolve/resolv.conf` — les serveurs en amont, en clair.
3. `resolvectl status` nomme le mode courant de `/etc/resolv.conf`
   (statique, stub, ou en amont), ce qui est le premier diagnostic qu'un
   administrateur fait.

---

## 7. Phase 5 — Les bascules de protocole, honnêtement

`LLMNR`, `MulticastDNS`, `DNSOverTLS` et `DNSSEC` sont réglables et
rapportés — mais il faut dire ce qui est réellement fait :

| Réglage | Ce qui sera fait |
|---|---|
| `DNSSEC=` | **Réel en partie** : `DnsValidator` existe et le stub peut valider une réponse signée. `allow-downgrade` accepte une zone non signée |
| `LLMNR=` | **Réglage seul** : aucun émetteur/récepteur LLMNR n'existe. Rapporté par `status`, sans effet sur la résolution |
| `MulticastDNS=` | **Réglage seul**, même raison |
| `DNSOverTLS=` | **Réglage seul** : `SimulatedTls` existe mais n'est pas branché au transport DNS |

Ces trois « réglage seul » doivent être **visibles comme tels** dans la
documentation et ne jamais faire croire à une résolution qui n'a pas
lieu. Un réglage accepté qui ne fait rien est le défaut que toute cette
série corrige ; le répéter ici serait incohérent.

---

## 8. Hors périmètre

- **D-Bus** (`org.freedesktop.resolve1`) : accès direct en mémoire.
- **`resolvectl service` / `openpgp` / `tlsa`** : SRV, OPENPGPKEY et TLSA
  n'ont pas de source de données dans les zones du simulateur.
- **LLMNR et mDNS réels** : deux protocoles entiers, chacun de la taille
  d'un PRD.
- **DNS-over-TLS réel** : demande de brancher `SimulatedTls` sur le
  transport DNS, séparément.
- **`resolvectl log-level`, `reset-server-features`,
  `show-server-state`** : diagnostics internes sans état à refléter.
- **`nss-resolve`** (la source NSS `resolve`) : `nsswitch.conf` porte
  `files dns`, ce qui est le comportement Debian ; ajouter `resolve`
  changerait l'ordre de résolution de toutes les maquettes.

---

## 9. Risques

| Risque | Portée | Atténuation |
|---|---|---|
| Lever le filtre `127.*` casse la résolution existante | Phase 2 | Levé pour la seule `127.0.0.53`, et seulement une fois le stub branché. Les suites DNS existantes sont le garde-fou |
| Le cache masque un changement d'enregistrement dans un TP | Phase 2 | Le TTL est respecté et décroît réellement ; `flush-caches` existe. Le cache est ce que fait un vrai système |
| networkd et resolvectl se contredisent sur les serveurs | Phase 3 | Une seule source : la configuration par lien posée par networkd, lue par le stub. `resolv.conf` reste une projection |
| Régression sur `dig` / `getent` / bind9 | Toutes | Ces trois surfaces sont balayées avant/après chaque phase |

---

## 10. Stratégie de test

| Fichier | Couvre |
|---|---|
| `probe-resolvectl-01-status-query.test.ts` | Phase 1 — dont **la corrélation `resolvectl query` ↔ `getent hosts`** |
| `probe-resolvectl-02-stub-et-cache.test.ts` | Phase 2 — le stub répond pour de vrai, le cache sert et se vide |
| `probe-resolvectl-03-par-lien.test.ts` | Phases 3 et 4 |

Mêmes règles de méthode : mesurer avant d'affirmer, ne jamais faire
passer un test par la force, corréler deux commandes plutôt que figer une
chaîne.

---

## 11. Ordre de livraison recommandé

**Phases 1 et 2 ensemble**, parce qu'elles se tiennent : une commande qui
interroge un stub muet ne vaut pas mieux que pas de commande. La phase 2
est celle qui supprime l'affirmation fausse (`ss` annonce un service qui
n'existe pas). Puis 3, puis 4. La phase 5 est de la déclaration : elle
peut suivre à tout moment, à condition de dire ce qui est réel.
