# PRD — Géographie et temps local : un seul fait, toutes les couches

## 0. Ce qui est demandé, et la méthode

Deux notions traversent **toutes** les couches de ce simulateur sans
appartenir à aucune : **où se trouve une adresse** et **quelle heure
il est ici**. Elles sont aujourd'hui écrites plusieurs fois, à des
endroits qui ne se parlent pas, et elles se **contredisent déjà**.

Ce PRD établit ce que chaque protocole et chaque équipement demande à
ces deux notions, puis définit **un seul socle** que toutes les couches
lisent — de la même façon que `core/ports/PortNumber.ts` porte la
notion de port et que `dns/` porte la notion de DNS.

Trois règles, celles de la maison (`CLAUDE.md` §7 et §8) :

1. **Mesuré d'abord**, sur des machines neuves, jamais déduit du code.
   Chaque constat du §1 est un relevé reproductible, daté.
2. **Une commande acceptée qui ne fait rien est pire qu'une commande
   refusée.** Un fuseau stocké et jamais appliqué, un pays déclaré et
   jamais consulté, sont le défaut que ce document referme.
3. **On choisit l'autorité AVANT de la citer.** Le §2 nomme, pour
   chaque décision, le standard adopté ou la documentation du
   constructeur — et dit lequel des deux tranche quand ils divergent.

---

## 1. Le point de départ, mesuré

### 1.1 La mesure qui tranche

Relevé du **2026-09-05T15:33:33Z**, sur un laboratoire neuf, trois
équipements, **un seul fuseau demandé : `Europe/Paris`**.

```
FortiGate (set timezone 4)      → 17:33:34   (UTC+02:00, CEST)
Linux     (timedatectl Paris)   → 16:33:34   (UTC+01:00, « CET »)
Linux     (date, même machine)  → 15:33:34   (UTC, aucun décalage)
Cisco     (clock timezone CEST 2 0) → 17:33:34 (parce que l'opérateur
                                      a tapé « 2 » à la main)
```

**Trois réponses pour une question, dont deux fausses.** Le 5 septembre,
`Europe/Paris` vaut UTC+02:00 : le FortiGate a raison, le Linux a une
heure de retard, et sur cette **même machine Linux** `timedatectl`
annonce `16:33 CET` pendant que `date` répond `15:33 UTC`. Deux
commandes du même système d'exploitation, au même instant, ne
s'accordent pas.

Le Cisco tombe juste **par accident** : l'opérateur a saisi le décalage
d'été à la main. En janvier, la même configuration affichera encore
`17:33 CEST` là où il devrait être `16:33 CET`.

### 1.2 Quatre modèles de fuseau pour un seul fait

| # | Écriture | Fichier | Forme | Heure d'été | Lecteurs |
|---|---|---|---|---|---|
| 1 | Noms IANA + `Intl` | `network/core/Timezone.ts` | nom (`Europe/Paris`) | **réelle**, calculée à la date | pare-feu **seul** |
| 2 | Table manuscrite | `network/devices/linux/time/TimezoneDatabase.ts` | nom + `offsetMin` **fixe** + abréviation | **aucune**, assumée en tête de fichier | Linux `timedatectl`, PowerShell `Get/Set-TimeZone` |
| 3 | Étiquette + décalage | `RouterManagementService.clockCfg` | libellé libre + `offsetMin` + règles d'été **manuscrites** | saisie à la main | Cisco IOS, Huawei VRP, commutateurs |
| 4 | Index numérique | `firewall/vendors/fortios/schema/timezones.ts` | entier `00`–`86` → nom IANA | via #1 | FortiOS `set timezone` |

Le modèle #2 **dit lui-même** sa limite, et l'honnêteté de ce commentaire
est ce qui rend le défaut visible :

> « Les zones à heure d'été y figurent avec leur heure normale : une
> bascule saisonnière demanderait les règles de tzdata, que ce
> simulateur n'a pas […] Conséquence assumée : `Europe/Paris` vaut ici
> UTC+1 toute l'année. »

Ce raisonnement était juste **quand il a été écrit**. Il ne l'est plus :
`core/Timezone.ts` porte depuis les vraies règles, via `Intl`. Le
simulateur **a** tzdata — celui du moteur JavaScript — et une couche
sur deux l'ignore.

### 1.3 Deux défauts mesurés dans le modèle #4

**Soixante-dix-neuf index sur quatre-vingt-sept sont acceptés et
silencieusement convertis en UTC.** La référence FortiOS 6.0.4 écrit
« Number corresponding to your time zone **from 00 to 86** » ; la table
du simulateur en déclare **huit**. Mesuré :

```
FGT # config system global
FGT (global) # set timezone 55        ← accepté, aucun message
FGT (global) # end
FGT # show system global | grep timezone
    set timezone 55                    ← rendu, donc rejoué à l'import
→ moteur : fuseau = UTC                ← la valeur est perdue
```

C'est exactement « stocké, rendu, lu par personne » : la configuration
se transporte, l'effet non.

### 1.4 Ce que chaque couche fait du temps, aujourd'hui

| Couche | Ce qu'elle fait | Verdict |
|---|---|---|
| **Certificats X.509** (`pki/CertificateAuthority`) | `notBefore`/`notAfter` en millisecondes epoch | ✅ correct — un certificat est **toujours** en UTC (RFC 5280 §4.1.2.5) |
| **Kerberos** (`kerberos/KdcSession`) | `authtime`/`endtime`/dérive en secondes epoch | ✅ correct — RFC 4120 impose l'UTC |
| **DNSSEC** (`dns/wire`) | `inception`/`expiration` en secondes epoch | ✅ correct — RFC 4034 §3.1.5 |
| **NTP** (`ntp/NtpAgent`) | horodatages RFC 5905, discipline d'horloge | ✅ correct — NTP est **sans fuseau** par construction |
| **`service timestamps`** (`inspection/config/LoggingConfig:718`) | `new Date(ts + zone.offsetMin * 60_000)` | ⚠️ lit le modèle #3 → jamais d'heure d'été |
| **Syslog sur le fil** (`syslog/SyslogAgent:308`) | `bsdTimestamp(Date.now())` | ❌ **l'horloge de la machine qui exécute le simulateur** — ni l'horloge de l'équipement, ni son fuseau. `clock set` n'a aucun effet sur ce qui part |
| **Horaires de politique** (`firewall/model/ScheduleObject:126`) | `new Date(at).getDay()` / `.getHours()` | ❌ le fuseau du **moteur JavaScript**, pas `set timezone`. Une politique « 08:00–18:00 lundi » se déclenche selon le navigateur |
| **cron** (`linux/cron/CronSchedule:125`) | `at.getHours()` / `at.getDay()` | ❌ idem — `/etc/timezone` est ignoré |
| **Journal FortiOS** (`fortios/log/fortiLogFormat`) | `eventtime` seul, pas de `date=`/`time=` | ⚠️ une vraie machine émet `date=` et `time=` **en heure locale** |
| **`show clock` / `display clock`** | modèle #3 | ⚠️ juste seulement si l'opérateur a saisi le bon décalage saisonnier |
| **Oracle** (`OracleExecutor:4003`) | `SYSDATE` = `new Date().toISOString()` | ❌ toujours UTC ; `DBTIMEZONE`, `SESSIONTIMEZONE`, `ALTER SESSION SET TIME_ZONE` n'existent pas |

Deux familles se dégagent, et **elles ne demandent pas la même chose** :

- celles qui **doivent** rester en UTC (certificats, Kerberos, DNSSEC,
  NTP) — et qui sont déjà correctes ;
- celles qui **rendent** ou **décident** en heure locale (affichage,
  horaires, cron, journaux) — et qui sont toutes fausses ou fragiles.

### 1.5 La géographie n'existe que dans le pare-feu

Le balayage est net : **`countryOf` et `GeoIpOverrides` sont les seuls
porteurs de géographie du dépôt**, et ils vivent sous
`devices/firewall/model/`. Rien d'autre — ni Linux, ni Cisco, ni
Huawei, ni Windows, ni DNS, ni DHCP, ni SNMP — n'a la moindre notion de
lieu.

Or plusieurs couches en **ont un besoin documenté** :

| Porteur | Ce que la norme prévoit | État |
|---|---|---|
| **SNMP `sysLocation`** (`OID_SYS_LOCATION` déclaré) | RFC 3418 §6 : la localisation physique du nœud | l'OID existe, `snmp-server location` est déclaré côté Cisco, **rien ne relie les deux à un lieu** |
| **DHCP option 123 GeoConf** | RFC 6225 : latitude/longitude/altitude avec résolution | absent |
| **DHCP option 99 GEOCONF_CIVIC** | RFC 4776 : adresse civique, avec le **code pays ISO 3166-1** en tête | absent |
| **LLDP-MED Location Identification TLV** | civique ou coordonnées, sur le lien | absent |
| **X.509 `subject`** | RFC 5280 : `C=` (pays), `ST=`, `L=` | le sujet est une **chaîne libre**, pas un nom distinctif structuré |
| **FortiOS `firewall address type geography`** | ISO 3166-1 alpha-2 | ✅ implanté, alimenté par `system geoip-override` |

---

## 2. Les autorités, choisies avant d'être citées

### 2.1 Temps

| Décision | Autorité | Pourquoi celle-là |
|---|---|---|
| Nommage des fuseaux | **base tzdata de l'IANA**, forme `Région/Ville` | C'est le nommage que Linux, macOS, Java et `Intl` emploient ; c'est celui que `timedatectl set-timezone` attend |
| Format des règles | **RFC 9636** (*The Time Zone Information Format*, TZif), qui **obsolète la RFC 8536** | Le format binaire que lisent les UNIX ; sa chaîne de pied de page suit la variable `TZ` de POSIX §8.3 |
| Horodatage syslog moderne | **RFC 5424** §6.2.3 | Exige un `TIMESTAMP` **RFC 3339** complet : année sur quatre chiffres, séparateur `T`, et **décalage explicite** (`Z` ou `±hh:mm`) |
| Horodatage syslog BSD | **RFC 3164** §4.1.2 | N'a **ni année ni fuseau** — c'est une limite du format, pas du simulateur, et elle doit être reproduite telle quelle |
| Validité des certificats | **RFC 5280** §4.1.2.5 | `UTCTime`/`GeneralizedTime`, **toujours** en temps de Greenwich |
| Horodatage Kerberos | **RFC 4120** | UTC, avec une dérive tolérée explicite |
| Signatures DNSSEC | **RFC 4034** §3.1.5 | secondes depuis l'époque, UTC |
| Protocole de temps | **RFC 5905** (NTPv4) | NTP transporte un instant, **jamais** un fuseau |

### 2.2 Vocabulaire par plateforme — la documentation du constructeur fait foi

Aucun de ces quatre dialectes n'est normalisé par l'IETF : ce sont des
CLI propriétaires, donc **la documentation du constructeur tranche**,
et une capture réelle la dépasse quand les deux divergent.

| Plateforme | Forme exacte |
|---|---|
| **Cisco IOS** | `clock timezone <nom> <heures> [<minutes>]` puis `clock summer-time <nom> recurring [<semaine> <jour> <mois> <hh:mm> ×2 [<décalage>]]`. Sans paramètres, `recurring` **retombe sur les règles des États-Unis**. Le `*` de `show clock` signale une horloge **non synchronisée** (réglée à la main, pas par NTP) |
| **Huawei VRP** | `clock timezone <nom> { add \| minus } <hh:mm:ss>` puis `clock daylight-saving-time <nom> { one-year \| repeating } <début> <fin> <décalage>`, où la forme `repeating` accepte `first\|second\|third\|fourth\|last <jour> <mois>` |
| **FortiOS** | `set timezone <00–86>`, un **index** dans une table de 87 entrées que `set timezone ?` énumère |
| **Linux** | `timedatectl set-timezone <Région/Ville>`, `/etc/localtime`, `/etc/timezone`, variable `TZ` |
| **Windows** | `Set-TimeZone -Id "<identifiant Windows>"` — un nommage **distinct** de tzdata (`Romance Standard Time` ↔ `Europe/Paris`), dont la correspondance doit rester **explicite**, jamais devinée |

### 2.3 Géographie

| Décision | Autorité |
|---|---|
| Code pays | **ISO 3166-1 alpha-2** — deux lettres. C'est ce que MaxMind publie (`country_iso_code`), ce que FortiOS attend (`set country-id`, `size[2]`), et ce que la RFC 4776 place en tête d'une adresse civique |
| Forme d'une base IP→pays | **MaxMind GeoLite2 Country CSV** : un fichier de *blocs* (réseau CIDR → identifiant de lieu) et un fichier de *lieux* (identifiant → code ISO), en UTF-8 avec ligne d'en-tête |
| Coordonnées par DHCP | **RFC 6225** (option 123, obsolète la RFC 3825) : latitude, longitude, altitude, **chacune avec ses bits de résolution** |
| Adresse civique par DHCP | **RFC 4776** (option 99) : le champ `what` distingue le lieu **du serveur** (0), **de l'élément réseau le plus proche du client** (1), ou **du client** (2) |
| Localisation SNMP | **RFC 3418** §6 : `sysLocation`, chaîne libre |
| Localisation X.509 | **RFC 5280** : `C`, `ST`, `L` dans le nom distinctif |

---

## 3. Les invariants

Ce sont les règles que le socle doit rendre **impossibles à enfreindre**,
pas des recommandations.

### Temps

- **I-T1 — Une seule table de fuseaux.** Un nom de zone se résout à un
  seul endroit. Les quatre modèles du §1.2 deviennent **une** table et
  **trois portes** (nom IANA, index FortiOS, identifiant Windows).
- **I-T2 — UTC sur le fil, local à l'affichage.** Tout ce qui traverse
  le réseau ou est comparé (certificats, tickets, signatures, sessions,
  durées) est en UTC. Le fuseau n'intervient qu'au moment de **rendre**
  ou de **décider d'un horaire humain**.
- **I-T3 — Le décalage est une FONCTION de l'instant, jamais une
  constante.** `offsetMin` stocké dans un champ est le défaut lui-même :
  la signature est `offsetAt(zone, instant)`. C'est ce qui distingue
  `Europe/Paris` en janvier de `Europe/Paris` en juillet.
- **I-T4 — Un fuseau inconnu est REFUSÉ**, en nommant ce qui manque.
  `set timezone 55` doit être refusé ou honoré, jamais accepté puis
  ramené à UTC en silence.
- **I-T5 — L'horloge est celle de l'ÉQUIPEMENT.** Aucun horodatage
  destiné à une machine simulée ne lit `Date.now()` : il lit l'horloge
  de cette machine, celle que `clock set` déplace et que NTP discipline.
- **I-T6 — Deux vues d'une même machine s'accordent.** `timedatectl` et
  `date`, `show clock` et `service timestamps`, `execute date` et
  `date=` d'un journal : une seule source, donc une seule réponse.

### Géographie

- **I-G1 — Un seul magasin de lieux**, hors du pare-feu, lisible par
  toute couche qui en a besoin.
- **I-G2 — Un code pays est un TYPE**, `CountryCode`, validé ISO 3166-1
  alpha-2 à la frontière — jamais une `string` de deux caractères
  espérés (`CLAUDE.md` §5).
- **I-G3 — Aucune base géographique n'est inventée.** Le simulateur ne
  peut pas embarquer GeoLite2, et **fabriquer** des plages pays serait
  produire des données que personne ne peut vérifier. La source est
  **déclarative** : l'opérateur écrit ses plages (`system geoip-override`
  côté FortiOS, un fichier lisible côté hôte). La forme de ce fichier
  **imite** le CSV GeoLite2 pour qu'un vrai extrait puisse y être versé.
- **I-G4 — Un critère géographique indécidable fait ÉCHOUER la
  correspondance**, jamais l'inverse (`CLAUDE.md` §6). Une adresse dont
  le pays est inconnu **ne correspond pas** à une adresse de géographie.

---

## 4. L'architecture cible

### 4.1 `src/core/time/` — le socle temporel

```
core/time/
  TimeZone.ts          — le TYPE : un nom IANA validé, rien d'autre
  TimeZoneRegistry.ts  — l'unique résolveur : nom → zone ; offsetAt(zone, t)
  ZoneAliases.ts       — les trois portes : index FortiOS, identifiant
                         Windows, libellé Cisco/VRP → TimeZone
  DeviceClock.ts       — l'horloge d'UN équipement : UTC + zone + réglage
                         manuel + discipline NTP
  Stamp.ts             — les formats : RFC 3339, BSD RFC 3164, IOS, VRP,
                         FortiOS `date=`/`time=`
```

`TimeZoneRegistry` **encapsule** `Intl` — c'est-à-dire la tzdata du
moteur JavaScript, donc les vraies règles d'heure d'été, tenues à jour
sans que ce dépôt ait à les porter. `core/Timezone.ts` en devient
l'implantation interne ; il n'est plus appelé directement.

**`DeviceClock` est le port étroit** que chaque équipement expose :

```ts
export interface DeviceClock {
  nowUtc(): number;                    // l'instant, toujours UTC
  zone(): TimeZone;                    // le fuseau configuré
  localNow(): number;                  // nowUtc() décalé pour l'affichage
  localParts(at?: number): LocalParts; // année/mois/jour/heure/minute/jour de semaine
  setUtc(epochMs: number): void;       // `clock set`, `date -s`
  setZone(zone: TimeZone): void;       // `clock timezone`, `set-timezone`
}
```

`localParts` est la pièce qui referme les défauts de `ScheduleObject` et
de `CronSchedule` : ces deux moteurs ne doivent **jamais** appeler
`getHours()` sur un `Date`, mais demander à l'horloge de leur machine
quelle heure locale il est.

### 4.2 `src/network/geo/` — le socle géographique

```
network/geo/
  CountryCode.ts     — le TYPE : ISO 3166-1 alpha-2, validé, comparable
  GeoDatabase.ts     — plages IP → CountryCode, forme GeoLite2
  GeoRegistry.ts     — l'unique résolveur : countryOf(ip): CountryCode | null
  Location.ts        — un LIEU : pays, subdivision, localité, coordonnées
  LocationCodec.ts   — RFC 6225 (coordonnées) et RFC 4776 (civique)
```

`GeoIpOverrides` du pare-feu devient un **alimenteur** de `GeoRegistry`,
pas un magasin parallèle : `config system geoip-override` déclare, le
registre répond, et toute couche qui pose la question obtient la même
réponse que le pare-feu.

### 4.3 Ce que chaque couche branche dessus

| Couche | Port | Ce qu'elle y gagne |
|---|---|---|
| Cisco IOS | `DeviceClock` | `clock summer-time recurring` **bascule vraiment** ; `show clock` juste toute l'année |
| Huawei VRP | `DeviceClock` | `clock daylight-saving-time … repeating` idem |
| Linux | `DeviceClock` | `timedatectl` et `date` s'accordent ; `cron` se déclenche à l'heure locale |
| Windows | `DeviceClock` + `ZoneAliases` | `Get-TimeZone` rend le bon `BaseUtcOffset` et un `SupportsDaylightSavingTime` **vrai** |
| FortiOS | `DeviceClock` + `ZoneAliases` | les 87 index ; horaires de politique en heure locale ; `date=`/`time=` dans les journaux |
| syslog | `DeviceClock` | l'horodatage émis est celui de **l'équipement** ; RFC 5424 porte enfin son décalage explicite |
| Oracle | `DeviceClock` | `DBTIMEZONE`, `SESSIONTIMEZONE`, `SYSDATE` ≠ `SYSTIMESTAMP` |
| SNMP | `Location` | `sysLocation` cesse d'être une chaîne sans support |
| DHCP | `LocationCodec` | options 99 et 123 réelles |
| LLDP | `LocationCodec` | Location Identification TLV |
| PKI | `CountryCode` | un `subject` structuré, `C=` validé |
| Pare-feu | `GeoRegistry` | ce qu'il a déjà, mais partagé |

---

## 5. Les lots, dans l'ordre

Chaque lot est **mesuré avant**, **discriminé par `git stash`**, et ne
part qu'avec sa sonde.

| # | Lot | Ce qu'il referme | Mesure de départ |
|---|---|---|---|
| **T1** | `core/time/` : le registre, le type `TimeZone`, `offsetAt` | I-T1, I-T3 | l'écart de 60 min du §1.1 |
| **T2** | `TimezoneDatabase` devient une **vue** du registre | la table fixe #2 | `timedatectl` dit `CET +0100` un 5 septembre |
| **T3** | `date` et `timedatectl` s'accordent | I-T6 | `15:33 UTC` contre `16:33 CET`, même machine |
| **T4** | `DeviceClock` sur Cisco et VRP ; `summer-time`/`daylight-saving-time` réels | modèle #3 | `show clock` faux six mois sur douze |
| **T5** | Les 87 index FortiOS ; un index inconnu est **refusé** | I-T4 | `set timezone 55` accepté → UTC |
| **T6** | `ScheduleObject` lit l'horloge de sa machine | I-T5 | un horaire suit le fuseau du navigateur |
| **T7** | `CronSchedule` idem | I-T5 | `/etc/timezone` ignoré |
| **T8** | `SyslogAgent` cesse d'appeler `Date.now()` ; RFC 5424 porte son décalage | I-T5, RFC 5424 | `clock set` sans effet sur le fil |
| **T9** | `date=`/`time=` dans les journaux FortiOS | fidélité | champs absents |
| **T10** | Oracle : `DBTIMEZONE`, `SESSIONTIMEZONE`, `SYSDATE`/`SYSTIMESTAMP` | I-T2 | tout en UTC, aucun réglage |
| **G1** | `core`/`network/geo/` : `CountryCode`, `GeoRegistry`, `GeoDatabase` | I-G1, I-G2 | la géo n'existe que dans le pare-feu |
| **G2** | `GeoIpOverrides` alimente le registre au lieu de le doubler | I-G1 | deux magasins en puissance |
| **G3** | `Location` + `sysLocation` SNMP avec un vrai support | §1.5 | OID déclaré, rien derrière |
| **G4** | DHCP options 99 et 123 (RFC 4776, RFC 6225) | §1.5 | absentes |
| **G5** | LLDP-MED Location Identification TLV | §1.5 | absent |
| **G6** | `subject` X.509 structuré, `C=` validé `CountryCode` | I-G2 | chaîne libre |

L'ordre n'est pas négociable sur deux points : **T1 avant tout le
reste** (sans registre unique, chaque lot rajoute une cinquième
écriture), et **G1 avant G2** (sinon le pare-feu garde son magasin et
on double au lieu de partager).

---

## 6. Ce qui n'est PAS fait, et pourquoi

Écrit ici plutôt que découvert plus tard.

- **Pas de tzdata embarquée.** Le registre s'appuie sur `Intl`, donc sur
  la base du moteur JavaScript. Conséquence assumée : les règles
  **historiques** lointaines dépendent du moteur, et une zone que le
  moteur ne connaît pas est refusée plutôt que devinée.
- **Pas de fichier TZif lu ou écrit.** `/etc/localtime` reste un marqueur
  dans le système de fichiers virtuel ; personne ici ne décode le format
  binaire de la RFC 9636, et prétendre le contraire serait faux.
- **Pas de base GeoLite2 embarquée** (I-G3). Le simulateur lit ce que
  l'opérateur déclare, dans une forme qui **accepte** un extrait réel.
- **Pas de géolocalisation par latence ni par `traceroute`.** Les trames
  sont livrées de façon synchrone ici (`CLAUDE.md`, limites connues) : il
  n'y a aucun temps d'aller-retour d'où déduire une distance.
- **Pas de bascule d'heure d'été *pendant* un laboratoire.** Le décalage
  est calculé à l'instant demandé, ce qui suffit à tout ce que le §5
  couvre ; simuler la nuit du changement demanderait de faire avancer
  l'horloge de plusieurs mois, ce qu'aucun laboratoire ne fait.
- **Pas de subdivision ISO 3166-2** dans un premier temps : `Location`
  porte le champ, `GeoRegistry` ne le renseigne pas tant qu'aucune
  source ne l'atteste.

---

## 7. Comment chaque lot se mesure

Le laboratoire de référence est celui du §1.1, parce qu'il **discrimine
déjà** : un instant, un fuseau, trois équipements.

- **Le témoin obligatoire** de chaque sonde : le même instant lu en UTC
  sur les trois machines doit être **identique**. Sans lui, un
  laboratoire mal câblé et un fuseau cassé sont indiscernables.
- **Le cas qui tranche pour le temps** : la même configuration, lue une
  fois en janvier et une fois en juillet. Un modèle à décalage fixe rend
  la même heure ; un modèle correct rend deux heures différentes.
- **Le cas qui tranche pour la géographie** : une adresse **hors** de
  toute plage déclarée ne correspond à aucune adresse de géographie
  (I-G4), et son jumeau positif — une adresse **dans** la plage —
  correspond.
- **Le piège nommé d'avance** : un cas négatif écrit avant que le
  mécanisme existe passe **vacuement**. Chaque « ne correspond pas » doit
  avoir un jumeau positif qui tombe, faute de quoi il ne prouve rien.

---

## 8. Références

Standards adoptés :

- [RFC 9636 — The Time Zone Information Format (TZif)](https://datatracker.ietf.org/doc/rfc9636/) (obsolète [RFC 8536](https://www.rfc-editor.org/rfc/rfc8536.html))
- [RFC 5424 — The Syslog Protocol](https://datatracker.ietf.org/doc/html/rfc5424) et RFC 3164 (format BSD)
- [RFC 6225 — DHCP Options for Coordinate-Based Location](https://www.rfc-editor.org/rfc/rfc6225.html) (obsolète RFC 3825)
- [RFC 4776 — DHCP Option for Civic Addresses](https://www.rfc-editor.org/rfc/rfc4776.html)
- RFC 5280 (X.509), RFC 4120 (Kerberos), RFC 4034 (DNSSEC), RFC 5905 (NTPv4), RFC 3418 (MIB-II `sysLocation`)
- ISO 3166-1 alpha-2

Documentation constructeur (proprietaire, donc citée comme telle) :

- [Cisco IOS — Basic System Management Command Reference, `clock timezone` / `clock summer-time`](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/bsm/command/bsm-cr-book/m_bsm-cr-a1.html)
- [Cisco IOS — Setting Time and Calendar Services](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/bsm/configuration/15-2mt/bsm-time-calendar-set.html)
- [Huawei VRP — `clock daylight-saving-time`](https://support.huawei.com/enterprise/en/doc/EDOC1100096312/8f75d1a3/clock-daylight-saving-time)
- FortiOS 6.0.4 CLI Reference, `config system global` → `set timezone` (`official_docs/forti-cli-ref-60.txt`, l. 33537)

Forme de données :

- [MaxMind — GeoIP2 / GeoLite2 City and Country Databases](https://dev.maxmind.com/geoip/docs/databases/city-and-country/)
