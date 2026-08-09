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
| **V3** | Chantier C : le nom du port, l'interface virtuelle, `display this` (**livré, §11**) | — |
| **V4** | Chantier D §1-§2 : les quatre messages, `Too many parameters` (**livré, §12**) | V1 |
| **V5** | Chantier D §3 et §5 : bornes, abréviation du nom d'interface (**livré, §13** ; l'aide §1.9 est passée à l'agent « logging ») | V4 |
| **V6** | `debugging` VRP — audit séparé, sur le modèle de `PRD-Debug-Fidelite-Cisco.md` | **Livré, §14** |
| **V7** | La queue d'une commande lue jusqu'au bout (reliquat de V4/V5) | **Livré, §16** |
| **V8** | La grammaire de `acl` et `stp` (reliquat de V7) | **Livré, §17** |
| **V9** | Le typage du shell (agent « logging ») | **Livré, §18** |
| **V10** | Le typage de `HuaweiSwitchShell` | **Livré, §19** |
| **V11** | Deux vues d'un même port en disent la même chose | **Livré, §20** |
| **V12** | `display ip interface brief`, un tableau pour deux plateformes | **Livré, §21** |
| **V13** | La famille « brief » des interfaces (`brief`, `description`) | **Livré, §22** |
| **V14** | Une adresse MAC s'écrit comme VRP l'écrit | **Livré, §23** |

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

---

## 11. V3 — Livré

### 11.1 Une correction de mon propre audit, d'abord

**Le §1.4 accusait à tort le switch.** J'y écrivais que son `display this`
« rend la configuration entière » ; la mesure avait été prise **après un
`quit`**, donc en vue système — où la vue courante EST la machine et où
tout rendre est juste. Le balayage de V3, qui parcourt chaque vue une par
une, l'a montré. Le vrai défaut du switch était ailleurs : `display this`
n'existait pas du tout en vue de VLAN.

C'est la troisième fois de ce corpus qu'une sonde mal cadrée accuse le
produit de plus qu'il ne fait (les deux autres sont notées en
`PRD-Routage-Fidelite.md` §14.1 et au §1.2 ci-dessus). La règle qui
manque à chaque fois est la même : **une commande se juge dans sa vue.**

### 11.2 Un port a un seul nom

Les ports sont rangés sous leur nom court (`GE0/0/0`), qui est interne.
L'expansion vers le nom complet était écrite **en ligne dans deux vues et
absente des quatre autres** — l'invite, `display interface brief`,
`display interface description` et `display interface <nom>` montraient
donc le nom interne. `huaweiDisplayInterfaceName()` est désormais la
seule expansion, lue par les six.

L'abréviation d'entrée ne change pas : `interface GE0/0/0` reste accepté,
seul l'affichage devient `[LAB-GigabitEthernet0/0/0]`.

### 11.3 Une interface virtuelle est vivante

Chaque vue calculait son état, et de façons différentes :
`getIsUp() && isConnected()` dans trois d'entre elles, et dans
`display interface` une liste d'interfaces virtuelles écrite à la main
(`/^(LoopBack|Tunnel)/`) qui oubliait `Vlanif` et `NULL`. Une Loopback
était donc rapportée morte alors que sa route était installée.

`iosInterfaceStatus` décrit l'état d'un **port**, pas un modèle par
constructeur : les vues VRP le lisent maintenant, chacune avec ses mots
(`*down` pour un arrêt administratif). Trois faits en découlent, et
chacun est tenu par un test : la Loopback est vivante, une interface
physique sans porteuse reste morte, et l'arrêt administratif se distingue
de la porteuse absente — distinction que le prédicat maison, rendant un
booléen, ne pouvait pas exprimer.

### 11.4 `display this` rend la vue courante

Quatre extracteurs de bloc écrits à la main, un par vue, chacun
s'arrêtant sur `#` **seulement** — ce qui laissait tout passer quand un
séparateur manquait, et c'est précisément ce qui faisait fuir `aaa` dans
la vue OSPF avant V2. Une seule marche les remplace, et elle s'arrête
aussi sur **toute ligne de premier niveau** : elle ne peut plus déborder,
même si la structure change à nouveau.

Les vues `aaa` et `acl` du routeur tombaient dans le `default` et
rendaient la configuration entière ; elles ont maintenant leur cas. La
vue de VLAN du switch n'avait pas la commande : elle l'a.

Le `default` — vue système — rend toujours tout, et c'est juste (§11.1).

### 11.5 Refusé, et pourquoi

**La terminaison diverge et je n'y touche pas** : `display this` finit par
`#` sur le routeur et par `return` sur le switch. L'incohérence est
réelle, mais trancher demande de savoir laquelle est celle de VRP, et je
n'en suis pas sûr. §0 interdit de faire reposer un correctif sur un point
non confirmé seul ; le cas reste ouvert plutôt que d'être aligné au
hasard sur la majorité du dépôt.

### 11.6 Tests et mesures

`huawei-une-verite-par-objet.test.ts` (17 cas) compare les vues **entre
elles** : les six qui nomment une interface emploient le même nom, celles
qui donnent son état s'accordent avec la table de routage, et
`display this` est **strictement plus petit** que la configuration dès
qu'on est descendu dans une vue — chacune de ses lignes devant par
ailleurs se retrouver dans la configuration complète, ce qui interdit
qu'il invente.

Discrimination par `git stash` : **10 des 17 tombent** avant.

**Cinq suites corrigées dans leur intention**, toutes fixant le nom
interne à l'écran (`toContain('GE0/0/0')`, `'[Huawei-GE0/0/0]'`). Leur
intention — l'abréviation est acceptée, la navigation fonctionne, la vue
reflète l'adresse — est conservée ; c'est la prémisse d'affichage qui
change, et le §1.5 dit pourquoi.

**Mesures.** 288 suites connexes vertes (3 126 cas) : Huawei, VRP,
interfaces, VLAN, ACL, `display`, scénarios, STP, LACP. Typecheck
`tsc -p tsconfig.app.json` à 164, inchangé ; lint identique au baseline
(103 problèmes avant, 103 après).

**Un rouge de pollution inter-fichiers, signalé** :
`scenario-ad-fsmo-roles.test.ts` tombe dans une campagne large et passe
seul, avec mes changements en place. C'est la classe déjà documentée dans
`CLAUDE.md` (registres non réinitialisés globalement — ici celui des
forêts Active Directory), sans rapport avec VRP.

---

## 12. V4 — Livré

### 12.1 Quatre messages, un format — et 237 sites

VRP n'a que quatre erreurs positionnelles et elles portent **toutes**
l'écho de la ligne et le curseur. Le dépôt en comptait quatre
formulations pour le seul paramètre erroné — `Wrong parameter found at
'^' position.` **sans aucun curseur**, `Wrong parameter found.`,
`Wrong parameter.`, plus les messages maison `Invalid IP octet: 999` et
`Invalid OSPF process ID.` — et **237 sites** rendant `Error: Incomplete
command.` nu.

La première formulation est la pire des cinq : elle annonce une position
et n'en montre aucune.

Les corriger un par un était exclu, et aurait de toute façon laissé le
238ᵉ recommencer. **La mise en forme se fait au point de sortie**, une
fois par plateforme, là où la ligne tapée et le nombre de mots-clés
reconnus sont encore connus (`normaliserErreurVrp`). Les chemins de la
trie formataient déjà correctement ; ce sont les retours de gestionnaires
qui étaient nus.

**Ce qui n'est pas une des quatre familles est laissé tel quel.** Un
message propre à une commande — `Error: OSPF is not configured.` — n'a
pas de position à montrer, et lui en inventer une aurait été un mensonge
de plus. Un test le fixe.

**Le curseur.** Fin de ligne pour `Incomplete command` (« il en manque
ici », la convention déjà écrite dans `formatVrpPositionalError`) ;
premier argument pour `Wrong parameter`, puisque c'est le paramètre qui
est en cause et que le nombre de mots-clés reconnus le localise.

### 12.2 `Too many parameters`, et un plafond qu'on ne pose pas à l'aveugle

Le trie ne portait qu'une arité **minimale** (`minArgs`, consultée à
l'exécution) et un `_noArgument` que seule l'aide lisait. Un mot en trop
derrière une commande gloutonne était donc silencieusement jeté :
`sysname R1 R2` prenait `R1` et perdait `R2`.

`maxArgs` est ajouté au trie, symétrique de `minArgs`, avec
`allowArgs(path, n)` pour le déclarer et `tropDeParametres()` pour le
lire au point de sortie VRP. **Le changement est purement additif** :
non déclaré, il n'y a pas de plafond, et le comportement de toutes les
commandes existantes — des deux constructeurs — est inchangé. Vérifié :
122 suites Cisco vertes (1 724 cas).

**Le plafond n'est déclaré que là où les formes légitimes sont closes et
vérifiables.** `sysname` prend un nom et un seul : la forme est close, le
plafond est sûr. `ip route-static … extra` et `ospf 1 zzz` ne le sont
pas — `ip route-static` accepte huit arguments et plus selon les options
(`preference`, `track`, `permanent`, `description`), et plafonner à
l'aveugle **refuserait une forme valide, ce qui serait pire que le
silence d'aujourd'hui**. Ces deux cas restent acceptés, et **un test les
fixe** pour que la déclaration, quand elle viendra, soit faite sciemment.

C'est le même arbitrage que V1 sur `undo` : la portée se resserre sur ce
qu'on peut vérifier, plutôt que de s'étendre sur ce qu'on suppose.

### 12.3 La frontière avec le lot de l'autre agent

L'agent « logging » a pris le §1.9 (l'aide `?`) et y traite les **arités
déclarées**, dont un cas que mon §1.7 relevait : `ip pool` répondant
`Incomplete command.` là où `interface LoopBack` répond `Wrong
parameter`. Le partage est net et les deux moitiés se complètent : leur
correctif est **déclaratif** — faire savoir au trie qu'un argument est
requis, d'où le bon message — le mien est **le format** de ce message et
le sort des formulations maison. Une fois les deux posés, un argument
manquant donne partout `Incomplete command` avec écho et curseur.

**J'ai touché `CommandTrie.ts`**, que cet agent disait éviter sans le
revendiquer, et je l'ai signalé dans le journal : l'ajout est un champ
optionnel plus deux accesseurs, sans effet sur les commandes qui ne le
déclarent pas.

### 12.4 Tests et mesures

`huawei-quatre-messages.test.ts` (12 cas) vérifie une **forme** balayée
sur une trentaine de commandes : trois lignes, un message parmi les
quatre familles, la ligne tapée telle quelle, un curseur dans ses bornes.
S'y ajoutent la position du curseur dans les deux cas où elle se déduit
(argument fautif, argument manquant), l'absence des cinq formulations
inventées, le fait qu'un refus ne change rien, et que la forme légitime
passe toujours.

Discrimination par `git stash` : **7 des 12 tombent** avant.

**Une suite corrigée dans son intention** :
`probe-vrp-01-loopback-et-display.test.ts` attendait `Invalid IP
address`. Elle vérifie maintenant le refus de VRP **et** que le curseur
désigne bien l'adresse fautive — donc plus qu'avant.

**Mesures.** 174 suites connexes vertes (3 555 cas) — toutes celles qui
construisent une machine Huawei ou qui mentionnent un des messages
touchés — plus les 122 suites Cisco (1 724 cas) pour le moteur partagé.
Typecheck `tsc -p tsconfig.app.json` à 165, inchangé ; lint identique au
baseline (104 problèmes avant, 104 après).

---

## 13. V5 — Livré

Le §1.9 (l'aide `?`) étant passé à l'agent « logging », ce lot se réduit
aux deux points restants du chantier D : les bornes, et l'abréviation du
nom d'interface.

### 13.1 Deux bornes vérifiées, deux laissées ouvertes

**Un router-id EST une adresse IPv4**, et n'importe quel mot était
accepté — `pasuneadresse` compris. Deux défauts se cachaient derrière :
la validation manquait, et la forme d'une ligne
`ospf <id> router-id <rid>` **jetait tout ce qui suivait l'identifiant de
processus**. Le router-id ne prenait donc pas, ce qui rendait la
validation d'autant plus invisible. Les deux sont corrigés ensemble : la
forme est honorée et validée.

**La préférence d'une route statique va de 1 à 255.** `0` et `256`
étaient acceptés, et `0` aurait fabriqué une route indérogeable.

**Deux bornes restent ouvertes, et un test le fixe** : la plage des
`LoopBack` et la longueur maximale d'un `sysname`. Elles existent sur un
vrai VRP, mais je n'en connais pas la valeur exacte, et §0 interdit de la
deviner. Le test qui les épingle n'affirme pas qu'elles sont illimitées :
il affirme que **ce lot ne les a pas inventées**, pour que la borne, le
jour où une source la donne, soit posée sciemment.

### 13.2 L'abréviation est une règle, pas une liste

`interface g0/0/0` est l'une des frappes les plus courantes d'un
opérateur VRP, et elle était refusée — tandis que `ge0/0/0` et `gi0/0/0`
passaient. La cause : **quatre tables d'écritures admises**, écrites à la
main, dans quatre fichiers.

| Où | Ce qu'elle admettait |
|---|---|
| `cli-utils.ts` (résolution d'un port existant) | `ge`, `gi`, `gigabitethernet`, `lo`, `lb`, `loopback`, `tu`, `tunnel`, … |
| `HuaweiConfigCommands.ts` (création d'une interface virtuelle) | les noms **entiers** seulement |
| `HuaweiSwitchShell.ts` (résolution côté switch) | `ge`, `gi`, `gigabitethernet` |
| `HuaweiSwitchShell.ts` (`vlanif`/`loopback`) | le nom entier, par expression régulière |

Une table fermée ne peut pas exprimer la règle de VRP — **tout préfixe
non ambigu du nom du type** — et ces quatre-là ne disaient déjà pas la
même chose. `huaweiTypeInterface(prefixe)` est désormais la règle unique,
lue par les quatre : elle rend le type quand **exactement un** le porte,
et `null` quand aucun ou plusieurs le portent, parce que deviner entre
deux serait pire que refuser.

Le nom court interne `GE` reste accepté à la saisie — il l'était déjà, et
c'est ainsi que ce simulateur range ses ports — mais ce n'est pas une
abréviation de VRP, et le code le dit.

### 13.3 Une régression que j'ai faite, et ce qu'elle apprend

En faisant lire la règle aux deux gestionnaires `vlanif`/`loopback` du
switch, j'ai remplacé une expression régulière dont le **groupe 1 était
le numéro** par une fonction dont le groupe 1 était le **type** — sans
toucher les appelants, qui lisaient toujours `[1]`. Résultat : trente
tests rouges, `interface LoopBack0` ne sélectionnant plus rien.

La leçon est dans la signature : la fonction rend maintenant un `number`
(`numeroDInterface`) au lieu d'un `RegExpMatchArray`, donc le type
interdit désormais la confusion que la forme précédente invitait.

### 13.4 Tests et mesures

`huawei-bornes-et-abreviation.test.ts` (10 cas) vérifie deux propriétés :
une borne connue tient **des deux côtés** (ce qui est hors bornes est
refusé, ce qui est dedans passe et prend), et l'abréviation est balayée
sur les **préfixes** — `g`, `gi`, `gig`, `giga`, le nom entier — y
compris ceux que personne n'avait pensé à inscrire, plus la casse, la
création d'une interface virtuelle par abréviation, et le refus d'un type
inconnu.

Discrimination par `git stash` : **8 des 10 tombent** avant.

**Une erreur de cadrage dans mon propre test**, la quatrième de ce
corpus : les deux bornes ouvertes étaient mesurées à la suite sur une
même machine, or la première descend en vue d'interface, où `sysname`
n'existe pas — le refus obtenu n'aurait rien dit de la borne. Chacune est
sur sa machine.

**Mesures.** 228 suites connexes vertes (3 045 cas), Cisco compris.
Typecheck `tsc -p tsconfig.app.json` à 166, inchangé ; lint identique au
baseline (65 problèmes avant, 65 après).

---

## 14. V6 — Livré : le `debugging` VRP

Audit séparé, comme annoncé au §8, et conduit comme celui du §0 : chaque
commande jugée **dans sa propre vue, sur une machine neuve**, sur un
`HuaweiRouter` et un `HuaweiSwitch` — dix-neuf formes de `debugging`,
leur `undo`, les deux vues d'état, et la ligne suivie **jusqu'à
l'abonné**, à la source (`HuaweiDebugService.subscribe`).

Ce lot n'a pas trouvé un défaut mais **un défaut de structure et sept
conséquences**. La cause unique : il y avait **quatre magasins** pour une
seule question — « qu'est-ce qui est allumé ? ».

### 14.1 Le constat qui commande tous les autres : quatre magasins

Mesuré, sur une machine neuve, en enchaînant deux commandes :

```
debugging ospf event        -> ""                       (magasin A : le service)
debugging ip icmp           -> "Info: ip icmp debugging is on."   (magasin B : un Set)
display debugging           -> "ip icmp debugging is on
                                OSPF event debugging is on"
undo debugging all          -> "1 debug switch(s) have been turned off"
display debugging           -> "ip icmp debugging is on"          ← toujours allumé
```

**La commande dont c'est l'unique raison d'être n'éteignait pas tout**,
et annonçait un compte faux en le disant. Les quatre magasins :

| # | Magasin | Écrit par | Émetteur ? | Vu par `display debugging` ? |
|---|---|---|---|---|
| A | `HuaweiDebugService` | formes OSPF/ICMP/IP du routeur | oui | oui |
| B | `_huaweiDebugFlags` (`Set<string>`) | le fourre-tout glouton de `HuaweiCommonConfig` | **non** | oui |
| C | `IPSecEngine` | `debugging ike` / `ipsec` | oui | oui |
| D | `DHCPServer` | `debugging dhcp server …` | oui | oui |

Le magasin B n'avait **ni propriétaire ni émetteur** : il rangeait la
phrase déjà rendue (`"ip icmp debugging is on"`), personne ne s'y
abonnait, aucune ligne n'en sortait jamais. `undo debugging all` du
routeur ne vidait que A ; une **seconde** déclaration de `undo debugging
all`, dans le module IPSec, ne vidait que C **en annonçant `Info: All
debugging turned off.`** — la phrase la plus fausse du sous-système.

### 14.2 Un sujet, deux écritures, dont la bonne était morte

`debugging icmp` allait dans A (et **émettait**) ; `debugging ip icmp` —
**l'écriture de VRP** — allait dans B et n'émettait rien. Les deux
apparaissaient dans `display debugging`, donc **un seul sujet occupait
deux lignes**, et l'écriture qu'un apprenant tape est précisément celle
qui ne traçait rien.

### 14.3 Trois formats de confirmation sur une seule machine

```
debugging ospf spf   -> "OSPF SPF debugging is on"        (sans `Info:`, sans point)
debugging ip icmp    -> "Info: ip icmp debugging is on."
debugging ospf event -> ""                                 (silence)
```

Et une **phrase d'IOS sur un équipement Huawei** : `disableAll()` rendait
`All possible debugging has been turned off` — les mots exacts d'IOS —
alors que le switch, au même instant, rendait ceux de VRP
(`Info: All possible debugging functions are off.`).

### 14.4 La même commande, deux réponses selon la vue

| Commande | Vue utilisateur | Vue système |
|---|---|---|
| `debugging ospf spf` | `OSPF SPF debugging is on` | **refusée** (`Unrecognized command`) |
| `debugging icmp` | `ICMP debugging is on` | `Info: icmp debugging is on.` |

Deux enregistrements distincts pour une commande, sur deux tries.

### 14.5 `debugging zzz` était accepté ; `debugging` seul valait `all`

Le fourre-tout acceptait **n'importe quel mot** comme nom de catégorie
(`Info: zzz debugging is on.`, puis listé par `display debugging`), et
`debugging` sans argument était traité comme `debugging all`. Symétrique-
ment, `undo debugging` seul rendait `Info:  debugging is off.` — deux
espaces, sujet vide.

### 14.6 Trois catégories déclarées sans aucune source

`rip`, `bgp`, `vrrp` : acceptées, listées « on », et **structurellement
muettes** — `attachToBus` ne s'abonnait à aucun sujet les concernant.
Vérifié : RIP configuré des deux côtés, VRRP configuré, `display rip 1
route` exécuté → **0 ligne**. `isis` était pire encore : accepté, rendu
`""`, rangé **nulle part**.

### 14.7 Le switch : décoratif de bout en bout

```
debugging stp        -> "Info: stp debugging is on."
_huaweiDebugFlags    -> []            ← rangé nulle part
display debugging    -> Error: Unrecognized command found at '^' position.
display debug        -> Error: Unrecognized command found at '^' position.
undo debugging all   -> "Info: All possible debugging functions are off."
```

Le switch n'avait **aucun service de debug**. La commande était acceptée
avec une confirmation, ne rangeait rien, n'émettait rien, et l'état ne
pouvait **pas être relu** — la seule commande capable de le contredire
étant refusée.

### 14.8 Le nom du port dans la trace

Les lignes émises nommaient `GE0/0/0` là où **toutes** les vues VRP
disent `GigabitEthernet0/0/0` depuis V3. La règle « un port a un seul
nom » n'avait pas atteint ce canal.

---

### 14.9 Le correctif : un magasin, une table, une phrase

**Un magasin.** `_huaweiDebugFlags` est supprimé. `HuaweiDebugService`
est le registre unique ; DHCP et IPSec gardent leur propre drapeau — ils
en sont légitimement propriétaires — et s'y **annoncent**
(`registerSwitchboard`) au lieu d'y être recopiés : `display debugging`
les rend d'une seule voix et `undo debugging all` les atteint. La seconde
déclaration de `undo debugging all` (module IPSec) est supprimée.

**Une table.** `router/diag/huaweiDebugCatalog.ts` porte, par catégorie :
l'**écriture canonique de VRP**, la **désignation unique** (celle de la
confirmation *et* du listage) et les **plateformes**. La résolution est
une règle — plus long préfixe gagnant, le reste étant une portée
(`debugging rip 1`) — et non une liste de `register` dispersés.

Chaque écriture canonique est aussi un **vrai chemin de la trie**, et pas
seulement une branche du fourre-tout. Ce n'était pas prévu : en retirant
les anciens nœuds littéraux, `debugging ip icmp` s'est mis à être **avalé
par `debugging ipsec`**, dont `ip` est un préfixe non ambigu — mesuré par
un test qui a viré au rouge, pas déduit. Effet de bord utile : ces formes
redeviennent découvrables par `?`.

**Une phrase.** Confirmation `Info: <désignation> debugging is on.`,
listage `<désignation> debugging is on`, extinction totale
`Info: N debugging switch(es) have been turned off.` — ou
`Info: All possible debugging functions are off.` quand il n'y avait
rien. Les mots d'IOS ont quitté l'équipement Huawei.

**Ce qui est accepté peut émettre.** C'est le cliquet de `PRD-Debug-
Fidelite-Cisco.md` §4.1, transposé : une catégorie n'entre au catalogue
que si le service l'émet, et un test **lit le fichier** pour l'imposer.
`rip`, `bgp`, `vrrp` ont donc reçu de vrais émetteurs (les mêmes sujets
de bus que le service Cisco, avec les mots de VRP), `arp packet` et `stp`
aussi. `isis` n'en a pas : il est refusé **en nommant la brique
manquante** (`Error: The IS-IS module produces no debugging information
in this simulator.`), et figure dans `HUAWEI_DEBUG_SANS_SOURCE`, liste
qui ne doit que **rétrécir** — même règle que le refus des types NQA de
`PRD-NQA.md`.

**Le switch a le même magasin**, sur les catégories qu'il sait tracer,
et `display debugging` lui répond.

**Une seule écriture par sujet.** `debugging icmp` n'existe plus :
`debugging ip icmp` est la forme de VRP, celle que `display debugging`
montrait déjà, et celle qu'un test existant attendait. `display debug`
n'est plus une seconde commande mais l'abréviation de `display
debugging`, donc la même réponse par construction.

### 14.10 Refusé, et pourquoi

**`debugging all` est refusé.** VRP a `undo debugging all` et n'a pas son
symétrique — l'asymétrie est celle de VRP, pas une simplification. Le
fourre-tout l'acceptait et allumait une catégorie nommée `all`.

**L'horodatage de la trace n'est pas fait ici, et c'est délibéré.** La
ligne part sans horodatage :

```
"ICMP: Echo Request sent, src=1.1.1.1, dst=2.2.2.2"
```

alors que la même machine, au même instant, annonce
`Timestamp: log date, trap date, debug date` à `display info-center` —
un réglage qui existe (`InfoCenterConfig.timestamps.debug`, format et
précision), qui est rendu, et que **rien ne lit**. C'est le jumeau VRP du
§1.1 du PRD debug Cisco. Il n'est pas corrigé dans ce lot pour une raison
de coordination, pas de difficulté : `info-center` appartient à l'autre
agent (`PRD-Info-Center-Huawei.md`), **aucun rendu d'horodatage VRP
n'existe encore**, et celui qu'il faut écrire servira aussi au canal
`log` vers `monitor`. L'écrire ici en ferait un second — exactement la
duplication que ce journal existe pour éviter. Le constat est passé dans
`JOURNAL-AGENTS-mandeng.md` avec le point d'accroche exact.

**Ce que le format de `display debugging` doit à VRP n'est pas
inventé.** Je n'ai pas de matériel pour vérifier le rendu exact ; les
désignations existantes sont **conservées** plutôt que remplacées par une
autre supposition. Ce que ce lot corrige est ce qui est démontrable sans
matériel : qu'une désignation soit **la même partout**.

### 14.11 Tests et mesures

`huawei-debugging-un-seul-magasin.test.ts` (17 cas) fixe quatre
propriétés : un seul magasin (extinction totale, compte annoncé exact,
extinction ciblée, et le second magasin absent **du code**) ; une seule
désignation (balayage de **tout** le catalogue : la confirmation, le
listage et l'extinction doivent se répondre) ; ce qui est accepté peut
émettre (le cliquet lu dans le fichier, le refus nommé, la forme VRP à
trois lignes pour un mot inconnu, et **deux traces réellement reçues** —
ICMP par un `ping`, OSPF par un `shutdown`/`undo shutdown` — dont on
vérifie qu'elles nomment `GigabitEthernet0/0/0` et jamais `GE0/0/0`) ;
les deux vues et les deux plateformes.

Discrimination par `git stash` : **15 des 17 tombent** avant. Les deux
qui passent des deux côtés sont exactement les cas déjà corrects pour les
catégories que le magasin A servait seul.

**Un test existant corrigé, et un seul** : `probe-debug-05-sortie-via-
ssh.test.ts` tapait `debugging icmp`, la seconde écriture supprimée. La
prémisse était fausse, pas l'attente — les trois lignes passent à
`debugging ip icmp` et le fichier est vert sans autre changement. Aucun
autre test n'a été touché : `huawei-config-parity.test.ts`, qui vérifie
que `display debugging` contient `ip icmp`, passe **inchangé**, ce qui
est le signe que sa prémisse était la bonne.

**Mesures.** 87 suites connexes vertes (1 359 cas), Cisco et DHCP
compris. Typecheck `tsc -p tsconfig.app.json` à **167, le baseline
inchangé**. Lint sur les dix fichiers touchés : **162 problèmes avant,
157 après** (cinq `any` de moins, aucun ajouté).

---

## 15. §1.9 — Livré (agent « logging »)

Repris avec l'accord de l'agent « routage/CLI », qui l'avait proposé
comme jumeau du chantier Cisco « ce que `?` propose, la machine
l'accepte ».

### 15.1 La cause n'était pas là où le constat la plaçait

Mesuré avant d'écrire une ligne : `CommandTrie.isExecutableAt` consulte
**déjà** `requiredArity` avant de proposer `<cr>`, et cette arité était
juste. Elle valait **zéro**. Ces commandes sont enregistrées par
`registerGreedy`, qui ne déclare aucun paramètre : la trie les croyait
exécutables telles quelles, proposait `<cr>` en toute logique, et c'est
le HANDLER qui refusait ensuite. Le rendu de l'aide n'avait aucun tort ;
il disait fidèlement une chose fausse qu'on lui avait apprise.

D'où un correctif **déclaratif** plutôt qu'un changement de moteur :
`describeArgs` pose les arguments, et poser un argument requis retire le
`<cr>` par construction. Un seul geste pour les deux moitiés du constat
— l'aide nomme ce qu'il faut taper, et cesse d'annoncer qu'on peut ne
rien taper.

Le relevé complet, routeur et switch, vue système :

| Commande | Avant | Après |
|---|---|---|
| `interface ?` | `WORD` + `<cr>` | les 7 types, sans `<cr>` |
| `interface` | `Error: Incomplete command.` | `Error: Incomplete command found at '^' position.` + curseur |
| `ip pool ?` / `ip host ?` | `WORD` + `<cr>` | le nom, sans `<cr>` |
| `vlan ?` (switch) | `batch` + `<cr>` | `<1-4094>` + `batch`, sans `<cr>` |
| `stp ?` (switch) | 7 mots empruntés + `<cr>` | les 13 mots du handler, sans `<cr>` |
| `interface ?` (switch) | `range` + `<cr>` | les 7 types |

### 15.2 Le piège : l'arité ne suffit pas

Déclarer le type comme argument requis retire bien le `<cr>` derrière
`interface`. Mais le numéro s'écrit de deux façons —
`interface GigabitEthernet0/0/0` en un jeton, `interface GigabitEthernet
0/0/0` en deux — et **compter les jetons ne peut pas trancher entre
elles** : requis, le second argument interdit la forme collée ;
optionnel, il déplace simplement le `<cr>` menteur d'un cran vers la
droite, derrière un type nu que la machine refuse.

C'est le seul endroit où le moteur a dû changer, et le changement est
additif : `CommandNode.executableWhen`, un prédicat consulté **en plus**
de l'arité, jamais à sa place. Un nœud qui n'en déclare pas se comporte
exactement comme avant. Ici il tient en une ligne — une interface se
désigne par un numéro, donc l'un des arguments doit porter un chiffre.

Deuxième ajout, du même ordre : `CommandTrie.describeNode(path, texte)`.
Un nœud créé **en chemin** — `routing-table` dans
`ip routing-table limit`, `radius-server` dans
`display radius-server configuration` — reçoit sa propre clé pour
description, que le rendu blanchit ensuite, puisque répéter le mot-clé
n'apprend rien. Personne ne l'enregistre pour lui-même, donc personne ne
le décrit. `describeNode` est la seule façon de le faire sans lui
inventer une action.

### 15.3 Trois erreurs de ma part, corrigées par la mesure

Écrites ici parce qu'elles se reproduiraient sans cela.

1. **`describeArgs` minuscule la clé du nœud qu'il crée.** Décrire le
   numéro par un nœud sous chaque type (`interface LoopBack`) fabriquait
   des enfants `loopback`, `nve`, `tunnel` — si bien que la liste
   revenait mi-`LoopBack` mi-`loopback`, les seconds portant en prime
   une description prise au dictionnaire global
   (`loopback  Set the loopback mode`, celle d'un tout autre usage du
   mot). Un seul nœud à **deux** arguments dit la même chose sans
   fabriquer d'enfant.
2. **`addCompletionKeywords` et `describeNode` sont ignorés en silence
   si le nœud n'existe pas encore.** Mes premiers appels précédaient
   l'enregistrement : aucun effet, aucun message. Ils doivent suivre.
3. **`describeNode` ne peut pas se contenter de tester la chaîne
   vide.** La description d'un nœud de chemin vaut sa propre clé, pas
   `''` ; le garde-fou n'entrait donc jamais. Les deux formes valent
   « pas de description ».

### 15.4 Ce qui a été volontairement laissé

* **`interface range` n'est plus proposé par l'aide du switch.** Le
  handler l'accepte — son propre commentaire le nomme « Cisco-ism the
  suites use » — mais VRP ne connaît pas cette forme, et son aide ne
  l'annoncerait pas. La commande continue de fonctionner ; elle cesse
  d'être présentée comme du VRP.
* **§1.10 (`int g0/0/0` refusé) n'est pas traité** : c'est
  l'abréviation du NOM d'interface, pas l'aide, et elle appartient au
  V5 de l'agent « routage/CLI ». Vérifié inchangé par ce lot.
* **Six mnémoniques d'aide restent des descriptions écrites par moi**
  plutôt que relevées sur un équipement de référence (les sept types
  d'interface, les treize mots de `stp`). Elles décrivent ce que le
  handler fait réellement — c'est vérifiable ici — mais leur formulation
  n'est pas celle de Huawei mot pour mot.

### 15.5 Mesures

`probe-vrp-aide-et-machine.test.ts` (17 cas), **11 tombent par
`git stash`** des six fichiers touchés. Les cas qui passent des deux
côtés sont les garde-fous de non-régression : `ospf ?` garde son `<cr>`
parce que `ospf` seul s'exécute — la règle livrée n'est pas « retirer
`<cr>` partout », c'est « le proposer là où la commande marche ».

Deux invariants sont vérifiés de bout en bout plutôt que cas par cas :
**chaque type proposé par `interface ?` ouvre réellement une interface**,
et **aucun mot-clé n'est proposé sans description ni avec une
description qui répète son mot**, sur quatorze racines de commandes et
les deux plateformes.

---

## 16. V7 — Livré : la queue d'une commande est lue jusqu'au bout

Ce lot ferme le reliquat que V4 et V5 avaient laissé ouvert **en le
fixant par test** : « les commandes sans plafond déclaré acceptent encore
un mot en trop ». V4 avait construit le mécanisme (`allowArgs`,
`argumentCeiling`, `tropDeParametres`) et ne l'avait déclaré que pour
`sysname`, en refusant explicitement de plafonner à l'aveugle.

### 16.1 Le constat : dix-sept formes avalent un mot en silence

Balayage de 27 commandes, chacune sur une machine neuve dans sa propre
vue : la forme légitime, puis la même avec un mot de plus. **Dix-sept
l'acceptent**, et — c'est ce qui rend le défaut sérieux — la commande
**prend quand même** :

```
ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 extra   =>  ""
display current-configuration                        =>  ip route-static 10.0.0.0 255.0.0.0 10.0.12.2
```

Le mot n'est ni lu, ni refusé, ni conservé. L'opérateur croit avoir
configuré ce qu'il a tapé ; la machine a configuré autre chose, sans un
mot. C'est le même défaut de fond que V1 (`undo` fourre-tout) et V2 (les
valeurs rangées puis jetées), sur la queue des commandes cette fois.

### 16.2 Pourquoi un plafond ne suffit pas

Mesuré avant de coder — c'est ce qui a changé le correctif prévu. La
queue légitime de `ip route-static` est **riche** :

```
ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 preference 100 tag 7 permanent
ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 description VERS LE SIEGE
ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 track nqa admin test
ip route-static 10.0.0.0 255.0.0.0 GigabitEthernet0/0/0 10.0.12.2
```

Six mots de plus que la forme minimale, tous légitimes, et l'un d'eux
(`description`) est **libre**. Compter les arguments ne veut donc rien
dire ici. Deux mécanismes, parce que deux grammaires :

| Grammaire | Mécanisme | Commandes |
|---|---|---|
| positionnelle **close** | plafond déclaré (`allowArgs`) | `ip pool` 1, `ip host` 2, `area` 1, `network` (aire) 2, `network` (RIP) 1, `version` 1, `name` (VLAN) 1, `port default vlan` 1 |
| queue à **mots-clés** | validée par son parseur | `ip route-static`, `ospf <id>`, `rip <id>`, `ip address`, `interface`, `vlan` |

`refuseMotInattenduVrp` (`cli-utils.ts`) est la phrase unique des
seconds : le mot fautif est **désigné** par le curseur, à la forme VRP à
trois lignes.

### 16.3 Deux cas où compter aurait été faux, et l'ont prouvé

**`interface`.** VRP admet que le numéro soit séparé du type
(`interface LoopBack 0`), donc un plafond de deux laisse passer
`interface GigabitEthernet0/0/0 extra` — mesuré : le plafond posé n'a
rien changé. La règle est que **le second mot ne peut être que le
numéro**. Au passage, le refus existait déjà pour ce cas
(`Wrong parameter`) mais son curseur pointait le nom de l'interface,
c'est-à-dire le seul mot juste de la ligne.

**`ip address`.** `ip address 10.0.12.1 255.255.255.0 sub` est légitime,
donc le plafond est à trois — et `… 255.255.255.0 extra` en a trois
aussi. Le troisième mot est désormais lu : seul `sub` existe.

### 16.4 Un défaut trouvé par le test du lot, pas par la sonde

`ospf 1 zzz` refusait correctement **et laissait `ospf 1` dans la
configuration** : `_enableOSPF()` était appelé avant la lecture de la
queue. Un refus ne doit rien poser ; la queue est maintenant lue
d'abord, le processus activé ensuite. C'est le cas « un refus ne pose
rien » de la suite qui l'a levé, pas le balayage — un test qui vérifie
seulement le message serait passé à côté.

### 16.5 Refusé, et pourquoi

**`acl` et `stp` restent perméables**, et c'est écrit dans la suite
plutôt que masqué. Les deux portent **plusieurs grammaires sous un seul
nœud** (`acl 2000` / `acl number 2000` / `acl name X advance` ; `stp
mode`, `stp priority`, `stp root`…). Leur poser un plafond refuserait des
formes légitimes ; écrire leur grammaire est un travail par commande, pas
un plafond. Un test les fixe pour que ce soit fait sciemment.

**`sub` est validé et ne fait toujours rien.** Le mot est désormais le
seul admis en troisième position, mais la machine n'a **pas de notion
d'adresse secondaire** : la seconde adresse remplace la première. C'est
un manque du plan de données, pas de la CLI. Nommé par un test qui
asserte la substitution, plutôt que corrigé à moitié.

**`description` et `vlan batch` ne sont pas plafonnés**, et deux cas le
vérifient : c'est exactement ce que « ne pas plafonner à l'aveugle »
veut dire.

### 16.6 Tests et mesures

`huawei-queue-lue-jusquau-bout.test.ts` (50 cas) balaie les **deux
côtés** systématiquement : 23 formes légitimes qui doivent passer *et
prendre* (le marqueur est cherché dans la configuration rendue), 18
formes parasites qui doivent être refusées, plus le curseur vérifié
mot à mot, le refus qui ne pose rien, le refus qui n'écrase pas ce qui
était posé, et le refus qui ne fait pas changer de vue. Un test qui ne
vérifierait que le refus laisserait passer un plafond posé à l'aveugle,
qui est le défaut inverse et pire.

Discrimination par `git stash` : **20 des 50 tombent** avant. Les 30
autres sont les formes légitimes — qui doivent passer des deux côtés, par
construction — et les remainders documentés.

**Mesures.** 85 suites connexes vertes (1 171 cas), plus les suites de
routage, DHCP et L3. Typecheck : **jeu d'erreurs identique** avant et
après (168, le baseline courant). Lint sur les cinq fichiers touchés :
125 problèmes avant, 125 après.

---

## 17. V8 — Livré : la grammaire de `acl` et `stp`

Les deux perméabilités que V8 ferme sont celles que **V7 avait nommées
sans les fermer**, et pour une raison qui tient toujours : toutes deux
portent plusieurs grammaires sous un seul nœud glouton, donc un plafond y
refuserait des formes légitimes. Il fallait écrire la grammaire.

### 17.1 `acl` : il y en avait DEUX, et elles ne disaient pas la même chose

Le constat le plus lourd du lot, et il ne portait pas sur la queue.
Mesuré sur un routeur et un switch neufs, même ligne, même vue :

| Ligne | Routeur | Switch |
|---|---|---|
| `acl 42` | `Error: ACL number must be 2000-…` | `[SW-acl-basic-42]` |
| `acl 0` | refusé | `[SW-acl-basic-0]` |
| `acl abc` | refusé | **`[SW-acl-basic-NaN]`** |
| `acl number` | refusé | **`[SW-acl-basic-NaN]`** |
| `acl name TEST advance` | `[R-acl-adv-TEST]` | **`[SW-acl-basic-TEST]`** |
| `acl ipv6 name V6` | `[R-acl-adv-V6]` | **`[SW-acl-basic-NaN]`** |

Trois faits, pas un : le switch **ne bornait rien**, il lisait le mot de
type comme un NUMÉRO — d'où l'impossibilité d'y créer une ACL nommée
avancée — et il ouvrait des vues dont le nom était littéralement `NaN`.
Sur la même maquette, la même commande donnait deux réponses selon
l'équipement.

`HuaweiAclGrammar.ts` porte la grammaire **une fois**, pour les deux ;
chaque plateforme garde SON magasin, qui est légitimement différent (le
moteur d'ACL du routeur, la table du switch). Ce qui ne doit pas
différer, c'est ce qui est accepté.

**Une forme a été sauvée plutôt que supprimée**, et c'est un test
existant qui l'a imposé : `acl name MGMT 2999` lie un nom à un numéro,
et c'était la seule forme que le switch avait et que le routeur
refusait. Ma première grammaire l'a fait tomber ; la bonne lecture est
que la grammaire partagée doit être l'**union des deux vraies
grammaires**, pas celle du routeur seul. Le numéro y décide du type,
comme partout ailleurs.

### 17.2 `stp` : le premier mot était validé, et rien au-delà

Sept formes en vue système passaient en avalant leur queue
(`stp mode rstp extra`, `stp priority 4096 extra`, `stp root primary
extra`, `stp enable extra`, `stp bpdu-protection extra`,
`stp edged-port default extra`, `stp instance 1 priority 4096 extra`).

La vue interface était pire : **rien** n'était vérifié au-delà du premier
mot. `stp cost abc`, `stp edged-port zzz`, `stp port priority abc`
étaient acceptés sans rien poser — et la ligne était **tout de même
conservée** pour `display this`, donc écrite dans la configuration et
**rejouée à l'import**. Elle n'est plus rangée qu'une fois la grammaire
admise.

`HuaweiStpGrammar.ts` est une **table**, pas une suite de `if` : c'est ce
qui rend vérifiable qu'aucune forme n'est oubliée, et c'est la forme que
le catalogue de `debugging` avait déjà prise au lot V6. Un mot-clé
inconnu et un mot en trop y sont deux fautes distinctes, chacune
désignant son jeton.

### 17.3 Le curseur désignait le mot juste

Défaut transversal aux deux commandes, et invisible tant qu'on ne lit que
le message : le curseur se posait **toujours sur le premier argument**,
c'est-à-dire sur le mot-clé que l'opérateur avait tapé correctement.

```
avant                       après
stp mode zzz                stp mode zzz
    ^                                ^
acl name TEST zzz           acl name TEST zzz
    ^                                     ^
```

C'est ce que `rendreErreurVrp` corrige : l'erreur **porte** son jeton
fautif au lieu qu'il soit deviné au rendu.

### 17.4 Deux réglages jetés alors que le moteur les portait

Trouvés en écrivant la table, pas cherchés. `stp timer` et
`stp pathcost-standard` étaient acceptés et **écartés**, alors que
`StpAgent` expose `setHelloSec`, `setForwardDelaySec`, `setMaxAgeSec` et
`setPathcostMethod` depuis toujours. Les refuser aurait été faux ; les
brancher tenait en trois lignes. **VRP compte ces temporisateurs en
centièmes de seconde** et le moteur en secondes, donc la conversion est
faite ici, et les bornes de chaque temporisateur sont les siennes
(`hello` 100-1000, `forward-delay` 400-3000, `max-age` 600-4000).

Mesuré : `stp timer hello 500` fait passer `display stp` de
`Hello 2s` à `Hello 5s`.

### 17.5 Refusé, et pourquoi

**`tc-protection` et `converge` restent admis et sans effet.** Leur
grammaire est désormais vérifiée, mais aucun modèle ne les porte — il n'y
a ni limitation de débit des changements de topologie ni convergence
rapide dans ce simulateur. Les refuser serait faux (ce sont de vraies
commandes VRP) et prétendre qu'elles agissent le serait aussi. Un test
les fixe.

**Les ACL L2 (4000-4999) et utilisateur (5000-5999) restent hors des
bornes tenues.** Elles existent sur VRP ; rien ici ne sait évaluer une
règle de ces familles, donc la vue n'est pas ouverte et la borne tenue
est nommée. C'est la règle du lot V6 pour `debugging isis`.

### 17.6 Tests et mesures

`huawei-grammaire-acl-et-stp.test.ts` (33 cas). La propriété la plus
forte du fichier n'est pas une liste d'attentes écrites à la main :
**les deux plateformes sont comparées l'une à l'autre** sur 28 formes
d'`acl`, sortie ET vue ouverte. Un test écrit à la main aurait pu
recopier la mauvaise réponse ; celui-ci ne peut pas passer si les deux
divergent.

Le reste balaie les deux vues de `stp` (21 formes légitimes, 28 fautives
en vue système ; 12 et 14 en vue interface), vérifie qu'un refus ne
change pas le mode ni ne laisse sa ligne dans la configuration, et pointe
le curseur mot à mot sur douze refus.

**Une assertion vide de sens, corrigée** : le premier test de
`stp timer` cherchait `/Hello.*5/`, qui matche aussi
`Hello 2s MaxAge 20s FwDly 15s` — le `5` de `15s`. Il passait avec le
correctif désactivé. Il compare maintenant `Hello 5s` contre un témoin
mesuré dans le même laboratoire (`Hello 2s`, le défaut), sans quoi un
laboratoire mal monté et une commande sans effet seraient indiscernables.

Discrimination par `git stash` : **23 des 33 tombent** avant.

**Mesures.** 87 suites connexes vertes (1 254 cas), plus les scénarios
VRP ACL/STP, VLAN et L3. Typecheck : jeu d'erreurs identique avant/après
(184). Lint : 4 problèmes avant, 4 après — les deux fichiers de grammaire
n'en ajoutent aucun.

**Un test existant corrigé, et un seul** :
`huawei-queue-lue-jusquau-bout.test.ts` épinglait ces deux perméabilités
comme reliquat de V7 ; le reliquat étant fermé, le cas devient sa garde
et vérifie maintenant le refus.

---

## 18. V9 — Livré : le typage du shell, et ce qu'il cachait (agent « logging »)

`HuaweiVRPShell.ts` portait **61 `no-explicit-any`**. Un `as any` ne
coûte pas une ligne de lint : il éteint le compilateur sur tout ce qui
suit le point. Les retirer était donc moins un nettoyage qu'une mesure —
et la mesure a trouvé des choses.

### Ce qui n'était que du bruit (40 sur 61)

Le compilateur acceptait déjà la forme sans cast, et personne ne l'avait
vérifié depuis :

- `setMode('bfd-global' as any)` et ses huit jumeaux : `HuaweiShellMode`
  contient ces vues **depuis longtemps**.
- `this as any` passé aux cinq constructeurs OSPF : le shell satisfait
  `HuaweiOSPFShellContext` sans aide.
- `(entry as any).type` / `.iface` sur la table ARP : `ARPEntry` déclare
  les deux.
- `(port as any).resetCounters` derrière un `typeof === 'function'` :
  `Port.resetCounters()` existe. Le garde-fou testait une méthode qui ne
  peut pas manquer.

### Le défaut que le premier cachait

`HuaweiVRPShell.mode` était déclaré `HuaweiShellMode | string`. Ce
`| string` **annule l'union entière** : `getActiveTrie()` ne pouvait
plus refuser une faute de frappe, elle retombait sur
`default: return this.userTrie`, c'est-à-dire une vue muette au lieu
d'une erreur de compilation. Une seule vue manquait à l'union pour
justifier ce `| string` : `pim`. Elle y est, le `| string` est parti, et
une vue inconnue ne compile plus.

### La configuration morte, rendue visible

Onze champs étaient ÉCRITS par `(b as any).champ = …` sur les objets
BGP et IS-IS sans être déclarés nulle part — donc lus par personne, ici
comme ailleurs. Les déclarer ne les rend pas vivants ; cela rend la
chose **greppable**, ce qu'un `any` empêchait. C'est la catégorie que
`CLAUDE.md` suit déjà pour `importedRoutes` et `BGPEngine.redistribute`.

Deux de ces commandes n'écrivent même pas dans `rawLines`
(`maximum load-balancing`, `ipv4-family`/`ipv6-family` côté BGP) : elles
n'ont **aucun effet observable**, ce qui est un défaut distinct et plus
grave que le typage. Il reste ouvert, et il est maintenant nommé.

### Les huit magasins bricolés

Le shell range huit choses sur le `Router` sous des propriétés
`_huawei*` que `Router` ne déclare pas : pare-feu, plages horaires,
politiques CPU-defend, LLDP, profils de file, extras RIP/IS-IS/QoS par
interface. `shells/huawei/vrpShellStores.ts` les déclare, et fait la
conversion **une fois** au lieu de trente et une.

Le `r[bucket]` dynamique méritait mieux qu'un type : `bucket` était un
`string`, donc `ifAttr('_huaweiLdpIf')` aurait créé un neuvième magasin
en silence, que rien n'aurait jamais lu. Le paramètre est restreint aux
clés réelles ; la faute est devenue une erreur de compilation. La boucle
« créer si absent puis poser l'attribut », recopiée à cinq endroits, est
devenue une fonction.

### Trouvé en passant

- `let i = vridIdx + 1` jamais réassigné (`prefer-const`), antérieur.
- **Une régression du lot V7** : `rip ?` proposait `vpn-instance` **sans
  description**. La lecture de queue ajoutée par V7 met ce mot-clé dans
  le corps du handler, d'où `autoContinuations` l'extrait ; VRP, à la
  différence d'IOS, n'écarte pas un mot-clé sans description. Corrigé en
  le NOMMANT dans `CliKeywordDescriptions` — c'est un vrai mot-clé de
  VRP, le taire aurait été pire que le décrire.

### Hors périmètre

`HuaweiConfigCommands.ts` porte 39 `any` de la même famille — champs
non déclarés sur `Port` (`flowControl`, `urpfMode`, `ipv6Enabled`…) et
sur l'interface en attente (`tunnelSource`, `greKey`…), plus huit
`catch (e: any)`. Les traiter demande de décider où vivent les réglages
VRP d'un port, ce qui est la même question que ci-dessus posée sur un
autre objet : un lot à part. Seul `setMode('rip' as any)`, rendu inutile
par l'union réparée, a été retiré au passage.

---

## 19. V10 — Livré : le typage de `HuaweiSwitchShell`, et ce qu'il cachait

Le jumeau du §18 sur l'autre shell, et la mesure donne un profil
différent : `HuaweiSwitchShell.ts` (3 654 lignes) ne portait **qu'un seul
`no-explicit-any`** — il était déjà propre de ce côté — mais **37
`as unknown as`**, qui éteignent le compilateur exactement de la même
façon **sans coûter une ligne de lint**. C'est le point du lot : le
linter ne les voyait pas, donc personne ne les avait comptés.

### 19.1 Quatorze fois la même affirmation

Les accesseurs d'agents (STP, LLDP, Dot1x, LACP, IGMP/PIM snooping,
debug) étaient castés **quatorze fois**, chacun réécrivant son
`import(...)` en ligne. Le cast était légitime dans son principe —
`swRef` est un `Switch`, ces agents vivent sur `HuaweiSwitch`, et un
`GenericSwitch` n'en a aucun, ce que `CLAUDE.md` documente. Ce qui ne
l'était pas, c'est de l'affirmer quatorze fois : chaque site pouvait
écrire une signature différente de celle du voisin sans que rien ne le
signale.

`huawei/huaweiSwitchDevice.ts` déclare **ce que le shell exige de son
équipement**, une fois. Les membres y sont optionnels parce qu'ils le
sont réellement — et c'est cette honnêteté qui a rendu le défaut suivant
visible.

### 19.2 Un membre que le cast affirmait et que personne ne fournit

`_setVtyTransportInput` est appelé par les deux shells Huawei sous un
commentaire affirmant qu'il « route through the device setter so
`CrossVendorSshHost.evaluate()` sees the change ». Il vit sur `Router`.
**Un `Switch` ne l'a pas** — et n'a ni serveur SSH ni politique de vty à
gouverner. `protocol inbound ssh` sur un switch Huawei est donc inerte,
et l'était en silence.

Le port le déclare optionnel : la commande reste acceptée, comme sur
VRP, et son inertie est écrite plutôt que masquée. **Le routeur a le
même appel** ; là-bas le membre existe, donc il fonctionne — c'est
seulement le cast qui y est du bruit.

### 19.3 La configuration de vue VLAN se perdait

Le défaut le plus concret, et il n'aurait pas été trouvé sans retirer
les casts. Six sites écrivaient
`(v as unknown as { extras }).extras` sur l'entrée VLAN —
`igmp-snooping`, `undo igmp-snooping`, `mux-vlan`, `vlan-type`,
`mac-vlan`, `ip`, `arp` — et **rien ne lisait jamais ce magasin**.

Ces lignes étaient donc absentes de `display current-configuration`,
c'est-à-dire perdues au rechargement d'une topologie. Le magasin est
déclaré dans le port (une conversion au lieu de six) **et il est rendu**,
sous son VLAN, ce qui était sa seule raison d'exister.

### 19.4 Un cast qui annulait l'union des vues

L'union `VRPSwitchMode` est complète (treize vues, treize cas dans
`getActiveTrie()`) — mais deux casts la neutralisaient :
`setMode: (m) => { this.mode = m as VRPSwitchMode }` pour les aides
partagées, et `this.mode = s.mode as VRPSwitchMode` à la restauration de
session. Les aides partagées sont écrites pour le **routeur** et
connaissent une trentaine de vues que le switch n'a pas ; l'une d'elles
posée ici tombait sur `default:` et rendait le shell **muet**, sans un
mot.

Une vue que cette plateforme n'a pas ne change plus la vue courante.
C'est la même forme que le `| string` du §18, sauf qu'ici l'union était
juste et que c'est le cast qui la défaisait.

### 19.5 Refusé, et pourquoi

**`description` et `step` de la vue ACL restent morts.** Écrits, lus par
personne, ici comme ailleurs. Les déclarer sur le type de la table ne les
rend pas vivants ; cela les rend **greppables**, ce qu'un cast empêche —
c'est la règle du §18 pour les onze champs BGP/IS-IS, et un test empêche
qu'un cast les rende invisibles à nouveau.

**Deux constats mesurés en passant, et laissés ouverts** parce qu'ils ne
relèvent pas du typage : `display interface Vlanif 10` (forme séparée)
est refusé alors que `interface Vlanif 10` est accepté — deux résolveurs
de nom pour un seul objet ; et `display interface vlanif10` rend
`vlanif10` en minuscules au lieu du `Vlanif10` canonique, la règle « un
port a un seul nom » du lot V3 n'ayant pas atteint cette vue.

### 19.6 Tests et mesures

Le typage lui-même est gardé par le **compilateur**, pas par un test :
`huawei-switch-typage.test.ts` (12 cas) vérifie les trois conséquences
réelles — la configuration VLAN qui revient et se range sous son VLAN, la
vue du routeur qui ne rend plus le shell muet, `protocol inbound` dont
l'inertie est désormais écrite — plus deux cliquets de source (aucun
`as unknown as` ni `as any` ne subsiste ; les magasins morts restent
déclarés).

**Une assertion qui ne discriminait rien, corrigée** : le cas « une vue
du routeur ne devient pas la vue du switch » s'appuyait d'abord sur
l'invite et sur le refus d'une commande inconnue — or les deux sont
IDENTIQUES avant et après, la vue inconnue retombant sur la trie
utilisateur. Il passait avec le correctif désactivé. Il s'appuie
maintenant sur le nom de vue retenu, qui est ce qui diffère réellement.

Discrimination par `git stash` : **6 des 12 tombent** avant.

**Mesures.** 88 suites connexes vertes (1 266 cas). `as unknown as` :
**37 → 0** ; `as any` : 1 → 0. Typecheck : jeu d'erreurs identique
avant/après (185). Lint sur les deux fichiers : **0 erreur, 0
avertissement**. Aucun test existant modifié.

---

## 20. V11 — Livré : deux vues d'un même port en disent la même chose

Les deux constats que §19 avait laissés ouverts. La mesure a montré
qu'ils n'étaient pas isolés mais deux facettes d'une seule règle — celle
que le lot V3 avait posée (« un port a un seul nom ») et qui n'avait pas
atteint ces vues.

### 20.1 Le constat : la même machine, le même instant, deux réponses

```
display interface LoopBack0                -> LoopBack0 current state : UP
display ip interface LoopBack0             -> LoopBack0 current state : DOWN

display interface GigabitEthernet0/0/0     -> GigabitEthernet0/0/0 current state : DOWN
display ip interface GigabitEthernet0/0/0  -> GE0/0/0 current state : DOWN

display interface LoopBack0                -> Internet Address is 1.1.1.1/255.255.255.255
display ip interface LoopBack0             -> Internet Address is 1.1.1.1/32
```

Un port **UP dans une vue et DOWN dans l'autre**. Le nom interne court
(`GE0/0/0`) rendu là où toutes les autres vues écrivent le nom complet.
Et le masque écrit de deux façons.

Chaque vue avait une moitié juste : `display interface` était passée au
lot V3 (nom canonique, prédicat d'état partagé) mais gardait le masque
pointé ; `display ip interface` avait le masque de VRP et **recalculait
l'état à sa façon** — la « sixième façon de calculer l'état » que le
commentaire de V3 nommait, toujours vivante ici.

### 20.2 Et les deux plateformes n'acceptaient pas les mêmes écritures

Trois résolveurs de nom coexistaient : celui du routeur
(`resolveHuaweiInterfaceName`), et **deux** sur le switch —
`resolveInterfaceName`, aveugle aux SVI et aux LoopBack, et
`resolveL3InterfaceName`, qui ne connaissait qu'elles et refusait toute
abréviation. D'où, mesuré :

| Écriture | Routeur | Switch |
|---|---|---|
| `display interface GigabitEthernet 0/0/1` | **refusé** | accepté |
| `display interface loop0` | accepté | **refusé** |
| `display interface Vlanif 10` | — | **refusé** (alors que `LoopBack 0` passe) |
| `display interface vlanif10` | — | rend **`vlanif10`**, le nom tel que tapé |
| `display ip interface <port physique>` | accepté | **refusé** |

Le `vlanif10` vient d'un repli : `resolveInterfaceName(x) || x`. Quand la
résolution échouait, la **saisie** servait de nom — donc la casse de
l'opérateur, et un refus seulement plus loin, quand `getPort()` ne
trouvait rien.

### 20.3 Le correctif : un résolveur, un nom, un état

**Un résolveur.** `resolveHuaweiInterfaceName` collapse désormais les
espaces — la forme séparée est une **forme** de VRP, pas une abréviation,
et le switch la collapsait déjà dans sa copie. Le switch n'a plus de
résolveur propre : il appelle le partagé sur la liste de ses interfaces,
virtuelles comprises, et `resolveL3InterfaceName` n'est plus qu'un filtre
de type au-dessus. Les trois désaccords tombent ensemble.

**Un nom.** Le repli `|| ifName` est supprimé : un nom qui ne se résout
pas est **refusé**, il ne devient pas un nom. Un nom qui se résout est
rendu par `huaweiDisplayInterfaceName`, comme partout ailleurs.

**Un état.** `display ip interface` lit `iosInterfaceStatus`, le prédicat
unique que V3 avait posé — d'où le LoopBack UP des deux côtés. Et les
deux vues rendent le masque en longueur de préfixe, qui est la forme de
VRP.

**Une divergence de plateforme fermée au passage** : `display ip
interface <port physique>` répondait sur le routeur et était refusé sur
le switch. Un port sans adresse n'est pas une erreur, c'est un port sans
adresse ; le switch le rend maintenant avec le même prédicat d'état et
`Internet protocol processing : disabled`.

### 20.4 Tests et mesures

`huawei-un-port-une-verite.test.ts` (10 cas). Sa forme suit le constat :
il **compare les vues entre elles** et les plateformes entre elles,
plutôt que chacune contre une attente écrite à la main — une attente
écrite à la main peut recopier la mauvaise réponse, une comparaison ne le
peut pas. Cinq écritures par nom, deux vues, deux plateformes, plus le
cliquet « le nom court interne ne sort jamais à l'écran » et « un refus
ne rend jamais la saisie comme si elle était un nom ».

Discrimination par `git stash` : **9 des 10 tombent** avant.

**Mesures.** 88 suites connexes vertes (1 266 cas), plus les suites
d'interface, de parité et de routage inter-VLAN. Typecheck : jeu
d'erreurs identique avant/après (187). Lint sur les trois fichiers : 37
problèmes avant, 37 après. Aucun test existant modifié.

---

## 21. V12 — Livré : `display ip interface brief`, un tableau pour deux plateformes

### 21.1 Ce que la mesure a trouvé

Le routeur et le commutateur rendaient **le même tableau chacun de son
côté**, avec des littéraux séparés. Quatre désaccords, mesurés sur deux
machines neuves portant les mêmes interfaces :

| | Routeur | Switch |
|---|---|---|
| Bloc de compteurs (`The number of interface that is UP…`) | présent | **absent** |
| Largeur de la colonne `Interface` | 34 | **28** |
| Protocole d'un LoopBack | `up` | `up(s)` |
| `display ip interface brief <nom>` | argument **ignoré**, tout le tableau | **refusé** |

Le troisième est le plus instructif : **la légende est la
spécification**. Les deux plateformes impriment `(s): spoofing` en tête,
et le protocole d'une interface de bouclage EST spoofé. C'est donc le
commutateur qui avait raison et le routeur qui contredisait sa propre
légende, pour le même type d'objet.

Le quatrième est le défaut de fond : l'argument était **lu puis jeté** —
`display ip interface brief GigabitEthernet0/0/0` rendait tout le
tableau, et un nom qui n'existe pas aussi. Un opérateur qui filtre et
obtient tout ne peut pas savoir que son filtre n'a pas été lu.

### 21.2 Le correctif, et une reprise plutôt qu'une copie

La cause de la divergence de largeur est celle que l'autre agent venait
de fermer ailleurs (`cli/TextTable.ts`, « un tableau se déclare, il ne se
dessine plus à la main ») : en-tête littéral d'un côté,
`padEnd(34)/(21)/(11)` de l'autre, rien qui relie les deux.
`huawei/huaweiTableLayouts.ts` **reprend ce module** — sur le modèle de
leur `ciscoTableLayouts.ts`, et non à côté — et porte les colonnes VRP,
la légende, le marqueur `(s)` et le bloc de compteurs. Les deux
plateformes appellent la même fonction ; une divergence de mise en page
n'est plus possible, elle est devenue impossible à écrire.

Le filtre est résolu par le résolveur unifié du lot V11, donc toute
écriture légitime du nom fait le même filtre (`gi0/0/0`,
`GigabitEthernet 0/0/0`, `vlanif10`) et un nom qui n'existe pas est
refusé au lieu d'être ignoré.

**Trouvé en passant** : le commutateur calculait l'état de ses lignes
d'une **septième** façon, à la main, au lieu de lire le prédicat partagé.
Il rend maintenant les mêmes valeurs que sa propre vue de détail, ce
qu'un cas du fichier de test vérifie en comparant les deux.

### 21.3 Refusé, et pourquoi

**`(l): loopback` reste annoncé et jamais posé.** La légende le déclare
sur les deux plateformes, et aucune ne marque quoi que ce soit avec. Je
ne sais pas où un vrai VRP le pose — sur le nom, sur le protocole, ou
seulement dans certaines versions — et §0 interdit de le deviner : un
marqueur inventé au mauvais endroit serait un mensonge de plus, pas un
progrès. Le constat est écrit ici et la légende reste telle quelle,
puisque c'est elle que les deux machines impriment aujourd'hui.

**Les compteurs comptent le tableau rendu, filtre compris.** Filtrer sur
une interface donne `UP … is 0 / DOWN … is 1` plutôt que le compte de
toute la machine. C'est cohérent avec ce que la vue montre ; je n'ai pas
de mesure d'un vrai VRP pour trancher l'autre lecture, et un test le fixe
pour que le choix soit su.

### 21.4 Tests et mesures

`huawei-ip-interface-brief.test.ts` (13 cas). Sa propriété centrale
compare **les deux plateformes entre elles** — même en-tête, mêmes bords
de colonnes — plutôt que chacune contre une maquette recopiée à la main,
qui aurait pu recopier la mauvaise. Un cas mesure en plus que **chaque
champ de données commence à un bord de colonne**, ce qui vérifie le
calage plutôt qu'un alignement obtenu par hasard ; un autre que les
compteurs comptent bien les lignes rendues ; un dernier que la vue brève
et la vue de détail donnent la même adresse et le même état.

Discrimination par `git stash` : **8 des 13 tombent** avant.

**Mesures.** 89 suites connexes vertes (1 276 cas), plus les scénarios de
hiérarchie de vues, telnet et L3. Typecheck : jeu d'erreurs identique
avant/après (192). Lint sur les fichiers touchés : 37 problèmes avant, 37
après — le nouveau module n'en ajoute aucun. Aucun test existant modifié.

---

## 22. V13 — Livré : la famille « brief » des interfaces

Même règle que §21, appliquée aux vues sœurs — et la mesure a montré que
`display interface brief` n'était pas seule : `display interface
description`, sa jumelle, portait les mêmes désaccords **plus un**, celui
de ne pas exister du tout sur le commutateur.

### 22.1 Sept désaccords pour deux commandes

Deux machines neuves portant le **même** état — un port décrit, un port
fermé par l'opérateur, une LoopBack :

| | Routeur | Switch |
|---|---|---|
| Légende (`PHY: Physical   *down: …`) | présente | **absente** |
| Colonnes `inErrors` / `outErrors` | présentes | **absentes** |
| Largeurs | 28/6/10 | **30/8/10** |
| `*down` sur un port fermé | posé | **jamais** |
| `PHY` et `Protocol` | calculées séparément | **la même expression** |
| Interfaces virtuelles listées | oui (LoopBack) | **non** |
| `display interface brief <nom>` | argument **ignoré** | **refusé** |
| `display interface description` | rendue | **inexistante** |

Trois de ces lignes ne sont pas de la mise en page. **`*down` n'existait
pas sur le commutateur** : un port que l'opérateur a fermé s'y montrait
`down`, exactement comme un port sans câble — la distinction que la
légende absente sert précisément à expliquer. Ses deux colonnes d'état
étaient **la même expression**, donc structurellement incapables de
différer. Et une LoopBack créée sur le commutateur était **invisible** de
sa propre vue brève, alors que sa vue `display ip interface brief` la
liste.

C'était une **huitième** façon de calculer l'état d'une interface dans ce
dépôt, écrite à la main à côté du prédicat partagé.

### 22.2 Le correctif

Les colonnes rejoignent `huawei/huaweiTableLayouts.ts`, à côté de celles
du lot V12. Les largeurs retenues sont **celles du routeur**, parce
qu'elles ne sont pas un choix : la sonde d'alignement de l'autre agent
(`probe-alignement-tableaux-cli.test.ts`) les fixe au caractère près
contre une sortie de vraie machine. Le commutateur les adopte, lit le
prédicat partagé, liste ses interfaces virtuelles, et gagne
`display interface description`, qu'il n'avait pas alors qu'il stocke les
descriptions depuis toujours.

Le filtre par interface passe par le résolveur unifié du lot V11 : toute
écriture légitime du nom fait le même filtre, un nom inconnu est refusé
au lieu de rendre tout le tableau.

### 22.3 Ce qui n'a délibérément PAS été propagé

**Le marqueur `(s)` reste hors de cette vue.** Le lot V12 l'a posé sur le
protocole d'un LoopBack dans `display ip interface brief`, parce que la
légende de CETTE vue-là déclare `(s): spoofing`. La légende de
`display interface brief` ne déclare que `PHY:` et `*down:` — donc `up`
y est juste, et y ajouter `(s)` par symétrie aurait été inventer.

C'est la même discipline que §21 : la légende est la spécification, et
elle n'est pas la même d'une vue à l'autre.

### 22.4 Tests et mesures

`huawei-interface-brief-famille.test.ts` (13 cas). Comme au lot
précédent, il compare **les deux plateformes entre elles** — même
légende, même en-tête, même comportement du filtre — et vérifie en plus
que la vue brève et la vue de détail s'accordent sur l'état du même port,
ce qui est la propriété que la huitième implémentation cassait.

Discrimination par `git stash` : **12 des 13 tombent** avant.

**Mesures.** 91 suites connexes vertes (1 471 cas), dont la sonde
d'alignement de l'autre agent, qui reste verte — la mise en page du
routeur est inchangée, c'est le commutateur qui l'a rejointe. Typecheck :
jeu d'erreurs identique avant/après (192). Lint : 37 problèmes avant, 37
après. Aucun test existant modifié.

---

## 23. V14 — Livré : une adresse MAC s'écrit comme VRP l'écrit

### 23.1 Le constat : trois champs collés

Trouvé en poursuivant la famille des tableaux, avec de vraies entrées
plutôt qu'un lab vide — c'est ce qui l'a rendu visible, un tableau sans
données ne débordant jamais :

```
[switch] display arp
IP ADDRESS      MAC ADDRESS    EXPIRE(M) TYPE   INTERFACE
10.0.10.2       02:00:00:00:00:1120        dynamicGigabitEthernet0/0/1

[switch] display mac-address
MAC Address    VLAN/VSI   Learned-From   Type
02:00:00:00:00:1110         GigabitEthernet0/0/1dynamic
```

On ne peut plus distinguer la MAC de son délai d'expiration, ni le port
du type. **La ligne est illisible**, et c'est la ligne que tout exercice
d'ARP fait afficher.

### 23.2 La cause, et ce qui la prouve sans référence extérieure

Les colonnes sont taillées pour une MAC de **quatorze** caractères —
comme le reste de ces tableaux, qui reproduit VRP (`EXPIRE(M)`,
`VPN-INSTANCE`, le pied `Total: 1  Dynamic: 1  Static: 0`) — et le rendu
en produisait **dix-sept**, au format IEEE `xx:xx:xx:xx:xx:xx`.

Ce qui rend le diagnostic certain **sans connaître VRP** : la machine
ACCEPTAIT déjà l'écriture à tirets. `arp static 192.168.1.50
aaaa-bbbb-cccc` est une commande que ce simulateur prend depuis toujours,
et que sa propre configuration rendue réécrit à l'identique — mais que sa
propre vue affichait `aa:aa:bb:bb:cc:cc`. **Elle lisait une écriture
qu'elle n'imprimait jamais.** C'est cette contradiction interne que la
suite vérifie, plutôt que le format en lui-même.

Ce qui relève de ma connaissance du constructeur, et qui est dit ici
plutôt que confondu avec le reste : que la bonne écriture soit
`0200-0000-0011`. Les deux raisonnements mènent au même correctif —
l'un parce que la table est cassée telle quelle, l'autre parce que VRP
écrit ainsi.

### 23.3 Deux colonnes trop étroites, trouvées avec

Le format seul ne suffisait pas : la colonne `TYPE` du commutateur
faisait **sept** caractères, soit exactement la longueur de `dynamic`,
donc la valeur remplissait sa colonne et se collait au nom d'interface ;
et `Learned-From` en faisait **quinze** pour un nom qui en fait vingt.
Les deux tables rejoignent `huaweiTableLayouts.ts`, où la largeur est
déclarée avec l'en-tête au lieu d'être comptée à côté.

**Trouvé avec** : `display arp` du routeur rendait `GE0/0/0`, le nom
court interne. La règle « un port a un seul nom » des lots V3 et V11
n'avait pas atteint cette vue non plus.

### 23.4 Tests et mesures

`huawei-adresse-mac.test.ts` (10 cas). Sa propriété centrale est le
**round-trip** — ce que la machine lit est ce qu'elle rend — parce
qu'elle se vérifie sans référence extérieure. Le reste balaie les six
vues qui impriment une MAC sur les deux plateformes, vérifie que chaque
champ commence à un bord de colonne, et pose le cas le plus direct :
**deux champs voisins ne se touchent jamais**, qui est la forme même du
défaut.

Discrimination par `git stash` : **8 des 10 tombent** avant.

**Mesures.** 91 suites connexes vertes (1 299 cas), dont les suites ARP
et table MAC. Typecheck : jeu d'erreurs identique avant/après (192).
Lint : 37 problèmes avant, **36 après**. Aucun test existant modifié.

---

## 24. V15 — Livré : VRRP, un magasin, une grammaire, une vue

### 24.1 Le constat, mesuré

La même configuration VRRP, tapée mot pour mot sur les deux plateformes,
donnait deux réponses qui n'avaient **rien en commun** :

```
routeur                             commutateur
GE0/0/0 | Virtual Router 1          Vlanif10 | Virtual Router 1
    State : Initialize                State : Initialize
    Virtual IP : 10.0.12.254          Virtual IP : 10.0.10.254
    Priority : 120                    Virtual MAC : 00:00:5e:00:01:01
    Advertisement timer : 1 seconds   PriorityRun : 90
    Preempt mode : Yes (delay 5s)     PriorityConfig : 120
    Authentication : none             Preempt : YES
```

Ni les champs, ni l'indentation, ni le nom de l'interface, ni l'écriture
de la MAC. Mais **le désaccord n'était pas d'affichage** : regarder les
deux priorités suffit à le voir. Pour la même commande
`vrrp vrid 1 track interface GigabitEthernet0/0/1 reduced 30`, le
commutateur descend à 90 et le routeur reste à 120.

**Cause : deux magasins pour un fait.** Le commutateur écrit dans
l'agent VRRP réel (`VrrpAgent`, qui porte l'état, l'élection et les
pistes) ; le routeur écrivait dans une **façade** séparée
(`HuaweiVrrpService`) que ses vues relisaient, et n'informait l'agent que
pour quatre champs sur huit — le `track` n'en faisait pas partie. Sur un
routeur, l'interface suivie pouvait donc tomber sans que rien ne bouge :
c'est exactement ce que la commande existe pour faire.

Dix autres constats, tous mesurés sur machine neuve :

1. **Le routeur ne validait rien.** `vrrp vrid 999`, `vrrp vrid 0`,
   `priority 300`, `priority 0`, `virtual-ip pas-une-ip`,
   `timer advertise 0` : tous acceptés en silence, puis rendus dans les
   vues et dans la configuration. Le commutateur refusait les six.
2. **Une faute de frappe devenait une ligne de configuration.**
   `vrrp vrid 1 zzz` tombait dans un tampon `rawLines` et ressortait
   telle quelle de `display current-configuration interface …` — donc
   **rejouée à l'import d'une topologie** (règle 3 du §0).
3. **La configuration se perdait, chacun dans un sens.** Le
   `display current-configuration` COMPLET du routeur ne rendait **aucune**
   ligne `vrrp`, alors que sa vue par interface les rendait toutes ; le
   commutateur faisait exactement l'inverse. Deux constructeurs de lignes
   par plateforme, quatre en tout, se contredisant deux à deux.
4. **`display vrrp interface GigabitEthernet0/0/0`** du routeur répondait
   `Info: No VRRP group on …` pour l'interface qui porte le groupe : le
   filtre comparait au nom court interne sans le résoudre.
5. Le routeur écrivait `GE0/0/0` dans `display vrrp`, `display vrrp
   brief`, `display vrrp statistics` **et dans son
   `display current-configuration interface …`** — la règle « un port a
   un seul nom » des lots V3 et V11 n'avait atteint aucune des quatre.
6. **Le `display vrrp` du commutateur avalait ses propres
   sous-commandes** : `display vrrp statistics` et `display vrrp verbose`
   y rendaient le bloc de `display vrrp`. Enregistré en greedy, il
   consommait tout ce qui suivait.
7. Le commutateur imprimait la MAC virtuelle au format IEEE
   (`00:00:5e:00:01:01`) — la règle du lot V14 — et le routeur n'en
   imprimait **aucune**.
8. Le commutateur acceptait `description`, `authentication-mode` et le
   délai de `preempt-mode timer delay` et **les perdait** : son `switch`
   n'avait pas de branche pour eux, et l'agent pas de champ.
9. Le couple `PriorityRun`/`PriorityConfig` n'était rendu par le
   commutateur que lorsque les deux valeurs DIFFÉRAIENT : sans piste on
   ne voyait qu'une ligne `Priority`, donc rien ne distinguait « pas de
   piste » de « piste qui n'a pas joué ».
10. **`admin-vrrp vrid <n>`** rangeait un numéro dans la façade et
    **personne ne le relisait** : ni vue, ni configuration, ni moteur.

### 24.2 Ce qui est fait

**Un magasin.** L'agent (`VrrpAgent`) devient le seul. `VrrpGroupRuntime`
reçoit les trois champs de configuration qui lui manquaient
(`preemptDelaySec`, `description`, `authMode`/`authKey`), et
`HuaweiVrrpService` est **supprimé** — après le retrait de ses lectures,
il ne lui restait qu'un écrivain et zéro lecteur, ce qui est le défaut
que ce lot ferme.

**Une grammaire.** `analyserVrrp` (`huawei/huaweiVrrpViews.ts`) analyse
les mots qui suivent `vrrp` et **valide** : `vrid` 1-255, `priority`
1-254 (255 est réservé au propriétaire de l'adresse et 0 à la
renonciation, RFC 3768 §6.1), adresse virtuelle réellement valide,
`timer advertise` 1-255, mot inconnu refusé. Les deux plateformes
n'enregistrent pas la commande au même endroit de l'arbre — `vrrp` côté
routeur, `vrrp vrid` côté commutateur — et c'est l'appelant qui
recompose, pour que la grammaire n'ait qu'une forme. Les refus passent
par `ErreurGrammaireVrp`/`rendreErreurVrp` (lot V7), donc le curseur
désigne le mot fautif et non le premier venu.

**Une vue.** `rendreDisplayVrrp`, `rendreDisplayVrrpBrief`,
`rendreDisplayVrrpStatistics` et `lignesConfigVrrp` sont appelées par les
deux plateformes. `display vrrp brief` passe par le `TextTable` de
l'autre agent et porte son bloc de comptage des deux côtés — le même
défaut que le lot V12 avait fermé sur `display ip interface brief`.
`lignesConfigVrrp` est branché dans `renderHuaweiInterfaceExtras`, que
les **deux** rendus de configuration du routeur traversent déjà : le
désaccord devient impossible plutôt que rattrapé.

### 24.3 Mesure et connaissance du constructeur, tenues séparées

Tout le §24.1 est **mesuré**. Que le bloc de VRP porte `PriorityRun` et
`PriorityConfig` côte à côte, `TimerRun`/`TimerConfig`, `Auth type`,
`Check TTL`, `Config type`, une piste nommée (`Track IF :
GigabitEthernet0/0/3   Priority reduced : 80`) suivie de son état sur la
ligne d'après, et une MAC en `0000-5e00-0101`, relève de la
**connaissance du constructeur** et non d'une capture. La suite ne
vérifie donc jamais ce bloc contre une maquette : elle vérifie que les
deux plateformes rendent **le même**, ce qui se contrôle sans connaître
VRP.

### 24.4 Ce qui est porté sans être agi, et pourquoi c'est écrit

`preempt-mode timer delay` et `authentication-mode` sont rangés, rendus
et rejoués, mais **le moteur ne diffère aucune prise de rôle et
n'authentifie rien**. C'était déjà le cas côté routeur ; ce lot leur
donne un seul magasin au lieu de les **perdre** côté commutateur, ce qui
est un progrès et non une décoration. Les faire agir est un travail de
protocole, pas de CLI, et reste ouvert.

Les compteurs de `display vrrp statistics` sont à zéro, et c'est un
**fait** plutôt qu'un manque : rien dans cet agent ne compte les annonces
émises ou reçues. Ce qui est réellement compté — le nombre de pistes —
l'est depuis l'agent.

`admin-vrrp vrid` est désormais **refusé en nommant la brique absente**
(`mVRRP is not implemented in this simulator`) : ce simulateur n'a pas de
VRRP administratif, aucun groupe membre ne peut s'y lier, et une
acceptation sans effet vaut moins qu'un refus qui dit pourquoi — même
arbitrage que `test-type` sur NQA.

### 24.5 Tests et mesures

`huawei-vrrp-un-magasin.test.ts` (20 cas). Comme les lots V11 à V14, il
compare les deux plateformes **entre elles** pour le même objet ; son cas
le plus fort n'est pas d'affichage mais fonctionnel — *une piste tombée
baisse la priorité du routeur aussi*. Il vérifie aussi que la
configuration rendue **se relit** : rejouée sur une machine qui porte
déjà la même configuration, chaque ligne est acceptée et le
`display vrrp` final est identique au caractère près.

Discrimination par `git stash` : **17 des 20 tombent** avant. Les 3 qui
passent des deux côtés portent sur le module de grammaire lui-même,
lequel n'existait pas — ils ne peuvent donc rien discriminer et sont là
comme garde-fou.

**Trois tests existants portaient une hypothèse fausse** et sont
corrigés, jamais le code :

| Fichier | Ce qu'il fixait | Pourquoi c'était faux |
|---|---|---|
| `switch-vrrp.test.ts` | `Virtual MAC : 00:00:5e:00:01:01` sur une machine **VRP** | VRP écrit en trois groupes de quatre (lot V14) ; le cas Cisco du même fichier garde sa forme IEEE, qui est celle d'IOS, et le cache ARP du PC aussi |
| `switch-fhrp-track.test.ts` | `Track IF : 1` puis une ligne à la mise en page propre à ce simulateur | VRP nomme l'interface suivie au lieu d'en donner le **compte** |
| `huawei-parity.test.ts` (2 cas) | `interface GE0/0/0` dans un bloc de **configuration** | Le nom court interne (lots V3/V11) ; la configuration complète de la même machine rendait déjà le nom canonique. L'abréviation reste acceptée en **entrée**, ce que ces cas vérifient toujours |

**Mesures.** 131 suites connexes vertes (2 224 cas) — famille FHRP
complète (14 suites, 133 cas), toutes les suites `huawei-*`, les sondes
et les exigences. Un échec, `probe-debug-02-collecte.test.ts` (SPAN),
**préexistant et sans rapport** : vérifié identique sur `HEAD` par
`git stash`. Typecheck : jeu d'erreurs identique avant/après (212).
Lint : **172 problèmes avant, 172 après**.
