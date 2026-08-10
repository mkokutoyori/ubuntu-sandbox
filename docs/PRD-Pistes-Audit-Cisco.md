# Les pistes d'audit Cisco — la trace de changement de configuration

Le tutoriel « Les Pistes d'Audit sur Cisco » rejoué contre le simulateur.

## 1. Ce que la mesure a trouvé

La mesure de départ est inhabituelle pour ce dépôt et mérite d'être dite
telle quelle : **les 65 commandes de configuration du tutoriel sont
toutes acceptées, et la plupart sont honorées.** Syslog est complet
(deux collecteurs, TCP et UDP distingués, `facility`,
`source-interface`, tampon dimensionné, sévérité), SNMPv3 fonctionne
(groupe, utilisateur, `auth sha`/`priv aes`), NTP rend de vraies
associations, l'archivage écrit de vrais fichiers sur `flash:`, et EEM
déclenche réellement ses applets sur motif syslog.

Ce qui ne fonctionnait pas tenait en une phrase : **la trace ne nommait
personne et ne se relisait pas.**

| Constat mesuré | Conséquence pour un auditeur |
|---|---|
| `log config` et ses quatre réglages acceptés, rangés, et **rien n'est jamais retenu ni annoncé** — aucun `%PARSER-5-CFGLOG_LOGGEDCMD` n'existait dans le dépôt | La seule trace de « qui a tapé quoi » qui n'exige aucun serveur ne produit rien |
| `logging size` rangé et **rendu nulle part** | Perdu au rechargement d'une topologie |
| `show archive log config` **n'existe pas** | Le journal n'a pas de porte |
| `show archive config differences` enregistrée **sans argument** et rendant une **phrase** au lieu d'un diff | « La commande la plus utile pour un auditeur » ne compare rien, et la forme du tutoriel est refusée |
| Le port de stockage ne sait qu'**écrire** | Le contenu archivé n'est relu par personne, donc aucun diff n'est calculable |
| `dir flash:archive/` **ignore le répertoire** et liste la racine | Réponse fausse à une question précise de la collecte de preuves |
| `show who` répond `% Invalid input` | Une étape de la séquence de collecte s'arrête |

## 2. Le journal de configuration (§3 du tutoriel)

`ArchiveService` retient désormais des enregistrements — index, session,
utilisateur, ligne, commande, horodatage — et le shell l'alimente depuis
le point où toute commande passe déjà.

**On journalise sur le mode d'AVANT la commande**, ce qui est ce que
fait IOS : `configure terminal` n'est pas une commande de configuration
(on n'y est pas encore quand on la tape), tandis qu'`interface Gi0/0` en
est une bien qu'elle change de mode.

**Une commande refusée n'entre pas au journal.** La retenir ferait lire
à l'auditeur une modification qui n'a pas eu lieu — un faux positif dans
une piste d'audit coûte plus cher qu'une absence.

**`hidekeys` masque à l'ÉCRITURE, pas à l'affichage.** Un journal qui
retiendrait le secret en clair pour le cacher ensuite serait exactement
la fuite que cette option existe pour empêcher, et il suffirait d'une
autre vue pour l'exposer. Le masquage vaut donc aussi pour le message
syslog, qui part vers un collecteur externe.

**Le journal est circulaire**, et `logging size` le borne vraiment :
sans cette borne, le réglage serait une valeur que rien ne lit et le
journal grossirait sans fin.

Le message est celui d'IOS, attesté par plusieurs captures
indépendantes : `%PARSER-5-CFGLOG_LOGGEDCMD: User:console logged
command:interface loopback 0`. Le tutoriel l'écrit avec une espace après
`User:` ; les captures réelles n'en ont pas, et c'est la capture qui
tranche.

**Sans `notify syslog`, rien n'est annoncé — mais tout est retenu.** Les
deux moitiés sont distinctes sur une vraie machine et le restent ici :
`logging enable` décide qu'on retient, `notify syslog` décide qu'on
prévient.

## 3. Comparer deux configurations (§4)

`show archive config differences [<avant> [<après>]]`.

- **Sans argument** : la dernière archive contre la configuration
  courante — « qu'est-ce qui a bougé depuis la dernière sauvegarde ? »,
  la question qu'on pose le plus souvent.
- **Un argument** : la dernière archive contre le fichier nommé. Le
  comparer à lui-même, ce que faisait la première version de ce
  correctif, ne différerait jamais de rien.
- **Deux arguments** : les deux fichiers nommés.

Le rendu est le diff contextuel d'IOS : une ligne retirée porte `-`, une
ajoutée `+`, et **la ligne de contexte qui les porte est répétée sans
signe**. C'est ce qui distingue « `shutdown` a disparu » de « `shutdown`
a disparu SUR Fa0/2 », la seule des deux qui soit une information.

**Le préambule n'est jamais compté.** `Current configuration : 729
bytes` change dès qu'une lettre change ailleurs, et `Building
configuration...` n'appartient pas à la configuration. Les garder ferait
de chaque diff un diff qui signale toujours au moins deux différences
dont aucune n'est une modification — l'auditeur apprendrait à ne plus
les lire.

Un fichier introuvable est **nommé** (`%Error opening <chemin> (No such
file or directory)`) plutôt qu'ignoré.

## 4. La collecte de preuves (§9)

`dir flash:<répertoire>/` liste le répertoire demandé, et rend le nom
**relatif** à ce répertoire, comme une vraie machine. L'argument ne
servait qu'à écrire l'en-tête.

`show who` est le synonyme historique de `show users`. Le rendu est le
même parce que c'est la même question : deux textes pour une question
feraient douter de la machine.

## 5. Trouvé en passant

Un test — `probe-archive-et-rate-limit.test.ts` — attendait
`Differences between latest two archives (3 → 4)`, c'est-à-dire la
**phrase** que rendait `formatShowArchiveDiff` à la place d'un diff : il
encodait le défaut comme contrat. Il éprouve désormais ce que la
commande promet.

Trois arguments des chantiers précédents (`enable view`, `parser view`,
`login-timeout`) n'avaient pas de description propre, si bien que `?`
recopiait celle du parent : `parser view ?` répondait « Define a CLI
view », qui décrit la commande et non ce qu'il faut taper ensuite.

## 6. Ce qui reste ouvert, et pourquoi

Écrit ici plutôt que découvert.

- **NTP** — délibérément non traité dans ce chantier : un autre agent y
  travaille en parallèle. La mesure ne lui a d'ailleurs trouvé aucun
  défaut : `show ntp status` et `show ntp associations` rendent de
  vraies valeurs, l'absence de synchronisation immédiate venant de la
  scrutation à 64 s.
- **L'accounting AAA (§3) émet désormais**, et le serveur déclaré à
  l'ancienne authentifie — voir §8 ci-dessous.
- **`show tacacs` voit désormais les deux formes** — voir §8.
- **`verify /md5 flash:<fichier>` répond `% Incomplete command`** —
  contrôle A22. Le système de fichiers sait désormais relire un
  fichier, donc le calcul est possible ; mais une image IOS n'a pas de
  contenu ici, et une somme MD5 sur un fichier vide serait une fausseté
  vérifiable — c'est déjà la réserve que `CiscoFileSystem` écrit dans
  son propre en-tête.
- **`show snmp user` affiche `AES` là où le tutoriel configure
  `aes 256`** : la longueur de clé est acceptée et perdue à
  l'affichage.
- **Les variables EEM `$_cli_username` et `$_remote_inet_address` ne
  sont pas substituées** derrière un `event syslog`, et le code le
  documente comme un choix. Sur ce point le vrai EEM lui donne raison :
  ces variables ne sont définies que pour un déclencheur `event cli`.
  Les exemples du tutoriel les utilisent sous `event syslog`, où elles
  resteraient littérales sur une vraie machine aussi.

## 7. Vérification

`pistes-audit-cisco.test.ts` (19 cas), discriminé par remise en état des
quatre fichiers produit : **15 tombent** avant correctif. Les 4 qui
passent des deux côtés sont nommés dans l'en-tête du fichier — deux sont
les cas de non-régression, les deux autres passaient pour une raison qui
ne prouve rien du mécanisme.

Non-régression : 224 fichiers, 3680 cas.


## 8. L'accounting et le serveur hérité (chantiers refermés)

Les deux points que §6 laissait ouverts sont traités ensemble : ils sont
le même sujet.

**La mesure a été faite contre un TÉMOIN monté dans le même
laboratoire, et c'était nécessaire** : au premier essai les deux formes
échouaient, ce qui aurait fait conclure à un défaut alors que c'était le
laboratoire qui était mal bâti. Avec le témoin, la mesure devient
lisible.

| | authentification | `show tacacs` |
|---|---|---|
| forme moderne (témoin) | réussit | voit le serveur |
| forme héritée | **échoue** | « No TACACS+ servers configured » |

**`tacacs-server host <ip> key <clé>` — la forme la plus tapée de tous
les cours — était rangée dans `legacyHosts`, un tableau que SEUL le
rendu de la configuration lisait.** La machine décrivait donc dans sa
configuration un serveur qu'elle n'avait pas, et un laboratoire monté
entièrement à l'ancienne échouait en silence. Elle alimente désormais le
même magasin que `tacacs server <nom>` ; le serveur n'ayant pas de nom
dans cette forme, c'est son adresse qui sert de clé, comme sur IOS.

**`server <ip>` comme membre de groupe était acceptée et JETÉE** : seul
`server name <nom>` était lu. C'était la cause restante — même une fois
le magasin unifié, le groupe demeurait vide.

**La configuration garde l'orthographe de chaque forme.** `legacySpelling`
est un drapeau de RENDU et non un second magasin : réécrire la forme
héritée en `tacacs server <nom>` déclarerait un nom que l'opérateur n'a
jamais donné, et la configuration est rejouée à l'import d'une topologie.

**Les compteurs de `show tacacs` étaient uniquement lus, jamais
incrémentés** : ils affichaient zéro après une authentification réussie,
donc le contrôle A10 (« échecs = 0 ») ne pouvait rien distinguer. Ils
sont mesurés au point où l'échange a lieu.

**`TacacsClientAgent.accountCommand()` était écrit, correct, et n'avait
aucun appelant de production.** Il est branché sur le point où toute
commande passe déjà. Deux décisions :

- **L'émission n'est pas attendue.** Un opérateur ne doit pas voir sa
  CLI se figer parce qu'un serveur TACACS+ est lent — c'est ce que fait
  `start-stop` sur une vraie machine. `wait-start`, qui bloque, n'est
  pas modélisé.
- **`start-stop` émet deux enregistrements, `stop-only` un seul.** Les
  rendre identiques ferait mentir la configuration sur ce que le
  collecteur reçoit.

**`show accounting` compte ce qui est réellement parti.** Le tutoriel
écrit `show aaa accounting` ; cette commande n'existe pas sur un vrai
IOS, et l'inventer pour coller au tutoriel apprendrait une commande que
la machine réelle refuse. C'est `show accounting` qui est rendue, avec le
tableau « Overall Accounting Traffic ». `Failed accounting` figure dans
`show tacacs` — c'est le contrôle A10.

Reste ouvert et non traité : la forme héritée de RADIUS
(`radius-server host`) est encore dans `legacyHosts`, donc inerte de la
même façon. Le correctif est le même, mais RADIUS a son propre magasin et
ses propres ports d'authentification et de comptabilité — c'est un
chantier jumeau, pas une extension de celui-ci.

`aaa-accounting-et-serveur-herite.test.ts` (13 cas) discriminé : **10
tombent** avant correctif. Non-régression : 245 fichiers, 3832 cas.
