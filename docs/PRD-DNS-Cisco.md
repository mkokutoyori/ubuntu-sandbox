# DNS sur Cisco : du client au serveur

## La mesure de départ

Le fichier de conformité du tutoriel « DNS : from zero to hero » compte
66 cas sur neuf parties. **40 échouaient.** La surface DNS de ce
simulateur tenait en quatre commandes rangées dans un magasin que
presque personne ne lisait :

| Ce que la machine acceptait | Ce qu'elle en faisait |
|---|---|
| `ip name-server <ip>` | rangé, jamais rendu, jamais interrogé |
| `ip domain-lookup` / `no` | rangé, jamais rendu, sans effet |
| `ip domain-name <nom>` | rangé, rendu, jamais utilisé pour compléter un nom |
| `ip host <nom> <ip>` | une seule adresse, jamais consultée par `ping` |

Et ce qui n'existait pas du tout : `ip domain list`, `ip domain
timeout`/`retry`/`round-robin`, `ip domain lookup source-interface`,
`clear host`, `ip dns server`, `ip dns primary`, `ip dns spoofing`,
`ip host … ns`, `show ip dns statistics`, `debug ip domain`, et côté VRP
`dns resolve`/`dns server`/`dns domain` avec leurs trois vues.

Le défaut central n'est pas une commande manquante : **`ping <nom>` ne
résolvait rien**. `parsePingArgs` refusait tout ce qui n'était pas une
adresse, donc la table d'hôtes elle-même — pourtant remplie — n'était
jamais consultée par la commande que le tutoriel fait taper en premier.

## Ce qui est livré

### Un magasin, pas trois

`CiscoDnsConfig` porte les seize réglages DNS et sait se rendre. Il
remplace les trois champs éparpillés sur `RouterManagementService`
(`domainName`, `ipDomainLookupEnabled`, `nameServers`), dont le rendu
était partiel et la lecture inexistante.

**Les deux orthographes sont acceptées** — `ip domain-lookup` et
`ip domain lookup`, `ip domain-name` et `ip domain name` — parce qu'un
IOS 15 accepte les deux et que les supports de cours utilisent les deux.
La configuration rend la forme historique, celle qu'un `show
running-config` de vraie machine imprime.

**Les défauts ne sont pas rendus** : la résolution est active par défaut
donc `ip domain-lookup` ne paraît pas, mais `no ip domain-lookup` si —
c'est un écart. `timeout 3` et `retry 2` sont les défauts d'IOS et ne
paraissent pas davantage.

### La table d'hôtes porte ce qu'IOS y met

`ip host web 10.0.0.10 10.0.0.11 10.0.0.12` : **jusqu'à huit adresses**
pour un nom, comme IOS. L'entrée distingue **permanent** (configurée) de
**temporaire** (apprise par DNS), ce que `show hosts` affiche
`(perm, OK)` / `(temp, OK)` et que `clear host *` sépare — cette commande
vide ce que le DNS a appris et **garde** ce que l'opérateur a configuré,
qui n'est pas un cache.

### La résolution a lieu, sur le fil

`RouterDnsService` résout dans l'ordre d'IOS : table statique d'abord,
puis serveurs de noms, chacun essayé avec chaque suffixe de recherche.
Un nom court est complété par `ip domain-name` ou par `ip domain list`.
La requête est un vrai message DNS encodé par le codec du dépôt, envoyé
en UDP/53 à travers la FIB ; la réponse alimente le cache en
**temporaire**. `ping` et `traceroute` passent tous deux par là.

`no ip domain-lookup` empêche vraiment la résolution — c'est la commande
qu'un opérateur tape pour que ses fautes de frappe cessent de pendre, et
elle ne faisait rien.

### Le routeur est un serveur DNS

`ip dns server` **lie vraiment UDP/53** et répond depuis la table
`ip host` : une requête `dig` d'une autre machine reçoit l'adresse, un
nom inconnu reçoit NXDOMAIN. `show ip dns statistics` compte ce qui est
réellement passé — reçues, répondues, échouées — et non des zéros.

### Diagnostic et parité

`debug ip domain` et son synonyme historique `debug domain` existent,
`show debugging` les annonce, et une résolution réelle écrit sa trace.
Le **commutateur** porte le même magasin et la même table : les quatre
commandes du tutoriel y sont acceptées, rendues et lues. Côté **VRP**,
`dns resolve`/`dns server`/`dns domain` alimentent le même magasin, et
`display dns server` / `display dns domain` / `display dns dynamic-host`
le lisent.

## Un défaut trouvé en corrigeant

`crypto key generate rsa` lisait le nom de domaine sur l'ancien magasin
pendant que `ip domain-name` écrivait sur le nouveau : la commande
répondait `% Please define a domain-name first.` juste après que
l'opérateur l'ait défini. C'est exactement la famille de défaut que ce
lot referme — deux magasins pour un fait — et elle s'est reproduite
pendant la correction. Les lecteurs lisent désormais le magasin unique.

## Mesures

`tuto-dns-cisco-conformite.test.ts` : **66 cas, 66 passent**. Discriminé
par `git stash` : **39 tombent** avant correctif. Neuf suites connexes
vertes (526 cas), plus les suites DNS existantes. Typecheck 119, lint
identique.
