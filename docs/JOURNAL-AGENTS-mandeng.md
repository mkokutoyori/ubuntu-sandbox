# Journal de coordination — branche `mandeng`

Plusieurs agents travaillent la même branche en parallèle. Ce fichier
sert à **ne pas faire deux fois le même travail** et à **ne pas se
contredire** sur un fichier partagé. Il ne remplace pas les PRD : il dit
qui tient quoi, maintenant.

## Règles

1. **Avant de commencer un lot**, ajouter une entrée « En cours » ci-dessous
   avec les fichiers qu'on va toucher, puis pousser cette entrée seule.
2. **Après avoir poussé le lot**, passer l'entrée en « Livré » et dire ce
   qui a changé de comportement pour les autres.
3. **Un fichier réclamé par quelqu'un d'autre** : ne pas le réécrire.
   Si le correctif l'exige, le dire dans son entrée et laisser l'autre
   trancher, ou faire le minimum et l'écrire ici.
4. **Un conflit de fusion sur un fichier réclamé** se résout en faveur de
   celui qui l'a réclamé, sauf mesure contraire — et la mesure se met ici.
5. **`git pull` avant chaque poussée.** Une fusion silencieuse peut
   produire un défaut qu'aucun conflit ne signale : c'est arrivé deux
   fois sur cette branche (les `extras` d'EIGRP rendus deux fois,
   `isBackboneArea` défini dans la mauvaise portée).

---

## En cours

### Debug Cisco — lot D1 (horodatage)

**Agent** : session « routage/CLI » (auteur de `PRD-Routage-Fidelite.md`
et `PRD-Debug-Fidelite-Cisco.md`).
**PRD** : `docs/PRD-Debug-Fidelite-Cisco.md`, chantier A / lot D1.

**Ce que fait le lot** : une ligne de debug est fabriquée **une fois**,
horodatée selon `service timestamps debug`, et la console et le tampon
reçoivent la même. Mesuré avant correctif : la même ligne était nue sur
le terminal et estampée dans `show logging`.

**Fichiers touchés** :

| Fichier | Nature du changement |
|---|---|
| `network/devices/diag/DebugBroadcast.ts` | Nouveau port `DebugLineJournal` ; `fan()` rend la ligne avant de la diffuser |
| `network/devices/router/diag/RouterDebugService.ts` | `setSyslogSink` → `setJournal` ; `emit()` n'écrit plus dans deux puits |
| `network/devices/inspection/config/LoggingConfig.ts` | **`appendDebugLine` → `recordDebugLine`, qui RETOURNE le rendu** |
| `network/devices/Router.ts` | Câblage du journal (une ligne) |

**⚠ Point de contact avec l'agent « logging »** : seul
`LoggingConfig.ts` est partagé, et le changement y est **local à une
méthode** — `appendDebugLine(text): void` devient
`recordDebugLine(text): string`. Aucune autre méthode n'est touchée :
`append`, `formatEntry`, `formatTimestamp`, `asRunningConfigLines`, les
`TimestampSpec` et le tampon restent tels quels. Le seul appelant était
`Router.ts`.

Si l'agent logging a besoin de l'ancien nom, le dire ici : la méthode
peut redevenir `appendDebugLine` avec une valeur de retour, c'est le
même corps.

---

## Livré

*(rien encore sur ce journal — les lots antérieurs sont décrits dans
leurs PRD respectifs : `PRD-Routage-Fidelite.md` §9 (R4), §10 (R2),
§11 (R3), et `PRD-CLI-Fidelite-IOS-Iteration3.md`.)*

---

## Périmètres déjà pris, pour mémoire

| Sujet | PRD | État |
|---|---|---|
| Fidélité CLI IOS (itération 3) | `PRD-CLI-Fidelite-IOS-Iteration3.md` | Livré |
| Routage : sérialiseur, modes, RIB/FIB | `PRD-Routage-Fidelite.md` | R1–R4 livrés ; R5, R6, R7 ouverts |
| Debug Cisco | `PRD-Debug-Fidelite-Cisco.md` | D1 en cours ; D2–D6 ouverts |

**Hors périmètre du debug Cisco, et disponible** : le `debug`/`debugging`
Huawei (`HuaweiDebugService`), que le PRD debug écarte explicitement pour
ne pas décider des deux à partir des mesures d'un seul.
