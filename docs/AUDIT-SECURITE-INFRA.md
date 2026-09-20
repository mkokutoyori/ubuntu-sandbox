# Audit sécurité — durcir l'infrastructure, et voir ce qui tient

**Date :** 2026-09-10 · **Méthode :** monter une infrastructure
d'entreprise, la durcir comme le ferait un ingénieur sécurité, puis
**attaquer chaque contrôle**. Relevés dans
`src/__tests__/debug/infra/` et `src/__tests__/debug/rman/`.

> **Le principe de cet audit.** Poser une commande ne prouve rien : le
> `CLAUDE.md` §6 nomme précisément le défaut où un critère est analysé,
> rangé, rendu par `show` — et jamais évalué. Un durcissement qui
> s'affiche sans s'appliquer est pire qu'un durcissement absent, parce
> qu'il produit une **fausse assurance**. Chaque ligne ci-dessous a donc
> deux colonnes : *accepté* et *appliqué*.

---

## 1. Ce que la phase « poser » ne dit pas

Vingt contrôles ont été posés sur un commutateur d'accès et un routeur
de cœur — VLAN, port-security, BPDU guard, storm-control, DHCP snooping,
ARP inspection, VLAN natif déplacé, AAA, SSH seul, `login block-for`,
ACL anti-usurpation, uRPF, services dangereux coupés, SNMPv3 authPriv,
syslog, NTP authentifié, bannière.

**Les vingt sont acceptés sans une erreur.** C'est exactement le résultat
qui ne doit convaincre personne, et le point de départ de l'audit.

---

## 2. Ce qui APPLIQUE réellement — mesuré

| Contrôle | Attaque | Résultat |
|---|---|---|
| `switchport port-security maximum 1` + `violation shutdown` | 2ᵉ MAC derrière un hub | **applique** — voir §2.1 |
| `ip access-group` avec `deny icmp` | ping à travers | `100% packet loss, +2 errors` ✅ |
| `transport input ssh` sur les VTY | `telnet 10.10.10.1` | `Connection refused` ✅ |
| `login block-for 120 attempts 3 within 60` | `show login` | rend les trois seuils, la fenêtre et le compteur ✅ |
| `ip dhcp snooping` + `vlan 1` | `show ip dhcp snooping` | `enabled`, **et `operational on VLAN 1`** ✅ |
| Politique FortiGate `accept` / `deny` | ping inter-zone | `0%` puis `100% packet loss` ✅ |

### 2.1 `port-security` — le relevé complet

```
[T] PC-A joint le routeur, avant durcissement    0% packet loss
[1] PC-A, 1re MAC apprise                        0% packet loss
[2] PC-B, 2e MAC sur le même port              100% packet loss
[3] Port Status : Secure-shutdown
    Security Violation Count : 1
    Sticky MAC Addresses : 1
    Last Source Address:Vlan : 0200.0000.001d:1
[4] show interfaces status                       Fa0/1  disabled
[5] PC-A APRÈS la violation                    100% packet loss
```

**[5] est le point le plus instructif, et ce n'est pas un défaut.**
`violation shutdown` err-disable le port **entier** : la machine
légitime perd le lien elle aussi. C'est ce que fait un vrai Catalyst, et
c'est la raison pour laquelle ce mode se déploie avec précaution. Un
simulateur qui n'aurait puni que l'intrus aurait enseigné le contraire.

> **Conclusion de cette section, et elle est à porter au crédit du
> projet :** la pile de sécurité réseau ne fait pas semblant. Les
> contrôles L2 et L3 testés tiennent sous l'attaque, avec les états, les
> compteurs et les effets de bord du matériel réel.

---

## 3. Le trou qui était unique — REFERMÉ depuis

> **Mise à jour.** Ce qui suit décrivait l'état au moment de l'audit. Le
> lot R7 l'a refermé : `resolveOneAddress` compose désormais un vrai SYN
> par `tcpConnectOutcome`, et `RmanSession` résout sa cible par la même
> porte. Le relevé après correctif :
>
>     RMAN @10.10.20.20, pare-feu OUVERT   connected to target database: ORCL
>     RMAN @10.10.20.20, pare-feu FERMÉ    RMAN-04006 / ORA-12170
>     sessions du pare-feu                 4 avant, 5 après
>
> **[D] est la preuve que la connexion traverse** — le pare-feu compte
> une session de plus. Reste ouvert : une sauvegarde vers un point de
> montage distant écrit encore dans le VFS local (lot R8).

### 3.1 L'état constaté à l'audit

Un seul contrôle s'est révélé sans effet, et il n'est pas dans le
réseau : **la connexion RMAN ne traverse rien**.

| | mesure |
|---|---|
| ping DB→BACKUP, aucune politique | `100% packet loss` |
| ping, politique **ACCEPT** | `0% packet loss` |
| ping, politique **DENY** | `100% packet loss` |
| `CONNECT TARGET …@10.10.20.20`, pare-feu **ouvert** | `connected to target database: ORCL` |
| la même, pare-feu **FERMÉ** | `connected to target database: ORCL` |
| sessions vues par le pare-feu | `4` avant, `4` après |

Les trois pings sont le **témoin** : ce pare-feu bloque réellement. Que
les deux connexions RMAN rendent la même réponse ne s'explique donc pas
par un pare-feu inerte, mais par une connexion qui n'existe pas — *un
pare-feu ne bloque pas ce qui ne traverse rien*.

**Gravité, du point de vue d'un ingénieur sécurité.** Ce n'est pas un
manque de fonctionnalité, c'est un **résultat faux**. Un opérateur qui
segmente son datacenter, coupe le flux base→sauvegarde et voit RMAN
continuer d'aboutir en conclura que sa règle est inefficace. Il tirera
de son laboratoire l'inverse de ce que la réalité lui enseignerait.
C'est inscrit au `TODO.md` et c'est le lot **R7** de
`docs/ASSESSMENT-RMAN.md`.

---

## 4. Deux réserves de méthode, que je porte à mon débit

Cet audit a produit **deux faux positifs** avant correction, tous deux
de mon fait, et les nommer vaut mieux que de les taire :

1. **`login block-for` déclaré « non appliqué ».** Faux : mon banc
   tronquait `show login` à trois lignes. La sortie complète rend bien
   « Router enabled to watch for login Attacks » et les trois seuils.
   C'est la lecture de l'implémentation qui a tranché — pas une
   deuxième mesure.
2. **DHCP snooping déclaré « non testé, offres non filtrées ».** Faux
   aussi : mon serveur voyou n'avait pas de démon DHCP du tout, donc
   l'absence d'offre ne prouvait rien sur le snooping.

`ip http server` reste **non mesurable** par ce laboratoire : `curl`
vers le routeur rend le vide avant comme après `no ip http server`. Ce
n'est pas un défaut établi, c'est un contrôle dont l'effet n'est pas
observable — donc une zone où un défaut pourrait vivre sans être vu.

---

## 5. Ce qui n'a pas été attaqué, et devrait l'être

Par honnêteté sur la couverture : ces contrôles ont été posés et
acceptés, mais **aucune attaque ne les a éprouvés**. Ne pas les compter
comme validés.

- **BPDU guard** — envoyer une BPDU sur un port `portfast`
- **ARP inspection** — ARP gratuit avec une liaison fausse
- **storm-control** — inondation de diffusion
- **uRPF** — paquet à source usurpée
- **SNMPv3 authPriv** — interroger en v2c malgré la déclaration v3
- **NTP authentifié** — serveur non authentifié
- **VLAN natif / pruning** — saut de VLAN (double étiquetage)
- **AAA** — échec d'authentification et repli
- **iptables, sudo, permissions `oracle`** — toute la pile hôte

C'est le programme d'un second passage, et chacun est un candidat
sérieux au défaut du §6.

---

## 6. Second passage — les attaques, et ce qu'elles ont trouvé

**Date :** 2026-09-20 · Relevé dans
`src/__tests__/debug/infra/second-passage-attaques.debug.test.ts`.

Le pronostic de la §5 s'est vérifié : sur les huit contrôles attaqués,
quatre tiennent, quatre portaient un défaut.

| Contrôle | Attaque | Accepté | Rendu par `show` | **Applique** |
|---|---|---|---|---|
| **uRPF** | paquet source `203.0.113.9`, aucune route | oui | oui | **oui** |
| **storm-control** | 53 diffusions à travers le port | oui | `Fa0/1 Forwarding 1.00%` | **NON** → S-01 |
| **BPDU guard** | BPDU sur un port `portfast` | oui | oui | **oui** |
| **SNMP** | requête v2c, community inconnue | oui | oui | **oui** |
| **NTP authentifié** | serveur sans la clé exigée | oui | oui | **oui** |
| **ARP inspection** | ARP gratuit à liaison fausse | oui | `(all)` → S-05 | **oui** |
| **VLAN natif** | double étiquetage | oui | oui | **partiel** → S-02 |
| **AAA** | repli après serveur injoignable | oui | oui | **NON** → S-03, S-04 |

### 6.1 uRPF tient, dans les deux sens

Le contrôle est éprouvé comme l'exige §6 — *il correspond quand il doit,
et il ne correspond pas quand il ne doit pas* :

```
[uRPF-T] TÉMOIN avant durcissement           0% packet loss
[uRPF-3] source légitime APRÈS durcissement  0% packet loss
[uRPF-4] source légitime rejetée ?           non
[uRPF-5] source usurpée rejetée ?            OUI
```

Le témoin et le cas [uRPF-3] sont indispensables : un banc qui n'aurait
mesuré que le rejet n'aurait pas distingué « uRPF filtre » de « ce lien
ne passe plus rien ».

### 6.2 S-01 — `storm-control` n'appliquait rien — **CORRIGÉ**

Le relevé initial :

```
storm-control broadcast level 1.00   accepté, silence
show storm-control                   Fa0/1 Forwarding 1.00% 1.00%
running-config                       la ligne est rendue
53 diffusions à travers le port      53 passent, AUCUNE supprimée
show interfaces status               Fa0/1 connected
```

La lecture du code a confirmé la mesure : le réglage était analysé,
**refusé s'il était incomplet**, stocké comme ligne de configuration et
rendu par `show storm-control` et `show running-config` — et le plan de
commutation ne le consultait **nulle part**. C'est le §6 dans sa forme
la plus exacte, et pour un contrôle de sécurité il produit une **fausse
assurance** : un opérateur croit son port protégé de l'inondation.

Le moteur évalue désormais les trois unités (`percent`, `pps`, `bps`)
sur une fenêtre d'une seconde, avec seuil haut et seuil bas. Relevé
après correctif :

```
40 diffusions, seuil 10 pps, sans action   10 relayées, 30 supprimées
le port reste                              connected
une trame UNICAST connue pendant la tempête  passe
avec `action shutdown`                     Fa0/1 disabled
```

**Le troisième point est celui qui compte.** `storm-control broadcast`
ne doit rien faire à l'unicast : un limiteur qui déborde sur les autres
classes de trafic serait un défaut plus grave que son absence.

Non-régression : `src/__tests__/audit/storm-control-audit-preuves.test.ts`.

### 6.3 BPDU guard, SNMP, NTP, ARP inspection — ils appliquent

Quatre des six contrôles restants tiennent, et le relevé le montre dans
les deux sens, comme l'exige §6 :

```
[bpdu-2] avant la BPDU du voyou                Fa0/3 connected
[bpdu-3] après la BPDU du voyou                Fa0/3 disabled

[snmp-4] requête v2c, community=public         refusée (aucune donnée)
[snmp-5] TÉMOIN — la même APRÈS `snmp-server community public RO`  aboutit

[ntp-4] clé exigée, serveur SANS clé           stratum 16, unsynchronized
[ntp-5] TÉMOIN — clé exigée, serveur AVEC clé  stratum 4, synchronized

[dai-3] deux ARP gratuits usurpant 10.0.0.10   2 reçus, 2 rejetés
[dai-4] journal                                Fa0/2 1 …/10.0.0.10 2 DHCP Deny
[dai-5] table ARP de la victime                non empoisonnée
```

Les témoins ne sont pas décoratifs. Sans `[snmp-5]`, « la requête v2c
est refusée » ne distinguerait pas un contrôle de communauté d'un agent
inerte ; sans `[ntp-5]`, « stratum 16 » ne distinguerait pas
l'authentification NTP d'un lien qui ne porte rien.

Deux limites nommées au passage, et mesurées :

- **`SnmpAgent` ne parle que v2c sur le fil.** `snmp-server group … v3
  priv` et `snmp-server user … auth sha … priv aes 128 …` sont acceptés
  et rendus, `groups`/`versions` ne sont consultés par aucun chemin de
  décision, et la brique manquante est USM (RFC 3414). Un labo ne peut
  donc pas démontrer qu'une requête v2c est refusée *parce que* seul v3
  est déclaré — ce qu'il démontre ici, c'est le contrôle de communauté.
- **`ntp server X` sans `key N` se synchronise même sous `ntp
  authenticate`.** C'est la lecture retenue par le dépôt dans
  `NtpAgent.authRequise()` (`this.config.authenticate && a.keyId !==
  undefined`), sourcée Cisco : `ntp authenticate` arme le mécanisme,
  c'est `key` sur l'association qui l'exige. Ce n'est pas un défaut.

### 6.4 S-02 — le saut de VLAN par double étiquetage — **CORRIGÉ**

L'attaque : une trame à DEUX étiquettes injectée sur un port d'accès —
extérieure égale au VLAN natif du trunk, intérieure VLAN 10.

```
[hop-1] natif 1, pirate en VLAN 1, double étiquette 1/10   VLAN 10  ← le saut aboutit
[hop-2] TÉMOIN — même port, trame simple                   VLAN 1
[hop-3] `switchport trunk native vlan 999`, pirate en 1    VLAN 1   ← refermé
[hop-4] TÉMOIN — trame simple, natif 999                   VLAN 1
[hop-5] natif 999 mais le pirate EST dans le natif          VLAN 10  ← toujours ouvert
[hop-6] `vlan dot1q tag native`                            % Invalid VLAN ID
```

`[hop-1]` et `[hop-5]` sont le comportement d'un vrai commutateur, et
doivent le rester. `[hop-3]` prouve que `switchport trunk native vlan`
applique. Le constat est `[hop-6]` : **la seule parade qui refermerait
`[hop-5]` n'existait pas.** `vlan dot1q tag native` n'était déclarée
nulle part — la commande tombait sur l'analyseur de `vlan <id>`, qui
répondait `% Invalid VLAN ID`.

Premier temps de la mesure, et il faut le dire : `[hop-6]` a d'abord été
relevé comme « accepté (silence) », ce qui aurait fait conclure au pire
des trois cas du §6. C'était une erreur de sonde — la ligne lisait la
sortie de `end`, pas celle de la commande. La commande était refusée,
donc §6 était respecté : un critère que le moteur ne sait pas évaluer
est refusé. Il manquait le moteur, pas la rigueur.

La commande est désormais déclarée (`vlan dot1q tag native` /
`no …`, annoncée par `?` à chaque niveau, rendue par
`show running-config`) et **elle décide** : à la sortie d'un trunk le
VLAN natif est étiqueté au lieu d'être envoyé nu, et une trame NON
étiquetée arrivant sur un trunk est rejetée. Relevé après correctif :

```
[hop-7] même attaque avec `vlan dot1q tag native`   VLAN 1   ← refermé
[hop-8] TÉMOIN — trame simple                       VLAN 1
```

La documentation Cisco est **injoignable depuis cet environnement**
(`www.cisco.com` → `connect_rejected` par le proxy de sortie, mesuré) ;
les deux moitiés du comportement viennent donc de la définition de la
commande pour l'étiquetage, et de la règle « un critère de sécurité
échoue FERMÉ » (§6) pour le rejet de l'entrant non étiqueté. Les
protocoles de contrôle (STP, CDP, DTP, LLDP, VTP, LACP, UDLD, EAPOL)
sont interceptés avant la classification de VLAN, donc ce rejet ne les
touche pas.

### 6.5 S-03 — le repli `local` après un groupe RADIUS injoignable — **CORRIGÉ**

L'attaque : `aaa authentication login default group GRP local`, serveur
RADIUS à une adresse où il n'y a personne, et une ouverture de session
SSH avec le compte **local**.

```
[aaa-0]  TÉMOIN DU LABO — `login local`, aucun aaa        entre
[aaa-0b] TÉMOIN — aaa new-model + `… default local`       entre
[aaa-2]  `… default group GRP` seul, serveur muet         refusé
[aaa-4]  `… default group GRP local`                      REFUSÉ  ← le défaut
[aaa-5]  TÉMOIN — mauvais mot de passe, repli autorisé    refusé
```

`[aaa-4]` est l'inverse exact d'IOS : un serveur injoignable doit être
**sauté**, et la chaîne continuer vers `local`. Ici il **rejetait**, et
la session était refusée. Conséquence pratique : *un routeur dont le
serveur RADIUS tombe verrouille dehors tous ses administrateurs, alors
même que l'opérateur avait écrit `local` pour ce cas précis.*

La cause tenait en une ligne. `RadiusClientAgent` distingue déjà en
interne `accept` / `reject` / `timeout` — son propre commentaire dit que
« seul `timeout` déclenche le basculement » — mais `authenticate()`
écrasait les trois en un booléen, et `tryRadiusGroup` relisait ce
booléen comme un **rejet faisant autorité** :

```ts
reachable = true;                       // « joignable » = une adresse est CONFIGURÉE
const accepted = await client.authenticate(…);
if (accepted) return 'accept';
return reachable ? 'reject' : 'continue';
```

`tryTacacsGroup`, quarante lignes plus bas, tenait déjà la bonne forme :
`pass` → accepte, `fail` → rejette, **tout le reste** → serveur suivant,
puis méthode suivante. C'est la duplication du §2 dans sa version la
plus coûteuse : deux écritures d'un même fait, dont une seule est juste.

Le verdict à trois valeurs est désormais porté jusqu'à l'appelant
(`authenticateWithOutcome`), et `tryRadiusGroup` a la forme de son
jumeau TACACS+. Relevé après correctif :

```
[aaa-2] `… group GRP` seul, serveur muet     Permission denied
[aaa-4] `… group GRP local`                  entre          ← le repli applique
[aaa-5] mauvais mot de passe                 Permission denied
```

### 6.6 S-04 — `radius-server timeout` / `retransmit` jamais appliqués — **CORRIGÉ**

Trouvé en instrumentant S-03 : la chaîne mettait **20 s** à rendre son
verdict là où l'opérateur avait écrit `radius-server timeout 1` et
`radius-server retransmit 0` — soit exactement les défauts IOS, 4 essais
de 5 s.

Un serveur déclaré par `radius server <nom>` naissait avec
`timeoutSec: 5, retransmit: 3` **inscrits dans son enregistrement**, si
bien que la chaîne `server.timeoutSec ?? defauts.timeoutSec` choisissait
toujours la valeur du serveur. Les réglages globaux étaient acceptés,
rendus par `show running-config`, et sans aucun effet. La forme héritée
`radius-server host …`, elle, laissait ces champs indéfinis — donc elle
marchait, et les deux formes ne répondaient pas la même chose sur la
même machine (§3).

Le défaut vit désormais **une seule fois**, au bout de la chaîne `??`
(`radiusAuthPort`, `syncRadiusServer`), et l'enregistrement du serveur ne
porte que ce que l'opérateur a tapé. Même correctif pour TACACS+, qui
avait la même forme. Mesure après : **1 003 ms** au lieu de 20 006.

### 6.7 S-05 — la colonne `Vlan` de `show ip arp inspection statistics` — **CORRIGÉ**

Le contrôle DAI applique (§6.3). Mais le tableau de ses compteurs
annonçait une colonne `Vlan` et y écrivait le mot `(all)` : les
statistiques étaient tenues **par port seulement**, donc le VLAN — que
le journal `show ip arp inspection log` connaît, lui — était perdu. Deux
vues d'un même fait dont une seule sait répondre. Les compteurs sont
désormais tenus par port **et** par VLAN, et le tableau rend une ligne
par VLAN observé.

### 6.8 Ce qui reste à attaquer

De la §5, il reste **la pile hôte** : `iptables`, `sudo`, les
permissions `oracle`. Ne pas la compter comme validée.

Non-régression du second passage :
`src/__tests__/audit/storm-control-audit-preuves.test.ts` (S-01) et
`src/__tests__/audit/second-passage-audit-preuves.test.ts` (S-02 à
S-05, 7 cas discriminants sur 13).
