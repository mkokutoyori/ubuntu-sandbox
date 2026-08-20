# Le serveur HTTP d'IOS, et `test aaa group`

Les deux points que `docs/PRD-Acces-Privileges-Cisco.md` §9 laissait
ouverts. Ils sont traités ensemble parce qu'ils se rejoignent : ce que le
serveur web fait de `ip http authentication aaa` est exactement le
mécanisme que `test aaa group` sert à éprouver.

## 1. Ce que la mesure a trouvé, contre ce que le PRD annonçait

Les deux affirmations du PRD précédent étaient fausses, et la seconde
l'était doublement. Elles sont corrigées là-bas et l'écart est écrit ici
plutôt qu'effacé — c'est la mesure qui tranche, pas la note de la fois
d'avant.

**« `ip http server` : accepté et rendu nulle part, dans les deux sens. »**
Exact, mais la cause était plus large que la commande. Les deux drapeaux
vivaient dans `CiscoConfigState`, une table dont la méthode de rendu
`runningConfigLines()` **n'a aucun appelant de production** — elle n'est
lue que par un test. Toute la table est donc muette, et `no cdp run`,
`no ip cef`, `no ip routing` et `lldp run` ne paraissent dans la
configuration que parce qu'un AUTRE magasin les rend (l'agent CDP pour
le premier). Ce qui dépasse l'affichage : la configuration rendue est
**rejouée à l'import d'une topologie**, donc un serveur web activé
disparaissait à l'enregistrement. S'y ajoutait que les cinq commandes
qui accompagnent le drapeau — `port`, `authentication`,
`max-connections`, `access-class`, `timeout-policy` — étaient refusées,
que `show ip http server status` n'existait pas, et qu'aucun port ne
s'ouvrait.

**« Le PRD dit que le serveur est actif par défaut, donc `no ip http
server` devrait paraître. »** Faux. La documentation Cisco de la série 15
écrit que le serveur est **arrêté** par défaut, et la table de drapeaux du
dépôt le disait déjà (`'ip http server': false`). C'est donc la forme
POSITIVE qui doit paraître, et c'est ce qui est fait.

**« `test aaa group … new-code` : absent, il faudrait un serveur TACACS+
qui réponde. »** Faux sur les deux moitiés. Le protocole TACACS+ **est**
implémenté — `TacacsClientAgent` ouvre une vraie connexion TCP/49,
chiffre le corps du paquet et gère son délai de garde, et un
`CiscoRouter` porte à la fois le client et le serveur. Et la commande
n'était pas absente : `AaaAuthenticator.testGroupAuthentication()` était
**écrite pour elle** — son commentaire en cite la syntaxe — de même que
`groupKind()`, « pour rendre la ligne *using TACACS+*/*using radius* de
`test aaa` ». Ce qui manquait était la porte, et il n'en manquait qu'une :
la commande existait dans `CiscoTerminalSession`, donc dans le terminal
graphique et **nulle part ailleurs**. La même machine y répondait par un
onglet et l'ignorait par son shell, en SSH comme dans un script.

## 2. La configuration

`CiscoHttpService` porte les six faits ensemble, parce qu'ils décrivent
UN serveur : un booléen seul ne peut dire ni sur quel port, ni pour qui.
Les deux entrées correspondantes sont **retirées** de `CiscoConfigState`
plutôt que laissées à côté — deux magasins pour le même fait est le
défaut que ce dépôt referme partout ailleurs.

| Commande | Défaut | Rendue |
|---|---|---|
| `ip http server` | arrêté | si actif |
| `ip http secure-server` | arrêté | si actif |
| `ip http port <1-65535>` | 80 | si ≠ 80 |
| `ip http secure-port <1-65535>` | 443 | si ≠ 443 |
| `ip http authentication {enable\|local\|aaa\|tacacs}` | `enable` | si ≠ `enable` |
| `ip http max-connections <1-16>` | 5 | si ≠ 5 |
| `ip http access-class [ipv4] <acl>` | aucune | si posée |
| `ip http timeout-policy idle <s> life <s> requests <n>` | 180/180/1 | si ≠ défaut |

Une valeur hors bornes est **refusée** plutôt que rognée : la ranger
silencieusement ferait mentir la configuration relue.

`show ip http server status` **lit** le service. Sa mise en forme vient
d'une capture réelle (jeu `ntc-templates`), pas d'un exemple de
documentation. Trois familles de lignes de cette capture sont
délibérément absentes, pour la raison qui valait déjà pour `show ip ssh` :
elles décriraient un mécanisme qui n'a pas lieu ici — la liste de suites
cryptographiques et la courbe ECDHE (ce moteur TLS choisit les siennes),
l'algorithme de condensé et `auth-retry` (aucune authentification digest,
aucun compteur), le téléversement de fichiers (inexistant). La **version
TLS**, elle, est rendue parce qu'elle est vraie et mesurable : ce moteur
est un TLS 1.3.

## 3. Le serveur SERT, et il sert l'EXEC

Un port ouvert que rien ne lit serait le défaut d'origine sous une autre
forme. Ce que sert le vrai serveur d'IOS, c'est l'exec :
`/level/<n>/exec/<commande>` exécute la commande au niveau demandé et
rend sa sortie. C'est la porte qui a rendu célèbre la faille
d'autorisation de 2001, et c'est ce qui fait de `ip http server` autre
chose qu'un drapeau.

La coquille HTML, l'en-tête `Server`, l'en-tête `Expires` et le corps du
401 sont repris d'une **transcription réelle** d'un IOS (le module
Metasploit `ios_http_auth_bypass` cite le dialogue `nc` complet) — un
module d'exploitation doit reproduire ce que la machine accepte, donc il
constitue une référence et non un exemple.

Deux propriétés valent d'être notées :

- **La porte lit le MÊME shell que la console.** `show version` par HTTP
  rend le texte de `show version`, pas un second rendu. Une machine qui
  répondrait deux textes selon la porte serait pire qu'une machine sans
  serveur web.
- **Le niveau du compte plafonne ce que l'URL demande.** C'est exactement
  le contrôle dont l'absence faisait la faille de 2001, où `/level/16/`
  et au-delà contournaient l'authentification.

`ip http access-class` filtre pour de bon, en soumettant à l'ACL le même
paquet synthétique que `access-class` sur une ligne VTY — `synthTcpPacket`
est exporté pour cela, deux synthèses différentes rendant deux verdicts
pour la même liste et la même adresse. Une ACL qui n'existe pas ne filtre
rien, comme `ip nat inside source list` accepte une liste écrite plus
tard.

`ip http secure-server` sert la même interface sur TLS. Le certificat
auto-signé est fabriqué au premier démarrage et **gardé** : en présenter
un nouveau à chaque cycle d'arrêt/redémarrage se lirait, chez le client,
comme une usurpation.

## 4. Ce que ce chantier a corrigé dans le moteur HTTP partagé

`Http1ClientSession.send()` est **entièrement synchrone** : il écrit, puis
se désabonne dans la foulée, tenant pour acquis que la réponse arrive
pendant `socket.write()`. C'est vrai tant que le gestionnaire du serveur
est synchrone — nginx, Apache et IIS le sont. Le serveur d'IOS, lui, peut
devoir authentifier par AAA/TACACS+, c'est-à-dire faire un aller-retour
TCP avant de pouvoir répondre ; cette réponse-là arrivait après le
désabonnement, et le client concluait « Empty reply from server » — la
fonction paraissait cassée alors que le serveur avait répondu. Côté TLS,
le même décalage rendait « wrong version number », c'est-à-dire un
diagnostic de TLS pour un problème qui n'en était pas un.

D'où : un gestionnaire peut désormais rendre une promesse, et les deux
clients gagnent un `sendAsync`. **L'attente est bornée par un nombre de
tours de micro-tâches et non par une horloge**, délibérément : dans ce
simulateur la livraison des trames est synchrone, donc une chaîne de
promesses ne dépend que du nombre de `then` traversés, jamais du temps
qui passe — un délai en millisecondes ne se déclencherait pas du tout
sous une horloge virtuelle qu'aucun test n'avance.

**Une nuance mesurée plutôt que supposée**, et elle a coûté six cas :
côté HTTPS, la file par connexion existe parce que `serverSeq` est le
compteur de séquence des enregistrements TLS et que deux réponses
chiffrées dans le désordre seraient rejetées par le pair — la protection
est authentifiée, donc l'ordre en fait partie. Mais faire passer une
réponse **synchrone** par cette file « pour l'uniformité » a cassé tous
les clients synchrones du moteur : six cas de `https.test.ts` et
`iis-https-binding.test.ts` sont tombés sur cette seule nuance. La file
ne se forme donc que lorsque quelque chose attend réellement.

## 5. `test aaa group`

Le rendu vit dans `TestAaaGroup.ts`, lu par le shell **et** par le
terminal graphique, plutôt que recopié.

**Trois issues, pas deux.** Le moteur distingue déjà `accept`, `reject` et
`continue` — ce dernier voulant dire qu'aucun serveur n'a répondu — et la
porte existante rendait `continue` comme un refus. C'est la confusion la
plus coûteuse du diagnostic AAA : « le serveur a dit non » envoie
vérifier un mot de passe, « aucun serveur n'a répondu » envoie vérifier
une route, une clé partagée ou un pare-feu. Les deux ont désormais leur
phrase, toutes deux attestées sur IOS.

`legacy` et `new-code` désignent deux versions du code d'appel interne
d'IOS et non deux protocoles : le dialogue sur le fil est le même, donc
les deux mots sont acceptés. N'accepter que `legacy`, comme le faisait la
porte existante, refusait la moitié de la syntaxe pour une distinction
qui ne change rien à ce qui est émis.

## 6. Limites assumées

- **Un commutateur garde et rend sa configuration, mais n'écoute pas.**
  Un Catalyst connaît `ip http server` — c'est la commande que tout guide
  de durcissement fait désactiver en premier — et le magasin est le même
  que celui du routeur. Mais `Switch` n'a **aucune pile TCP** (pas
  davantage de serveur SSH), donc aucun port ne s'ouvre. C'est déjà vrai
  de tout serveur sur un commutateur ici ; ce qui est réparé est la
  fidélité de la configuration, pas le service.
- **`show ip http server connection` et `... session-module` ne sont pas
  rendues** : aucune connexion n'est retenue et aucun module n'est
  déclaré, donc les deux vues n'auraient aucune matière. `all` rend
  l'état plutôt que d'inventer deux tableaux.
- **Le reste de la table de drapeaux morte n'est pas traité ici.**
  `ip source-route` et `ip domain-lookup` restent stockés sans être
  rendus — `no ip domain-lookup`, l'une des commandes les plus tapées
  d'IOS, est donc encore perdue au rechargement d'une topologie. C'est le
  même défaut, mais un autre sujet : le corriger demande de décider quel
  magasin fait foi pour chaque drapeau, ce que ce chantier n'a fait que
  pour le serveur web.
