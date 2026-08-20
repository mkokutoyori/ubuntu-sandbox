# Tutoriel DNS — de zéro à héros

**Objectif final** : à la fin de ce tutoriel, tu sauras construire toi-même un petit
réseau d'entreprise complet dans le simulateur : un **serveur Linux** qui joue le rôle
de **serveur DNS** (avec BIND 9, le vrai logiciel utilisé partout dans le monde), un
**switch Cisco** qui joue le rôle de **serveur DHCP** (il distribue automatiquement les
adresses aux machines), et des PC clients qui, sans aucune configuration manuelle,
obtiennent une adresse et arrivent à joindre un serveur web **par son nom**.

Aucune connaissance préalable n'est requise. Chaque notion est expliquée avant d'être
utilisée. Toutes les commandes de ce tutoriel ont été testées dans le simulateur : tu
peux les recopier telles quelles.

**Plan du tutoriel**

1. [Les fondations : comprendre un réseau](#partie-1)
2. [Pourquoi le DNS existe](#partie-2)
3. [Comment fonctionne le DNS](#partie-3)
4. [Les outils du technicien DNS](#partie-4)
5. [BIND 9 : notre serveur DNS](#partie-5)
6. [DHCP : distribuer les adresses… et l'adresse du DNS](#partie-6)
7. [Le grand lab : construire le réseau complet](#partie-7)
8. [Pour aller plus loin](#partie-8)
9. [Annexe : aide-mémoire](#annexe)

---

<a name="partie-1"></a>
## Partie 1 — Les fondations : comprendre un réseau

### 1.1 C'est quoi, un réseau ?

Un réseau informatique, c'est simplement **plusieurs machines reliées entre elles pour
échanger des informations** : des PC, des serveurs, des imprimantes, des téléphones…
Pour qu'elles se comprennent, il faut deux choses : un moyen physique de se parler (des
câbles, du Wi-Fi) et des règles communes de conversation (les **protocoles**). DNS et
DHCP, que nous allons étudier, sont deux de ces protocoles.

### 1.2 L'adresse IP : le numéro de rue de chaque machine

Chaque machine d'un réseau possède une **adresse IP**, qui l'identifie de manière
unique, comme une adresse postale identifie une maison. Une adresse IPv4 s'écrit en
quatre nombres (de 0 à 255) séparés par des points :

```
192.168.1.10
```

Certaines plages d'adresses sont réservées aux réseaux **privés** (ta maison, une
entreprise) : `192.168.x.x`, `10.x.x.x`, `172.16.x.x` à `172.31.x.x`. C'est ce que
nous utiliserons dans notre lab.

### 1.3 Le masque de sous-réseau : où s'arrête mon quartier ?

Le **masque** indique quelle partie de l'adresse désigne *le réseau* (le quartier) et
quelle partie désigne *la machine* (la maison). Le masque le plus courant est
`255.255.255.0`, aussi noté `/24` :

```
192.168.1.10 / 24
└────┬────┘ └┬┘
 réseau      machine
(192.168.1)  (n° 10)
```

Deux machines dont l'adresse commence par le même `192.168.1.` sont dans le **même
réseau** : elles peuvent se parler directement. Notre lab entier tiendra dans un seul
réseau `192.168.1.0/24`, qui peut accueillir 254 machines (de `.1` à `.254`).

### 1.4 L'adresse MAC : le numéro de série de la carte réseau

En plus de son adresse IP (qui peut changer), chaque carte réseau a une **adresse MAC**
gravée en usine, du genre `02:00:00:00:00:37`. C'est l'équivalent d'un numéro de série.
Tu la croiseras dans les tables DHCP : c'est ainsi que le serveur DHCP reconnaît « qui »
a demandé une adresse.

### 1.5 Le switch : la multiprise intelligente

Un **switch** (commutateur) est la boîte sur laquelle on branche toutes les machines
d'un même réseau local (LAN). Contrairement à une simple multiprise, il apprend quelle
machine est branchée sur quel port et n'envoie chaque message qu'au bon destinataire.
Dans notre lab, le switch Cisco **SW1** sera le cœur du réseau — et il rendra en plus
un service supplémentaire : serveur DHCP.

*(Pour information : un __routeur__ est l'équipement qui relie des réseaux différents
entre eux — par exemple ton réseau local et Internet. Notre lab tient dans un seul
réseau, nous n'en aurons pas besoin.)*

### 1.6 Client, serveur et ports

- Un **serveur** est une machine qui *rend un service* : distribuer des pages web,
  répondre aux questions DNS…
- Un **client** est une machine qui *consomme* ce service : ton PC.

Une même machine rend souvent plusieurs services. Pour les distinguer, chaque service
écoute sur un **port**, un numéro de guichet :

| Service | Port |
|---|---|
| **DNS** | **53** (UDP et TCP) |
| Web (HTTP/HTTPS) | 80 / 443 |
| SSH (prise de contrôle à distance) | 22 |
| DHCP | 67 (serveur) / 68 (client) |

Retiens surtout : **le DNS, c'est le port 53**.

### 1.7 Les interfaces réseau

La « prise réseau » d'une machine s'appelle une **interface** :

- Sur Linux : `eth0` (première carte Ethernet).
- Sur Cisco : `GigabitEthernet0/1`, `GigabitEthernet0/2`… (abrégé `Gi0/1`, `Gi0/2`).

Quand on dit « configurer une IP sur eth0 », on dit simplement : « donner une adresse
à cette prise réseau ».

---

<a name="partie-2"></a>
## Partie 2 — Pourquoi le DNS existe

### 2.1 Le problème

Les machines se joignent par **adresse IP**. Mais personne n'a envie de taper
`142.250.74.238` pour aller sur Google, ni de retenir `192.168.1.80` pour joindre le
serveur web interne de sa boîte. **Les humains retiennent des noms, les machines
utilisent des nombres.** Il faut un traducteur.

Le **DNS** (*Domain Name System*, système de noms de domaine) est ce traducteur :
c'est un **annuaire** qui convertit un nom (`www.monreseau.lan`) en adresse IP
(`192.168.1.80`) — et parfois l'inverse.

### 2.2 L'ancêtre : le fichier hosts

Avant le DNS, chaque machine avait un simple fichier texte listant tous les noms
connus. Il existe encore ! Sur Linux, c'est `/etc/hosts` :

```
127.0.0.1   localhost
192.168.1.80  web1
```

Tu peux l'essayer : ajoute une ligne dans `/etc/hosts` et `ping web1` fonctionnera.
Mais imagine devoir recopier ce fichier sur *chaque* machine à *chaque* changement…
C'est ingérable dès qu'on dépasse trois machines. Le DNS résout ce problème : **un
seul serveur détient l'annuaire, tout le monde l'interroge**.

À savoir : quand une machine Linux doit résoudre un nom, elle regarde **d'abord**
`/etc/hosts`, **puis** interroge le DNS. Ça sert au dépannage (et ça explique des
surprises quand un vieux `/etc/hosts` traîne).

### 2.3 L'idée géniale du DNS : un annuaire découpé et délégué

Le DNS mondial n'est pas un gros fichier central : c'est un annuaire **hiérarchique et
distribué**. Chaque organisation gère *sa* partie (son « domaine ») sur *ses* serveurs,
et une mécanique de délégation permet de retrouver n'importe quel nom de proche en
proche. C'est ce qui lui permet de fonctionner à l'échelle d'Internet entier.

---

<a name="partie-3"></a>
## Partie 3 — Comment fonctionne le DNS

### 3.1 L'arbre des noms : lire un nom de droite à gauche

Un nom de domaine se lit **de droite à gauche**, comme une adresse postale qu'on lirait
du pays vers la rue :

```
www.exemple.com.
 │      │    │  └── la racine « . » (souvent invisible, mais toujours là)
 │      │    └── le TLD (Top-Level Domain) : com, org, fr…
 │      └── le domaine : exemple.com — acheté/géré par une organisation
 └── un nom dans ce domaine (souvent une machine ou un service)
```

L'ensemble forme un arbre : la **racine** (`.`) connaît les serveurs des **TLD**
(`com.`, `fr.`…), qui connaissent les serveurs de chaque **domaine** (`exemple.com.`),
qui connaissent enfin les noms individuels (`www.exemple.com.`).

Dans notre lab, nous créerons notre propre domaine privé : **`monreseau.lan`** (le
suffixe `.lan` est couramment utilisé pour les réseaux locaux, il n'existe pas sur
Internet — parfait pour s'entraîner sans rien casser).

### 3.2 Zone et serveur autoritaire

Une **zone** est la portion de l'arbre dont un serveur détient officiellement les
données — son bout d'annuaire. Le serveur qui héberge la zone est dit **autoritaire**
(*authoritative*) : quand il répond, il ne « croit pas savoir », il **sait**, car il
possède le fichier original. Dans le lab, notre serveur Linux **NS1** sera autoritaire
pour la zone `monreseau.lan`.

### 3.3 Le résolveur récursif : celui qui fait les démarches à ta place

Ton PC ne parcourt pas l'arbre lui-même. Il pose sa question à un **résolveur** (le
« serveur DNS » configuré sur ta machine), qui fait tout le travail :

```
   PC                 RÉSOLVEUR                    SERVEURS AUTORITAIRES
    │  « IP de          │
    │ www.exemple.com?» │   1. demande à la racine  ──► « voyez les serveurs de com. »
    ├───────────────────►   2. demande à com.       ──► « voyez les serveurs d'exemple.com. »
    │                   │   3. demande à exemple.com ──► « www = 93.184.216.34 » (réponse AA)
    │  ◄─── 93.184.216.34 ──┘
```

- Étapes 1-3 : le résolveur suit les **délégations** de serveur en serveur — c'est la
  **résolution récursive**.
- Le PC, lui, n'a envoyé qu'**une seule question**. Son rôle est minuscule : on
  l'appelle le **résolveur stub**.

Dans un petit réseau fermé comme le nôtre, pas besoin de racine : les clients
interrogent directement NS1, qui est autoritaire pour tout ce qui nous intéresse.

### 3.4 Le cache et le TTL : ne pas redemander cent fois

Refaire tout ce trajet à chaque question serait du gâchis. Le résolveur **met en
cache** chaque réponse pendant une durée fixée par le serveur autoritaire : le **TTL**
(*Time To Live*, durée de vie, en secondes). Un TTL de `3600` = « tu peux réutiliser
cette réponse pendant 1 heure sans me redemander ».

Conséquence à connaître : quand on **modifie** un enregistrement DNS, les caches du
monde entier peuvent continuer à servir l'ancienne valeur jusqu'à expiration du TTL.

### 3.5 Les enregistrements : le contenu de l'annuaire

Une zone contient des **enregistrements** (*records*). Chacun associe un nom à une
information, avec un type :

| Type | Rôle | Exemple |
|---|---|---|
| **A** | nom → adresse IPv4 | `web1  IN A  192.168.1.80` |
| **AAAA** | nom → adresse IPv6 | `web1  IN AAAA  fd00::80` |
| **CNAME** | alias : « ce nom = cet autre nom » | `www  IN CNAME  web1` |
| **NS** | « voici le serveur qui gère cette zone » | `@  IN NS  ns1.monreseau.lan.` |
| **SOA** | carte d'identité de la zone (voir §5.3) | un seul par zone, obligatoire |
| **MX** | serveur de courrier du domaine | `@  IN MX 10 mail` |
| **TXT** | texte libre (vérifications, anti-spam…) | `@  IN TXT "v=spf1 -all"` |
| **PTR** | l'inverse : IP → nom (« reverse DNS ») | `80  IN PTR  web1.monreseau.lan.` |

Deux détails de syntaxe qui piègent tout le monde :

- `@` signifie « le domaine lui-même » (`monreseau.lan`).
- Un nom **terminé par un point** (`ns1.monreseau.lan.`) est **absolu** ; sans point
  final (`web1`), le nom de la zone est ajouté automatiquement
  (`web1` → `web1.monreseau.lan`). Oublier ce point final est l'erreur n°1 du débutant.

### 3.6 Sur le fil : UDP, TCP et les codes de réponse

Une question DNS et sa réponse sont de petits messages envoyés sur le **port 53**, en
UDP la plupart du temps (rapide), en TCP quand la réponse est trop grosse ou pour les
transferts de zone. Dans une réponse, trois **drapeaux** (flags) et un **code** nous
intéressent :

- `aa` (*authoritative answer*) : la réponse vient du serveur autoritaire lui-même.
- `rd` / `ra` (*recursion desired / available*) : « je veux »/« je sais faire » de la
  récursion.
- Le code de retour :

| Code | Signification |
|---|---|
| `NOERROR` | tout va bien (réponse dans la section ANSWER) |
| `NXDOMAIN` | **ce nom n'existe pas** |
| `SERVFAIL` | le serveur a un problème (zone en panne, récursion impossible…) |
| `REFUSED` | le serveur **refuse** de répondre (règle de sécurité, mauvais serveur interrogé) |

Tu verras ces codes dans chaque sortie de `dig` — savoir les lire, c'est savoir
dépanner.

---

<a name="partie-4"></a>
## Partie 4 — Les outils du technicien DNS

Ces commandes s'utilisent sur les machines Linux du simulateur (ouvre le terminal de la
machine en double-cliquant dessus).

### 4.1 `dig` : l'outil de référence

```
dig web1.monreseau.lan
```

`dig` interroge le DNS et affiche **tout** : la question, la réponse, les drapeaux.
Sortie réelle du simulateur, annotée :

```
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 18625     ← le code : NOERROR = OK
;; flags: qr rd ra; QUERY: 1, ANSWER: 1, ...                  ← les drapeaux

;; QUESTION SECTION:
;web1.monreseau.lan.        IN  A                              ← ce qu'on a demandé

;; ANSWER SECTION:
web1.monreseau.lan.   3600  IN  A   192.168.1.80               ← la réponse ! (TTL 3600)

;; SERVER: 192.168.1.10#53(192.168.1.10)                       ← qui a répondu, port 53
```

Variantes indispensables :

```
dig +short www.monreseau.lan        # réponse brute, sans le décorum
dig @192.168.1.10 web1.monreseau.lan   # interroger CE serveur précis (dépannage !)
dig monreseau.lan SOA               # demander un autre type d'enregistrement
```

### 4.2 `nslookup` et `host` : les alternatives simples

```
nslookup web1.monreseau.lan
host web1.monreseau.lan
```

Même usage, sortie plus courte. `dig` reste l'outil des pros parce qu'il montre les
drapeaux et les codes.

### 4.3 `/etc/resolv.conf` : « quel est MON serveur DNS ? »

Ce fichier indique à une machine Linux **à qui** poser ses questions DNS :

```
cat /etc/resolv.conf
search monreseau.lan          ← suffixe ajouté aux noms courts (ping web1 → web1.monreseau.lan)
nameserver 192.168.1.10       ← l'adresse du serveur DNS à interroger
```

Point capital pour la suite : **c'est le DHCP qui remplira ce fichier automatiquement**.

### 4.4 `ping <nom>` : le test de bout en bout

```
ping -c 1 web1.monreseau.lan
```

`ping` par nom teste **deux choses à la fois** : la résolution DNS (le nom devient une
IP) puis la connectivité (l'IP répond). Si `ping <IP>` marche mais `ping <nom>`
échoue → le problème est côté DNS. Ce réflexe de découpage est la base du dépannage.

---

<a name="partie-5"></a>
## Partie 5 — BIND 9 : notre serveur DNS

### 5.1 named, le démon

**BIND 9** est le logiciel serveur DNS le plus répandu au monde. Son programme s'appelle
`named` (*name daemon* — un **démon** est un programme qui tourne en permanence en
arrière-plan). Sur Ubuntu, on le pilote avec `systemctl`, le chef d'orchestre des
services :

```
sudo systemctl start named      # démarrer
systemctl status named          # vérifier ("Active: active (running)" = tout va bien)
sudo systemctl stop named       # arrêter
sudo systemctl reload named     # relire la configuration sans coupure
```

### 5.2 `/etc/bind/named.conf` : la configuration

Le fichier de configuration principal. Sa syntaxe : chaque directive finit par un
**`;`**, les blocs sont entre **`{ }`**, les commentaires commencent par `//` ou `#`.
Version minimale pour notre lab :

```
options {
  directory "/var/cache/bind";     // répertoire de travail de named
  recursion no;                    // serveur purement autoritaire (pas de démarches pour autrui)
};

zone "monreseau.lan" {
  type primary;                    // nous détenons l'original de cette zone
  file "/etc/bind/db.monreseau.lan";  // le fichier qui contient les enregistrements
};
```

- `recursion no` : notre serveur ne répond **que** sur sa zone. Pour un serveur
  d'entreprise qui doit aussi résoudre Internet, on mettrait `recursion yes` +
  `forwarders { <ip>; };` (voir Partie 8).
- `type primary` : le serveur **primaire** détient le fichier original (un
  **secondaire** en garderait une copie synchronisée — Partie 8).

### 5.3 Le fichier de zone, ligne par ligne

C'est l'annuaire proprement dit. Notre `/etc/bind/db.monreseau.lan` :

```
$ORIGIN monreseau.lan.
$TTL 3600
@    IN SOA ns1.monreseau.lan. admin.monreseau.lan. ( 2026070201 3600 900 604800 300 )
     IN NS  ns1.monreseau.lan.
ns1  IN A   192.168.1.10
web1 IN A   192.168.1.80
www  IN CNAME web1
```

Décortiquons :

- **`$ORIGIN monreseau.lan.`** — le domaine de la zone. Tout nom sans point final se
  verra ajouter ce suffixe. (Note le point final !)
- **`$TTL 3600`** — TTL par défaut : les réponses sont valables 1 h en cache.
- **La ligne SOA** (*Start Of Authority*) — la carte d'identité de la zone :
  - `ns1.monreseau.lan.` : le serveur primaire ;
  - `admin.monreseau.lan.` : l'e-mail du responsable (le premier point remplace le
    `@` : ça se lit `admin@monreseau.lan`) ;
  - `2026070201` : le **numéro de série**. **À incrémenter à CHAQUE modification** de
    la zone (convention : AAAAMMJJnn = date + n° du jour). C'est grâce à lui que les
    serveurs secondaires détectent qu'il y a du nouveau ;
  - `3600 900 604800 300` : rythmes de synchronisation des secondaires (refresh,
    retry, expire) et durée de cache des réponses négatives (minimum).
- **`IN NS ns1...`** — déclare le serveur DNS de la zone (obligatoire).
- **`ns1 IN A 192.168.1.10`** — le nom `ns1` pointe vers l'IP du serveur DNS lui-même.
- **`web1 IN A 192.168.1.80`** — notre serveur web.
- **`www IN CNAME web1`** — `www` est un alias de `web1` : les deux noms mènent à la
  même machine.

### 5.4 Vérifier AVANT de démarrer

Deux outils vérifient la configuration — prends l'habitude de les lancer avant chaque
(re)démarrage, comme un correcteur orthographique :

```
named-checkconf
```
Silencieux = configuration correcte. Sinon, il donne le fichier et la ligne fautive :
`/etc/bind/named.conf:3: missing ';' before '}'`.

```
named-checkzone monreseau.lan /etc/bind/db.monreseau.lan
zone monreseau.lan/IN: loaded serial 2026070201
OK
```

Bonus rassurant : si la configuration est cassée, `systemctl start named` **refuse de
démarrer** et affiche l'erreur — un serveur DNS ne démarre jamais avec une config
invalide.

### 5.5 `rndc` : la télécommande de named

`rndc` parle au démon **pendant qu'il tourne** :

```
rndc status          # état du serveur (nb de zones, query logging…)
rndc reload          # recharger la conf et les zones (après une modification)
rndc reload monreseau.lan   # recharger UNE zone
rndc flush           # vider le cache
rndc querylog on     # journaliser chaque question reçue dans /var/log/named/query.log
```

Si named est arrêté, `rndc` répond
`rndc: connect failed: 127.0.0.1#953: connection refused` — c'est normal : la
télécommande n'a plus personne à qui parler.

---

<a name="partie-6"></a>
## Partie 6 — DHCP : distribuer les adresses… et l'adresse du DNS

### 6.1 Le problème de la configuration manuelle

Sans DHCP, il faudrait taper sur **chaque** machine : son IP, son masque et l'adresse
du serveur DNS. Dix machines = dix occasions de se tromper (doublons d'IP, fautes de
frappe…). Le **DHCP** (*Dynamic Host Configuration Protocol*) automatise tout : la
machine démarre, demande « quelqu'un peut me configurer ? », et un serveur DHCP lui
répond avec tout le nécessaire.

### 6.2 DORA : la conversation en 4 temps

```
PC (sans adresse)                        Serveur DHCP (notre switch SW1)
   │── 1. DISCOVER : « quelqu'un m'entend ? » ──►│   (diffusé à tout le réseau)
   │◄── 2. OFFER   : « je te propose 192.168.1.100 » ──│
   │── 3. REQUEST  : « je la prends ! » ──►│
   │◄── 4. ACK     : « c'est validé, voici le reste » ──│
```

**D**iscover, **O**ffer, **R**equest, **A**ck → « DORA ». Quatre messages, et le PC est
configuré.

### 6.3 Le bail (lease)

L'adresse n'est pas donnée, elle est **louée** pour une durée limitée (le **bail**).
La machine renouvelle son bail périodiquement ; si elle disparaît, l'adresse redevient
disponible. Le serveur tient un registre des baux — sur Cisco :
`show ip dhcp binding`.

### 6.4 Les options DHCP : LE lien avec le DNS

Le message ACK ne contient pas que l'adresse. Il transporte des **options** :

| Option | Contenu | Dans notre lab |
|---|---|---|
| 1 | masque de sous-réseau | `255.255.255.0` |
| 3 | passerelle par défaut (routeur) | — (pas de routeur) |
| **6** | **adresse du serveur DNS** | **`192.168.1.10` (NS1 !)** |
| 15 | nom de domaine à ajouter aux noms courts | `monreseau.lan` |

**C'est ici que DHCP et DNS se rejoignent** : grâce à l'option 6, chaque PC apprend
automatiquement l'adresse de NS1, et son `/etc/resolv.conf` se remplit tout seul.
Aucune configuration manuelle sur les clients — c'est toute la beauté de la chose.

### 6.5 Le CLI Cisco en 90 secondes

Pour configurer le switch, il faut connaître les **modes** du terminal Cisco — on les
reconnaît au symbole en fin de ligne (le « prompt ») :

```
SW1>            mode utilisateur : consultation limitée
SW1# ◄──────    mode privilégié : toutes les consultations   (on y entre avec `enable`)
SW1(config)# ◄─ mode configuration : on modifie              (via `configure terminal`)
SW1(dhcp-config)# ◄─ sous-mode : ici, config du pool DHCP
```

`exit` remonte d'un niveau, `end` revient directement au mode privilégié. Les commandes
`show ...` (consultation) se lancent depuis le mode privilégié `#`.

---

<a name="partie-7"></a>
## Partie 7 — Le grand lab : construire le réseau complet

### 7.0 Objectif et plan d'adressage

Voici ce que nous allons construire :

```
                        ┌───────────────┐
                        │   SW1 (Cisco) │  ◄── switch = cœur du LAN
                        │ serveur DHCP  │      + serveur DHCP
                        └──┬───┬───┬───┬┘
              Gi0/1 ───────┘   │   │   └─────── Gi0/4
                 │       Gi0/2 │   │ Gi0/3          │
        ┌────────┴──────┐ ┌────┴─────┐ ┌───┴────────┐ ┌────┴───┐
        │ NS1 (Linux)   │ │   PC1    │ │ WEB1(Linux)│ │  PC2   │
        │ serveur DNS   │ │ client   │ │ serveur web│ │ client │
        │ 192.168.1.10  │ │ (DHCP)   │ │192.168.1.80│ │ (DHCP) │
        └───────────────┘ └──────────┘ └────────────┘ └────────┘
```

| Machine | Rôle | Adresse | Comment ? |
|---|---|---|---|
| SW1 | switch + serveur DHCP | — | — |
| NS1 | serveur DNS (BIND 9) | `192.168.1.10` | **fixe** (un serveur ne change pas d'adresse !) |
| WEB1 | serveur web | `192.168.1.80` | **fixe** |
| PC1, PC2 | clients | `192.168.1.100` et suivantes | **DHCP** |
| Domaine | — | `monreseau.lan` | zone hébergée sur NS1 |

Règle d'or illustrée ici : **les serveurs ont des adresses fixes** (tout le monde doit
pouvoir les trouver), **les clients sont en DHCP** (peu importe leur adresse).

### 7.1 Étape 1 — Poser et câbler

Dans le simulateur, glisse-dépose sur le canevas : un **switch Cisco** (SW1), deux
**serveurs Linux** (NS1 et WEB1), deux **PC Linux** (PC1, PC2). Puis câble :

| Câble | De | Vers |
|---|---|---|
| 1 | SW1 `Gi0/1` | NS1 `eth0` |
| 2 | SW1 `Gi0/2` | PC1 `eth0` |
| 3 | SW1 `Gi0/3` | WEB1 `eth0` |
| 4 | SW1 `Gi0/4` | PC2 `eth0` |

### 7.2 Étape 2 — Adresses fixes des serveurs

Ouvre le terminal de **NS1** :

```
sudo ip addr add 192.168.1.10/24 dev eth0
ip -4 addr show eth0
```

Tu dois voir la ligne `inet 192.168.1.10/24 ... scope global eth0`. Fais de même sur
**WEB1** :

```
sudo ip addr add 192.168.1.80/24 dev eth0
```

Premier test de connectivité (depuis WEB1) — on valide le câblage **avant** d'empiler
les services :

```
ping -c 1 192.168.1.10
64 bytes from 192.168.1.10: icmp_seq=1 ttl=64 time=1.8 ms      ← le LAN fonctionne !
```

### 7.3 Étape 3 — SW1 devient serveur DHCP

Ouvre la console de **SW1** et tape, ligne par ligne :

```
enable
configure terminal
ip dhcp excluded-address 192.168.1.1 192.168.1.99
ip dhcp pool LAN
 network 192.168.1.0 255.255.255.0
 dns-server 192.168.1.10
 domain-name monreseau.lan
end
```

Explication de chaque ligne :

| Commande | Ce qu'elle fait |
|---|---|
| `ip dhcp excluded-address .1 .99` | **interdit** de distribuer `.1` à `.99` — nos serveurs y vivent (`.10`, `.80`) : sans cette ligne, le DHCP pourrait donner leur adresse à un PC → conflit ! |
| `ip dhcp pool LAN` | crée un « réservoir » d'adresses nommé LAN |
| `network 192.168.1.0 255.255.255.0` | le réservoir couvre le réseau 192.168.1.0/24 (les clients recevront donc `.100`, `.101`, …) |
| `dns-server 192.168.1.10` | **option 6 : « votre serveur DNS est NS1 »** — la ligne la plus importante du tutoriel ! |
| `domain-name monreseau.lan` | option 15 : suffixe pour les noms courts |

Vérifie :

```
show ip dhcp pool
Pool LAN :
 ...
 Total addresses                : 254
```

### 7.4 Étape 4 — NS1 devient serveur DNS

Sur **NS1**, crée d'abord la configuration de BIND. La méthode la plus simple au
terminal est le « heredoc » avec `tee` (colle le bloc entier d'un coup, il écrit le
fichier et l'affiche) — tu peux aussi utiliser `nano` ou `vim` si tu préfères :

```
sudo tee /etc/bind/named.conf << 'EOF'
options {
  directory "/var/cache/bind";
  recursion no;
};
zone "monreseau.lan" {
  type primary;
  file "/etc/bind/db.monreseau.lan";
};
EOF
```

Puis le fichier de zone :

```
sudo tee /etc/bind/db.monreseau.lan << 'EOF'
$ORIGIN monreseau.lan.
$TTL 3600
@    IN SOA ns1.monreseau.lan. admin.monreseau.lan. ( 2026070201 3600 900 604800 300 )
     IN NS  ns1.monreseau.lan.
ns1  IN A   192.168.1.10
web1 IN A   192.168.1.80
www  IN CNAME web1
EOF
```

**Vérifie avant de démarrer** (réflexe de pro) :

```
named-checkconf
named-checkzone monreseau.lan /etc/bind/db.monreseau.lan
zone monreseau.lan/IN: loaded serial 2026070201
OK
```

Démarre et contrôle :

```
sudo systemctl start named
systemctl status named
● named.service - BIND Domain Name Server
     Active: active (running) since ...          ← le serveur écoute sur le port 53 !
```

### 7.5 Étape 5 — Les clients se configurent tout seuls

Sur **PC1** (puis pareil sur PC2), une seule commande :

```
sudo dhclient eth0
```

En coulisses : DISCOVER → OFFER → REQUEST → ACK (revois §6.2). Vérifie le résultat :

```
ip -4 addr show eth0
    inet 192.168.1.100/24 ... dynamic ...        ← adresse reçue ("dynamic" = via DHCP)

cat /etc/resolv.conf
search monreseau.lan                             ← option 15 reçue
nameserver 192.168.1.10                          ← option 6 reçue : NS1 !
```

**Prends une seconde pour savourer** : tu n'as rien configuré sur ce PC, et il connaît
pourtant son adresse, son domaine et son serveur DNS. Côté switch, le bail est
enregistré :

```
show ip dhcp binding
IP address          Client-ID/...           Lease expiration        Type
192.168.1.100       01020000000037          03 Jul 2026 12:54:01    Automatic
```

### 7.6 Étape 6 — Le test final : joindre une machine par son nom

Toujours sur PC1 :

```
dig web1.monreseau.lan
;; ->>HEADER<<- opcode: QUERY, status: NOERROR, ...
;; ANSWER SECTION:
web1.monreseau.lan.   3600  IN  A   192.168.1.80
;; SERVER: 192.168.1.10#53(192.168.1.10)         ← c'est bien NS1 qui a répondu
```

L'alias CNAME fonctionne aussi :

```
dig +short www.monreseau.lan
web1.monreseau.lan.                              ← www est un alias…
192.168.1.80                                     ← …qui mène à la même IP
```

Et le test de bout en bout :

```
ping -c 1 web1.monreseau.lan
PING web1.monreseau.lan (192.168.1.80) 56(84) bytes of data.
64 bytes from 192.168.1.80: icmp_seq=1 ttl=64 time=1.087 ms
```

🎉 **Ton réseau est complet.** Remonte le fil de ce qui vient de se passer, car c'est
toute la matière du tutoriel en une commande : PC1 a demandé `web1.monreseau.lan` →
son résolveur stub a interrogé NS1 (appris via l'option 6 du DHCP servi par SW1) →
NS1, autoritaire pour la zone, a répondu `192.168.1.80` → PC1 a pingé cette adresse à
travers le switch.

### 7.7 Étape 7 — Faire vivre le réseau

**Ajouter une machine à l'annuaire.** On installe un serveur d'impression en
`192.168.1.90` ? Sur NS1, ajoute l'enregistrement et **incrémente le serial** :

```
sudo tee /etc/bind/db.monreseau.lan << 'EOF'
$ORIGIN monreseau.lan.
$TTL 3600
@    IN SOA ns1.monreseau.lan. admin.monreseau.lan. ( 2026070202 3600 900 604800 300 )
     IN NS  ns1.monreseau.lan.
ns1  IN A   192.168.1.10
web1 IN A   192.168.1.80
www  IN CNAME web1
imp1 IN A   192.168.1.90
EOF
```

*(serial passé de `...01` à `...02` — c'est le contrat : modification = incrément)*

Recharge sans coupure et vérifie :

```
rndc reload monreseau.lan
zone reload successful

dig +short imp1.monreseau.lan        # depuis PC1
192.168.1.90
```

**Observer qui interroge ton serveur.** Sur NS1 :

```
rndc querylog on
cat /var/log/named/query.log         # après quelques requêtes des PC
... client ... 192.168.1.100#... query: web1.monreseau.lan IN A ...
```

### 7.8 Dépannage : les pannes classiques

| Symptôme | Cause probable | Diagnostic |
|---|---|---|
| `dig` ne répond pas du tout (`no servers could be reached`) | named arrêté, ou mauvais câble | `systemctl status named` sur NS1 ; `ping 192.168.1.10` depuis le PC |
| `Failed to start named.service` | faute de syntaxe dans la conf | lis le message ! `named-checkconf` donne fichier + ligne |
| Réponse `SERVFAIL` | zone déclarée mais fichier de zone absent/cassé | `named-checkzone` sur le fichier ; `rndc status` |
| Réponse `NXDOMAIN` | le nom n'existe pas dans la zone | faute de frappe ? enregistrement oublié ? point final en trop/en moins ? |
| `ping <IP>` OK mais `ping <nom>` KO | problème DNS côté client | `cat /etc/resolv.conf` : bon `nameserver` ? refais `sudo dhclient eth0` |
| Le PC n'a pas d'adresse | pool DHCP mal configuré | `show ip dhcp pool` et `show ip dhcp binding` sur SW1 |
| Modif de zone invisible | serial non incrémenté, ou reload oublié | incrémente le serial puis `rndc reload` ; TTL en cache (attends ou `rndc flush`) |
| named refuse de démarrer : `address already in use` | un autre service DNS (dnsmasq) occupe déjà le port 53 | un seul serveur DNS par machine ! arrête l'autre |

---

<a name="partie-8"></a>
## Partie 8 — Pour aller plus loin

**Résoudre aussi Internet (récursion + forwarders).** Notre NS1 ne connaît que
`monreseau.lan`. Pour qu'il résolve aussi les autres noms en relayant vers un résolveur
amont :

```
options {
  directory "/var/cache/bind";
  recursion yes;
  forwarders { 10.0.9.1; };              // le résolveur amont
  allow-recursion { 192.168.1.0/24; };   // récursion réservée à NOTRE réseau
};
```

`allow-recursion` est une règle de sécurité essentielle : un serveur qui fait de la
récursion pour la terre entière (« open resolver ») se fait aussitôt exploiter pour des
attaques.

**Les ACL en général.** BIND filtre par adresse source : `allow-query` (qui peut
interroger), `allow-transfer` (qui peut copier la zone entière), avec les mots-clés
`any`, `none`, `localhost`, `localnets` et la négation `!`. Un client refusé reçoit
`REFUSED` — tu sais maintenant le lire dans `dig`.

**Un deuxième serveur DNS (zone secondaire).** Si NS1 tombe, plus personne ne résout.
La parade : un **secondaire** NS2 qui garde une copie synchronisée de la zone. Sur le
primaire :

```
zone "monreseau.lan" {
  type primary;
  file "/etc/bind/db.monreseau.lan";
  allow-transfer { 192.168.1.11; };      // NS2 a le droit de copier la zone
  also-notify { 192.168.1.11; };         // et il est prévenu à chaque changement
};
```

Sur NS2 (`192.168.1.11`) :

```
zone "monreseau.lan" {
  type secondary;
  primaries { 192.168.1.10; };
  file "db.monreseau.lan";
};
```

Mécanique : à chaque `rndc reload` côté primaire (avec serial incrémenté !), NS1 envoie
un message **NOTIFY** ; NS2 compare les serials et rapatrie la zone par un **transfert
AXFR** (sur TCP/53). Il ne reste qu'à annoncer les deux serveurs dans l'option
`dns-server` du pool DHCP : `dns-server 192.168.1.10 192.168.1.11`.

**Le reverse DNS (PTR).** Une zone spéciale (`1.168.192.in-addr.arpa`) permet la
question inverse : « qui est 192.168.1.80 ? » → `dig -x 192.168.1.80`.

**DNSSEC.** Des signatures cryptographiques ajoutées aux zones pour prouver que les
réponses n'ont pas été falsifiées en route. C'est le chapitre « sécurité avancée » du
DNS — garde-le pour plus tard, les fondations que tu viens d'acquérir sont exactement
celles sur lesquelles il repose.

---

<a name="annexe"></a>
## Annexe — Aide-mémoire

**Côté client Linux**

```
sudo dhclient eth0                  # demander une adresse au DHCP
ip -4 addr show eth0                # voir mon adresse
cat /etc/resolv.conf                # voir mon serveur DNS
dig <nom>                           # question DNS détaillée
dig +short <nom>                    # réponse brute
dig @<ip-serveur> <nom>             # interroger un serveur précis
nslookup <nom> · host <nom>         # alternatives simples
ping -c 1 <nom>                     # test DNS + connectivité
```

**Côté serveur DNS (NS1)**

```
/etc/bind/named.conf                # configuration de BIND
/etc/bind/db.<zone>                 # fichier de zone (⚠ serial à incrémenter !)
named-checkconf                     # vérifier la conf
named-checkzone <zone> <fichier>    # vérifier une zone
sudo systemctl start|stop|status named
rndc status | reload [zone] | flush | querylog on|off
```

**Côté switch Cisco (SW1)**

```
enable → configure terminal        # entrer en configuration
ip dhcp excluded-address <de> <à>
ip dhcp pool <NOM>
 network <réseau> <masque>
 dns-server <ip> [ip2]
 domain-name <domaine>
end
show ip dhcp pool                   # état du réservoir
show ip dhcp binding                # baux distribués
```

**Les 4 codes DNS à connaître par cœur**

`NOERROR` = OK · `NXDOMAIN` = nom inexistant · `SERVFAIL` = serveur en difficulté ·
`REFUSED` = interdit par une règle.
