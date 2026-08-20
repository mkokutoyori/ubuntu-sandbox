# PRD — La console qui ne s'arrête jamais

## 0. Ce qui a été mesuré

Un rapport décrit un navigateur qui meurt pendant un collage, et une console
de routeur qui se remplit seule :

```
*Aug  6 14:49:12.972: %PORT-4-WARNINGS: GigabitEthernet0/0: port is down, frame dropped
*Aug  6 14:49:12.972: %PORT-4-WARNINGS: GigabitEthernet0/0: port is down, frame dropped
```

Le rapport avance trois causes. **Deux sont exactes et tracées jusqu'à la
ligne ; la troisième n'a pas pu être reproduite** et est dite telle quelle
plutôt que corrigée à l'aveugle.

---

## 1. Le message n'aurait jamais dû exister — **CONFIRMÉ, et tracé**

La chaîne complète, de la trame à l'écran :

1. `Port.receiveFrame()` (`hardware/Port.ts`) : une trame arrivant sur un
   port arrêté incrémentait `counters.dropsIn` **et** appelait
   `Logger.warn(equipmentId, 'port:recv-blocked', '<if>: port is down,
   frame dropped')` — **une fois par trame**, sur le chemin de données le
   plus chaud du simulateur.
2. `Logger.warn` publie `{topic:'log', level:'warn', event, message}`.
3. `LoggingConfig`'s pont générique (`logHandler`) promeut **tout** `warn`
   interne en message syslog : `this.append('warnings',
   tagFromEvent(event), message)`.
4. `tagFromEvent('port:recv-blocked')` → `port`, et `formatEntry` compose
   `%${tag.toUpperCase()}-${sevNum}-${mnemonic ?? severity}` →
   **`%PORT-4-WARNINGS`**.

Le rapport a raison sur les deux griefs, et pour la même raison :
`%PORT-4-WARNINGS` n'est pas une facilité IOS, et son mnémonique
(`WARNINGS`) n'est que le nom de la sévérité — la ligne est **fabriquée
par le pont**, pas écrite par quelqu'un. Et l'événement lui-même n'a pas
à être journalisé : un vrai routeur **compte** une trame jetée sur une
interface éteinte — ce sont les `input drops` de `show interfaces` — et
n'en dit rien.

**Correctif.** Le `Logger.warn` disparaît des deux points d'appel de ce
type : `Port.receiveFrame` (port arrêté) et `Cable.transmit` (câble
coupé, câble incomplet), tous trois par trame. Le compteur reste,
l'événement de bus reste, la ligne de console s'en va. La correction
n'est pas de rendre le message plus réaliste, c'est de ne pas l'écrire.

Ce que ce correctif ne fait PAS, et il faut le dire : le pont générique
continue de fabriquer une facilité à partir de n'importe quelle étiquette
interne. Tarir la source la plus bruyante n'assainit pas le pont. Le
restreindre à une liste de facilités réelles est un lot distinct, plus
large, qui touche tout ce qui journalise aujourd'hui par ce chemin.

---

## 2. `logging rate-limit` ne limitait rien — **CONFIRMÉ**

`LoggingConfig.rateLimit` était **stocké et lu par personne** : la
commande était analysée, rangée dans un champ, et aucun code ne la
consultait. Le plafond que réclame le rapport existait donc en syntaxe
seulement.

Il est réel maintenant, et borné à ce qu'IOS borne : **les sorties temps
réel** — console et `terminal monitor` — jamais le tampon ni le relais
syslog. C'est le débit vers un écran qu'IOS protège ; jeter la trace en
même temps ferait perdre l'information qu'on cherche justement à lire
après coup.

Ce qui est refusé n'est pas perdu en silence : le compte des messages
supprimés est porté par la première ligne qui repasse, sous
`%LOGGING-4-RATELIMIT: N messages rate-limited`.

**Choix assumé** : aucun plafond n'est appliqué par défaut. IOS n'en
applique pas, et en inventer un ferait diverger le simulateur d'une
machine réelle sur un point observable. La protection demandée existe
désormais — `logging rate-limit 10` — mais elle se configure, comme sur
un vrai routeur.

---

## 3. Chaque message en double, et de plus en plus — **NON REPRODUIT**

Le rapport lit une accumulation d'abonnements, et l'explication proposée
(React StrictMode montant deux fois sans nettoyage) est plausible en
soi. Elle ne s'applique pas ici : **il n'y a pas de `StrictMode`** dans
`main.tsx`, `useNetworkLogs` nettoie bien son abonnement
(`return () => Logger.unsubscribe(id)`), `TerminalManager` n'appelle
`init()` qu'une fois par session, et la même séquence rejouée en test ne
produit qu'une occurrence de chaque `%LINK`/`%LINEPROTO`.

Ce que j'ai fait quand même, parce que c'est gratuit et que ça ferme la
classe entière : **`CiscoTerminalSession.startConsoleLogging` est
idempotent**. Un second appel REMPLACE l'abonnement au lieu de s'y
ajouter. Un abonnement qui s'accumule ne se voit pas — il se compte,
chaque message sortant une fois de plus que la fois d'avant.

Je ne prétends pas avoir corrigé le doublon observé : je n'ai pas su le
reproduire, et le tarissement de la source (§1) suffit à expliquer que
le symptôme disparaisse, doublon ou pas.

---

## 4. Le format d'uptime — **CONFIRMÉ, et pire que signalé**

`Router1 uptime is 00:00:12` ne vient d'aucun des deux rendus du dépôt —
mais les deux étaient faux, et différemment :

* `CiscoShowCommands.formatUptime` répondait `0 minutes` sous la minute,
  là où IOS **compte les secondes** (`12 seconds`) ;
* `CiscoCommonShow` écrivait toujours `N days, N hours, N minutes`, même
  à zéro : `0 days, 0 hours, 3 minutes` là où IOS écrit `3 minutes`.
  Aucun des deux ne connaissait la **semaine**, qu'IOS utilise
  (`2 weeks, 3 days, 5 hours, 12 minutes`).

Deux rendus d'une même grandeur finissent par se contredire ; il n'en
reste qu'un, `formatIosUptime`, partagé par le routeur et le switch.

---

## 5. Le scrollback — **déjà borné, laissé tel quel**

Le rapport demande un plafond de 500 à 1 000 lignes. Il en existe déjà
un : `MAX_SCROLLBACK_LINES = 5000`, réglable depuis la fenêtre du
terminal, et chaque ligne est rendue sous `content-visibility: auto`
(voir `CLAUDE.md`, rapport 09 item #53) — le navigateur ne met en page
que ce qui approche du viewport. Abaisser un défaut réglable par
l'utilisateur est une décision produit, pas une correction de défaut :
elle n'est pas prise ici, et le chiffre est dit pour qu'elle puisse
l'être en connaissance de cause.

---

## 6. Discrimination

`probe-console-flood.test.ts` (18 cas) au `git stash` : **15 échouent
authentiquement avant le correctif**. Les 3 qui passent des deux côtés
sont les cas de non-régression (compteur `dropsIn`, absence de plafond
par défaut, tampon complet malgré le plafond).
