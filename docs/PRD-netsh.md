# PRD — Limites de la commande Windows `netsh` actuellement implémentée

**Version** : 1.0
**Date** : 2026-07-06
**Projet** : Ubuntu Sandbox — simulateur réseau navigateur
**Auteur** : Claude (agent), à la demande de l'utilisateur
**Références normatives** :
- Microsoft Docs — `netsh` (référence en ligne de commande), contextes
  `netsh advfirewall`, `netsh interface ip`/`ipv6`, `netsh interface
  portproxy`, `netsh wlan`, `netsh dhcpclient`, `netsh dnsclient`
- `PRD-Windows-Server.md` (déjà en place dans ce dépôt — les contextes
  `dhcp server`/`nps` de `netsh` en sont des façades)

---

## 0. Contexte et portée du document

Ce PRD documente, sans les corriger, **toutes les limites vérifiées** de la
commande `netsh` réellement implémentée dans ce dépôt
(`src/network/devices/windows/WinNetsh.ts`, fichier unique de 3154 lignes),
par comparaison avec le comportement du vrai `netsh.exe`. Recherche menée
par lecture intégrale du fichier, de ses fichiers satellites
(`PortProxyRule.ts`, `PortProxyTable.ts`), de son point de branchement dans
`WindowsPC.ts`, et de la suite de tests existante.

### 0.1 Principe directeur

Comme pour les PRD précédents de ce dépôt (`PRD-TCP.md`, `PRD-ip.md`,
`PRD-Nslookup-Dig-Rndc-Runas.md`) : ce document sépare strictement le
**constat** (§1) de la **proposition** (§2 à §8). Toute correction future
devra rester **additive et testée**.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

Toute la logique vit dans un seul fichier : `WinNetsh.ts`, point d'entrée
unique `cmdNetsh(ctx, args)`, qui distribue vers ~25 fonctions internes
`handleNetsh*`. Fichiers satellites : `PortProxyRule.ts` (value object),
`PortProxyTable.ts` (registre de règles par device, référencé depuis
`WindowsPC.ts`).

| Contexte | Gestionnaire (ligne) | Profondeur |
|---|---|---|
| `interface ip` / `ipv4` | `handleNetshInterfaceIp` (577) | show/set/add/delete/reset — complet |
| `interface ipv6` | `handleNetshInterfaceIpv6` (1211) | add/show/delete adresse+route |
| `interface show interface`, `set interface` | 376, 408 | admin enable/disable, renommage |
| `interface portproxy` | `handleNetshPortproxy` (481) | add/set/delete/show/reset, 4 familles |
| `interface tcp/udp/6to4/isatap/teredo/httpstunnel` | **aucun** | annoncés dans l'aide (108-110) seulement, aucun gestionnaire n'existe |
| `dhcpclient` | `handleNetshDhcpclient` (1528) | install/uninstall/renew/release/show/set/list/trace |
| `dnsclient` | `handleNetshDnsclient` (1754) | show/add/delete/set/reset |
| `dhcp` (admin serveur legacy) | `handleNetshDhcpServer` (1373) | add scope/excluderange/reservedip, show scope |
| `nps` | `handleNetshNps` (1453) | add client, show clients |
| `ipsec static`/`ipsec dynamic` | `handleNetshIPSec*` (2077-2456) | CRUD complet sur policy/filter/rule en mémoire ; `dynamic show/set` affichage seul |
| `lan` | `handleNetshLan` (2491) | profiles/interfaces/settings/tracing, add/delete/export/import |
| `namespace` (NRPT) | `handleNetshNamespace` (2658) | add/show policy |
| `bridge` | `handleNetshBridge` (2720) | create/add/show/delete |
| `advfirewall`/`advfirewall firewall` | `handleNetshAdvfirewall`/`handleAdvfwFirewall` (2833/2861) | `firewall add/show/delete rule` = réel ; `advfirewall show/set/consec/monitor/export/import` = stub `'Ok.'` |
| `http` | `handleNetshHttp` (2966) | iplisten, sslcert add/show/delete |
| `wlan` | `handleNetshWlan` (3062) | profiles add/delete/show, connect/disconnect/set |
| `trace`, `winhttp`, `winsock`, `p2p` | inline dans `cmdNetsh` (271-306) | chaînes toutes faites, aucun état |
| `routing` | inline (181) | reproduit volontairement le vrai message "helper non installé… RRAS requis" — RRAS hors périmètre |
| `mbn`, `netio`, `nlm`, `ras`, `rpc`, `wcn`, `wfp`, `branchcache`, `firewall` (legacy) | dictionnaire `SUB_CONTEXT_STUB` (140-150) | seuls `?`/`dump`/`help` répondent ; explicitement étiquetés "stubs for contexts without full implementations" |

### 1.2 Ce qui est déjà réel et solide (à ne pas casser)

- **`interface ip`/`ipv4` set/add/delete address/dns/route** : réel,
  appelle `ctx.configureInterface`, `ctx.setDefaultGateway`,
  `ctx.addStaticRoute`/`ctx.removeRoute`, qui écrivent dans les mêmes
  objets `RoutingTable`/`Port` que le plan de données IP forwarding/ARP/
  ping (`WindowsPC.ts:2091-2094`).
- **`interface ipv6`** : les adresses sont posées sur le vrai `Port`
  (`port.configureIPv6`), partagé avec `ipconfig`/`ping -6`.
- **`interface portproxy`** : les règles sont poussées dans
  `ctx.portProxy` (`PortProxyTable`), qui alimente une
  `PortProxySocketProjection` créant de vrais listeners de la table de
  sockets — confirmé par une suite de tests dédiée et passante
  (`windows-port-forwarding.test.ts`), montrant que les règles apparaissent
  réellement dans `netstat` et sont retirées à la suppression.
- **`advfirewall firewall add/show/delete rule`** : les règles vont dans
  `ctx.dynamicFirewallRules`, exactement la map lue par
  `WindowsPC.firewallFilter()`, invoquée sur le vrai chemin des paquets
  entrants (`inboundSshFirewallVerdict`) et émettant même un événement de
  sécurité 5152. **Un vrai moteur d'ACL, pas un générateur de texte.**
- **`dhcp server` (legacy) et `nps`** délèguent à de vrais objets service
  `ctx.dhcpServerRole`/`ctx.npsRole` avec une vraie logique de scope/
  exclusion/réservation.
- **`dnsclient`/`interface ip show dns`** reflètent la même liste de
  serveurs DNS que celle réellement utilisée par la résolution de noms.

### 1.3 Gap analysis — limites vérifiées

| # | Limite | Comparé à | Sévérité |
|---|---|---|---|
| 1 | **`netsh advfirewall` — configuration de profil/globale entièrement absente.** Le vrai `netsh advfirewall show currentprofile/allprofiles`, `set allprofiles state on\|off`, `set currentprofile firewallpolicy`, `export`/`import` sont tous des no-ops (`show`/`set` renvoient `'Ok.'`, ligne 2839-2841). On peut ajouter/afficher/supprimer des règles mais pas activer/désactiver le pare-feu lui-même ni inspecter les réglages par profil — une surface large et couramment scriptée. | `netsh advfirewall` réel | **Élevée** |
| 2 | **Contextes `interface tcp`/`interface udp` absents.** Le vrai `netsh interface tcp set global autotuninglevel=...`, `show global` sont annoncés dans l'aide mais inatteignables — produisent un "not found" trompeur au lieu du comportement documenté. | `netsh interface tcp` réel | Élevée |
| 3 | **Contextes de tunneling IPv6 (`6to4`, `isatap`, `teredo`, `httpstunnel`) absents.** Annoncés dans `NETSH_INTERFACE_HELP` mais aucun gestionnaire — usage réel faible aujourd'hui, mais le texte d'aide sur-promet. | `netsh interface 6to4`/etc. réels | Moyenne |
| 4 | **`netsh advfirewall consec`/`monitor` absents** (règles de sécurité de connexion IPsec / moniteur en direct) — uniquement présents dans le texte d'aide (lignes 2790, 2802), aucune implémentation. | `netsh advfirewall consec`/`monitor` réels | Moyenne |
| 5 | **Pas de mode interactif `netsh -c <contexte>`/shell.** Le vrai `netsh` supporte un shell interactif (`netsh` puis invite `interface ip>`) et l'exécution batch `-f script`/`-c` ; le simulateur ne supporte que des commandes ponctuelles entièrement qualifiées (confirmé : aucune gestion de `-f`, `-c`, ou de REPL nulle part dans `cmdNetsh`). | `netsh(1)` mode interactif réel | Moyenne |
| 6 | **`netsh dump` non implémenté partout.** Chaque texte d'aide de contexte liste `dump` ("Displays a configuration script") mais aucun contexte ne le gère — le round-trip réel `dump`/`exec` (exporter la config courante en script, la rejouer) n'a aucun équivalent. | `netsh ... dump` réel | Moyenne |
| 7 | **`wlan`/`lan`/`http`/`namespace`/`bridge`/`ipsec` sans effet comportemental.** Ce sont des surfaces de commande crédibles pour des exercices de script/parsing, mais elles ne touchent aucun moteur Wi-Fi, pont, HTTP.sys, DNS-NRPT ou tunnel IPsec ailleurs dans le dépôt — écart purement cosmétique face au vrai `netsh` qui modifie réellement le comportement réseau de l'OS. | Comportement réel de chaque contexte | Faible |
| 8 | **Asymétrie de verbes dans `advfirewall firewall`** : pas de `set rule` (le vrai `netsh advfirewall firewall set rule name=... new ...` permet d'éditer une règle existante) — seuls add/show/delete existent. | `netsh advfirewall firewall set rule` réel | Faible |
| 9 | **`interface ip add neighbors` sans `delete neighbors` correspondant** (seuls routes/dns/address ont un pendant `delete` ; `handleInterfaceIpDelete` n'a pas de branche `neighbors`). | `netsh interface ip delete neighbors` réel | Faible |
| 10 | **Fidélité des messages d'erreur inégale.** Certains chemins reproduisent fidèlement le texte d'erreur Windows réel (message d'index DNS requis, `The object already exists.`), mais de nombreux contextes stub renvoient un `'Ok.'`/`"not found"` générique plutôt que le format d'erreur réel de netsh (souvent verbeux, multi-ligne) — écart d'authenticité systématique mais de faible sévérité, présent dans presque tous les contextes stub. | Format d'erreur `netsh` réel | Faible |
| 11 | **Aides globales `netsh show` minimales.** `show alias` renvoie toujours vide (ligne 327) et il n'y a aucun support de définition d'alias (`netsh -a AliasFile` n'est pas non plus parsé), alors que le vrai `netsh` supporte les alias définis par l'utilisateur de bout en bout. | `netsh alias`/`netsh -a` réels | Faible |

### 1.4 Marqueurs explicites de périmètre déjà dans le code

Aucun tag `TODO`/`FIXME` dans le fichier. Langage explicite "ceci est un
stub" trouvé à :
- Lignes 139-140 : `// Sub-context stubs for contexts without full
  implementations` → dictionnaire `SUB_CONTEXT_STUB`.
- Ligne 308 : `// Sub-context stubs (mbn, netio, nlm, ras, rpc, wcn, wfp,
  etc.)`.
- Lignes 1352-1356 et 1435-1439 : notes de périmètre explicites citant
  `PRD-Windows-Server.md §5 P8/P9`, indiquant que les contextes legacy
  `dhcp server`/`nps` n'implémentent que les "formes usuelles" et que
  l'auteur de règles NPS "n'a pas de vrai équivalent `netsh nps`" — hors
  périmètre assumé.
- Lignes 2776-2783 : commentaire documentant que l'ancienne fixture
  module-level `fwRules` a été retirée au profit de la map par-device
  `dynamicFirewallRules` — les règles de pare-feu étaient un faux
  singleton partagé et ont été délibérément corrigées pour être réelles
  et par-device.

### 1.5 Couverture de test actuelle

`windows-netsh.test.ts`, `windows-netsh-dhcp-dns.test.ts`,
`windows-port-forwarding.test.ts`, `cmd-netsh.test.ts` (1479 lignes, la
couverture la plus large — `advfirewall`, `dhcpclient`, `dnsclient`,
`ipsec`, `lan`, `bridge`, `wlan`, `http`, `namespace` ont tous des tests
passants). **`interface tcp/udp/6to4/isatap/teredo/httpstunnel` n'ont
aucune référence de test nulle part**, cohérent avec le fait qu'ils ne
sont pas implémentés.

### 1.6 Moteur sous-jacent partagé — implication pour le périmètre

Pour les deux contextes les plus importants opérationnellement, le moteur
sous-jacent existe déjà et est solide ; la plus grande opportunité de ce
PRD est de **combler des écarts de surface de commande**, pas de
construire de nouveaux moteurs de simulation :
- **Pare-feu** : `dynamicFirewallRules` + `WindowsPC.firewallFilter()` est
  un vrai moteur d'ACL par-paquet déjà exercé par les tests SSH/port. Le
  manque porte sur la surface profil/globale/consec/monitor/export de
  `netsh advfirewall` autour de ce moteur, pas sur le moteur lui-même.
- **Routage** : `addStaticRoute`/`getRoutingTable`/`removeRoute` écrivent
  dans la même `RoutingTable` utilisée par le forwarding IPv4/IPv6 dans
  tout le simulateur (partagée avec la logique de routage cœur des
  routeurs Cisco/Huawei). `netsh interface ip/ipv6 add/delete route`
  l'expose déjà bien ; les manques restants sont d'affichage
  (`interface tcp/udp`) plutôt qu'une capacité de forwarding manquante.
- **Port-proxy** : également branché sur de vrais listeners de socket via
  `PortProxySocketProjection` — solide.
- À l'inverse, **wlan/lan/http/namespace/bridge/ipsec dynamic** n'ont
  aucun moteur sous-jacent nulle part dans le dépôt (aucune simulation
  Wi-Fi/pont/HTTP.sys/NRPT/IKE n'existe) — combler l'écart signifierait
  soit construire un nouveau moteur léger, soit scoper explicitement le
  PRD à "fidélité de surface commande/sortie uniquement, sans effet
  comportemental", faute de quoi rien n'existe à brancher.

---

## 2. Objectifs

### 2.1 Objectifs de ce PRD (remédiation proposée, non encore engagée)

1. **`netsh advfirewall` — état de profil réel.** Un modèle minimal par
   profil (`domain`/`private`/`public`) : `state on|off`,
   `firewallpolicy`, réellement lu par `show currentprofile`/
   `allprofiles` et réellement respecté par `WindowsPC.firewallFilter()`
   (un profil désactivé laisse tout passer, mimant le vrai comportement).
2. **`netsh advfirewall firewall set rule`** — édition d'une règle
   existante, complétant la symétrie add/show/delete/set déjà en place
   ailleurs dans le fichier.
3. **`interface tcp`/`interface udp` — sous-ensemble minimal.** Au moins
   `show global`/`set global autotuninglevel` en lecture/écriture
   cohérente avec ce que `interface ipv4/ipv6 dynamicport show tcp`
   affiche déjà (`renderDynamicPort`), pour que la command-surface promise
   par l'aide existe réellement.
4. **`interface ip delete neighbors`** — complète la symétrie add/delete
   déjà présente pour route/dns/address.
5. **`netsh dump`** pour les contextes qui ont déjà un état réel
   (`interface ip/ipv6`, `advfirewall firewall`, `portproxy`) : génère un
   script `netsh` rejouable reproduisant la configuration actuelle —
   valeur pédagogique directe (comprendre "à quoi ressemble ma config
   sous forme de commandes").
6. **Alias (`netsh -a`/`show alias`)** — un mécanisme minimal de définition
   et de substitution d'alias, pour la fidélité de scripting.

### 2.2 Non-objectifs (explicitement hors périmètre)

- **Mode interactif complet (`netsh` shell/`-c`/`-f` batch)** — valeur
  pédagogique marginale face au coût d'implémentation (un vrai
  interpréteur de sous-shell contextuel) ; les commandes ponctuelles
  entièrement qualifiées couvrent l'essentiel des besoins de lab.
- **`advfirewall consec`/`monitor`** — sécurité de connexion IPsec et
  moniteur en direct ; aucun scénario de lab existant n'en dépend.
- **Contextes de tunneling IPv6 (`6to4`/`isatap`/`teredo`/`httpstunnel`)**
  — technologies de transition IPv6 obsolètes, aucune valeur pédagogique
  dans un simulateur qui a déjà un vrai double-stack IPv4/IPv6.
- **Construire des moteurs Wi-Fi/pont/HTTP.sys/NRPT/IKE réels** derrière
  `wlan`/`lan`/`http`/`namespace`/`bridge`/`ipsec dynamic` — hors
  périmètre de ce PRD ; ces contextes restent volontairement des
  command-surfaces sans effet comportemental, comme documenté en §1.6.
  Un futur PRD dédié pourrait les traiter individuellement si un besoin
  pédagogique concret apparaît (ex. un PRD Wi-Fi/802.11).
- **`mbn`, `netio`, `nlm`, `ras`, `rpc`, `wcn`, `wfp`, `branchcache`**
  (dictionnaire `SUB_CONTEXT_STUB`) — contextes réseau avancés/obscurs,
  aucune demande de lab identifiée.
- **`netsh routing`** — reproduit déjà volontairement le message réel
  "RRAS requis" ; construire un vrai RRAS est un chantier disproportionné.

---

## 3. Architecture cible

### 3.1 Principe directeur

Confirmé par la recherche (§1.6) : pour le pare-feu et le routage, `netsh`
est déjà une couche de présentation par-dessus des moteurs réels
(`dynamicFirewallRules`/`firewallFilter()`, `RoutingTable`). Les objectifs
#1-#4 (§2.1) sont de la **pure extension de surface de commande**
au-dessus de moteurs déjà solides. Seul l'objectif #5 (`dump`) introduit un
nouveau mécanisme transverse (sérialisation de configuration en script),
mais réutilise entièrement les données déjà collectées par les
gestionnaires `show` existants — aucune nouvelle source de vérité.

### 3.2 Modules proposés (arborescence)

```
src/network/devices/windows/
  WinNetsh.ts               (existant — gagne le modèle de profil
                             pare-feu, `set rule`, `interface tcp/udp`
                             minimal, `delete neighbors`, dispatch `dump`)
  WinNetshDump.ts            (nouveau — sérialise l'état courant
                             (interface ip/ipv6, advfirewall firewall,
                             portproxy) en script `netsh` rejouable ;
                             pur formateur, aucune mutation d'état)
  WinNetshAlias.ts            (nouveau — table d'alias par session,
                             substitution avant dispatch dans `cmdNetsh`)
```

`WindowsPC.firewallFilter()` (existant) gagne une vérification de l'état
de profil (`enabled`/`disabled` par profil actif) avant d'appliquer les
règles `dynamicFirewallRules` — changement additif, un profil "on" par
défaut préserve le comportement actuel.

### 3.3 Design patterns retenus

- **Strategy** pour `dump` : chaque contexte ayant un état réel expose un
  petit sérialiseur (`toNetshScript(): string[]`) suivant la même
  interface, agrégés par `WinNetshDump.ts` — pas de gros `switch` central
  fragile.
- Cohérent avec le pattern déjà en place (moteur réel + façade de
  commande) qui a fait ses preuves pour le pare-feu et le port-proxy dans
  ce même fichier.

---

## 4. Modèle de données

### 4.1 État de profil pare-feu

```ts
type FirewallProfile = 'domain' | 'private' | 'public';

interface FirewallProfileState {
  enabled: boolean;
  inboundAction: 'block' | 'allow';
  outboundAction: 'block' | 'allow';
}

// Un état par profil, par device — la plupart des labs restent sur
// le profil 'public' actif par défaut, cohérent avec un PC non-domain-joint.
type FirewallProfileTable = Record<FirewallProfile, FirewallProfileState>;
```

### 4.2 Alias

```ts
interface NetshAlias {
  name: string;
  expansion: string; // ligne de commande netsh complète à substituer
}
```

---

## 5. Plan de mise en œuvre (TDD, par phases)

| Phase | Contenu | Dépend de |
|---|---|---|
| **P1 — État de profil pare-feu réel** | `FirewallProfileTable` ; `advfirewall show currentprofile/allprofiles` et `set ... state on\|off` réellement lus/écrits ; `firewallFilter()` respecte le profil actif | Existant (`dynamicFirewallRules`, `firewallFilter()`) |
| **P2 — `advfirewall firewall set rule`** | Édition d'une règle existante (nom, action, ports, protocole) sans passer par delete+add | Existant |
| **P3 — `interface ip delete neighbors`** | Symétrie add/delete complète pour les entrées ARP statiques posées via `netsh` | Existant |
| **P4 — `interface tcp`/`udp` minimal** | `show global`/`set global autotuninglevel` cohérents avec `renderDynamicPort` existant (checkpoint de régression complète) | Existant |
| **P5 — `netsh dump`** | `WinNetshDump.ts` pour `interface ip/ipv6`, `advfirewall firewall`, `portproxy` | P1, P2, P3, P4 (le dump doit refléter tout ce qui précède) |
| **P6 — Alias (`netsh -a`/`show alias`)** | `WinNetshAlias.ts` ; substitution avant dispatch dans `cmdNetsh` (checkpoint de régression complète, fin du PRD) | Existant |

Chaque phase suit le cycle rouge → vert → refactor, régression localisée à
chaque phase, régression complète (`npx vitest run`) après P4 et après P6.

---

## 6. Stratégie de test

1. **Profil pare-feu** : `netsh advfirewall set publicprofile state off`
   puis une connexion normalement bloquée par une règle passe — `set ...
   state on` la rebloque ; `show allprofiles` reflète l'état réel des
   trois profils.
2. **`set rule`** : modifier l'action d'une règle existante via `set rule
   name=... new action=block` change réellement le verdict de
   `firewallFilter()` sans nécessiter un delete+add.
3. **`delete neighbors`** : une entrée ARP statique ajoutée via `netsh
   interface ip add neighbors` disparaît réellement de la table ARP après
   `delete neighbors`.
4. **`interface tcp/udp`** : `set global autotuninglevel=disabled` est
   reflété par `show global` et par le `dynamicport`/comportement TCP déjà
   modélisé ailleurs.
5. **`dump`** : le script produit par `netsh interface ip dump` rejoué sur
   un device fraîchement créé reproduit exactement la même configuration
   d'interface (idempotence dump→replay).
6. **Alias** : définir un alias puis l'invoquer produit exactement le même
   résultat que la commande complète qu'il substitue.
7. **Non-régression** : `windows-netsh.test.ts`,
   `windows-netsh-dhcp-dns.test.ts`, `windows-port-forwarding.test.ts`,
   `cmd-netsh.test.ts` restent verts après chaque phase — en particulier
   aucune règle de pare-feu existante ne doit changer de verdict par
   défaut (profil "on" par défaut préserve le comportement actuel).

---

## 7. Risques et points d'attention

1. **Le modèle de profil pare-feu (P1) touche un chemin de données déjà
   exercé en production** (`firewallFilter()`, utilisé par le test SSH
   entrant) — tout changement doit être strictement additif : un profil
   actif par défaut à `enabled: true` avec les mêmes actions
   `inbound=block/outbound=allow` que le comportement actuel implicite,
   pour qu'aucun test existant ne bascule de verdict.
2. **Fidélité `dump` (P5)** — comme pour les précédents PRD, viser une
   fidélité "commandes `netsh` réellement rejouables" plutôt qu'une
   compatibilité bit-à-bit avec le format exact généré par un vrai
   Windows (ordre des lignes, commentaires d'en-tête).
3. **`interface tcp/udp` (P4)** — vérifier en préambule si un concept de
   réglage TCP global (autotuning, congestion) existe déjà ailleurs dans
   le simulateur (voir `PRD-TCP.md`, qui documente l'absence de contrôle
   de congestion réel) — `set global autotuninglevel` ne doit pas laisser
   croire à une capacité de tuning qui n'existe pas réellement côté pile
   TCP tant que `PRD-TCP.md` n'est pas mis en œuvre.
4. **Portée volontairement restreinte** — ce PRD ne traite explicitement
   PAS `wlan`/`lan`/`http`/`namespace`/`bridge`/`ipsec dynamic` (§2.2) ;
   toute demande future sur ces contextes mérite son propre PRD scopé,
   pas une extension ad hoc de celui-ci.

---

## 8. Critères d'acceptation

1. `netsh advfirewall show currentprofile/allprofiles` reflète un état de
   profil réel ; `set ... state on|off` change réellement le
   comportement de `firewallFilter()`.
2. `netsh advfirewall firewall set rule` édite réellement une règle
   existante.
3. `netsh interface ip add/delete neighbors` sont symétriques.
4. `netsh interface tcp/udp show global`/`set global` existent et sont
   cohérents avec le reste de la pile TCP déjà modélisée.
5. `netsh ... dump` produit un script rejouable et idempotent pour
   `interface ip/ipv6`, `advfirewall firewall`, `portproxy`.
6. Les alias définis via `netsh -a`/`add alias` fonctionnent de bout en
   bout et apparaissent dans `show alias`.
7. Les suites `windows-netsh*.test.ts`/`cmd-netsh.test.ts`/
   `windows-port-forwarding.test.ts` restent vertes après chaque phase
   (régression complète après P4 et après P6).
