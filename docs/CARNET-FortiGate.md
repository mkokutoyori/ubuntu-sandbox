# Carnet de bord — FortiGate / FortiOS

> Ce carnet existe pour qu'un autre agent puisse **reprendre le travail
> sans me poser de question**. Il dit où en est le module, ce qui a été
> décidé et pourquoi, ce qui est en cours, et quoi faire ensuite.
>
> Il enregistre **ce qui a été mesuré**, pas ce qui était prévu. Quand la
> mesure contredit le BRD, c'est la mesure qui est écrite ici et le BRD
> qui est corrigé.

| | |
|---|---|
| **BRD** | `docs/BRD-FortiGate.md` — 6019 lignes, 44 chapitres, 230 exigences |
| **BRD du socle** | `docs/BRD-Firewall.md` — prérequis de lecture |
| **Carnet du module** | `docs/JOURNAL-FIREWALL.md` — entrées E0…E32, défauts B1…B43 |
| **Code** | `src/network/devices/firewall/vendors/fortios/` |
| **Tests** | `src/__tests__/unit/network-v2/firewall/fortios-*.test.ts` |
| **E2E** | `e2e/fortigate-*.spec.ts` |
| **Branche** | `mandeng` |

---

## 1. Où en est le module — état au dernier commit

| Phase (BRD §39) | Contenu | État |
|---|---|---|
| — | Déclinaison initiale : profil, shell à deux tables, 32 cas | ✅ livrée (E31) |
| **1** | **La grammaire : schéma déclaratif, navigateur, trois rendus** | ✅ livrée (E32) |
| **1b** | **Migration sur le moteur de commandes partagé `src/cli/`** | ✅ livrée |
| **2** | Système et objets : `system *`, `addrgrp`, `service`, `schedule`, `router static` | ✅ livrée |
| **3** | NAT complet : `ippool`, `vip`, `central-snat-map`, `router policy` | ✅ livrée (E33) |
| **4** | Diagnostic et journaux | ✅ livrée (E34) |
| **5** | VDOM et modes de déploiement | ✅ livrée (E35) |
| **6** | Inspection et UTM | ✅ livrée (E36) |
| **7** | Utilisateurs et authentification | ✅ livrée (E37) |
| **8** | VPN — tunnel, certificats, DPD/NAT-T, SSL-VPN web | ✅ livrée (E38 à E42) |
| **9a** | **SD-WAN : membres, sondes réelles, bascule sur perte** | ✅ livrée (E43) |
| **9b** | **HA : élection, cerveau divisé, synchronisation par le fil** | ✅ livrée (E44) |
| **10** | **Routage dynamique — RIP et OSPF sur de vrais minuteurs** | ✅ livrée (E45) |
| **11** | **Points restés ouverts : BGP, DHCP, NTP, horaires** | ✅ livrée (E46 à E48) |
| **12** | **Le portail captif capture** | ✅ livrée (E49) |
| **13** | **Les collecteurs syslog émettent** | ✅ livrée (E50) |

**Mesures au dernier commit** : 1182 cas verts sur 45 fichiers du module
pare-feu ; 407 cas FortiOS (32 d'origine + 60 de grammaire + 29 de
système + 34 de NAT + 13 d'aide/langue + 44 de diagnostic + 27 de
VDOM + 36 d'UTM + 43 d'utilisateurs + 42 de VPN + 12 de trafic dans le
tunnel + 10 de certificats + 11 de DPD/NAT-T + 13 de SSL-VPN + 14 de SD-WAN + 28 de HA) ; 59 specs
Playwright ; aucune erreur de typecheck dans le module ; lint propre.
**Le badge « Limited simulation » est retiré.** S'y ajoutent 40 cas de
socle cryptographique (`ike-real-diffie-hellman.test.ts`).

---

## 2. Ce qui est décidé, et qu'il ne faut pas re-décider

Ces décisions sont prises, argumentées, et coûteuses à défaire. Un agent
qui reprend doit les connaître avant de toucher au code.

| # | Décision | Où c'est argumenté |
|---|---|---|
| **D1** | La grammaire est portée par un **schéma déclaratif**, jamais par du code par table | BRD §14, principe F1 |
| **D2** | Le schéma porte les **valeurs par défaut** — sans elles `show` et `get` ne peuvent pas différer, et `unset` ne peut pas se distinguer de `delete` | BRD §15, principe F2 |
| **D3** | `onCommit` est le **seul** point d'écriture vers les magasins du socle | BRD §14.5 |
| **D4** | Aucun moteur, aucune liste blanche, aucun verdict de paquet dans `vendors/fortios/` — garde-fous G1, G6 mécaniques | `architecture-guards.test.ts` |
| **D5** | `always` n'est pas un horaire mais **l'absence de restriction** : il se traduit `undefined` vers le socle | Défaut B41 |
| **D6** | La position d'une règle dans sa table est portée par le **contexte de commit**, jamais reconstituée | Défaut B40 |
| **D7** | Un attribut non simulé est **refusé** en nommant la brique manquante, jamais accepté inerte | BRD principe F6 |
| **D8** | Les notes de simulateur sont préfixées `NOTE:` et **supprimables** | BRD §17.4 |
| **D9** | La sérialisation de topologie **est** le texte de `show full-configuration` ; d'où l'exigence que cette sortie soit rejouable | BRD §34.2 |
| **D10** | **Le moteur de commandes est celui de `src/cli/`** — pas un second | §3 ci-dessous |
| **D11** | **La politique voit la destination APRÈS traduction** (`policySeesPreNatDestination: false`) ; ce qui lui fait quand même nommer la VIP, c'est que l'**objet adresse d'une VIP désigne l'adresse interne** | E33, renversement mesuré |
| **D12** | **`match-vip` vaut `enable` par défaut** (Fortinet l'a inversé en 7.2.3, et ce simulateur annonce 7.4.4) et n'existe que sur une règle `deny` | E33 |
| **D13** | `availableWhen` peut consulter un **autre objet** via `FortiObjectView.setting(chemin, attribut)`, servi par `FortiConfigTree` lui-même — jamais par un second magasin | E33, `central-nat` |
| **D14** | L'**ARP mandataire** est une propriété du socle (`Firewall.setProxyArpEntries`), consultée par `ArpService.answersFor` ; une VIP ou un pool le déclare, il ne le réimplémente pas | E33 |
| **D15** | **L'interface est en ANGLAIS** — messages de refus, notes du simulateur, motifs `unimplemented`. Un FortiGate ne parle pas français | Demande explicite, E33b |
| **D16** | `cliHelp(input)` **passe le texte tel quel**, espace de fin compris : c'est lui qui distingue « liste les enfants » de « filtre par préfixe » | E33b |
| **D17** | **`diagnose debug flow` lit `ctx.trace`** — la trace que le paquet a suivie, jamais une seconde écrite pour l'affichage | E34, OT-6 |
| **D18** | Un journal est **structuré** (`FirewallLogStore`), pas une ligne de texte : sans champs, `execute log filter field` ne peut filtrer sur rien | E34 |
| **D19** | Les champs d'un journal FortiOS sont **entre guillemets**, les numériques exceptés | E34, mesuré |
| **D20** | **La règle implicite ne journalise pas par défaut** ; `config log setting` / `set fwpolicy-implicit-log enable` la fait parler | E34, mesuré |
| **D21** | Une vue ne publie **que ce qui est mesuré**. ~~Pas de CPU ni de mémoire, faute de modèle de charge~~ → **E62** : le modèle existe (`health/SystemLoad`), la charge est DÉRIVÉE de ce que l'équipement porte et fait, et ce qui n'a pas de source (`nice`, `iowait`, `irq`) reste à zéro | E34, E62 |
| **D21b** | La charge a **une seule source pour trois vues** : `get system performance status`, `diagnose sys top` et `diagnose hardware sysinfo conserve` ne peuvent pas se contredire | E62 |
| **D21c** | Un mécanisme annoncé par une vue doit **pouvoir se produire** : un mode conserve calculé sur une mémoire toujours nulle décrivait un état inatteignable | E62 |
| **D22** | **Un FortiGate multi-VDOM est UNE machine.** Jamais N objets `Firewall` : un registre de `VdomContext` sur un seul châssis | BRD §10.2, E35 |
| **D23** | Le **mono-VDOM est le cas particulier** du multi-VDOM, pas une branche : `FirewallServices` résout toujours par VDOM | FGT-VDM-2, E35 |
| **D24** | Un VDOM est une **PORTÉE** (`FortiTableSpec.scopeOnly`), pas un conteneur : l'arbre complet se rouvre dessous | Défaut B50 |
| **D25** | L'arbre de configuration est **indexé par portée** pour un spec `scope: 'vdom'` — sinon deux VDOM éditent la même table | Défaut B51 |
| **D26** | Le mode transparent est un **PIPELINE**, pas un drapeau : `FirewallProfile.pipeline` est un dictionnaire par mode | FGT-DEP-6, E35 |
| **D27** | `vdom-link` est un **vrai `Cable`** entre deux `Port` : c'est ce qui fait traverser les deux politiques pour de bon | BRD §10.5, E35 |
| **D28** | La couche de socket UDP du pare-feu est **`ControlPlaneUdpEndpoint`**, celle que le routeur et le commutateur remplissent déjà — pas une seconde table de ports. Le module était nommé `RouterUdpEndpoint` et ne dépendait pourtant que d'une méthode d'émission ; le renommer coûtait moins qu'une copie | E36 |
| **D29** | Il n'y a **qu'un constructeur de datagramme UDP** dans tout le pare-feu (`udpDatagram`, dans `l3/FirewallEgress.ts`). Il y en avait trois — un pour DNS en client, un pour DNS en serveur, un pour IKE — qui différaient sur la longueur annoncée et sur rien d'autre | E36 |
| **D30** | Une commande asynchrone passe par **`FortiShell.takePendingAsync()`**, lu par `FortiGate.executeCommand` — la même écoutille que les shells IOS et VRP, `execute` restant synchrone pour tout le reste | E36 |
| **D31** | **Tab FAIT DÉFILER** les candidats (`CyclingPolicy`), il ne se tait pas sur l'ambiguïté comme IOS. C'est la doc CLI de Fortinet qui le dit — « Press the Tab key multiple times to cycle through available matches » — et la politique existait déjà pour VRP | E37 |
| **D32** | `get` et `show` prennent un chemin LIBRE dont les *alternatives* sont les branches de l'arbre. Déclarer une branche par mot-clé aurait cassé `get system status`, dont `status` n'est pas une table ; `argumentAccepts` accepte toujours le jeton quand une place porte des `alternatives` sans `values` | E37 |
| **D34** | **Une commande s'abrège jusqu'au plus court non ambigu, chemin compris.** Fortinet en donne l'exemple : `get system status` → `g sy stat`. Le verbe s'abrégeait déjà ; le CHEMIN de `get`/`show` ne s'abrégeait pas, faute d'être un chemin de mots-clés. `resolvePathWords` le résout mot à mot contre les branches de l'arbre **et** les vues déclarées, exact d'abord, préfixe unique ensuite, ambiguïté nommée sinon | E52, mesuré |
| **D35** | **Le vocabulaire d'`execute` est déclaré une fois** (`execute/executeVocabulary.ts`), lu par la répartition, par la complétion et par l'aide. Il était enfermé dans une chaîne de `if` : ni `?`, ni Tab, ni l'abréviation ne pouvaient le voir, et `execute pin` répondait « is not implemented in this simulator » pour une commande qui l'est. Un cas de garde vérifie qu'aucune entrée déclarée ne ment et qu'aucune proposition n'est absente de la liste | E52 |
| **D36** | **Un message ne prétend jamais qu'une commande manque au simulateur alors qu'elle existe.** Une sous-commande non résolue est `unknown action` ou une ambiguïté nommée ; `is not implemented in this simulator` est réservé à ce qui est vraiment hors périmètre | E52 |
| **D37** | **Une valeur proposable n'est pas décidée par sa CASSE.** `argumentCompletableValues` filtrait sur `/^[a-z]…/`, donc aucun nom d'objet en majuscules — soit la quasi-totalité des objets FortiOS — n'était jamais proposé après `edit `. Le bon discriminant est le PLACEHOLDER (`argumentPlaceholder(spec)` et les formes `<…>`/`WORD`/`A.B.C.D`), pas la casse | E52, socle partagé |
| **D38** | `exit`/`quit` referme la session EXEC et rend `login:` — la machine ne se ferme pas, elle redemande qui parle. `endExecSession()` est surchargee pour REARMER la porte plutot que fermer l'onglet ; fermer l'onglet ferait disparaitre la transcription que l'operateur vient de produire | E39 |
| **D39** | Le crochet du socle est `exitClosesLocalSession()`, faux par defaut. La condition existante ne consultait `isTopLevelExit` que pour une session DISTANTE, et l'elargir a tout le monde aurait fait deconnecter un IOS ou un VRP dont ce n'est pas la regle | E39 |
| **D40** | `config system console` est une VRAIE table de schema, donc `set output standard` coupe la pagination pour de bon (`getPageSize()` rend 0, le mecanisme que le socle porte deja pour `terminal length 0`) et `set login disable` ouvre la console sans demander de compte. Stocker les deux sans les honorer aurait ete le decor que ce depot passe son temps a defaire | E39 |
| **D41** | Le defaut d'`output` est **`more`**, verifie chez Fortinet et non suppose — c'est pourquoi une longue sortie PAGINE sur une machine neuve, et la sonde garde ce cas comme temoin | E39 |
| **D42** | `execute reboot`/`shutdown` empruntent le pas `confirmation` du socle d'interaction (`CommandInteractionPlan`), qui existait et que le pare-feu n'utilisait pas. Un `y` sur `reboot` fait un VRAI cycle d'alimentation (`powerOff` puis `powerOn`), donc la console redemande le login : une machine qui redemarre oublie qui etait connecte | E39 |
| **D43** | Le rearmement apres cycle d'alimentation est DIFFERE d'un tour de boucle. Mesure : l'evenement `device.power-on` arrive pendant la retombee du flux qui l'a declenche, et poser la nouvelle invite a cet instant la faisait balayer par la fin de l'ancien flux — la console repartait en mode normal sans login | E39 |
| **D44** | Le TTL est un PARAMETRE de `buildEchoRequest`, jamais un champ qu'on repose apres coup. `{ ...request, ttl }` laissait la somme de controle calculee pour l'ancien TTL, donc chaque sonde de traceroute etait jetee comme corrompue au premier saut : `execute traceroute` n'avait JAMAIS trouve quoi que ce soit dans ce simulateur | E40 |
| **D45** | `execute ssh`/`execute telnet` passent par la machinerie de client que le socle porte deja pour IOS et VRP. Le crochet ajoute est `stripClientPrefix()`, identite par defaut : le socle n'examinait que le PREMIER mot, et FortiOS ecrit le verbe en deux mots. Ecrire un second client aurait donne deux clients qui finissent par diverger | E40 |
| **D46** | Hors console, `execute ssh <cible>` NOMME la brique manquante au lieu de repondre « unknown action » : la commande existe, c'est le terminal qui manque pour saisir le mot de passe. Un garde-fou du depot (« chaque sous-commande declaree REPOND ») a attrape ce trou, et il avait raison | E40 |
| **D47** | Le renifleur capture **a partir de maintenant** dans un terminal — il ne rejoue pas le tampon. C'est ce que fait une vraie machine, et c'est ce qui rend la commande utilisable : on la lance, on provoque le trafic, on le voit passer. Rejouer le passe aurait donne une commande qui repond avant qu'on ait rien fait | E41 |
| **D48** | Hors terminal (script, tuyau) la commande GARDE son texte d'un bloc, lu dans le tampon. Un script n'a personne pour provoquer le trafic pendant qu'il attend, donc la capture vivante n'y voudrait rien dire ; c'est la meme separation que `FirewallPing.run()` / `.begin()` | E41 |
| **D49** | `PacketCapture` gagne un `observe()`, et le filtre de la capture vivante passe par le MEME `frameMatches` que `select()`. Un second predicat aurait fini par ne pas filtrer pareil selon qu'on regarde en direct ou en differe | E41 |
| **D50** | `execute backup`/`restore` traversent le VRAI reseau par le client TFTP existant : `put` depose le texte que rend `renderWholeConfig`, `get` le relit et `absorbClusterConfiguration` le rejoue commande par commande. Rien n'est ecrit de neuf — les trois briques etaient la, il manquait la porte | E42 |
| **D51** | Une restauration REMET A ZERO avant de rejouer. Sans cela elle ne restaurerait pas, elle SUPERPOSERAIT : une regle ajoutee apres la sauvegarde survivrait a la restauration de la sauvegarde qui ne la contient pas | E42 |
| **D52** | La remise a zero rejoue les DEFAUTS de chaque table (`commitDefaults`) au lieu d'oublier le texte : les effets d'une configuration vivent sur l'equipement, pas dans l'arbre, donc vider l'arbre seul laissait la machine telle quelle. `applyFactoryIdentity()` rend en plus le nom d'origine et le compte `admin` SANS mot de passe — donc la console reimpose le changement au premier acces, comme une machine sortie d'usine | E42 |
| **D53** | Le pare-feu EXPOSE un `observables` de la meme forme que celui d'un hote, parce que c'est ce que `resolveObservables` cherche par canard. Ecrire un panneau special au pare-feu aurait fait deux panneaux qui finissent par ne pas dire la meme chose de la meme situation | E43 |
| **D54** | Les vues sont POUSSEES aux points de mutation (cache ARP change, commit de configuration, echo emis ou recu) et non recalculees a la lecture : `useSyncExternalStore` exige un instantane stable, donc un `get()` qui reconstruirait un tableau a chaque appel ferait boucler le rendu | E43 |
| **D55** | Les compteurs que ce pare-feu ne tient PAS (NDP, delais d'attente ICMP, requetes ARP emises) sont rendus a zero plutot que devines. Zero est ici un fait — il n'y a pas de cache NDP derriere — et non un remplissage | E43 |
| **D38** | `FirewallProfile.unimplemented` est **supprimé** : déclaré, lu par personne, et faux (il rangeait `config vpn ipsec` et `diagnose debug flow` parmi les absents alors que les deux sont livrés). Ce que le produit refuse se dit à l'endroit du refus, pas dans une liste que rien ne consulte | E52 |
| **D39** | **Une valeur commencée entre guillemets se complète.** `set srcaddr "N` + Tab ne proposait rien, le guillemet ouvrant faisant partie du préfixe comparé. `FortiShell.completions()` travaille sur la valeur nue et rend les deux guillemets — c'est la forme que le tutoriel et Fortinet écrivent partout | E52b, mesuré |
| **D40** | **Le chemin d'un `show`/`get` se complète en PROFONDEUR**, et propose les CLÉS quand il nomme une table. Les `alternatives` d'un chemin libre sont statiques (D32), donc bornées au premier niveau ; la descente est faite dans la porte FortiOS, qui lit le même arbre — pas dans le socle, dont ce n'est pas la question | E52b |
| **D41** | **Une liste de valeurs se complète à CHAQUE valeur.** La place d'un attribut multiple est un `REST` : le curseur y voit tout le reste de la ligne, donc rien ne correspondait après la première valeur. La porte FortiOS interroge le socle sur le seul mot en cours, et **seulement si l'attribut est `multiValue`** — sinon `set action accept ` proposerait à nouveau les valeurs de l'énumération | E52c, mesuré |
| **D42** | Les verbes qui prennent `<attribut> <valeurs…>` sont déclarés **une fois** (`VALUE_LIST_VERBS`, exporté par `FortiSocle`) et lus par les deux endroits qui en ont besoin. Le garde-fou G6 a refusé un `new Set([…])` dans le shell, et il avait raison : c'était une seconde liste | E52c |
| **D56** | Les garde-fous ajoutés d'après BRD-Firewall §40.6 sont numérotés **`G-P*`** et non `G*` : le BRD générique et le BRD FortiGate donnent chacun un sens à G6/G7/G8, et reprendre les chiffres aurait laissé croire que le fichier porte les huit du générique | E53 |
| **D57** | **Un garde-fou porte son témoin.** Chacun des trois nouveaux a un cas qui le fait échouer sur une entrée fabriquée — un garde qu'on ne voit jamais échouer ne prouve pas qu'il regarde. Celui de G-P1 a été vérifié en retirant pour de bon `sdwan` du pipeline FortiOS : il l'attrape | E53 |
| **D58** | **Une vue de lecture porte la lecture seule dans son TYPE** : champ `readonly`, aucun retour `void`, tout tableau rendu en `readonly T[]`. Un tableau nu remet à l'appelant une poignée VIVE sur le magasin. `FortiObjectView.key` était `key: string` alors que la clé est l'index de la table — une écriture par la vue n'aurait fait que la moitié de ce que fait `rename()` | E54, mesuré |
| **D59** | **`diagnose debug flow show` LIT le nom de l'option.** Il ne lisait que la valeur, si bien que `show console enable` allumait les noms de fonction : une option en activait une autre, et une option sans valeur passait pour un `enable`. `console` tait la trace sans arrêter le traçage (activée par défaut, sinon le TP 9 cesserait de marcher) ; `iprope` est refusée en nommant ce qui manque | E55, mesuré |
| **D60** | **La sauvegarde chiffrée l'est avec la forme de Fortinet** : AES-256-GCM, clé = UN tour de SHA-256 sur le mot de passe — la faiblesse réelle du format, reproduite plutôt que corrigée. Divergence unique et assumée : le corps est armuré en base64 parce que le VFS ne stocke que de l'UTF-8 (même contrainte que `openssl enc`, `PRD-OpenSSL`) | E55 |
| **D61** | **L'étiquette GCM fait la différence entre trois refus** : mot de passe absent, mauvais mot de passe, fichier abîmé. C'est ce que le chiffrement authentifié apporte et qu'un chiffrement de flux n'aurait pas pu donner | E55 |
| **D62** | **Un refus de mot de passe NOMME la règle non remplie.** `FortiAttributeSpec.valueRefusal(value, environment)` rend la raison et non un booléen, et reçoit le `FortiSchemaEnvironment` que `FortiConfigTree` remplit déjà — pas un objet nouveau : c'est le contrat que `isRouted` lit depuis toujours. Un refus muet enverrait deviner | E55 |
| **D63** | **`apply-to` porte aussi sur `psksecret`**, pas seulement sur les comptes : c'est le seul endroit du pare-feu où la qualité d'une clé partagée est vérifiée, et l'ignorer aurait fait mentir la commande sur sa propre portée | E55 |
| **D64** | **`FortiTableSpec.keyOnConfigLine`** déclare les tables dont FortiOS met la clé sur la ligne `config` (`config system replacemsg admin "pre_admin-disclaimer-text"`). Il gouverne les TROIS endroits qui doivent s'accorder — commande enregistrée, descente du navigateur, RENDU — sans quoi `show` écrirait une forme que l'import d'une topologie ne saurait pas rejouer | E55 |
| **D65** | **Le drapeau de bannière et son texte restent deux réglages distincts.** Le drapeau sans texte n'affiche rien, le texte sans drapeau non plus, et les deux cas sont épinglés — c'est l'erreur la plus fréquente sur cette commande, et les fusionner l'effacerait au lieu de l'enseigner | E55 |
| **D66** | **Le verrou d'administration porte sur le COMPTE, pas sur la source** — la documentation Fortinet le dit, et le compteur était indexé par adresse, donc la console (qui n'en a pas) n'était jamais comptée. `refusesSource()` ne juge plus que le `trusthost`. Conséquence assumée : verrouiller `admin` depuis l'extérieur le verrouille aussi pour la console, ce qui est le risque contre lequel `trusthost` existe | E56, mesuré |
| **D67** | **Le décrément de TTL est UNE fonction, appelée par l'étape ET par le chemin rapide.** `session-lookup` accepte et saute les étapes suivantes — comme une vraie machine, sauf qu'une vraie machine décrémente quand même ; la première version ne décrémentait qu'à l'aller | E56, mesuré |
| **D68** | **`opmode` est le SEUL décideur du décrément**, pas la liste d'étapes du profil. Un pare-feu transparent est un pont et ne décrémente pas ; faire porter la règle par les deux aurait donné deux décideurs pour un même fait. L'étape figure donc dans tous les pipelines | E56 |
| **D69** | Le décrément est placé **après la décision de routage et avant la politique**, l'ordre d'`ip_forward()` sous Linux dont FortiOS dérive : un paquet refusé par la politique est refusé, pas « time exceeded » | E56 |
| **D70** | **`get router info ospf …` est la sortie de zebra/FRR, pas celle d'IOS**, et le format vient de `ospfd/ospf_vty.c` — la documentation Fortinet étant hors de portée du mandataire. Le décalage d'un caractère entre la ligne de colonnes et les données est REPRODUIT parce qu'il est réel | E57, mesuré |
| **D71** | **Les faits OSPF sont des types du SOCLE.** La première version les posait dans `vendors/fortios/diag/`, ce qui aurait fait importer la couche vendeur par `FirewallRouting` — précisément ce que le garde-fou G2 interdit. Le socle mesure, la déclinaison met en forme | E57 |
| **D72** | **`recordHealth` rend la TRANSITION, pas l'état.** Un `null` sur un non-changement est ce qui rend l'événement utilisable : sinon chaque tour de sonde redévelopperait toutes les routes et fermerait les mêmes sessions | E58 |
| **D73** | **Le développement d'une route de zone vit sur l'ÉQUIPEMENT**, appelé par le commit ET rejoué par la transition de santé. Il était fait dans `commitDevice`, donc figé ; deux développements auraient fini par différer. L'équipement garde les routes DÉCLARÉES, parce qu'on ne redéveloppe pas ce qu'on n'a pas gardé | E58 |
| **D74** | **La session du membre mort est FERMÉE, pas réécrite.** Le paquet suivant retraverse le pipeline et se fait aiguiller : même résultat observable qu'une réévaluation, par un mécanisme que la table sait déjà faire | E58 |
| **D75** | Les faits de route déclarés sont un type du SOCLE (`DeclaredStaticRoute`), que la déclinaison satisfait par sa forme — deuxième fois que G2 attrape le même réflexe d'importer la couche vendeur depuis `Firewall.ts` | E58 |
| **D76** | **`set mtu` n'agit que sous `set mtu-override enable`**, comme sur un vrai FortiGate. Les deux attributs existaient et étaient morts ; honorer `mtu` seul aurait été une infidélité dans l'autre sens, et un témoin pin le fait que `set mtu 600` seul ne contraint rien | E59, mesuré |
| **D77** | **Le refus pour MTU est une ÉTAPE, la découpe est à l'ÉMISSION** — l'ordre d'`ip_forward()` (TTL puis `ip_exceeds_mtu`, avant le crochet FORWARD) puis d'`ip_output`. La découpe à l'émission vaut donc aussi pour les paquets que le pare-feu produit lui-même | E59 |
| **D78** | Les deux erreurs ICMP du pare-feu passent par UN seul émetteur : deux auraient fini par ne pas sourcer l'erreur depuis la même interface | E59 |
| **D33** | Le ping se déroule **pas à pas** (`FirewallPing.begin()`), pour que le terminal imprime chaque réponse à son arrivée et que Ctrl+C rende les statistiques de ce qui est parti. `run()` demeure et appelle les mêmes pas : un script n'a pas à changer | E37 |
| **D34** | La connexion de console est un **enchaînement d'`InteractiveStep`** (le moteur de flux que `passwd` et `ssh` empruntent déjà), posé en `authGate` — pas une machine à états écrite dans la session. Le forçage du mot de passe est donc une BRANCHE de ce même enchaînement, et un refus revient au pas 0 sans que rien ne soit à réarmer | E38 |
| **D35** | Ce qui déclenche le changement forcé est **le mot de passe VIDE du compte** (`adminHasNoPassword`), jamais un booléen « premier démarrage ». C'est la règle de FortiOS et elle a une conséquence observable : `set password` fait cesser le forçage à l'instant, et le rendre au vide le fait revenir — un drapeau de premier démarrage aurait menti dans les deux sens | E38 |
| **D36** | Le verrouillage par nombre d'essais (`admin-lockout-threshold`) **ne s'applique pas à la console**, parce que le compteur de ce dépôt est indexé par SOURCE et qu'une console n'en a pas. Inventer une clé aurait fait verrouiller une session SSH pour une faute de frappe tapée sur la console. Inscrit dans `TODO.md` plutôt que deviné | E38 |
| **D37** | Le compte d'usine `admin` est semé par le **constructeur de `FortiGate`** et non par le shell : un pare-feu sans compte n'existe pas sur une vraie machine, et le semer depuis le shell le faisait dépendre d'une première commande tapée | E38 |

---

## 3. D10 — pourquoi le moteur de commandes partagé

**Le constat.** La phase 1 a livré une aide et une complétion écrites
dans `FortiShell` : une liste de verbes par contexte, un filtre par
préfixe, un rendu en deux colonnes. Cela fonctionne et c'est un **second
moteur** — alors que `src/cli/` en porte un, écrit pour Cisco et l'ASA,
qui fait davantage et mieux :

| Ce que `src/cli/` donne | Ce que la phase 1 faisait |
|---|---|
| Arguments **typés** (`INT` borné, `IP_ADDR`, `ENUM`…) | Types maison, validés à part |
| `?` rendant la **plage réelle** (`<0-32>`) | Le nom de l'attribut |
| Valeurs énumérées **décrites** une par une | Décrites, mais par un second chemin |
| Plusieurs **formes** pour une même place (`alternatives`) | Absent |
| **Abréviations** non ambiguës | Absent |
| **Ambiguïté** nommée plutôt que premier arrivé | Absent |
| `<cr>` quand la commande est complète | Absent |
| Filtrage par **atteignabilité** du sous-arbre | Absent |
| Complétion `TAB` distincte de `?` | Un seul comportement |

**La difficulté, et sa réponse.** FortiOS n'est pas une CLI à
mots-clés : les commandes légales dépendent de l'endroit où l'on est dans
l'arbre de configuration, et les attributs dépendent de l'objet ouvert.
Une `CommandTable` statique ne peut pas l'exprimer.

**La réponse retenue** : une `CommandTable` est **construite par
contexte**, à partir du schéma, et mise en cache. Un contexte est
(chemin de schéma, signature de disponibilité de l'objet). Chaque table
est petite — quelques dizaines de nœuds — et il n'y a **qu'un seul
moteur** : `parseCommand` décide de ce qui est légal, `complete` rend les
suggestions, et les gestionnaires appellent le navigateur qui mute.

**Le gain qui n'était pas prévu** : les références se complètent pour de
bon. Comme la table est bâtie à la demande, `set srcaddr ?` peut lister
les objets adresse **qui existent réellement**, ce qu'une table statique
ne saurait pas faire.

**Conséquence sur le BRD** : §14 est réécrit — le schéma décrit *ce qui
existe*, le moteur partagé décide *ce qui est légal et ce qui se
propose*. Les deux ne se recouvrent plus.

---

## 4. Carte du code

```
src/cli/                                  ← LE moteur, partagé (ne pas dupliquer)
├── ArgumentTypes.ts        ArgumentSpec, ARGUMENT_TYPES, argumentAccepts,
│                           argumentSuggestions, argumentPlaceholder
├── CommandTable.ts         CommandSpec, l'arbre, l'atteignabilité
├── CommandParser.ts        parseCommand, abréviations, ambiguïté
├── CompletionEngine.ts     complete(TAB | QUESTION_MARK), <cr>
├── CliSession.ts           mode, privilège, champs de contexte, invite
└── CliEngine.ts            exécution + messages IOS

src/network/devices/firewall/vendors/fortios/
├── FortiGate.ts            l'équipement
├── FortiProfile.ts         le profil (contrat de déclinaison)
├── FortiShell.ts           l'aiguilleur — ne connaît aucune table
├── FortiMessages.ts        le catalogue de messages, trois familles
├── FortiSocle.ts           ← construit la CommandTable par contexte
├── schema/
│   ├── types.ts            FortiTableSpec, FortiAttributeSpec
│   ├── index.ts            assemblage + schemaIndex()
│   ├── firewallPolicy.ts   config firewall policy
│   ├── firewallObjects.ts  config firewall address (+ phase 2)
│   ├── system.ts           ← phase 2
│   └── router.ts           ← phase 2
├── runtime/
│   ├── FortiObject.ts      un objet : valeurs explicites + défauts
│   ├── FortiTable.ts       une table : ordre, clés, clone/rename/move
│   ├── FortiConfigTree.ts  l'arbre des tables
│   ├── FortiNavigator.ts   la pile et les 18 verbes
│   └── FortiValidator.ts   validation (délègue à argumentAccepts)
└── render/
    ├── showRenderer.ts     show et show full-configuration
    └── getRenderer.ts      get
```

---

## 5. Les pièges déjà rencontrés

Un agent qui reprend gagnera du temps à les connaître.

| # | Piège | Comment il se manifeste |
|---|---|---|
| **P1** | `remove` puis `append` dans `onCommit` | Rééditer une règle la **remonte en fin de table**, donc change l'ordre d'évaluation. Utiliser `insertAt` avec `context.position`. |
| **P2** | Passer `schedule: 'always'` au socle | `PolicyEvaluator` refuse une règle dont l'horaire n'est pas évaluable → **aucune correspondance**, donc `ping` à 100 % de perte et NAT sans effet. Deux symptômes, une cause. |
| **P3** | `session as LinuxTerminalSession` dans `TerminalView` | Toute session déclarant `getSessionType() === 'linux'` traverse le chemin de rendu Linux. **Le terminal ne s'ouvre pas du tout** — l'arbre React tombe. Corrigé par des défauts sur `TerminalSession`. |
| **P4** | `strict: false` dans `tsconfig.app.json` | Les unions discriminées **ne se rétrécissent pas**. Un `{ok:true}\|{ok:false}` ne compile pas ; utiliser une forme plate. |
| **P5** | Les tests unitaires ne voient pas l'interface | `createSessionForDevice` rendait une session pendant que le terminal plantait. **Toute phase doit livrer une spec Playwright.** |
| **P6** | `FortiTerminalSession.getSessionType()` rend `'linux'` | Choix assumé pour le thème ; c'est ce qui expose P3. Ne pas le changer sans mesurer le thème et le collage. |
| **P7** | `ObjectStore.matchesAnyAddress` cherche un objet **par nom** | Une règle NAT portant une adresse **en clair** (l'`extip` d'une VIP) ne correspond à rien. Le moteur porte `addressMatches` (nom ou littéral) : c'est lui qu'il faut appeler. |
| **P8** | `ObjectStore.addAddress` refuse un doublon | Le motif `removeAddress` + `addAddress` laisse **silencieusement l'ancienne valeur** dès que l'objet est membre d'un groupe (le `remove` échoue alors). Utiliser `upsertAddress`. |
| **P9** | Une traduction posée écrase la précédente | Une session qui subit DNAT **puis** SNAT perd la moitié destination si `applyPolicyNat` ne **fusionne** pas : la réponse repart avec l'adresse interne et le client la refuse. Toujours `mergeTranslations`. |
| **P10** | La livraison locale précède le NAT | Une VIP posée sur l'adresse **de l'interface** — le renvoi de port le plus courant — est servie par la pile locale et jamais traduite. `Firewall.handleIpv4Frame` consulte `hasInboundRule` d'abord. |
| **P11** | Un laboratoire de sortie sans route par défaut | `route-lookup` refuse, la politique n'est jamais atteinte, et le symptôme lu est « le NAT ne traduit pas ». Quatre cas de la sonde de phase 3 sont tombés là-dessus. |
| **P12** | `session.c2s` porte le tuple **traduit** | La session est installée APRÈS le NAT. Filtrer ou afficher `c2s` montre l'adresse publique là où l'opérateur cherche la privée. Utiliser `originalFlow(session)`. |
| **P13** | Un argument `REST` est découpé aux espaces | `diagnose sniffer packet any 'host 1.2.3.4' 4 10` arrive en cinq mots : l'expression entre apostrophes doit être recollée avant lecture (`splitSnifferArguments`). |
| ~~**P14**~~ | ~~Le garde-fou G1 borne un fichier vendeur à 800 lignes~~ | **Retiré.** Le comptage de lignes s'est révélé un mauvais indicateur de couplage : il imposait des extractions dictées par un compteur plutôt que par la cohésion, pour un coût en temps supérieur à ce qu'il faisait gagner. Les extractions déjà faites restent — elles étaient justes ; c'est l'obligation qui disparaît. |
| **P15** | G6 interdit un `new Set(['…'])` littéral hors du schéma | Même pour une liste qui n'est pas des attributs de configuration. Nommer une constante `readonly string[]` et construire le `Set` à partir d'elle. |
| **P16** | `allowaccess` JETTE le paquet, il ne le rejette pas | Une interface qui n'admet pas un service ne répond RIEN — le client attend puis conclut « Connection timed out », jamais « Connection refused ». Une sonde qui attend un refus explicite teste le mauvais comportement ; c'est l'ABSENCE d'invite de mot de passe qui prouve le rejet. |
| **P18** | Le succès d'un `execute` FortiOS ne s'invente pas | Aucune transcription publique ne dit ce qu'écrit `execute vpn certificate local export tftp` quand il réussit ; la documentation donne la syntaxe et rien d'autre, et la documentation Fortinet n'est pas lisible directement depuis ce réseau. Il ne rend donc RIEN en cas de succès — ce que font la plupart des verbes `execute` — et ne parle qu'en cas d'échec. Fabriquer un `Send certificate … OK.` plausible serait apprendre une sortie que la vraie machine ne rend peut-être pas. |
| **P17** | Une adresse et un port ne se passent pas en `string`/`number` | Le dépôt a déjà `IPAddress` et `core/ports/PortNumber` (RFC 6335, utilisé par les services Linux et le gestionnaire de services Windows). Toute nouvelle signature les prend ; la conversion se fait à la frontière qui lit l'argument. Chercher AVANT d'écrire un type de valeur — il existe probablement déjà. |

---

## 6. Ce qu'il faut faire ensuite — dans l'ordre

### 6.1 Phase 1b — migration sur le moteur partagé — ✅ livrée

`FortiAttributeSpec` porte des `ArgumentSpec` de `src/cli/` ;
`FortiSocle` bâtit une `CommandTable` par contexte, mise en cache sur
(chemin, attributs disponibles, empreinte des références) ; `FortiShell`
délègue l'analyse et la complétion ; `FortiValidator` délègue à
`argumentAccepts`.

**Ce qui a été ajouté au moteur partagé**, purement additif :
`TreeNode.legend` et `CommandTable.describePath()`. Un nœud
intermédiaire héritait de la description de son **premier descendant**,
donc `config ?` annonçait « Configure IPv4 addresses. » pour le mot
`config` — la description d'une branche pour le nom de toutes. Cisco a
le même défaut sur `show ?` ; la légende le referme pour les deux, et
l'héritage reste le comportement par défaut.

**Acquis mesurés** : abréviations, ambiguïté nommée, plages réelles dans
l'aide (`<0-32>`), `<cr>`, et — le gain non prévu — les **références se
complètent sur ce qui existe** (`set srcaddr ?` liste les objets
adresse réellement déclarés), parce que la table est bâtie à la demande.

74 cas de grammaire, 1054 cas verts sur `firewall/` + `cli/`, typecheck
**348** contre une base à **351**.

### 6.2 Phase 2 — système et objets — ✅ livrée

**Onze chemins de configuration** : `system global`, `system settings`,
`system interface` (+ VLAN, `allowaccess`), `system zone`, `system dns`,
`system dhcp server` (+ `ip-range`), `firewall addrgrp`,
`firewall service custom`, `firewall service group`,
`firewall schedule recurring`, `router static`. Plus le catalogue de
36 services d'usine (`schema/predefined.ts`).

**Deux prélèvements sur le socle**, les premiers des treize (BRD §31.2) :

- **`model/ScheduleObject.ts`** — l'objet horaire que `BRD-Firewall` §8.5
  spécifiait et que personne n'avait écrit, avec `ScheduleStore` et la
  règle de franchissement de minuit ;
- le branchement de **`PolicyEvaluator.scheduleActive`**, qui existait
  comme dépendance et **n'était câblé par personne** — une règle horaire
  était donc soit inévaluable, soit ignorée ;
- **`Firewall.setAllowedAccess` / `allowsAccess`**, et le filtre appliqué
  dans `deliverLocally`. Une interface qui n'admet pas `ping` ne répond
  pas à l'écho. Une interface **jamais configurée** répond, sans quoi
  chaque autre constructeur aurait perdu son ping.

**Défaut trouvé par la suite à l'aveugle, dans le moteur partagé** :
un horaire déclaré `WORD` avec un `literal: 'hh:mm'` annonçait `hh:mm` à
l'opérateur et **acceptait n'importe quoi** — `set start 25:99` passait.
Le `literal` décrit, il ne vérifie pas. `src/cli/ArgumentTypes.ts` gagne
le type **`TIME`**, qui sert aussi à IOS (`clock set`, `time-range`).

**Mesures** : 29 cas, **24 tombent** avant correctif. 1102 verts sur
`firewall/` + `cli/`. Typecheck **347** contre une base à **351**.

### 6.2 bis — Phase 2 : plus rien ne reste

Tout est fermé. `config system dhcp server` côté plan de données et
`config system interface` en `mode dhcp` en E47 ; `config system ntp`,
`config firewall schedule onetime` et `config firewall schedule group`
en E48.

Une note de ce carnet disait `PolicyEvaluator.scheduleActive` « câblé par
personne » : **c'était faux**, il l'est depuis `VdomRegistry:183`.

### 6.3 Phase 2 — le plan d'origine, pour mémoire

| Chemin | Fichier |
|---|---|
| `config system global` | `schema/system.ts` |
| `config system settings` | idem |
| `config system interface` (+ `secondaryip`) | idem |
| `config system zone` | idem |
| `config system dns`, `config system ntp` | idem |
| `config system dhcp server` (+ `ip-range`, `reserved-address`) | idem |
| `config firewall addrgrp` | `schema/firewallObjects.ts` |
| `config firewall service custom` / `group` | idem |
| `config firewall schedule recurring` / `onetime` | idem |
| `config router static` | `schema/router.ts` |
| Catalogue prédéfini (BRD §44.2) | `schema/predefined.ts` |

**Prélèvement sur le socle**, le premier des treize (BRD §31.2) :

- l'**objet horaire** (`model/ScheduleObject.ts`), spécifié par
  `BRD-Firewall` §8.5 et jamais implémenté ;
- le branchement de `PolicyEvaluator.scheduleActive`, qui existe comme
  dépendance et **n'est câblé par personne**.

**Critère de sortie** : le laboratoire L1 du BRD se joue de bout en bout
dans un terminal graphique, et `allowaccess` refuse vraiment une
connexion.

### 6.4 Phase 3 — NAT complet — ✅ livrée

Livrée : `config firewall ippool` (les quatre types, `nat/IpPool.ts`),
`config firewall vip` (statique et renvoi de port), l'ARP mandataire, le
trafic *hairpin*, `config firewall central-snat-map` avec `set
central-nat`, `config router policy` avec l'étape `policy-route` du
pipeline, et `match-vip`.

**Ce qui reste de la phase 3, nommé plutôt que tu** :

- ~~`dns-translation` et `fqdn` sont déclarés et non commis~~ **fermé en
  E52** : `fqdn` est commis pour de bon (`set mapped-addr <objet>`, le
  VIP pointe sur l'adresse que le nom résout et **suit** quand elle
  change), et `dns-translation` est REFUSÉ en nommant la brique
  manquante — un relais applicatif DNS sur le chemin de transit
  (`TODO.md`, section Pare-feu FortiGate). Il n'existe donc à aucun
  moment un mot-clé accepté et inerte ;
- ~~`firewall vip` de type `server-load-balance` — aucune brique
  existante à réutiliser~~ **fermé en E66, et cette phrase était
  FAUSSE** : trois briques existaient. Le point d'accroche du DNAT
  inscrivait déjà son choix dans la session (donc la persistance d'une
  session était gratuite), et `FirewallPing`/`dialTcp` savaient déjà
  sonder. `least-rtt` et `http-host` restent refusés en nommant leur
  brique, comme les moniteurs applicatifs ;
- `firewall vip6` / `ippool6` (IPv6) — le socle NAT est IPv4 seul ;
- `central-snat-map` en `type ipv6`, `nat46`/`nat64` ;
- ~~`pba-timeout` est stocké et ne périme rien~~ **fermé en E52** :
  l'allocateur prend l'horloge du pare-feu, chaque bloc porte son
  `lastUsedAt`, et un bloc inutilisé plus longtemps que le délai est rendu
  au pool — ports compris. L'usage repousse l'échéance, parce que la
  documentation Fortinet décrit une INACTIVITÉ et non un bail à durée
  fixe. Trouvé et corrigé dans le même allocateur : `overloadMappings`
  était inséré sous une clé et supprimé sous une autre, donc la table
  fuyait et n'était jamais relue — une PAT qui n'est pas stable pour un
  flux est une PAT dont la réponse ne revient pas.

### 6.5 Phase 4 — diagnostic et journaux — ✅ livrée

Livrée : `diagnose sys session list|filter|clear|stat`,
`diagnose debug flow` (filtres, `trace start`, `show function-name`),
`diagnose firewall iprope list|show`, `diagnose sniffer packet`, les
vues `get` (`system status`, `system performance status`, `system arp`,
`system interface`, `router info routing-table all`), `config log
syslogd[2-4]` + `filter`, `config log memory setting|global-setting`,
`config log setting`, les quatre formats (`default`, `csv`, `cef`,
`rfc5424`) et `execute log filter|display|delete-all`. **Le badge
« Limited simulation » est retiré du FortiGate.**

**Ce qui reste de la phase 4, nommé plutôt que tu** :

- ~~`get system performance status` ne rend ni CPU ni mémoire~~
  **fermé en E62** : `health/SystemLoad` mesure, les trois vues le
  lisent, les seuils du mode conserve se règlent et valaient 88/82/78
  là où un vrai FortiGate donne 95/88/82, et le mode conserve a
  désormais une conséquence sur le trafic ;
- ~~les collecteurs syslog n'émettent pas~~ **fermé en E50** : un vrai
  `rsyslog` reçoit la ligne dans son `/var/log/syslog`. Le chemin CLI
  était faux au passage (`config log syslogd setting` et
  `… filter` sont FRÈRES sur un vrai FortiGate, pas parent/enfant) ;
- `diagnose sniffer packet` lit le tampon de capture du pare-feu, pas le
  bus de trames global : il voit ce qui traverse CE pare-feu, ce qui est
  le périmètre de la commande, mais un `any` n'inclut pas les trames
  qu'un autre équipement échange ;
- ~~`execute backup|restore|revision` (BRD §29.4-29.5) n'a pas été pris~~
  **fermé en E65** : `backup` et `restore` existaient depuis E42 (vrai
  TFTP) ; ce qui manquait était l'HISTORIQUE. `config/RevisionStore`,
  `execute revision list|delete config`,
  `execute restore config flash <id>` et `revision-backup-on-logout`
  ferment le point. Le seul déclencheur modélisé est la déconnexion d'un
  administrateur — ce simulateur n'a ni mise à jour de micrologiciel ni
  interface web, donc les deux autres déclencheurs d'un vrai boîtier ne
  sont pas inventés.

### 6.6 Phase 5 — VDOM et modes de déploiement — ✅ livrée

Livrée : `VdomRegistry`/`VdomContext` au socle, étape `vdom-bind`,
`config vdom`, `config global`, `set vdom-mode multi-vdom`, `set vdom`
sur une interface, `config system vdom-link` (vrai câble interne),
`config system switch-interface` (étape `switch-bridge`),
`set opmode transparent` + `manageip`/`gateway` (étape `mac-lookup` et
pipeline par mode), et l'invite qui indique le VDOM courant.

**Ce qui reste de la phase 5, nommé plutôt que tu** :

- ~~les comptes administrateurs ne sont pas encore une portée globale
  (`config system admin` n'a pas de schéma)~~ **note périmée, corrigée
  le 2026-08-23** : `schema/admin.ts` porte `config system admin` depuis
  la phase 7, et la phase 14 l'a branché sur une vraie session SSH ;
- `vdom-mode split-vdom` est accepté et se comporte comme `multi-vdom` :
  la séparation gestion/trafic n'a pas de mécanisme derrière. **Mesuré
  et inscrit dans `TODO.md` le 2026-08-23** — trancher demande d'abord
  d'établir si ce mode existe encore en 7.6, ce que les sources
  consultées contredisent l'une l'autre ;
- le **laboratoire L9** (FortiGate vs ASA) est une comparaison
  documentaire, pas un mécanisme ; il n'a pas été écrit en code ;
- ~~l'apprentissage MAC du mode transparent est une table simple sur le
  châssis, sans vieillissement ni STP~~ **fermé en E64** : `l2/BridgeFdb`
  vieillit (300 s, l'âge comptant depuis la dernière trame vue), porte
  une instance PAR VDOM, se purge quand un port tombe, et se lit par
  `diagnose netlink brctl list|name host <vdom>.b`. **Le partage avec
  `Switch` est examiné et écarté** : sa table est indexée `vlan:mac` et
  distingue statique / dynamique / trou noir, avec la sécurité de port et
  le vieillissement accéléré de STP par-dessus ; un pont de mode
  transparent n'a ici aucune de ces notions. Le STP n'est pas ajouté — un
  pont transparent sans STP est ce que ce simulateur porte, et l'écrire
  serait un chantier de `Switch.ts`.

### 6.7 Phase 6 — inspection et UTM — ✅ livrée

Livrée : `inspection/UtmProfiles.ts` + `inspection/ContentInspector.ts`
au socle, étage `utm-inspect`, `config antivirus profile`,
`config webfilter profile` + `config webfilter urlfilter`,
`config dnsfilter profile` + `config dnsfilter domain-filter`,
`config file-filter profile`, `config firewall ssl-ssh-profile`,
`config firewall profile-protocol-options`, et les six références UTM
d'une politique derrière `set utm-status enable`.

**Trois défauts de socle trouvés ici et corrigés** (E36) : la session
était indexée sur le paquet APRÈS traduction (aucune connexion TCP ne
pouvait traverser avec NAT) ; l'inspection n'était appelée que sur le
premier paquet (la charge utile ne voyage jamais dans le SYN) ; un
enfant de type objet était injoignable depuis la CLI et absent du
`show`.

**Ce qui est REFUSÉ dans le produit, en nommant la brique absente** —
et qu'il ne faut donc pas « implémenter » sans fournir la brique :

- `deep-inspection` : pas de point de terminaison TCP/TLS sur le
  pare-feu, donc aucun certificat re-signé possible ;
- `application list`, `ips sensor`, `dlp sensor` : pas de base de
  signatures FortiGuard, et il n'y en aura pas ;
- `firewall shaper traffic-shaper` : pas d'horloge de fil.

**Ce qui reste de la phase 6, nommé plutôt que tu** :

- le catalogue de catégories est LOCAL (quatre catégories,
  `LOCAL_URL_CATEGORIES`) : il n'y a pas de FortiGuard ;
- l'antivirus reconnaît EICAR et rien d'autre — c'est une signature de
  test, pas un moteur ;
- `scan-archive-contents` est accepté et ne descend dans aucune archive
  (il n'y a pas de décompresseur) ;
- ~~le filtrage de fichiers lit le nombre magique en tête de corps, donc
  ne voit pas un fichier réparti sur plusieurs segments~~ **fermé en
  E63** : l'inspection lit un FLUX réassemblé par connexion et par sens,
  borné par `oversize-limit`. Le défaut était plus large que le filtrage
  de fichiers — la signature antivirus se contournait de la même façon,
  en coupant l'envoi en deux.

**Si vous câblez le serveur DHCP du FortiGate** (`config system dhcp
server` est aujourd'hui grammaire seule) : le socle DHCP du dépôt est
`src/network/dhcp/DHCPServer.ts`. N'en écrivez pas un second.

### 6.8 Phase 7 — utilisateurs et authentification — ✅ livrée

Livrée : `IdentityTable` (le pendant de `SessionTable` pour les
identités), `UserDirectory`, `AccessMatrix`, `AuthPortal`, une **pile
TCP sur le pare-feu**, l'étage `auth-check`, `config user
{local,group,radius,tacacs+,ldap,setting}`, `config system
{admin,accprofile}` avec `trusthost`, et `diagnose firewall auth
{list,clear,filter}`.

**La pile TCP du pare-feu est neuve et vaut au-delà de cette phase** :
c'est la brique dont l'absence avait fait refuser `deep-inspection` en
phase 6. Elle ne suffit pas à elle seule pour la rouvrir (il faudrait
aussi terminer ET ré-émettre une session TLS sous un certificat
re-signé), mais elle en est le premier morceau.

**Réutilisations — ne réécrivez rien de tout cela** :
`NetworkOsCredentialStore` (comptes, verrouillage), `RadiusClientAgent`,
`TacacsClientAgent`, **`LdapClient`/`dialLdap`** (chantier AD),
`Http1ServerSession` (portail), `TcpStack` (adaptateur de `Router`),
`addressObjectMatches` (comparaison `trusthost`).

**Ce qui est REFUSÉ dans le produit**, en nommant la brique absente :
FSSO (pas de contrôleur de domaine ni d'agent collecteur), SAML (pas de
fournisseur d'identité), et la double authentification `fortitoken` /
`email` / `sms` (pas de graine de jeton ni d'horloge partagée — un
second facteur toujours accepté serait pire que pas de second facteur).

**Ce qui reste de la phase 7, nommé plutôt que tu** :

- ~~le portail n'intercepte pas~~ **fermé en E49** : un flux HTTP non
  authentifié reçoit un vrai `303` vers `http://<pare-feu>:1000/fgtauth`,
  et `security-mode captive-portal` sur une interface existe. HTTPS n'est
  pas capturé (il faudrait présenter un certificat pour un nom qu'on n'a
  pas — même brique manquante que `deep-inspection`) ;
- ~~l'authentification d'un compte administrateur n'est pas branchée sur
  une vraie connexion SSH~~ **fermé en E51** : le pare-feu héberge un
  vrai serveur SSH (et telnet) sur sa propre pile TCP, par le
  `SshServerHandler` que le dépôt sert déjà à quatre familles
  d'appareils. `ssh admin@<pare-feu>` depuis un `LinuxPC` ouvre une vraie
  session, les trames sont comptées sur le câble, chaque session a sa
  propre CLI portant l'identité de l'administrateur — donc son profil
  d'accès — et `trusthost` refuse au niveau du paquet ;
- `two-factor` est refusé, donc `email-to` est stocké sans emploi.

### 6.9 Phase 8 — VPN — ✅ livrée

Livrée : `config vpn ipsec phase1-interface` / `phase2-interface` (et la
forme héritée `phase1`), l'interface de tunnel — routable et nommable en
`srcintf`/`dstintf` —, `diagnose vpn tunnel {list,summary,up}`, et la
programmation du moteur IKE partagé depuis les déclarations FortiOS.

**Deux chantiers de SOCLE en font partie, et ils dépassent FortiOS** :

- **IKE calcule un vrai Diffie-Hellman** (`crypto/dh/modp.ts`,
  `ipsec/IkeKeyExchange.ts`). Avant, aucun groupe n'était calculé ; le
  matériel de clé venait de la seule PSK. Les nombres premiers viennent
  des RFC 2409 et 3526, extraits du texte et vérifiés. **Cela profite
  aussi à Cisco et Huawei**, qui partagent ce moteur.
- **3DES se déchiffre** (`crypto/cipher/des.ts`), et ESP l'applique
  vraiment.

**`IpsecHost` est le port étroit** qui permet à `Router` ET à `Firewall`
d'héberger le MÊME moteur IKE. N'en écrivez pas un second.

**FGT-VPN-3 est FERMÉ** (journal E39) : un ping part d'un poste derrière
un FortiGate et ressort derrière l'autre, en ESP sur le fil, dans un
laboratoire à deux pare-feu câblés. Quatre défauts ont été trouvés en le
mesurant, et un seul était dans le VPN :

- **un pare-feu ne recevait AUCUN datagramme adressé à lui-même hormis
  un écho ICMP**, donc aucun ne pouvait RÉPONDRE à une offre IKE ;
- **`IPSecEngine` fouillait la table de ports de `Router`** par un
  `as any` — `IpsecHost` porte désormais les quatre faits qu'il
  cherchait, et le moteur ne sait plus ce qu'est un port ;
- **`removeStaticRoute` avait un corps VIDE** : `delete <n>` sous
  `config router static` laissait la route dans la table de transfert ;
- **une seule carte de chiffrement** pour tous les tunnels rendait
  impossible de retrouver celle d'un tunnel donné.

**`authmethod signature` est FERMÉ** (journal E40) : `config vpn
certificate local` porte l'identité de la machine, `config vpn
certificate ca` ce qu'elle croit, le certificat entre en PEM et un
certificat qu'aucune ancre ne signe fait ÉCHOUER le tunnel. Un `onCommit`
peut désormais refuser, ce qu'il fallait pour qu'une phase 1 `signature`
sans certificat soit rejetée à la fermeture, comme sur une vraie machine.

**`dpd` et `nattraversal` sont FERMÉS** (journal E41) : les deux
atteignent le moteur, `dpd-retryinterval`/`dpd-retrycount` existent, et
`natt: mode=` rapporte ce que la session a NÉGOCIÉ au lieu de ce qui a
été configuré — il était faux, pas seulement inerte. Trouvé en chemin :
`diagnose vpn tunnel up` ne négociait rien.

**SSL-VPN est FERMÉ en mode web** (journal E42) : `config vpn ssl
settings`, `config authentication-rule` et `config vpn ssl web portal`
existent, le portail ÉCOUTE en TLS avec le certificat de `set servercert`
— premier consommateur du magasin de E40 — et `tunnel-mode` est refusé en
nommant la brique absente (un client FortiClient). Trouvé en le
mesurant, et bien plus large : **un pare-feu ne remettait aucun segment
TCP à sa propre pile**, donc tout écouteur qu'il porte était sourd, le
portail d'authentification de la phase 7 compris.

**La phase 8 n'a plus de reste.**

### 6.10 bis — Phase 21 — le recollage des fragments — ✅ livrée

Le pare-feu recolle un datagramme fragmenté **avant** la recherche de
politique, comme le chemin logiciel d'un vrai FortiGate. `set
ip-fragment-mem-thresholds` borne la table et `diagnose snmp ip frags`
la mesure.

Ce qui reste ouvert, et qui est une décision plutôt qu'un oubli : le
seuil est déclaré sous `config system settings`, donc par VDOM, parce que
c'est là que Fortinet le place ; la table est unique pour l'équipement.
Deux VDOM posant deux seuils écrivent successivement sur la même borne.
Une table par contexte n'apporterait rien tant qu'un laboratoire n'a pas
deux VDOM sous charge de fragments.

### 6.10 ter — Phase 22 — la voie de commande de grappe — ✅ livrée

`execute ha manage <index> <compte>` ouvre une VRAIE session sur le
membre distant : mot de passe évalué chez la cible, invite du distant,
commandes exécutées là-bas, `exit` qui ramène. `execute ha synchronize
start` tapé sur un secondaire TIRE la configuration du primaire, comme
la documentation de Fortinet le décrit — c'est depuis le subordonné que
cette commande se tape.

Reste ouvert, et sans rapport avec la voie de commande : les adresses MAC
virtuelles du cluster (`TODO.md`), qui touchent `Port` et
l'apprentissage MAC de tous les commutateurs du projet.

### 6.10 quater — Phase 23 — origine et seuils du journal — ✅ livrée

Une ligne de configuration porte la porte par laquelle elle a été tapée,
et le tampon mémoire écrit son événement à chacun des trois seuils.

### 6.10 Après

Suivre §39 du BRD. Chaque phase : revendiquer dans
`JOURNAL-FIREWALL.md`, livrer, discriminer par `git stash`, mettre à jour
ce carnet.

---

## 7. La procédure de livraison

Elle n'est pas négociable — c'est ce qui rend le travail reprenable.

1. **Revendiquer** le périmètre dans `docs/JOURNAL-FIREWALL.md` avant
   d'écrire (un autre agent travaille sur le même module).
2. Écrire les cas **à l'aveugle** : décrire ce qu'une vraie machine fait,
   sans lire l'implémentation d'abord. C'est ce qui a trouvé B40.
3. Tout cas nominal a son **témoin** — le cas où ça ne marche pas.
4. **Discriminer** : `git stash push -- src/network/devices/firewall/`,
   rejouer, compter les cas qui tombent, écrire le nombre.
5. Non-régression **du module seul** :
   `npx vitest run src/__tests__/unit/network-v2/firewall/`.
6. Au moins une spec **Playwright** par phase (voir P5).
7. Typecheck ≤ base, lint identique fichier par fichier.
8. Journal + carnet + BRD si la mesure l'a contredit.
9. Commit, push.

**Base de référence au dernier commit** : typecheck **347** erreurs
(le chiffre monte quand la branche intègre d'autres travaux — le
comparer, jamais le supposer).

---

## 8. Historique des mises à jour de ce carnet

| Date | Auteur | Ce qui change |
|---|---|---|
| 2026-08-22 | agent `mandeng` | Le MTU de sortie est respecté (E59). Décisions D76 à D78. **`set mtu` était stocké, rendu, et lu par personne** — plus large que ce que l'entrée annonçait. DF posé donne un ICMP Fragmentation Needed portant le MTU, DF absent donne de vrais fragments RFC 791. |
| 2026-08-22 | agent `mandeng` | La santé SD-WAN a enfin des consommateurs (E58). Décisions D72 à D75. Les deux entrées ouvertes nommaient le MÊME chaînon manquant : la mesure existait, l'événement non. La route de zone suit la santé (`update-static-route`), et la session du membre mort est fermée. |
| 2026-08-22 | agent `mandeng` | Les deux vues OSPF du §20.2 (E57). Décisions D70 et D71. La matière était là en entier ; il manquait le rendu, pris dans la source de FRR plutôt que de mémoire. Deux prémisses de ma sonde étaient fausses — le laboratoire ne formait aucune adjacence. |
| 2026-08-22 | agent `mandeng` | Deux entrées ouvertes fermées (E56). Décisions D66 à D69. **Le verrou d'administration ne comptait rien sur la console** — il était indexé par source, or un vrai FortiGate verrouille le COMPTE. **Le pare-feu était invisible à un `traceroute`** : il ne décrémentait jamais le TTL d'un paquet relayé. |
| 2026-08-22 | agent `mandeng` | TP 23 et TP 24 du tutoriel (E55). Décisions D59 à D65. **TP 23 se joue en entier sans changer une ligne de produit** — le premier échec venait de ma lecture de `diagnose debug flow show console`, qui est un RÉGLAGE et non un affichage. **La sauvegarde « chiffrée » ne l'était pas** : le mot de passe était accepté et jeté, les deux fichiers octet pour octet identiques. **`config system password-policy` et les bannières de connexion n'existaient pas.** |
| 2026-08-17 | agent `mandeng` | Création. État après phase 1, décision D10, plan de phase 1b et 2. |
| 2026-08-17 | agent `mandeng` | Phase 3 livrée (E33). Décisions D11 à D14, pièges P7 à P11, §6.4 (ce qui reste de la phase 3). |
| 2026-08-17 | agent `mandeng` | Phase 4 livrée (E34), badge retiré. Décisions D15 à D21, pièges P12 à P15, §6.5 (ce qui reste de la phase 4). |
| 2026-08-17 | agent `mandeng` | Phase 5 livrée (E35). Décisions D22 à D27, §6.6 (ce qui reste de la phase 5). |
| 2026-08-18 | agent `mandeng` | Phase 8 livrée (E38). §6.9. **Socle : IKE calcule un vrai DH ; 3DES se déchiffre.** Deux affirmations du BRD corrigées après vérification. |
| 2026-08-18 | agent `mandeng` | Phase 7 livrée (E37). §6.8. Pile TCP sur le pare-feu. **LDAP était déjà écrit (chantier AD) — le BRD se trompait, corrigé.** |
| 2026-08-18 | agent `mandeng` | Phase 6 livrée (E36). §6.7 (refus assumés, ce qui reste). Trois défauts de socle corrigés (clé de session post-NAT, inspection hors du premier paquet, enfants de type objet). |
| 2026-08-19 | agent `mandeng` | Phase 13 livrée (E50). **Les collecteurs syslog émettent pour de bon**, et leur chemin CLI était faux (`setting`/`filter` sont frères). |
| 2026-08-20 | agent `mandeng` | Phase 14 livrée (E51). **Le pare-feu héberge un vrai serveur SSH et telnet**, et `allowaccess` devient un filtre local-in par port de destination — il était stocké et lu par personne, comme les sept réglages d'administration de `config system global`. Piège P14 retiré : la limite de 800 lignes par fichier (NFR-M3, garde-fous G1 et G3) est supprimée. |
| 2026-08-21 | agent `mandeng` | Phase 15 livrée (E52). **`pba-timeout` périme vraiment un bloc de ports** — et `overloadMappings` fuyait, inséré sous une clé et supprimé sous une autre. **Le TYPE d'un VIP gouverne** : `fqdn` est commis avec `set mapped-addr`, `dns-translation` est refusé en nommant le relais DNS de transit manquant (`TODO.md`). Le client DNS du pare-feu est RÉUTILISÉ, pas réécrit : une première version en doublait `FirewallDnsClient` et a été supprimée avant commit. |
| 2026-08-24 | agent `mandeng` | Phase 27 livrée (E73). **Une politique IPv6 juge un paquet IPv6.** La mesure confirme l'entrée et trouve deux défauts qu'elle ne nomme pas : `AddressObject.family` était écrit et LU PAR PERSONNE, et les cinq comparateurs passaient par `tryIpToUint32` — donc un candidat v6 ne pouvait correspondre qu'à `any`, **et y correspondait**, `kind === 'any'` sortant avant toute vérification de famille : une règle `all` → `all` écrite pour v4 jugeait du trafic v6. **Décision de périmètre RENVERSÉE par la vérification avant d'écrire une ligne** : cette phase annonçait `config firewall policy6`, or Fortinet l'a RETIRÉE en 6.4 et `FortiProfile.defaultVersion` vaut 7.6.3 — c'est la politique UNIFIÉE (`srcaddr6`/`dstaddr6`) qui est écrite, et c'est aussi la meilleure conception. **La réponse est permise par la SESSION**, portée par la table existante — `FlowKey` prend des `string` et accueille l'IPv6 sans modification. **Défaut de socle trouvé en chemin** : `EndHost` répondait à un écho depuis sa PREMIÈRE adresse globale, alors que RFC 4443 §4.2 impose l'adresse à laquelle la requête était adressée — invisible tant que rien ne vérifiait la source d'une réponse. |
| 2026-08-24 | agent `mandeng` | Phase 26 livrée (E72). **Le pare-feu parle IPv6 pour lui-même.** Le report ne visait que `execute ping6` ; la mesure trouve qu'IPv6 manquait en ENTIER — pas d'adresse, pas de NDP, pas de table v6, et un `PacketContext` déclarant une union `IPv4Packet | IPv6Packet` dont le second membre n'était jamais construit. **Aucun second ICMPv6 n'a été écrit** : `router/IPv6DataPlane.ts` est un plan de données complet bâti sur un port étroit, et il portait déjà `sendEchoRequest()` ; `l3/FirewallIpv6.ts` remplit ce port en quatre délégations vers `Equipment`. **Le verrou de transit est la décision structurante** : le moteur de politiques est v4 seulement, donc `ipv6FilterPermits` répond `false` en sortie — un paquet v6 qu'aucune politique ne peut juger ne traverse pas, ce qui est le refus implicite d'un vrai FortiGate et la posture « fail closed » du dépôt ; héberger le plan de données sans ce verrou aurait ouvert le pare-feu. Le même crochet, en entrée, fait de `ip6-allowaccess` une vraie porte, et il ne récuse QUE l'écho — écarter tout ce qui n'est pas pour nous aurait bloqué les sollicitations de voisin, donc NDP. **Mesure écrite plutôt que masquée** : le premier écho reste sans réponse, le voisin devant résoudre notre adresse L2 en sens inverse — ma première rédaction exigeait `0% packet loss` et c'est elle qui avait tort. |
| 2026-08-24 | agent `mandeng` | Phase 25 livrée (E71). **Une zone SD-WAN suit ses MEMBRES, et un membre référencé ailleurs est refusé.** Les deux reports `[sdwan]` étaient VRAIS — première fois depuis longtemps — mais la mesure trouve un troisième défaut qu'aucun ne nomme : `delete` d'un membre ne retirait ni le membre ni sa route, donc le pare-feu aiguillait vers un membre supprimé. **Les trois ont une seule cause** : `SdwanService.apply()` ne faisait que `set` alors qu'`onCommit` lui passe la configuration COMPLÈTE — une méthode qui reçoit l'état voulu et se contente d'ajouter accumule au lieu de réconcilier. **Aucun moteur neuf pour le refus** : ma première écriture a créé un index de références nourri à la main, SUPPRIMÉ avant commit parce que `runtime/references.ts` existe, parcourt l'ARBRE en lisant les `referenceTo` du schéma (donc couvre toutes les tables, pas les quatre que j'avais listées) et rend déjà les lignes attestées ; il n'avait qu'une porte, il en a deux — le refus et la vraie commande `diagnose sys cmdb refcnt show`. La vérification n'a démenti qu'une supposition de ma sonde : il n'y a PAS de ligne de total, une référence par ligne et rien du tout s'il n'y en a aucune. |
| 2026-08-24 | agent `mandeng` | Phase 24 livrée (E70). **La bannière s'AFFICHE et s'ACCEPTE, un mot de passe ne se RÉUTILISE pas.** `LoginBanners` était écrit par `commitDevice` et **lu par personne** : ni `pre-login-banner` ni `post-login-banner` ne paraissait sur AUCUNE porte, donc le report « la session s'ouvre sans rien demander » décrivait déjà un défaut plus étroit que le vrai. Les deux crochets attendaient — `ISshServerContext.getBanner?()` non implémenté, `banner()` du contexte telnet rendant `null` en dur. La bannière d'avant-connexion emprunte l'annonce pré-authentification de la pile SSH (donc après le nom, avant le mot de passe, comme un vrai FortiGate en CLI) ; celle d'après-connexion emprunte `motd()` côté telnet et la sortie asynchrone du canal côté SSH — `getMotd()` est déclarée, implémentée quatre fois et LUE PAR PERSONNE, s'y appuyer aurait été s'appuyer sur un accesseur mort. **Le texte est mesuré, pas inventé** : `(Press 'a' to accept):` vient d'une transcription rancid-discuss et des rapports oxidized/netmiko/paramiko qui la reconnaissent. **Deux sémantiques que ma première écriture avait fausses et que la vérification a renversées** : `reuse-password-limit` est un NOMBRE DE REPRISES (0-20) et non une profondeur — la profondeur est `user-history-password-threshold` (3-15, absent d'ici, ajouté) — et `min-change-characters` compte les caractères ABSENTS de l'ancien mot de passe, non une différence par position : un mot de passe RETOURNÉ n'apporte aucun caractère neuf. |
| 2026-08-24 | agent `mandeng` | Phase 23 livrée (E69). **Le journal dit D'OÙ vient la modification, et le tampon ALERTE.** Les DEUX reports visés étaient faux. `FortiShell` n'est PAS partagé — `createManagementCli` en construit un par session depuis la phase 14 — et les trois seuils ONT chacun leur identifiant réel, en 32xxx (32023/32042/32043) et non en 22xxx où le report les cherchait ; `22023` est `LEAVE_EXTREME_LOW_MEM_MODE`, un autre sujet. **La porte descend jusqu'au shell** (`createCli(user, origin)`) au lieu de s'y deviner : `ssh(<adresse>)`, `telnet(<adresse>)`, `jsconsole`. Une session relayée par la grappe reporte `jsconsole`, et c'est un choix — `execute ha manage` donne une VRAIE session locale sur le membre distant, inventer un mot pour « venu du lien de grappe » aurait été une valeur que personne n'a vue. **Le franchissement se garde de lui-même** : sans drapeau, l'alarme écrite relancerait le calcul et le tampon se remplirait de ses propres alarmes. |
| 2026-08-23 | agent `mandeng` | Phase 22 livrée (E68). **Le battement de cœur porte une VOIE DE COMMANDE.** FGCP n'avait qu'une annonce à sens unique : `execute ha manage` rendait `Connecting to…` et la main, `execute ha synchronize start` sur un secondaire n'attirait rien. Deux entrées `[ha]` de `TODO.md` se ferment par UN mécanisme — `fgcp-command-request`/`fgcp-command-reply` sur le même ethertype. **La voie passe sur le FIL** (le report craignait qu'un registre partagé le contourne : c'est pour cela qu'elle n'en est pas un), et l'échange est synchrone parce que la livraison de trames l'est. **L'authentification est évaluée chez la CIBLE et la session tient à un JETON** : une première version ré-authentifiait à chaque ligne sans mot de passe à présenter — soit une porte ouverte, soit rien qui passe. `createManagementCli` et `management.login()` sont RÉUTILISÉS, aucun second chemin d'exécution n'est écrit. Un cas durci après discrimination : « câble coupé » passait sur `/fail/`, le mot de passe tapé en clair étant alors une commande inconnue. |
| 2026-08-23 | agent `mandeng` | Phase 21 livrée (E67). **Un datagramme fragmenté est RECOLLÉ avant la politique.** Le pare-feu fragmentait à la sortie et ne recollait jamais à l'entrée : `IPv4Reassembler` existe dans le socle, `Router` s'en sert, le pare-feu n'avait aucun appelant. Le report du `TODO` — « il faut d'abord décider QUAND » — est re-mesuré et tombe : la documentation de Fortinet dit que la défragmentation existe « so that policy can be applied to reassembled packets ». **Deux cas écrits comme décisifs passaient AVANT le correctif**, et pour une raison imprévue : sous une politique permissive, un pare-feu qui ne recolle pas transmet quand même les fragments et c'est le SERVEUR qui les recolle — seule une politique nommant le port montre le défaut, les fragments 2 et 3 ne le portant pas. Trois pièges mesurés : DF est posé par défaut sur tout UDP sortant (donc rien n'arrivait), et ni la borne mémoire ni un jeu incomplet ne se produisent depuis une maquette — livraison synchrone, leviers de perte probabilistes — donc ces deux cas sont au niveau du module et le disent. `set ip-fragment-mem-thresholds` (32-2047 M, défaut 32) BORNE vraiment, et évince le jeu le PLUS ANCIEN. |
| 2026-08-23 | agent `mandeng` | Phase 20 livrée (E66). **Un VIP de répartition choisit un serveur, et il le choisit VIVANT.** `set type server-load-balance` était refusé depuis E52, sur une prémisse FAUSSE — le TODO disait « aucune brique à réutiliser » alors que trois existaient : le point d'accroche unique du DNAT (qui inscrit déjà son choix dans la session, donc la persistance était gratuite), `FirewallPing` et `dialTcp`. `SdwanHealthProbe` est examiné et écarté avec sa raison. `least-rtt`, `http-host` et les moniteurs applicatifs sont REFUSÉS en nommant leur brique — les accepter marquerait chaque serveur vivant sans le lui demander. **La leçon est dans l'observable** : le client compose le VIP et voit le VIP (le retour est dé-traduit), donc trois cas de la sonde mesuraient le VIP au lieu du choix ; le choix est une décision du pare-feu et se lit dans sa session. |
| 2026-08-23 | agent `mandeng` | Phase 19 livrée (E65). **La configuration garde son HISTORIQUE.** `execute revision` n'existait pas, `execute restore config flash <id>` était refusée, et `revision-backup-on-logout` — le réglage qui CRÉE une révision — était absent du schéma. Rien n'est écrit pour restaurer : le chemin de restauration savait déjà rejouer un texte de configuration à travers la vraie CLI. La déconnexion est branchée aux DEUX endroits où une session d'administration se termine (SSH/telnet et console), pas à un seul. **Deux points fermés au passage** : `vdom-mode` est désormais CACHÉE comme sur un vrai 7.4/7.6 — c'était le point que la phase 18 avait laissé en le disant sûr — et `FORTI_CLI_LOGOUT`, sentinelle produite par `exit` et consommée par PERSONNE, est supprimée plutôt que branchée. |
| 2026-08-23 | agent `mandeng` | Phase 18 livrée (E64). **Le pont du mode transparent apprend, VIEILLIT, et se lit.** La table était un `Map<string, string>` : aucun horodatage donc aucun vieillissement (une entrée vivait jusqu'à l'extinction), aucune vue pour la lire, une seule instance pour tout le châssis là où un vrai FortiGate en porte une par VDOM, et rien ne la purgeait quand un port tombait. `l2/BridgeFdb` porte les quatre, l'expiration étant calculée à la LECTURE (G5 interdit les minuteurs bruts). `diagnose netlink brctl list|name host <vdom>.b` rend les colonnes du vrai outil, `ttl` portant le temps qui RESTE. **Le partage avec `Switch.ts` est examiné et écarté avec sa raison**, comme la première règle de `CLAUDE.md` le demande. |
| 2026-08-23 | agent `mandeng` | Phase 17 livrée (E63). **L'inspection lit un FLUX, pas un segment.** `inspectedFlowOf` lisait la charge utile d'UN paquet, donc TOUTE détection UTM se contournait en coupant l'envoi en deux — la signature antivirus comme le nombre magique d'un fichier. `inspection/StreamAssembler` réassemble par CONNEXION et par SENS (la clé de flux était déjà directionnelle), libère son tampon à la fermeture de session, et **ne réassemble PAS UDP** — coller deux datagrammes DNS produirait un message que personne n'a envoyé. La borne est celle du vrai boîtier : `oversize-limit` (défaut 10 Mo, minimum 1) et `set options oversize` ; le défaut laxiste de Fortinet est GARDÉ tel quel. **Le laboratoire a dû être refait** : monté sur `nginx`, il ne prouvait rien — le serveur répondait `400` et fermait avant le second `write`. Un cas a été DURCI après discrimination, la coupure passant désormais au milieu du nombre magique. |
| 2026-08-23 | agent `mandeng` | Phase 16 livrée (E62). **La charge est MESURÉE et le mode conserve engage.** Trois vues promettaient une mesure et lisaient la même constante gelée — CPU figé à `idle: 100`, mémoire utilisée NULLE, donc un mode conserve structurellement impossible. `health/SystemLoad` dérive la charge de ce que l'équipement porte et fait ; `FirewallProfile.chassis` déclare RAM, CPU et débit une seule fois pour les trois constructeurs. **Les seuils étaient faux** (88/82/78 au lieu de 95/88/82) et ne se réglaient pas. Le mode conserve a une CONSÉQUENCE : session refusée au seuil extrême, `av-failopen` (mandataire, échoue OUVERT par défaut) et `ips global fail-open` (flux, échoue FERMÉ) au seuil rouge — polarités opposées, comme sur un vrai boîtier. Trois lignes inventées retirées de `get system performance status`. Deux erreurs de mon propre modèle corrigées en lisant la sortie : `utilisé + libre + libérable = total` (trois catégories DISJOINTES), et un tampon de journaux réservé n'est pas réclamable. |
| 2026-08-19 | agent `mandeng` | Phase 12 livrée (E49). **Le portail captif détourne pour de bon**, et un défaut du socle TCP tombe avec : `transmit` sourçait un segment par le ROUTAGE au lieu de `socket.localIp`. |
| 2026-08-19 | agent `mandeng` | Phase 11 livrée (E46 à E48). **Tous les points ouverts de la phase 2 sont fermés.** **BGP : le refus de la phase 10 reposait sur une prémisse fausse de ma part** — le pare-feu a un `TcpStack` depuis la phase 7. **DHCP : `onCommit` était vide**, le serveur sert maintenant de vrais baux et `mode dhcp` est un vrai client. |
| 2026-08-21 | agent `mandeng` | Le panneau « Live state » lit le pare-feu (E43). Decisions D53 a D55. **Toutes ses sections rendaient « (empty) »** pour une machine qui portait au meme instant une interface adressee, une entree ARP et une pile TCP ; le PC voisin, lui, montrait les siennes. |
| 2026-08-21 | agent `mandeng` | Sauvegarde, restauration, remise a zero (E42). Decisions D50 a D52. Le fichier traverse le vrai reseau par TFTP ; la remise a zero rejoue les DEFAUTS et rend le mot de passe vide. |
| 2026-08-21 | agent `mandeng` | Le renifleur au fil de l'eau (E41). Decisions D47 a D49. **`diagnose sniffer packet` ecrit paquet par paquet et Ctrl+C l'arrete**, dans un terminal ; hors terminal il garde son texte d'un bloc. |
| 2026-08-21 | agent `mandeng` | Sortir de la machine (E40). Decisions D44 a D46. **`execute traceroute` n'avait jamais fonctionne** — somme de controle IPv4 calculee pour un TTL de 64 puis TTL remplace, donc toute sonde jetee au premier saut ; la meme machine au meme instant repondait au `ping`. `execute ssh`/`telnet` branches sur la machinerie de client existante. |
| 2026-08-21 | agent `mandeng` | Sortie de console et reglages (E39). Decisions D38 a D43. **`exit` referme ce que `login` avait ouvert**, `config system console` existe et ses deux reglages AGISSENT, `execute reboot`/`shutdown` demandent confirmation et font un vrai cycle d'alimentation. Mesure corrigee en chemin : l'historique et l'edition de ligne fonctionnaient deja — la premiere lecture les croyait absents parce que le pager `--More--` avalait les touches. |
| 2026-08-21 | agent `mandeng` | Confort de CLI et console de premier démarrage (E37, E38). Décisions D31 à D37. **La console demande un login et force le mot de passe vide**, et un défaut du socle tombe avec : `authenticateAdmin` comparait `secrets.get(name) === password`, donc un compte SANS entrée de secret ne pouvait accepter aucun mot de passe, pas même le vide — le compte d'usine était inauthentifiable. |
| 2026-08-19 | agent `mandeng` | Phases 9a/9b/10 livrées (E43, E44, E45). **`OSPFEngine.activateInterface` rendu idempotent dans le socle partagé** — quatre appelants portaient la même garde, donc c'était au moteur de la porter. **`convergeDynamicRouting()` écrit puis supprimé** : les deux bouts ont de vrais minuteurs, la sonde avance une horloge. **Prémisse fausse corrigée, et elle était la mienne** : une note de périmètre attribuait au BRD §22.3 un refus de RIP/OSPF qu'il ne contient pas (§19.3 disait déjà « les moteurs existent, le travail est de les brancher »). Jumelle de la leçon LDAP/DH : on vérifie une citation avant de la répéter. Format de `get router info routing-table all` corrigé en CIDR après vérification chez Fortinet. |
