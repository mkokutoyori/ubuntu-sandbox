# PRD — systemd-networkd : un démon qui configure vraiment

**Version** : 1.0
**Date** : 2026-07-28
**Projet** : Ubuntu Sandbox — Plan de configuration réseau Linux
**Auteur** : Claude Code
**Références normatives** : `systemd-networkd.service(8)`, `systemd.network(5)`, `systemd.netdev(5)`, `systemd.link(5)`, `networkctl(1)`, `resolved.conf(5)`

---

## 0. Contexte et portée du document

`networkctl` sait désormais dire la vérité sur l'état des liens
(`docs/PRD-networkctl.md`, livré). Ce PRD traite l'autre moitié : le démon
qui **produit** cet état.

Le constat mesuré est net et tient en une ligne : **les fichiers
`.network` sont lus, jamais appliqués**. Un administrateur écrit
`/etc/systemd/network/10-eth0.network` avec `Address=192.168.50.10/24`,
redémarre le service, et l'interface reste sans adresse. `networkctl
status` nomme pourtant le fichier correctement — la phase 3 de networkctl
a livré la découverte et l'analyse, mais rien derrière ne les consomme.
C'est un démon qui lit sa configuration et n'en fait rien.

Deuxième constat, du même ordre : **arrêter le démon ne change rien**.
`systemctl stop systemd-networkd` laisse tout en place et `networkctl`
continue d'annoncer des liens en cours de configuration. Rien dans le
simulateur ne dépend du fait que networkd tourne.

Le périmètre est donc : faire du démon l'acteur qui applique les fichiers
natifs, puis donner un sens à son cycle de vie, puis étendre au `[Link]`,
aux `.netdev` et au DNS. Aucune ligne de code n'est écrite dans le cadre
de ce document.

---

## 1. Analyse de l'existant

### 1.1 Inventaire

| Fichier | Rôle actuel | Lignes |
|---|---|---|
| `src/network/devices/linux/LinuxServiceManager.ts` | Unité `systemd-networkd.service` (l. 260), type `notify`, `execReload` | 1070 |
| `src/network/devices/LinuxMachine.ts` | `wireNetworkConfigLifecycle()` : rejoue `applyNetplan()` sur start/restart/reload | — |
| `src/network/devices/linux/LinuxNetworkConfigManager.ts` | `applyNetplan`, `applyDeclaredConfig`, `resolveNetworkdFiles`, dérive, conflits NM | ~380 |
| `src/network/devices/linux/net/NetworkdFiles.ts` | **Analyseur `.network`/`.link`/`.netdev`, découverte, `[Match]`** (livré avec networkctl P3) | ~160 |
| `src/network/devices/linux/net/LinkState.ts` | État de lien dérivé, consommé par `networkctl` | ~230 |
| `src/network/devices/linux/net/NetworkConfigFiles.ts` | netplan YAML + `/etc/network/interfaces` | ~170 |

### 1.2 Ce qui existe déjà et est réutilisable

- **L'analyseur de fichiers natifs est fait.** `discoverNetworkdFiles`,
  `matchNetworkFile`, `matchLinkFile`, `[Match]` par glob, priorité
  lexicographique et masquage `/etc` sur `/usr/lib` : tout est livré,
  testé, et n'attend qu'un consommateur.
- **Le point d'ancrage du cycle de vie existe.**
  `wireNetworkConfigLifecycle()` s'abonne déjà aux événements `start` /
  `restart` / `reload` de l'unité. Il ne reste qu'à lui faire appliquer
  autre chose que netplan.
- **Le moteur d'application existe**, en petit :
  `applyDeclaredConfig()` sait poser une adresse, une passerelle et un
  MTU sur un port réel. Il est typé sur `DeclaredInterfaceConfig`
  (netplan) ; c'est le modèle à généraliser, pas la logique à réécrire.
- **L'unité est un vrai service** : elle tourne dans `ps`, `systemctl
  status` la rend, `journalctl -u systemd-networkd` a des lignes, et
  `logMgr.logSystemd('systemd-networkd', …)` alimente déjà le journal.
- **`systemd-resolved.service` existe et tourne**, ce qui donne un point
  d'accroche naturel pour `DNS=`.

### 1.3 Ce qui manque ou court-circuite (analyse d'écart)

Constats **mesurés** : un `.network` écrit avec `Address=192.168.50.10/24`,
`Gateway=192.168.50.1`, `DNS=9.9.9.9` et `MTUBytes=1400`, puis
`systemctl restart systemd-networkd`.

| # | Écart constaté | Comportement réel attendu | Sévérité |
|---|---|---|---|
| 1 | Après redémarrage du démon, `ip -br addr` ne montre **aucune** adresse IPv4 sur eth0. `Address=` n'est jamais appliqué | L'adresse déclarée est posée sur le lien | Bloquant |
| 2 | `ip route` reste vide : `Gateway=` n'est jamais appliqué | La route par défaut est installée | Bloquant |
| 3 | `MTUBytes=1400` ignoré : `ip -br link` donne toujours 1500 | Le MTU du lien suit `[Link] MTUBytes=` | Élevée |
| 4 | `/etc/resolv.conf` reste vide : `DNS=` n'est jamais propagé | Les serveurs déclarés deviennent les résolveurs du système | Élevée |
| 5 | `networkctl reload` rejoue netplan, jamais les `.network` | `reload` relit les fichiers natifs | Bloquant |
| 6 | `systemctl stop systemd-networkd` ne change rien : `networkctl list` annonce toujours `configuring` | Démon arrêté ⇒ plus personne ne configure ; les liens gérés retombent en `pending`/`unmanaged` | Élevée |
| 7 | L'état `setup` ignore les `.network` : il est dérivé du seul netplan (`LinkState.deriveSetup`) | Un lien retenu par un `.network` est `configured` une fois appliqué | Élevée |
| 8 | `[Match]` n'est consulté que pour l'affichage ; aucune application ne le respecte | Le premier fichier retenu gouverne le lien | Élevée |
| 9 | Aucun support `.netdev` : impossible de créer un lien virtuel par fichier | `Kind=dummy`/`vlan`/`veth` crée le périphérique au démarrage du démon | Moyenne |
| 10 | Aucune notion d'`ActivationPolicy=` : le démon ne monte jamais un lien | Par défaut le démon monte les liens qu'il gère | Moyenne |
| 11 | `[DHCP]`/`[DHCPv4]` non lu : un `.network` en DHCP ne déclenche aucun bail | `DHCP=yes` lance le client sur ce lien | Moyenne |
| 12 | Sections `[Address]` et `[Route]` (formes longues, multiples) non gérées | Plusieurs adresses et routes par lien | Moyenne |
| 13 | Aucun journal d'application : le journal ne montre que start/stop | Chaque application est tracée, comme `applyNetplan` le fait déjà pour netplan | Faible |
| 14 | `networkd-dispatcher` absent, `resolvectl` absent | Hors périmètre — voir §9 | — |

**Ce qui est déjà juste et ne doit pas régresser** : le chemin netplan
(`applyNetplan`, dérive, conflits NetworkManager) est correct et couvert
par `linux-network-config-drift.test.ts`. Ubuntu fait de netplan le
générateur qui *produit* les `.network` ; ce PRD ajoute le format natif
sans retirer le raccourci netplan existant.

---

## 2. Modèle : qui décide de quoi

L'écart #1 vient d'une absence d'acteur. On introduit un **plan de
configuration** unique, distinct du plan d'affichage livré avec
networkctl.

```
fichiers .network/.link/.netdev ─┐
                                 ├─► NetworkdConfigPlan ─► application sur les Port
netplan / interfaces ────────────┘        (résolu)              (effets réels)
                                                │
                                                ▼
                                          LinkState (lecture seule, networkctl)
```

### 2.1 `NetworkdLinkPlan`

Ce qu'un lien doit devenir, résolu depuis le **premier** fichier retenu :

| Champ | Source | Effet |
|---|---|---|
| `addresses: string[]` | `[Network] Address=`, `[Address] Address=` | `configureInterface` |
| `gateway: string \| null` | `[Network] Gateway=`, `[Route] Gateway=` | `setDefaultGateway` |
| `routes: {destination, gateway}[]` | `[Route]` | `addStaticRoute` |
| `dns: string[]` | `[Network] DNS=` | `/etc/resolv.conf` |
| `domains: string[]` | `[Network] Domains=` | `search` de resolv.conf |
| `dhcp: 'no'\|'yes'\|'ipv4'\|'ipv6'` | `[Network] DHCP=` | client DHCP |
| `mtu: number \| null` | `[Link] MTUBytes=` | `Port.setMTU` |
| `macAddress: string \| null` | `[Link] MACAddress=` | `Port.setMAC` |
| `activationPolicy` | `[Link] ActivationPolicy=` | monte/descend le lien |
| `sourceFile: string` | — | tracé au journal, rendu par `networkctl` |

**Règle d'unicité** : un lien est gouverné par **un seul** `.network`, le
premier retenu dans l'ordre lexicographique. systemd ne fusionne pas
plusieurs fichiers pour un même lien, et fusionner ici serait inventer
une sémantique.

### 2.2 Précédence entre netplan et fichiers natifs

Sur Ubuntu, netplan **génère** `/run/systemd/network/10-netplan-*.network`.
Le simulateur garde son raccourci (netplan appliqué directement), donc la
règle est :

1. Un `.network` retenu pour le lien → il gouverne, netplan est ignoré
   **pour ce lien**.
2. Sinon → le chemin netplan actuel s'applique, inchangé.

C'est ce qui garantit la non-régression de la dérive netplan tout en
faisant du format natif la source la plus spécifique.

---

## 3. Phase 1 — Le démon applique les fichiers natifs

**C'est la seule phase qui corrige un démon inerte ; elle passe avant tout
le reste.**

1. `NetworkdConfigPlan.resolve(vfs, ports)` → un `NetworkdLinkPlan` par
   lien retenu, construit sur `discoverNetworkdFiles`/`matchNetworkFile`
   déjà livrés.
2. `LinuxNetworkConfigManager.applyNetworkd(net)` applique adresses,
   passerelle et routes, et trace chaque effet au journal via le
   `logSystemd('systemd-networkd', …)` déjà en place.
3. `wireNetworkConfigLifecycle()` appelle `applyNetworkd()` **avant**
   `applyNetplan()`, ce dernier sautant les liens déjà gouvernés (§2.2).
4. `networkctl reload` et `networkctl reconfigure <lien>` passent par le
   même chemin — c'est l'écart #5.

**Critère d'acceptation** : écrire un `.network` avec `Address=`, faire
`systemctl restart systemd-networkd`, et constater l'adresse dans
`ip -br addr` **et** dans `networkctl status`. Les deux commandes doivent
s'accorder, comme pour la phase 1 de networkctl.

---

## 4. Phase 2 — Le cycle de vie du démon compte

1. `applyNetworkd()` n'agit que si l'unité est active : configurer alors
   que le démon est arrêté n'a pas de sens.
2. `LinkState.deriveSetup` consulte l'état du service : démon arrêté ⇒ un
   lien qu'il gérait passe `pending` au lieu de rester `configuring`
   (écart #6).
3. `setup` est dérivé du plan et non plus du seul netplan : lien retenu et
   appliqué ⇒ `configured` ; retenu, DHCP, sans bail ⇒ `configuring` ;
   non retenu ⇒ `unmanaged` (écart #7).
4. `networkctl status` nomme le fichier qui gouverne réellement.

**Choix assumé** : arrêter networkd ne **retire pas** les adresses déjà
posées. C'est le comportement réel — les adresses sont un état du noyau,
que le démon ne nettoie pas en s'arrêtant. Seul le regard de `networkctl`
change.

---

## 5. Phase 3 — `[Link]` : MTU, MAC, politique d'activation

1. `MTUBytes=` → `Port.setMTU` (écart #3).
2. `MACAddress=` → `Port.setMAC`.
3. `ActivationPolicy=` (`up` par défaut, `always-up`, `manual`, `down`,
   `always-down`) → le démon monte le lien qu'il gère (écart #10).
4. Ces trois-là s'appliquent aussi depuis un `.link`, dont le `[Match]`
   porte `OriginalName=`.

---

## 6. Phase 4 — `.netdev` : les liens virtuels par fichier

`Kind=dummy`, `vlan`, `veth` sont les trois seuls types que le simulateur
sait réellement créer (`IpLinkOpsContext.addDummy/addVlan/addVeth`, déjà
utilisés par `ip link add`). Le démon crée le périphérique au démarrage,
puis lui applique son `.network` s'il en existe un.

**Explicitement hors périmètre** : `bond`, `bridge`, `wireguard`,
`macvlan`, `tun`/`tap`. Aucun modèle ne les porte côté hôte, et en
inventer un dépasse ce PRD — c'est aussi pourquoi les états
`enslaved`/`degraded-carrier` de `LinkState` restent non dérivables.

---

## 7. Phase 5 — DNS

1. `DNS=` → `/etc/resolv.conf` (`nameserver`), avec l'en-tête généré
   qu'Ubuntu écrit (écart #4).
2. `Domains=` → ligne `search`.
3. Les serveurs obtenus par bail DHCP se combinent aux serveurs déclarés,
   les déclarés d'abord — ordre de systemd.
4. `LinkState.dns` lit le résultat, donc `networkctl status` montre ce
   que le système résout réellement.

**Limite assumée** : le vrai Ubuntu fait pointer `/etc/resolv.conf` vers
un lien symbolique géré par `systemd-resolved` (`127.0.0.53`). Ici les
serveurs sont écrits en clair dans le fichier, parce que le résolveur du
simulateur lit ce fichier directement (`LinuxNetKernel`, §NSS). Écrire
`127.0.0.53` sans stub à cette adresse casserait toute résolution — ce
serait de la fidélité de façade payée d'une régression réelle.

---

## 8. Phase 6 — DHCP piloté par fichier

1. `[Network] DHCP=yes|ipv4|ipv6|no` déclenche le client sur le lien
   (écart #11), via le `DHCPClient` déjà réel.
2. `[DHCPv4] UseDNS=`, `UseRoutes=`, `UseMTU=` filtrent ce que le bail a
   le droit d'appliquer.
3. Un `.network` statique et un bail actif ne coexistent pas : le fichier
   gouverne, comme chez systemd.

---

## 9. Hors périmètre

- **D-Bus** (`org.freedesktop.network1`) : l'accès reste direct, en
  mémoire. La façade est fidèle, le transport ne l'est pas.
- **`networkd-dispatcher`** : absent aujourd'hui, et c'est un paquet
  Ubuntu distinct de systemd.
- **`resolvectl` et le stub 127.0.0.53** — voir §7.
- **`systemd-networkd-wait-online`** : suppose un modèle de cible de
  démarrage bloquante qui n'existe pas.
- **bond / bridge / wireguard / macvlan** — voir §6.
- **IPv6 par annonces de routeur** (`IPv6AcceptRA=`) : pas de modèle RA
  côté hôte, donc pas de dérivation possible.
- **`[Network] IPv6PrivacyExtensions=`, `[Network] LLMNR=`, mDNS.**

---

## 10. Risques

| Risque | Portée | Atténuation |
|---|---|---|
| La dérive netplan casse | `linux-network-config-drift.test.ts` | La règle §2.2 : sans `.network` retenu, le chemin netplan est **inchangé**. Vérifier ce test avant et après ; s'il tombe, c'est la précédence qu'il faut corriger, jamais l'assertion |
| Double application (netplan + natif) sur un même lien | Phase 1 | Un lien gouverné par un `.network` est retiré de la boucle netplan, pas configuré deux fois |
| Fusion accidentelle de plusieurs `.network` | Phase 1 | Règle d'unicité §2.1 : premier retenu, point |
| `setup` devient dépendant du service et casse `networkctl` | Phase 2 | Les 45 probes networkctl existantes sont le garde-fou : elles tournent avant/après chaque phase |
| `MACAddress=` casse l'ARP ou les tables MAC apprises | Phase 3 | Appliqué à la création du plan seulement, jamais sur un lien déjà porteur de trafic |

---

## 11. Stratégie de test

| Fichier | Couvre |
|---|---|
| `probe-networkd-01-application.test.ts` | Phase 1 — dont **la corrélation `ip -br addr` ↔ `networkctl status`** après redémarrage du démon |
| `probe-networkd-02-cycle-de-vie.test.ts` | Phase 2 — démon arrêté, `setup` retombe ; adresses conservées |
| `probe-networkd-03-link-netdev.test.ts` | Phases 3 et 4 |
| `probe-networkd-04-dns-dhcp.test.ts` | Phases 5 et 6 |

Mêmes trois règles de méthode que pour networkctl : mesurer avant
d'affirmer, ne jamais faire passer un test par la force, et corréler deux
commandes plutôt que figer une chaîne.

---

## 12. Ordre de livraison recommandé

**Phase 1 d'abord, seule.** C'est elle qui transforme un démon qui lit sa
configuration sans rien en faire en un démon qui configure. Les phases 2
et 3 la rendent cohérente ; 4, 5 et 6 l'étendent. La phase 4 (`.netdev`)
peut être abandonnée sans dommage si le budget manque — les trois types
créables sont marginaux dans une maquette pédagogique.
