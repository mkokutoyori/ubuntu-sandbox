# Vérifier un mot de passe, et libérer la console

Deux bugs signalés depuis l'usage :

1. « Quand j'active un enable password, je n'arrive plus à passer en mode
   priv exec. »
2. « Quand j'active un enable password/secret, je n'arrive plus à passer
   en mode user, l'`exit` depuis `#` ferme le terminal directement. »

Ils n'en font qu'un et demi : le premier est une **famille entière**, le
second la conséquence d'un comportement par ailleurs juste.

---

## 1. Le mot de passe était comparé à la FORME STOCKÉE

`enableInteractionPlan` (`CiscoShellBase.ts`) faisait
`value === gate.value`. C'est juste tant que la forme conservée est le
texte en clair, et faux dès qu'elle ne l'est plus. **Trois gestes très
ordinaires suffisent**, et dans chacun la machine refuse le BON mot de
passe pour toujours :

| Geste | Ce qui est rangé |
|---|---|
| `service password-encryption` après un `enable password` | `062B0035484B19181604175A` (type 7) |
| `enable password 7 <chiffre>` collé d'une configuration | le chiffre |
| **Sauvegarder puis rouvrir la topologie** | `$1$a38effcc$3fSShOKFha.TXFAu34YEB/` |

Le troisième est le plus coûteux, parce qu'il frappe une machine que
**personne n'a mal configurée**. `show running-config` REND le condensé —
c'est son rôle, IOS ne réaffiche jamais un mot de passe en clair — et
l'import de topologie rejoue cette configuration. Mesuré :

```
enable secret MonSecret1
→ rendu   : enable secret 5 $1$a38effcc$3fSShOKFha.TXFAu34YEB/
→ rejoué  : {"value":"$1$a38effcc$3fSShOKFha.TXFAu34YEB/","algo":"md5"}
```

Donc **un secret posé en clair devient un condensé à la première
sauvegarde**, et la machine rouverte refuse le mot de passe que
l'apprenant vient de choisir.

### La règle, et elle n'était écrite qu'une fois dans tout le dépôt

Un condensé se **VÉRIFIE** en recalculant avec son propre sel ; un chiffre
réversible se **DÉCHIFFRE**. Le type 7 est un chiffre de Vigenère à clé
fixe — c'est précisément pourquoi Cisco le documente comme un
obscurcissement et non comme une sécurité.

`NetworkOsAccount.authenticate` appliquait déjà exactement cette règle
côté Huawei, et son commentaire l'énonce mot pour mot (« un compte
rechargé depuis une configuration n'ouvre plus »). Le côté Cisco ne
l'avait nulle part. `shells/cisco/ciscoPasswordVerify.ts` est le pendant
lecture de `ciscoPasswordRender.ts`, qui existait seul depuis toujours.

Le choix se fait sur le **PRÉFIXE de la valeur** et non sur l'étiquette
d'algorithme, exactement comme `cryptPrefixType` côté rendu : c'est la
valeur qui dit ce qu'elle est, et une étiquette qui la contredirait (un
`$9$` rangé sous `enable secret 5`) ne doit pas décider à sa place.

### Les six portes qui comparaient par égalité

Fixer `enable` seul aurait laissé les cinq autres cassées de la même
façon :

| Porte | Fichier |
|---|---|
| `enable` (les deux plateformes) | `CiscoShellBase.enableInteractionPlan` |
| Connexion console (`login` + `password`) | `CiscoTerminalSession.buildLinePasswordLoginSteps` |
| Connexion telnet vers une vty | `RouterTelnetServerContext.authenticate` |
| AAA, méthodes `enable` et `line` | `AaaAuthenticator.tryLocalMethods` |
| `ip http authentication enable` | `Router.authenticateHttp` |
| **`login local` — le compte local** | `NetworkOsAccount.authenticate` |

La dernière est venue de l'audit qui a suivi le correctif, et c'est la
porte que les cours font poser **juste après** `enable`. Elle était
d'autant plus frappante que ce fichier appliquait **déjà** la règle côté
Huawei, son commentaire l'énonçant mot pour mot ; seul le côté Cisco
retombait sur l'égalité. Mesuré :

```
username admin privilege 15 secret Admin@2025
  authenticate('admin','Admin@2025')  → true
  … rendu : username admin privilege 15 secret 5 $1$c40d53d7$BcMGxv…
  … après rejeu de cette ligne        → FALSE

username carl password Carlsecret1 + service password-encryption
  authenticate('carl','Carlsecret1')  → FALSE
```

Le second ne demande **même pas un rechargement** : la même machine, au
même instant, refuse le mot de passe qu'on vient de lui donner. C'est le
jumeau exact du bug signalé, sur l'autre porte. Le témoin qui rend la
mesure lisible est `username bob password Bobsecret1` sans chiffrement,
qui traverse l'aller-retour intact (`password 0 Bobsecret1`) — sans lui,
« l'authentification échoue » ne distinguerait pas un défaut de
vérification d'un laboratoire mal monté.

### Deux défauts trouvés en chemin, dans l'analyseur du mot de passe de ligne

`update.linePassword = args.slice(1).join(' ') || args[0]` retirait le
chiffre de type **INCONDITIONNELLEMENT** :

- `password mon mot` rangeait `mot` — le premier mot du mot de passe
  disparaissait en silence ;
- `password 7 <chiffre>` rangeait le chiffre **comme s'il était le texte
  en clair**, sans garder l'algorithme — donc le rendu le **rechiffrait
  une seconde fois** dès que `service password-encryption` était actif,
  produisant une chaîne que plus personne ne savait déchiffrer.

`VtyLineConfig.linePasswordAlgo` manquait et porte désormais la forme.

---

## 2. `exit` depuis `#` fermait l'onglet

Terminer la session **est** le vrai comportement d'IOS, il reste vérifié
par `cisco-exec-mode-transitions.test.ts`, et ce n'est pas ce qu'il
fallait changer. Ce qui manquait est ce qu'une vraie machine fait
**ENSUITE** : la console est une ligne soudée, pas une connexion. Elle
annonce et attend.

```
R1#exit

R1 con0 is now available

Press RETURN to get started.

```

Formulation vérifiée sur des transcriptions réelles, pas écrite de
mémoire. Ici l'onglet **disparaissait**, donc `exit` — le geste qu'on
apprend pour quitter le mode privilégié — coupait l'accès à la machine
entière et il fallait rouvrir un terminal.

`CLITerminalSession.endExecSession()` remplace l'appel direct à
`_onRequestClose`. La fermeture reste juste pour une session **enfant**
(un `ssh`/`telnet` ouvert depuis un autre terminal) : là, la session EST
la connexion. `consoleReleasedBanner()` rend `null` par défaut — on
n'invente pas la formulation d'un constructeur dont on n'a pas la
transcription, donc **VRP garde son comportement actuel** (voir §4).

### Ce que la sonde stricte a attrapé, et qui était le vrai fond

La session rouverte doit repartir au niveau **UTILISATEUR**. Poser
`this.mode = 'user'` dans `cmdExit` ne suffisait pas : `show privilege` et
`modeDeRetour` lisent le **NIVEAU** (`currentPrivilegeLevel`), pas le
mode, et le mode y revenait tout seul. Sans les deux, `exit` **rendait les
droits d'administration à qui appuie sur une touche** — l'inverse exact de
ce que la commande promet. C'est le même couple que `disable` remet à
zéro.

Ce point n'a été visible que parce que l'assertion a été **ancrée** :
`level is 1` est un préfixe de `level is 15`, donc la formulation courte
passait des deux côtés et ne prouvait rien — le même piège que
`0% packet loss` dans `100% packet loss`.

La contrepartie est asservie par test : avec un `login` sur la console, la
frappe **repasse par la porte**. Sans ce cas, on aurait pu « corriger » le
bug en offrant une session gratuite juste après avoir annoncé qu'on en
fermait une.

---

## 3. Trois tests existants encodaient un contrat périmé

Ils échouaient **avant** ce lot (vérifié par revert complet) et sont dans
l'aire auditée, donc corrigés ici. Tous les trois pour la même raison :
IOS laisse **trois** essais sur une même invocation d'`enable` (acquis
d'un lot précédent), donc tant qu'ils ne sont pas épuisés la session est
encore en saisie de mot de passe — et y taper `show privilege` **soumet un
mot de passe vide** au lieu de poser une question. Les trois lisaient donc
`% Access denied` là où ils croyaient lire un niveau.

- `cisco-privilege-levels-really-gate.test.ts` (2 cas)
- `cisco-local-auth-privilege-levels.test.ts` (1 cas)

Deux autres, dans `cisco-huawei-aaa-security.test.ts`, échouaient pour une
raison différente et le produit avait raison contre eux : ils appelaient
`runSshCommandSync('', 'show running-config')` — la **chaîne vide** comme
nom d'utilisateur. `show running-config` est une commande de niveau 15 et
la porte SSH lit le niveau du compte, donc un utilisateur inconnu vaut 1
et lit le refus. En production `RouterSshServerContext` passe toujours le
nom authentifié ; seule cette abréviation de test ne le faisait pas. Ils
interrogent désormais la machine en tant que quelqu'un.

---

## 4. Laissé ouvert, mesuré et écrit plutôt que tu

- **VRP** : `quit` depuis la vue utilisateur ne rend pas
  `Connection closed.` — seul Cisco émet cette chaîne — donc rien ne
  change côté Huawei. Une vraie console VRP se repropose elle aussi ; le
  point d'accroche est `consoleReleasedBanner()`, il ne manque que la
  transcription qui donne la formulation exacte.
- **`enable secret 8|9` collé** : vérifié par `ciscoPasswordMatches`
  (PBKDF2 et scrypt réels), mais la CLI ne produit aujourd'hui que du `5`
  au rendu, donc l'aller-retour ne traverse pas ces deux formes.
- **La console et la ligne vty chiffrent à deux moments différents** :
  `enable password` chiffre à la CONFIGURATION, le mot de passe de ligne
  au RENDU. Les deux conventions cohabitent depuis toujours ; le
  vérificateur lit les deux, mais une seule des deux est ce que fait une
  vraie machine.

---

## Mesures

`probe-acces-mot-de-passe-et-console.test.ts` — **27 cas**, les deux
plateformes (routeur et commutateur), discriminé par `git stash` :
**12 tombent authentiquement** avant correctif (plus 2 des 3 cas de
`login local` ajoutés par l'audit). Les autres portent sur le module de
vérification lui-même et sur les cas de refus, et passent des deux
côtés — ils gardent la règle, ils ne prouvent pas la correction.

`e2e/cisco-enable-password-et-console-liberee.spec.ts` — **6 cas
Playwright** dans le vrai navigateur, les deux plateformes : les deux bugs
se voient sur l'onglet de terminal et nulle part ailleurs.

Régressions connexes : **22 suites** d'accès/AAA/privilèges/console/SSH,
**371 cas verts**. Typecheck : jeu d'erreurs identique (120 hors tests). Lint :
identique (les 2 erreurs de `Router.ts` préexistent, lignes 515 et 5132).
