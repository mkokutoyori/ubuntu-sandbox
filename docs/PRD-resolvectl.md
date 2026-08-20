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
| 10 | Aucune bascule de protocole (LLMNR, mDNS, DNSSEC, DNSoverTLS) | Les quatre réellement branchées — voir §7 | Moyenne |
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

| Réglage | Ce qui est fait |
|---|---|
| `DNSSEC=` | **Réel** : `DnsValidator` remonte la chaîne par de vraies requêtes DNSKEY/DS. `secure`, `bogus` et `insecure` sont tous les trois atteints ; `allow-downgrade` accepte une zone non signée, jamais une falsifiée. `resolvectl nta` soustrait un domaine à la validation |
| `DNSOverTLS=` | **Réel** : `DnsTlsTransport` fait une vraie poignée de main TLS 1.3 (RFC 8446) sur le 853, avec PKI et ALPN `dot` exigée. `yes` refuse de retomber en clair, `opportunistic` y retombe |
| `LLMNR=` | **Réel** (RFC 4795) : UDP/5355 sur 224.0.0.252. L'hôte vérifie l'unicité de son nom au démarrage (§4.1), répond pour son nom mono-label en unicast, et se tait pour tout autre nom. Le réglage ouvre ou ferme un vrai port |
| `MulticastDNS=` | **Réel** (RFC 6762) : UDP/5353 sur 224.0.0.251, domaine `.local`. Sondage avant revendication (§8.1), renommage sur conflit (§9), départage des sondages simultanés (§8.2), réponse sur le groupe, unicast à TTL plafonné pour une requête ponctuelle (§6.7), annonce après acquisition (§8.3). Éteint par défaut, comme sur Ubuntu |

Plus aucun réglage de cette table n'est un texte sans effet.

### 7.2 Le préalable : un hôte savait-il seulement parler à un groupe ?

Non, et c'était le vrai obstacle. `EndHost.resolveRoute` n'avait aucune
route pour 224.0.0.0/4 ni pour 255.255.255.255 : `sendUdpDatagram`
rendait `false` sans rien émettre, y compris vers un groupe que l'hôte
venait de rejoindre. En réception, `handleIPv4` jetait tout paquet
multicast, faute d'être « pour nous » — alors même que le filtre L2
l'avait laissé monter parce que la carte est abonnée au groupe.

Les deux moitiés sont corrigées : la MAC de destination se déduit du
groupe (RFC 1112 §6.4, via `ipv4MulticastToMac` déjà présent pour IGMP),
la trame part sur chaque lien monté qui porte une adresse, avec TTL 1
pour un groupe de lien ; et un datagramme multicast est livré à
l'écouteur UDP, sans « port injoignable » en retour — répondre cela à un
groupe désignerait un coupable qui n'a rien demandé.

### 7.3 Règle de sélection, et ce qui la gouverne

| Nom demandé | Protocole |
|---|---|
| `*.local` | mDNS seulement — jamais un serveur unicast (RFC 6762 §3) |
| mono-label | DNS d'abord ; LLMNR quand le serveur ne sait pas, ou quand il n'y en a aucun |
| autre | DNS |

`resolvectl query` nomme le protocole employé (`-- Information acquired
via protocol LLMNR/IPv4`), et une réponse venue du lien n'est jamais
annoncée comme authentifiée : personne ne la signe.

Le réglage global est **le défaut des liens**, pas un interrupteur
indépendant. Un protocole de lien est donc actif dès qu'un lien
l'autorise, et c'est le global qui tranche tant qu'aucun lien n'est
configuré. Sans cette règle, `resolvectl llmnr eth0 no` sur l'unique
lien ne fermait rien — le global valant encore `yes` — et
`resolvectl mdns eth0 yes` restait sans effet sur une machine sans
serveur DNS, faute de lien à consulter.

### 7.4 Le conflit de noms, traité différemment par chaque RFC

Les deux protocoles vérifient qu'un nom leur appartient avant de le
défendre, et c'est là qu'ils divergent le plus.

**LLMNR signale.** Au démarrage, l'hôte demande son propre nom au lien,
trois fois (§4.1). Une réponse veut dire qu'un autre le porte : LLMNR
n'arbitre pas et ne renomme pas — il pose le bit `C` dans ses réponses,
et le demandeur décide. La réponse reste utilisable ; se taire
priverait d'une information que personne d'autre n'a.

**mDNS tranche.** L'hôte sonde son nom trois fois à 250 ms d'intervalle
(§8.1) : une question `ANY` portant en section Authority les
enregistrements qu'il *compte* poser. S'il reçoit une réponse, le nom
est pris ; il passe à `alpha-2.local` et resonde (§9). Deux hôtes qui
sondent en même temps ne peuvent compter l'un sur l'autre pour
répondre — aucun ne possède encore le nom — alors ils comparent leurs
enregistrements proposés et le plus grand l'emporte (§8.2). Sans ce
départage, les deux renonceraient ou les deux revendiqueraient. Tant
que le sondage dure, l'hôte **ne répond pas** pour le nom : ce serait
affirmer la possession qu'il est en train de vérifier.

**Un piège de l'en-tête, et un vrai défaut corrigé.** LLMNR redéfinit
deux bits du header DNS (§2.1.1) : là où le DNS place `AA` (bit 10) il
place `C` (Conflict), et là où il place `RD` (bit 8) il place `T`
(Tentative). Le répondeur posait `aa: true` sur chaque réponse « parce
qu'un répondeur LLMNR fait autorité » — il annonçait donc un conflit à
chaque fois. `llmnrFlagOverrides`/`readLlmnrBits` (`llmnr/types.ts`)
existent pour que l'aliasing soit écrit plutôt que deviné.

**Limites assumées.** Le répondeur est unique pour l'hôte alors que le
réglage est par lien : la granularité par lien du *répondeur* n'est pas
modélisée, celle de la *résolution* l'est. Les groupes IPv6
(`FF02::1:3`, `FF02::FB`) ne sont pas émis, la pile v6 n'ayant pas
d'équivalent à l'émission vers un groupe arbitraire. Le départage §8.2
compare des adresses A triées plutôt que la forme canonique octet par
octet de la RFC — même ordre pour les seuls enregistrements en jeu ici,
mais c'est une simplification, pas la lettre.

### 7.5 Réponses connues (§7.1) et DNS-SD (RFC 6763)

**Réponses connues.** Un interrogateur joint à sa question ce qu'il sait
déjà ; le répondeur retire de sa réponse tout ce que l'autre a écrit, et
se tait complètement s'il ne reste rien. Le seuil est celui de la RFC :
la copie du demandeur n'est retenue que si son TTL dépasse la moitié de
celui qu'on aurait servi — en dessous, elle est près d'expirer et il
faut la rafraîchir. Le TTL de référence est celui de la réponse qu'on
*aurait* faite, donc 10 s pour une requête ponctuelle (§6.7), pas 120.

**DNS-SD.** Trois enregistrements décrivent un service, et rien de neuf
ne circule sur le fil — c'est tout l'intérêt du protocole :

| Question | Réponse |
|---|---|
| `_services._dns-sd._udp.local` PTR | les *types* présents sur le lien (§9) |
| `_http._tcp.local` PTR | les *instances* de ce type (§4.1) |
| `_printer._sub._http._tcp.local` PTR | les instances déclarées sous ce **sous-type** (§7.1) |
| `Mon serveur._http._tcp.local` SRV | l'hôte, le port, priority et weight (§5) |
| … TXT | les métadonnées, un `clé=valeur` par segment (§6.1) |

Un sous-type restreint la découverte sans créer un second service : son
PTR désigne exactement la même instance. Il n'apparaît pas dans
l'énumération de §9, qui ne liste que des types.

Le répondeur joint en additionnels ce que le demandeur voudra de toute
façon ensuite (§12) : le SRV et le TXT derrière un PTR, l'adresse
derrière un SRV — un seul aller-retour suffit à `resolvectl service`.

**La publication passe par un fichier d'unité**, pas par une commande :
`systemd-resolved` lit `/etc/systemd/dnssd/*.dnssd` (`systemd.dnssd(5)`),
au même format que les `.network` de networkd, avec le même ordre
`/etc` › `/run` › `/usr/lib`. Une unité sans `Name`, `Type` ou `Port`
est ignorée plutôt que publiée à moitié.

```ini
[Service]
Name=Mon serveur web
Type=_http._tcp
SubType=_printer
Port=80
Priority=0
Weight=0
TxtText=path=/index.html
```

Le nom d'instance est libre — espaces et points compris (§4.1.1) : il
est fait pour être lu. `parseInstanceName` découpe donc depuis la fin,
seule façon correcte de séparer `Bureau 2.4._http._tcp.local`.

### 7.6 Cycle de vie d'un service (§8.4, §10.1)

Un service publié est **annoncé** dès que le nom d'hôte est acquis — pas
avant : annoncer un service porté par un nom encore en sondage
affirmerait les deux à la fois. Modifié, il est **réannoncé** avec le bit
cache-flush, qui remplace au lieu d'empiler. Retiré, il part avec un
**TTL nul** : c'est l'instruction de suppression de §10.1, pas un
silence.

Le rechargement des `.dnssd` est différentiel et non un `clear()` suivi
d'une republication. Sans comparer, un service retiré du disque
disparaîtrait en silence et les pairs qui l'ont entendu continueraient
de le croire là. Republier à l'identique, à l'inverse, n'annonce rien —
cela n'apprendrait rien à personne.

**Pour que tout cela ne soit pas décoratif**, l'agent écoute aussi les
annonces des autres et tient un cache passif des services entendus.
C'est ce cache qu'un TTL nul vide, et c'est lui qui rend un adieu
observable : sans écoute passive, une annonce partirait sans que rien
ne puisse montrer qu'elle arrive.

**Expiration (§10).** Une entrée de ce cache vaut la durée annoncée, pas
davantage. Un pair qui s'éteint brutalement n'émet aucun adieu : sans
échéance, son service serait resté là indéfiniment. Une réannonce
repousse l'échéance, ce qui est tout l'intérêt d'en émettre une.

L'élagage se fait à la lecture et à chaque annonce entendue, plutôt que
sur une minuterie par entrée. Le contrat observable — un service expiré
n'est jamais rapporté — est tenu ; l'événement d'expiration part donc *à
ou après* l'échéance, pas à la seconde près. Un cache passif n'a
personne à prévenir dans l'intervalle.

Le cache dit ce qu'on a **entendu** ; un parcours pose une vraie
question. Les deux ne se contredisent pas : après expiration,
`browse()` retrouve le service, simplement l'auditeur ne l'avait plus en
mémoire. Une entrée expirée n'est pas une absence de service.

**Limites.** Le cache retient l'instance, son hôte et son port, pas ses
métadonnées : le TXT reste demandé à la résolution. Il n'y a pas de
réinterrogation continue (§5.2), qui suppose un parcours actif inscrit
dans la durée. Un adieu supprime immédiatement, là où la RFC recommande
d'attendre une seconde pour laisser passer ce qui est en vol — sans
effet observable sur une course que rien ici ne produit.

### 7.1 Le chemin asynchrone de la base `hosts`

Valider demande des allers-retours supplémentaires ; chiffrer demande une
poignée de main. Les deux imposent le chemin asynchrone, alors que
`INssSource` était synchrone de bout en bout : sous `DNSSEC=` actif ou
`DNSOverTLS≠no`, un `getent hosts` **à froid** ne rendait rien, et le
disait comme un nom inconnu.

C'est corrigé, pour la seule base qui en a besoin. Les autres — `passwd`,
`group`, `services`… — se lisent dans le VFS et restent réellement
synchrones ; leur donner un chemin asynchrone n'aurait rien apporté.

| Élément | Ce qui a changé |
|---|---|
| `INssSource` | Jumeaux **optionnels** `gethostbynameAsync`/`gethostbyaddrAsync`. Une source qui ne les implémente pas — `files` — reste interrogée par sa méthode synchrone |
| `NameServiceSwitch` | `lookupAsync`/`lookupViaAsync`. La marche `[STATUS=action]` est extraite dans un walker unique que les deux chemins pilotent, pour qu'ils ne puissent pas décider différemment |
| `DnsNssSource` | `queryAsync` sur le résolveur de fil ; l'extraction message → `NssResult` est partagée avec le chemin synchrone |
| `getent` | Passe du `switch` synchrone du dispatcher au registre des commandes, donc au chemin asynchrone. Seules les bases `hosts`/`ahosts*` l'empruntent ; les autres repartent sur l'implémentation inchangée |
| `resolveHostname`/`6` | Déjà `async` de signature, ils appelaient une résolution synchrone. `ping`, `traceroute` et les autres en profitent sans changer |
| `curl` | `fetchHttp` attend la résolution ; le dial lui-même reste synchrone |

**Limite restante, mesurée.** Un `getent` atteint par un chemin
irréductiblement synchrone — le collecteur du bash interne, appelé pour
les imbrications profondes — retombe sur `getentSync` et ne voit donc ni
DNSSEC ni DoT. Un script lancé par `bash script.sh` n'est *pas* concerné :
le dispatcher route déjà cette forme vers son jumeau asynchrone.
`ssh` non plus n'a pas de chemin asynchrone : `runSshClient` est
synchrone de bout en bout et résout surtout par la topologie, pas par
NSS ; `resolveHostnameSync` lui reste réservé, avec la même limite.

---

### 7.7 Le même lien, vu depuis Windows

LLMNR est une invention de Microsoft, et un Windows le parle par défaut.
Ce simulateur en avait pourtant tiré une asymétrie difficile à défendre :
tout ce qui précède ne valait que pour les hôtes Linux. Mesuré avant
d'écrire une ligne — une machine Windows et une machine Linux sur le même
commutateur, chacune sachant se nommer, ne se voyaient pas :

| Mesure de départ | Résultat |
|---|---|
| `ping alpha` depuis Windows | `could not find host alpha` |
| `Resolve-DnsName alpha` | `DNS name does not exist` |
| `resolvectl query win10` depuis Linux | `Name or service not known` |
| Ports 5355 / 5353 sur Windows | aucun |

Les deux agents (`LlmnrAgent`, `MdnsAgent`) ne dépendaient que de
`EndHost`, dont `WindowsPC` hérite : il n'y avait rien à spécialiser, et
rien à dupliquer — seulement à brancher, et à trouver le bon interrupteur.

**La commande qui les allume, elle, n'est pas la même.** Windows n'a pas
de `resolvectl` ; il a une clé de stratégie, celle que pose l'objet de
stratégie de groupe « Désactiver la résolution de noms multicast » et que
tout guide de durcissement fait écrire à la main :

```
HKLM\SOFTWARE\Policies\Microsoft\Windows NT\DNSClient
    EnableMulticast : REG_DWORD  0 → LLMNR éteint
    EnableMDNS      : REG_DWORD  0 → mDNS éteint
```

**L'absence de valeur vaut « activé ».** C'est l'état d'un Windows sorti
de l'installation, pas un choix de ce simulateur — et c'est l'inverse du
côté Linux, où `resolvectl mdns <lien> yes` est nécessaire. Cette
asymétrie est celle des deux systèmes.

Pour que le réglage ne soit pas décoratif, `PSRegistryProvider` notifie
désormais après toute écriture (`onValueChanged`), quel que soit le
chemin — `reg add` de cmd, `Set-ItemProperty` de PowerShell, stratégie de
groupe. Sans ce fil, poser `EnableMulticast` à zéro aurait affiché
« opération réussie » pendant que le port 5355 restait ouvert.

**L'ordre de résolution** suit celui du client DNS de Windows : littéral
→ fichier `hosts` → cache → serveurs DNS → lien. Un nom `.local` ne part
**jamais** vers un serveur unicast (RFC 6762 §3, respecté par Windows
depuis la version 1703) ; un nom mono-label va à LLMNR. Une réponse de
lien entre dans le cache du client avec son TTL, faute de quoi
`ipconfig /displaydns` et `Get-DnsClientCache` ne verraient pas un nom
que `ping` vient pourtant de résoudre.

`nslookup` reste en dehors : il parle directement aux serveurs, sans
passer par le client DNS — c'est le comportement réel, et c'est ce qui
permet de distinguer les deux.

| Surface | État |
|---|---|
| Répondeur LLMNR / mDNS sur `WindowsPC` | Réel, mêmes agents que Linux |
| `EnableMulticast` / `EnableMDNS` | Commandent l'écoute **et** la résolution |
| `ping`, `Resolve-DnsName`, `resolveHostname` | Passent par le lien en dernier recours |
| `Resolve-DnsName -DnsOnly / -LlmnrOnly / -NoHostsFile / -CacheOnly` | Réels — la cmdlet ne nommant pas le protocole qui a répondu, les poser est le seul moyen de le savoir |
| `Get-NetUDPEndpoint` | Ajouté : le pendant UDP de `Get-NetTCPConnection`, qui manquait |
| `netstat -an`, `Get-DnsClientCache`, `ipconfig /displaydns` | Cohérents avec ce que le lien a répondu |

**Un appelant qui ne sait pas attendre.** Les cmdlets du client DNS de
Windows n'ont pas de forme asynchrone, et `OracleExecutor` mis à part,
`ICmdlet.execute` est synchrone de bout en bout. `queryMulticastDnsSync`
existe pour cela : dans ce simulateur une trame est remise par appel
direct, donc la réponse d'un pair arrive pendant l'envoi. C'est fidèle en
*sémantique* — un résolveur système bloque son appelant, `gethostbyname`
aussi — mais il n'y a pas de délai à attendre : un pair qui ne répond pas
rend la main immédiatement, là où un vrai hôte patienterait sa seconde.

**Un défaut voisin, révélé par les probes et corrigé.**
`Set-ItemProperty -Path 'HKLM\SOFTWARE\...'` — la forme de `reg.exe`,
sans les deux-points du lecteur PowerShell — ne passait aucun des deux
tests de chemin et retombait sur un `return null` muet : ni erreur, ni
effet. PowerShell réel répond `Cannot find drive. A drive with the name
'HKLM' does not exist.` ; c'est désormais ce que rendent
`Set-ItemProperty` et `Remove-ItemProperty`. Une écriture perdue qui se
présente comme réussie est pire qu'un refus.

**Hors périmètre, et pourquoi.**

- **Publication DNS-SD depuis Windows.** Le répondeur mDNS intégré à
  Windows répond pour le nom de la machine ; il ne publie pas de service.
  Publier demande Bonjour (`dns-sd.exe`), qui n'est pas un composant du
  système. Il n'y a donc pas d'équivalent natif aux unités
  `/etc/systemd/dnssd/*.dnssd` du §7.5, et en inventer un serait ajouter
  une surface que Windows n'a pas.
- **Granularité par interface.** La clé
  `...\Tcpip\Parameters\Interfaces\{GUID}\EnableMulticast` existe sur un
  vrai Windows, mais ce simulateur n'a pas de modèle de GUID d'interface :
  la stratégie est donc appliquée à l'hôte entier. C'est la même limite
  que celle déjà déclarée côté Linux pour le *répondeur*.
- **NetBIOS (`-NetbiosFallback`, `-LlmnrNetbiosOnly`).** `nbtstat` rend
  une table de noms locale, mais aucune résolution NBNS ne circule sur le
  fil ; ces deux commutateurs resteraient sans objet.

---

## 8. Hors périmètre

- **D-Bus** (`org.freedesktop.resolve1`) : accès direct en mémoire.
- **`resolvectl openpgp` / `tlsa`** : OPENPGPKEY et TLSA n'ont pas de
  source de données dans les zones du simulateur. `service` en a une
  depuis DNS-SD (§7.5) et existe.
- **Réinterrogation continue** (RFC 6762 §5.2) : rafraîchir un
  enregistrement à 80–95 % de son TTL suppose un parcours actif inscrit
  dans la durée, que rien n'expose aujourd'hui.
- **DoH et DoQ** : `DnsHttpsTransport`/`DnsQuicTransport` reposent encore
  sur `SimulatedTls` et migrent sous `PRD-HTTP.md`/`PRD-QUIC.md`.
- **Épinglage du certificat DoT** (`DNSOverTLS=yes#nom`, vérification du
  nom du serveur) : le transport vérifie la chaîne, pas l'identité.
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
| `probe-windows-01-noms-de-lien.test.ts` | §7.7 — les deux répondeurs sur Windows, la stratégie du registre, l'ordre de résolution, la cohérence du cache client |

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
