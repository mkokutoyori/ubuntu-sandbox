# PRD — Fidélité du CLI Huawei VRP

## 0. Méthode, et ce qu'elle interdit

Tout ce qui suit est **mesuré** sur un `HuaweiRouter` et un
`HuaweiSwitch` neufs, jamais déduit de la lecture du code. Chaque
commande est jugée **dans sa propre vue, sur une machine neuve** : un
balayage qui enchaîne les commandes sur une seule machine change de vue
en route et juge les suivantes ailleurs qu'où elles se tapent. Cette
erreur a été commise puis corrigée pendant l'audit du CLI Cisco
(`PRD-Routage-Fidelite.md` §14.1), où elle avait fait passer pour
« refusées » deux commandes qui existaient ; elle ne l'est plus ici.

Trois règles tenues pendant tout le document :

1. **Ce qui n'est pas confirmé n'est pas corrigé.** Là où je ne suis pas
   sûr du comportement du vrai VRP, je l'écris et je ne touche pas — la
   même règle que pour `debug interface <nom>` côté Cisco.
2. **Une commande acceptée qui ne fait rien est pire qu'une commande
   refusée**, sauf quand le matériel réel ne fait rien non plus. Cette
   distinction décide de la moitié des arbitrages du §5.
3. **La configuration rendue n'est pas un affichage** : c'est le texte
   que l'import d'une topologie rejoue, donc ce qui **refait**
   l'équipement.

**Périmètre.** Le CLI VRP du routeur et du switch. **Hors périmètre,
tenu par l'autre agent** : `info-center` et tout le sous-système de
journalisation VRP (`PRD-Info-Center-Huawei.md`, livré). Le
`debugging` VRP (`HuaweiDebugService`) est libre mais fait l'objet d'un
lot distinct (§6), pour ne pas mêler deux sujets.

---

## 1. Ce qui est confirmé

### 1.1 `undo` est un trou noir — CONFIRMÉ

N'importe quel mot derrière `undo` est **accepté en silence**, sur le
routeur comme sur le switch, en vue système comme en vue d'interface :

```
[QU] undo zzz                      => ""
[QU] undo aaa bbb ccc              => ""
[QU] undo ospf zzz                 => ""
[QU] undo ip route-static zzz      => ""
[QU] undo interface                => ""
[QU-GE0/0/0] undo portswitch       => ""
```

VRP répond `Error: Unrecognized command found at '^' position.` Une
faute de frappe après `undo` rend donc la main sans un mot, et
l'opérateur croit avoir défait quelque chose. C'est le défaut le plus
grave de cet audit : il ne casse pas une commande, il **casse la
confiance dans le silence**, qui est la seule confirmation que VRP donne
quand tout va bien.

Un contre-exemple montre que le défaut est bien dans le fourre-tout et
non partout : `undo ip address` en vue d'interface répond correctement
`Error: Unrecognized command found at '^' position.`

### 1.2 La configuration ne se rejoue pas — CONFIRMÉ, 14 lignes sur 46

Une configuration ordinaire (nom, une interface adressée, une Loopback,
une route statique, OSPF, RIP, une ACL) rendue par
`display current-configuration`, puis **retapée ligne à ligne sur une
machine neuve** — ce que fait l'import d'une topologie — voit **14 de ses
propres lignes refusées**.

Deux causes, une seule nature : **des séparateurs `#` manquants**.

```
#
acl number 2000
 rule 0 permit source 10.0.0.0 0.255.255.255
ip route-static 172.16.0.0 255.255.0.0 10.0.12.2 preference 100   ← dans le bloc ACL
#
…
 area 0
  network 10.0.12.0 0.0.0.255
aaa                                                               ← dans le bloc OSPF
```

`ip route-static` est rendu **à l'intérieur du bloc `acl number 2000`**,
et le bloc `aaa` **à l'intérieur du bloc OSPF**. Au rejeu, la route est
tapée depuis la vue ACL et tout `aaa` depuis la vue de zone OSPF : les
14 lignes tombent. La machine rechargée n'a ni route statique, ni
comptes, ni RIP, ni OSPF — et **rien ne le signale**.

Mesure honnête sur la méthode : ma première tentative filtrait les
lignes `#`, ce qui refusait 23 lignes au lieu de 14 et accusait le
produit de plus qu'il ne fait. Le `#` d'un fichier VRP sépare les blocs
et ramène en vue système ; le rejeu doit l'honorer. Le chiffre de 14 est
celui d'un rejeu correct.

### 1.3 Pertes sèches — CONFIRMÉ, 3 sur 5 testées

Tapé, puis relu dans `display current-configuration` :

| Tapé | Relu |
|---|---|
| `undo summary` (vue RIP) | **absent** |
| `local-user zoe service-type telnet` | `local-user zoe service-type ssh` |
| `rule 15 deny source 192.168.1.0 0.0.0.255` | `rule 0 deny source 192.168.1.0 0.0.0.255` |
| `local-user zoe privilege level 3` | présent |
| `mtu 1400` | présent |

Les deux premières sont des pertes, la troisième est **pire** : le
numéro de règle d'une ACL décide de l'ordre d'évaluation et sert à la
supprimer. Une ACL rechargée sous un autre numéro n'est pas la même ACL.

### 1.4 `display this` ne filtre pas la vue — CONFIRMÉ

`display this` a une seule raison d'exister : montrer la configuration
**de la vue courante**. Deux échecs distincts :

- **Routeur, vue OSPF** : rend le bloc `ospf 1` puis **tout ce qui
  suit**, `aaa` et ses quatre comptes compris.
- **Switch** : rend **la configuration entière** — `sysname`, les VLAN,
  les cinquante interfaces, `Vlanif1`. C'est `display
  current-configuration` sous un autre nom.

En vue d'interface sur le routeur, en revanche, la sortie est juste. Le
filtre existe donc pour un cas et pas pour les autres.

Divergence relevée au passage : la sortie du switch se termine par
`return`, celle du routeur par `#`.

### 1.5 Deux noms pour un même port — CONFIRMÉ

Sur la même machine, au même instant :

| Endroit | Nom rendu |
|---|---|
| l'invite en vue d'interface | `[QP-GE0/0/0]` |
| `display interface brief` | `GE0/0/0` |
| `display ip interface brief` | `GigabitEthernet0/0/0` |
| `display current-configuration` | `GigabitEthernet0/0/0` |
| `display this` | `GigabitEthernet0/0/0` |

`GE0/0/0` est le nom **interne** du port ; VRP n'affiche jamais que le
nom complet, invite comprise (`[Huawei-GigabitEthernet0/0/0]`). Deux
noms pour un objet, c'est un apprenant qui cherche `GE0/0/0` dans une
commande qui n'en veut pas.

### 1.6 Une interface virtuelle est vue morte — CONFIRMÉ

```
LoopBack0                         9.9.9.9/32           down       down
```

…alors que **sa route est bien installée** dans
`display ip routing-table`. Une Loopback n'a pas de porteuse : elle est
`up` par construction, sur tout matériel. Les deux vues de la même
interface se contredisent — c'est exactement le défaut que
`PRD-Routage-Fidelite.md` §4.2 a fermé côté Cisco (« une chose existe si
et seulement si `iosInterfaceStatus(port).protocol === 'up'` »), resté
ouvert côté VRP.

### 1.7 Trois formes pour une même famille d'erreur — CONFIRMÉ

```
[display]         => "Error: Incomplete command found at '^' position.\ndisplay\n       ^"
[ip route-static 10.0.0.0]
                  => "Error: Incomplete command."            ← ni echo ni curseur
[interface zzz]   => "Error: Wrong parameter found at '^' position."   ← ni echo ni curseur
```

La même machine écrit donc l'erreur d'arité de deux façons, et pointe le
curseur dans un cas sur trois. S'y ajoutent des messages **maison**, qui
ne sont d'aucun constructeur :

- `Error: Invalid IP octet: 999`
- `Error: Invalid OSPF process ID.`
- `Error: Route not found.`

VRP n'a que quatre formes, et elles portent toutes l'écho et le curseur :
`Unrecognized command`, `Incomplete command`, `Wrong parameter`,
`Too many parameters`.

### 1.8 Ni bornes ni paramètres en trop — CONFIRMÉ, 8 sur 8

Toutes acceptées sans un mot :

| Commande | Ce qu'elle devrait valoir |
|---|---|
| `ospf 1 router-id 999.999.999.999` | ce n'est pas une adresse |
| `interface LoopBack 1024` | hors de la plage des Loopback |
| `ip route-static … preference 0` | la préférence commence à 1 |
| `ip route-static … preference 256` | elle s'arrête à 255 |
| `sysname` de 300 caractères | une borne existe |
| `ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 extra` | `Too many parameters` |
| `sysname R1 R2` | `Too many parameters` |
| `ospf 1 zzz` | `Too many parameters` |

Le mot en trop est **silencieusement ignoré**, ce qui est la forme la
plus trompeuse du refus manquant : la commande a l'air d'avoir pris ce
qu'on lui a donné.

### 1.9 L'aide propose ce que la machine refuse — CONFIRMÉ

```
[system-view] interface ?
  WORD  Enter interface view
  <cr>
```

`<cr>` annonce que `interface` seul est une commande complète ; la
machine répond `Error: Unrecognized command found at '^' position.`
Et `WORD` remplace la liste des **types** d'interface que VRP propose
(`GigabitEthernet`, `LoopBack`, `NULL`, `Vlanif`…) — l'aide ne sert plus
à rien précisément là où un apprenant en a besoin.

Deux descriptions sont vides ou tautologiques : `ip ?` propose
`routing-table` sans description, `display ip ?` propose `source Source`.

C'est le jumeau VRP d'un chantier déjà mené côté Cisco par l'agent
« logging/CLI » (« ce que `?` propose, la machine l'accepte ») : la
règle est écrite, seul le côté Huawei reste.

### 1.10 L'abréviation du type d'interface manque — CONFIRMÉ

`dis cu`, `dis ver`, `dis ip int b`, `sys`, `sysn R9`, `q` fonctionnent :
l'abréviation générale est bien là. Mais :

```
[system-view] int g0/0/0   => "Error: Wrong parameter found at '^' position."
```

`interface g0/0/0` est l'une des frappes les plus courantes d'un
opérateur VRP. Le nom d'interface n'est pas passé par le même mécanisme
d'abréviation que les mots-clés.

---

## 2. Chantier A — La configuration doit se rejouer

**La règle.** Ce que `display current-configuration` rend doit pouvoir
être retapé tel quel, bloc par bloc, et produire la même machine.

1. **Un `#` sépare deux blocs de premier niveau, toujours.** `ip
   route-static` n'appartient à aucun bloc et doit sortir du bloc ACL ;
   `aaa` ouvre un bloc et doit être précédé de son `#`.
2. **Le numéro de règle d'une ACL est celui que l'opérateur a écrit.**
3. **`undo summary` et `service-type` sont rendus** — ce qui suppose de
   vérifier d'abord qu'ils sont *stockés*, la perte pouvant être à
   l'écriture et non au rendu.
4. **L'invariant est un test**, pas une relecture : sérialiser, rejouer
   sur une machine neuve en honorant les `#`, re-sérialiser, comparer.
   Zéro ligne refusée, et les deux textes identiques.

## 3. Chantier B — `undo` cesse d'être un trou noir

`undo <mot inconnu>` est refusé avec le message de VRP et le curseur au
bon endroit. La règle vaut pour les deux plateformes et pour toutes les
vues. Le fourre-tout qui absorbe aujourd'hui la commande doit être
remplacé par un refus explicite, à l'endroit unique où il se décide —
sans quoi le prochain ajout d'`undo` reproduira le défaut.

## 4. Chantier C — Une seule vérité par objet

1. **Un port a un nom**, le nom complet, partout : invite,
   `display interface brief`, et le reste.
2. **Une interface virtuelle est vivante** — `LoopBack`, `Vlanif`,
   `NULL`, `Tunnel` — et les vues d'interface, la table de routage et la
   configuration s'accordent. Le prédicat existe déjà côté Cisco
   (`iosInterfaceStatus`) et rien n'empêche VRP de le lire : ce n'est pas
   un modèle par constructeur, c'est l'état d'un port.
3. **`display this` rend la vue courante**, et rien d'autre, sur les deux
   plateformes.

## 5. Chantier D — Refuser ce qui doit l'être

1. **Quatre messages, un format.** Les quatre formes de VRP, chacune avec
   l'écho de la commande et le curseur. Les messages maison
   (`Invalid IP octet`, `Invalid OSPF process ID`) disparaissent au
   profit de `Wrong parameter`.
2. **Un paramètre en trop est une erreur** (`Too many parameters`), et
   c'est le refus le plus rentable de la liste : il attrape à lui seul
   les trois cas du §1.8.
3. **Une borne se vérifie** quand elle est connue. Là où je ne sais pas
   la borne exacte du vrai VRP, je ne l'invente pas : le PRD le dit et le
   cas reste ouvert plutôt que d'être « corrigé » vers une valeur
   plausible.
4. **L'aide ne propose que ce que la machine accepte** — le `<cr>` de
   `interface ?` disparaît, les types d'interface remplacent `WORD`, et
   une entrée sans description est retirée de l'aide (elle reste
   acceptée à la frappe).
5. **`interface g0/0/0`** : le nom d'interface passe par l'abréviation.

---

## 6. Séquencement

| Lot | Contenu | Dépend de |
|---|---|---|
| **V1** | Chantier B : `undo` refuse l'inconnu (**livré, §9**) | — |
| **V2** | Chantier A : séparateurs, numéro de règle, pertes sèches, invariant de rejeu (**livré, §10**) | — |
| **V3** | Chantier C : le nom du port, l'interface virtuelle, `display this` | — |
| **V4** | Chantier D §1-§2 : les quatre messages, `Too many parameters` | V1 |
| **V5** | Chantier D §3-§5 : bornes, aide, abréviation du nom d'interface | V4 |
| **V6** | `debugging` VRP — audit séparé, sur le modèle de `PRD-Debug-Fidelite-Cisco.md` | — |

V1 part en premier parce qu'il est petit, isolé, et qu'il rend une
information que l'opérateur n'a pas aujourd'hui. V2 est le plus lourd et
le plus utile : c'est lui qui rend les topologies rechargeables.

---

## 7. Les tests

Des propriétés, pas des listes de chaînes :

1. **Aller-retour** : sérialiser, rejouer, re-sérialiser, comparer —
   zéro ligne refusée.
2. **Un mot inconnu est refusé**, balayé derrière `undo` comme ailleurs,
   dans toutes les vues et sur les deux plateformes.
3. **Un objet, un nom** : le nom du port est le même dans toutes les vues
   qui le nomment, comparé entre vues et jamais à une chaîne écrite à la
   main.
4. **Les vues s'accordent** sur l'état d'une interface, y compris
   virtuelle — le jumeau VRP de
   `cisco-interface-state-one-truth.test.ts`.
5. **`display this` ⊂ `display current-configuration`**, et strictement
   plus petit dès qu'on est dans une vue.
6. **Ce que `?` propose, la machine l'accepte** — balayage, pas liste.
7. **Un paramètre en trop est refusé** — balayage sur les commandes qui
   en prennent un nombre fixe.

---

## 8. Hors périmètre

- **`info-center`** et la journalisation VRP : livrés par l'autre agent
  (`PRD-Info-Center-Huawei.md`).
- **Le `debugging` VRP** : réservé au lot V6, pour ne pas décider de deux
  sujets à partir des mesures d'un seul — la même précaution que le PRD
  debug Cisco a prise à l'égard de Huawei.
- **Les VLAN sur le routeur** : `vlan 1` répond `Unrecognized command`
  sur un `HuaweiRouter`. Un AR2220 réel les connaît, mais ce simulateur
  place la commutation sur le switch ; ouvrir `vlan` sur le routeur est
  une décision de modèle, pas de CLI, et elle n'appartient pas à ce PRD.
- **Les bornes que je n'ai pas pu confirmer** (longueur de `sysname`,
  plage des `LoopBack`) : nommées au §1.8, corrigées seulement si une
  source les fixe.

---

## 9. V1 — Livré

**Le défaut.** `undo <n'importe quoi>` rendait la main en silence, sur les
deux plateformes et dans toutes les vues. La cause tient en une ligne :
`cmdUndo()` reconnaît une quinzaine de formes et se termine par
`return '';` — tout le reste tombe dans ce silence. Les fourre-tout
`registerGreedy('undo', …)` — deux sur le routeur, trois sur le switch —
y mènent tous.

**La règle appliquée.** `undo X` existe si et seulement si `X` se
configure dans cette vue, et **le trie de la vue sait déjà répondre** :
`refuseUnknownUndo(trie, args, raw)` interroge `trie.match()` et rend le
message de VRP, ou `null` pour laisser passer. Un seul endroit décide,
donc le prochain `undo` ajouté ne peut pas rouvrir le trou. Le message
réutilise `HUAWEI_ERRORS.UNRECOGNIZED`, déjà là, plutôt qu'une seconde
mise en forme : écho de la ligne et curseur sous le mot fautif.

**La portée a été resserrée après mesure, et c'est le cœur du lot.** La
première version interrogeait la forme ENTIÈRE (`trie.match('ip pool P1')`),
ce qui faisait dépendre le refus de l'arité d'enregistrement du positif :
`ip pool` est enregistré sans argument, donc `undo ip pool P1` — légitime
— était refusé. La règle ne porte plus que sur le **premier mot**, la
seule question que ce lot pose. Un mot en trop derrière une tête valide
est une autre erreur (`Too many parameters`), qui appartient au lot V4 :
`undo sysname bbb ccc` passe donc encore, et **un test le fixe** pour que
le jour où V4 le corrige, il le fasse sciemment.

**Deux comportements changent, et le refus est le bon.** `undo arp-proxy
enable` et `undo sftp` en **vue système** étaient acceptés ; sur VRP,
`arp-proxy enable` est une commande d'interface et `sftp` une commande de
vue utilisateur. Ni l'une ni l'autre n'existe là où elle était acceptée.
Vérifié par comparaison avec l'état antérieur, pour ne pas confondre une
correction avec une régression.

**Un constat trouvé en écrivant le test, et gardé.** `undo shutdow` est
ACCEPTÉ, et c'est juste : VRP abrège, donc `shutdow` *est* `shutdown`,
derrière `undo` comme ailleurs. Mon premier jeu de mots « inconnus »
contenait cette troncature et accusait le produit à tort. La liste ne
retient que des transpositions — la faute qu'un opérateur commet
vraiment — et une assertion sépare désormais les deux : l'abréviation
doit continuer de fonctionner derrière `undo`.

**Tests.** `huawei-undo-refuse-inconnu.test.ts` (17 cas) vérifie une
propriété et non une liste : un balayage de mots inconnus dans trois vues
du routeur et trois du switch, l'écho et la position du curseur, le fait
que **les deux plateformes refusent avec le même mot**, un balayage
symétrique de dix-neuf `undo` légitimes qui doivent continuer de passer,
et qu'un refus ne défait rien — la configuration est comparée à
elle-même avant et après.

Discrimination par `git stash` : **7 des 17 tombent** avant. Une des
assertions passait d'abord **à vide** — « les deux plateformes refusent
avec le même mot » était vraie quand les deux rendaient `""` ; elle
exige maintenant que ce mot commun soit le refus.

**Mesures.** 156 suites connexes vertes (3 176 cas) — toutes celles qui
tapent `undo` ou construisent une machine Huawei. Typecheck
`tsc -p tsconfig.app.json` à 162, inchangé ; lint identique au baseline
(40 problèmes avant, 40 après).

---

## 10. V2 — Livré

**L'invariant est tenu** : sérialiser, retaper sur une machine neuve en
honorant les `#`, re-sérialiser, comparer. **Zéro ligne refusée** (contre
14) et les deux textes identiques.

### 10.1 Le `#` : une règle mécanique plutôt que vingt-cinq rappels

Le séparateur était poussé à la main en une vingtaine d'endroits, donc
deux manquaient. Ajouter les deux aurait laissé le vingt-sixième oublier
à son tour. `normaliserBlocsVrp()` applique une règle unique, une seule
fois, à la fin : **on quitte un bloc dès qu'une ligne de premier niveau
suit une ligne indentée, et il faut alors un `#`.** Deux lignes de
premier niveau qui se suivent n'en demandent pas — VRP groupe ses
commandes autonomes, et une règle plus large aurait coupé ces groupes.
La même passe supprime les `#` doublés.

### 10.2 Le numéro de règle, et un piège qui a corrigé mon correctif

Deux défauts se suivaient. Le parseur **consommait le numéro deux fois** :
`rawArgs.slice(1)` le retirait avant que la lecture de `ruleId`, dix
lignes plus bas, puisse le voir — il était donc toujours perdu. Et le
rendu écrivait `idx * 5`, sans jamais lire ce qui était rangé.

Mon premier correctif rendait `entry.sequence ?? idx * 5`, ce qui a fait
tomber une suite existante — à juste titre. Ce test tape
`rule permit source …` **sans numéro** et attend `rule 0`/`rule 5` :
c'est l'auto-numérotation, qui est légitime. Le champ
`sequenceConfigured` existait déjà pour exactement cette distinction
(« L'opérateur a-t-il ÉCRIT ce numéro ? ») ; il est maintenant posé par
les deux parseurs et lu par les quatre rendus. La suite passe **sans être
modifiée**, ce qui est le bon signe : sa prémisse n'était pas le défaut.

### 10.3 Le mot de passe, ou pourquoi la moitié du correctif aurait été pire

Les séparateurs réparés, l'aller-retour ne refusait plus rien mais
produisait **une machine cassée** : le rejeu prenait l'empreinte du
compte pour son mot de passe, et `zoe` n'ouvrait plus. Rendre le texte
identique en laissant cela aurait été le motif que ce dépôt passe son
temps à retirer — un fait affiché que rien ne soutient.

La cause : le magasin gardait le **clair**, l'algorithme n'étant qu'une
étiquette, et le rendu chiffrait à l'affichage. Le commentaire du parseur
affirmait pourtant déjà le contraire (« a cipher value is already
hashed »). Le modèle est désormais cohérent d'un bout à l'autre :

- **ce qui est rangé est ce qui sera rendu** — l'empreinte pour
  `irreversible-cipher`, le chiffre pour `cipher` ;
- la **même commande** sert à poser un clair (ce que l'opérateur tape) et
  à rejouer une configuration (qui porte la valeur transformée), donc
  `looksLikeIrreversibleCipher`/`looksLikeReversibleCipher` distinguent
  les deux à la forme, comme VRP le fait avec son encodage de longueur
  fixe ;
- `authenticate()` passe par l'algorithme : PBKDF2 du mot tapé comparé à
  l'empreinte, déchiffrement pour le cipher réversible.

Conséquence assumée et vérifiée : la configuration **ne porte jamais le
clair**, et un compte rejoué s'ouvre quand même avec son mot de passe
d'origine. Une suite existante fixait la prémisse inverse
(`expect(u?.secret).toBe('Admin@123')` après un `password cipher`) —
c'est-à-dire un mot de passe « chiffré » stocké en clair ; elle teste
maintenant son intention réelle, que le compte s'ouvre.

### 10.4 Trois pertes sèches, trois causes différentes

| Perte | Cause |
|---|---|
| `service-type telnet` → `ssh` | la projection `_listLocalUsers()` laissait le champ de côté, et le rendu écrivait `ssh` en dur |
| `undo summary` absent | `_huaweiRipExtras` était écrit par le CLI et **lu par personne** — même forme morte que `_huaweiRipIfExtras`, trouvée en R7 |
| `version 1` → `version 2` | le rendu écrivait `2` en dur, et la commande `version` **ignorait son argument** : elle était acceptée et ne réglait rien |

Le troisième cas n'était pas dans la liste de l'audit ; le test de
l'aller-retour l'a fait sortir. `huaweiRipExtras()` est maintenant un
accesseur unique partagé par celui qui écrit et celui qui rend.

### 10.5 Tests et mesures

`huawei-config-round-trip.test.ts` (14 cas) : l'aller-retour lui-même
(aucun refus, textes identiques, rendu stable), la structure en blocs
vérifiée comme une **propriété** — aucune ligne de premier niveau ne suit
une ligne indentée sans `#` — et non par une liste de positions, ce que
l'opérateur a écrit qui revient tel quel, ce que la machine numérote
elle-même qui le reste, et le compte qui s'ouvre après rejeu.

Discrimination par `git stash` : **10 des 14 tombent** avant.

**Mesures.** 230 suites connexes vertes (3 220 cas) : Huawei, SSH, AAA,
authentification, telnet, ACL, RIP ; puis 187 suites (3 680 cas) sur tout
ce qui touche aux identifiants. Typecheck `tsc -p tsconfig.app.json` à
163, inchangé ; lint à 113 problèmes contre 114 (un de moins, le `any`
retiré du sac RIP).

**Trois rouges antérieurs, vérifiés et non traités** :
`advanced-15-scenarios` §13 et `ssh-operator-journeys` §J04/§J08 tombent
identiquement avec mes changements remisés. Ils sont côté Cisco/Windows,
hors du périmètre VRP, et signalés dans le journal.
