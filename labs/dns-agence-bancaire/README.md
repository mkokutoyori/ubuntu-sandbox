# Lab DNS — Agence bancaire (Banque Horizon)

Un lab pour **s'entraîner sur le protocole DNS** avec deux éditeurs côte à côte (**Windows Server** et **BIND9**), un petit arbre DNS complet qui permet la **récursion** (racine → `com` → domaine de la banque), un réseau d'agence avec **DHCP**, et un **site web avancé** servi en HTTPS par nginx.

Tout le lab a été construit en tapant de vraies commandes (PowerShell, bash, IOS) dans les terminaux du simulateur, exporté en JSON, puis **réimporté dans un canevas vierge** : les mêmes 18 vérifications passent sur le lab neuf et sur le lab réimporté (voir `src/labs/dnsAgenceBancaire/checks.ts`).

## Ce que le lab enseigne

- la **délégation** : la racine délègue `com`, `com` délègue `banquehorizon.com`, la racine du lab délègue aussi la zone inverse `113.0.203.in-addr.arpa` ;
- la **récursion** et la **redirection** : un poste interroge DC1 (Windows), qui redirige vers DNS-RES (BIND), qui descend l'arbre depuis les indices racine ;
- le **DNS partagé / privé** : `horizon.local` n'existe que chez DC1 ; DNS-RES la lui renvoie (`forward only`) ;
- le **serveur secondaire** et le **transfert de zone** : NS1-BANK (BIND) est primaire, NS2-BANK (Windows) est secondaire (AXFR + NOTIFY) ;
- le **DHCP avec mise à jour dynamique** : les baux donnent adresse, passerelle, deux serveurs DNS et le suffixe `horizon.local`, et DC1 inscrit chaque client dans la zone ;
- les **suffixes DNS**, le **cache** des clients et des serveurs, la **NRPT** (table de politique de résolution de noms) ;
- le **web** vu du DNS : plusieurs noms (`www`, `ebanking`, `agences`, `api`) pour une seule adresse, redirection HTTP → HTTPS, hôtes virtuels nginx, API JSON, page de maintenance ;
- le **NAT** et le routage entre l'agence, le fournisseur d'accès et l'hébergement.

## Schéma

```
   INTERNET SIMULÉ (R-ISP)

   198.51.100.0/24 « infra DNS »                       203.0.113.0/24 « hébergement banque »
   ┌─────────────┐  ┌─────────────┐                    ┌────────────┐ ┌────────────┐ ┌─────────────┐
   │ ROOT-NS     │  │ TLD-NS      │                    │ NS1-BANK   │ │ NS2-BANK   │ │ WEB-BANK    │
   │ Linux BIND9 │  │ Windows DNS │                    │ Linux BIND9│ │ Windows DNS│ │ Linux nginx │
   │ zone « . »  │  │ zone « com »│                    │ primaire   │ │ secondaire │ │ HTTP/HTTPS  │
   │ .1          │  │ .2          │                    │ .10        │ │ .11        │ │ .20         │
   └──────┬──────┘  └──────┬──────┘                    └─────┬──────┘ └─────┬──────┘ └──────┬──────┘
          └─── SW-INFRA ───┘                                 └──── SW-HEBERGEMENT ──────────┘
                 │ .254                                                    │ .254
                 └────────────────────────── R-ISP ────────────────────────┘
                                               │ Gi0/2  192.0.2.1/30
                                               │
                                               │ Gi0/0  192.0.2.2/30   (NAT overload)
                                            R-AGENCE ── trunk 802.1Q ── SW-AGENCE
                                                                           │
                         VLAN 20 « SERVEURS » 10.20.20.0/24                │      VLAN 10 « POSTES » 10.20.10.0/24
                         ┌──────────────┐   ┌───────────────┐              │      ┌─────────────┐ ┌─────────────┐ ┌───────────────┐
                         │ DC1          │   │ DNS-RES       │ ─────────────┴───── │ PC-GUICHET1 │ │ PC-GUICHET2 │ │ PC-CONSEILLER │
                         │ Windows      │   │ Linux BIND9   │                     │ Windows     │ │ Windows     │ │ Linux         │
                         │ DNS + DHCP   │   │ résolveur     │                     │ DHCP        │ │ DHCP        │ │ DHCP          │
                         │ .10          │   │ récursif .53  │                     │ .50         │ │ .51         │ │ .52           │
                         └──────────────┘   └───────────────┘                     └─────────────┘ └─────────────┘ └───────────────┘
```

## Plan d'adressage

| Équipement | Rôle | Système | Adresse | Passerelle |
|------------|------|---------|---------|------------|
| ROOT-NS | serveur racine (zone `.`) | Linux + BIND9 | 198.51.100.1/24 | 198.51.100.254 |
| TLD-NS | serveur de la zone `com` (sans récursion) | Windows Server + DNS | 198.51.100.2/24 | 198.51.100.254 |
| NS1-BANK | primaire de `banquehorizon.com` et `113.0.203.in-addr.arpa` | Linux + BIND9 | 203.0.113.10/24 | 203.0.113.254 |
| NS2-BANK | secondaire (transfert depuis NS1-BANK) | Windows Server + DNS | 203.0.113.11/24 | 203.0.113.254 |
| WEB-BANK | site de la banque (nginx, 80/443/8081) | Linux + nginx | 203.0.113.20/24 | 203.0.113.254 |
| R-ISP | routeur du fournisseur | Cisco IOS | 198.51.100.254/24, 203.0.113.254/24, 192.0.2.1/30 | — |
| R-AGENCE | routeur de l'agence, NAT, relais DHCP | Cisco IOS | 192.0.2.2/30 (WAN), 10.20.10.1/24 (VLAN 10), 10.20.20.1/24 (VLAN 20) | 192.0.2.1 |
| SW-AGENCE | commutateur de l'agence | Cisco IOS | VLAN 10 `POSTES`, VLAN 20 `SERVEURS`, Fa0/1 en trunk | — |
| DC1 | DNS interne `horizon.local` + serveur DHCP | Windows Server | 10.20.20.10/24 | 10.20.20.1 |
| DNS-RES | résolveur récursif de l'agence | Linux + BIND9 | 10.20.20.53/24 | 10.20.20.1 |
| PC-GUICHET1 / 2 | postes de guichet | Windows | DHCP : 10.20.10.50 / .51 | 10.20.10.1 |
| PC-CONSEILLER | poste du conseiller | Linux | DHCP : 10.20.10.52 | 10.20.10.1 |

Étendue DHCP `POSTES` (sur DC1) : 10.20.10.50 → 10.20.10.200 /24, bail de 8 jours, options *routeur* 10.20.10.1, *serveurs DNS* 10.20.20.10 puis 10.20.20.53, *suffixe DNS* `horizon.local`. R-AGENCE relaie les requêtes DHCP du VLAN 10 vers DC1 (`ip helper-address`).

## L'arbre DNS

```
.                                   ROOT-NS   a.root-servers.net = 198.51.100.1
└── com.                            TLD-NS    a.nic.com          = 198.51.100.2
    └── banquehorizon.com.          NS1-BANK (primaire, BIND)  +  NS2-BANK (secondaire, Windows)
          @ A, MX 10 mail / 20 mail2, TXT SPF, ns1, ns2, web, mail, mail2
          www, ebanking, agences, api   →   CNAME web   →   203.0.113.20
          _dmarc TXT, _imaps._tcp SRV

113.0.203.in-addr.arpa.             délégué par la racine du lab à ns1.banquehorizon.com (PTR de .10 .11 .20 .25)

horizon.local.                      DC1 seulement (zone privée, jamais publiée dans l'arbre)
  dc1, dns-res, intranet (CNAME dc1), pc-guichet1, pc-guichet2 (inscrits par le DHCP)
```

Le résolveur DNS-RES (`/etc/bind/named.conf`) : `recursion yes`, `allow-query` et `allow-recursion` limités à `10.20.0.0/16`, une zone `type hint` pointée sur ROOT-NS, et une zone `horizon.local` en `type forward; forward only;` vers DC1.

## Comptes

Chaque terminal s'ouvre déjà connecté :

| Équipements | Utilisateur | Remarque |
|-------------|-------------|----------|
| PC-GUICHET1, PC-GUICHET2 | `User` (Windows) | utilisateur standard |
| DC1, TLD-NS, NS2-BANK | `Administrator` (Windows Server) | PowerShell : les modules DnsServer et DhcpServer sont chargés |
| PC-CONSEILLER, ROOT-NS, NS1-BANK, DNS-RES, WEB-BANK | `user` (Linux) | `sudo` sans mot de passe |
| R-ISP, R-AGENCE, SW-AGENCE | console IOS | `enable` puis `configure terminal` |

## Ouvrir le lab

1. `npm run dev`, puis <http://localhost:8080>.
2. Barre d'outils → **Importer** → `labs/dns-agence-bancaire/topology.json`.
3. Double-clic sur un équipement pour ouvrir son terminal.

## Vérifier en cinq minutes que tout fonctionne

Sur **PC-GUICHET1** (PowerShell) :

```powershell
ipconfig /all
```
→ `DHCP Enabled : Yes`, `IPv4 Address : 10.20.10.50`, `DNS Servers : 10.20.20.10` puis `10.20.20.53`, `Connection-specific DNS Suffix : horizon.local`, `DHCP Server : 10.20.20.10`.

```powershell
Resolve-DnsName www.banquehorizon.com
```
```
Name      : www.banquehorizon.com
Type      : A
TTL       : 300
Section   : Answer
IPAddress : 203.0.113.20
```

```powershell
Test-NetConnection www.banquehorizon.com -Port 443
```
→ `RemoteAddress : 203.0.113.20`, `TcpTestSucceeded : True`.

Sur **PC-CONSEILLER** (bash) :

```bash
dig www.banquehorizon.com +short
curl -sk https://www.banquehorizon.com/ | head -12
```

Les 18 vérifications complètes (une par leçon) sont dans `src/labs/dnsAgenceBancaire/checks.ts` ; le test `src/__tests__/unit/labs/dns-agence-bancaire.test.ts` les exécute sur le lab neuf et sur ce fichier réimporté.

---

# Exercices

## 1. Suivre une résolution de bout en bout (PC-CONSEILLER)

```bash
dig +trace @10.20.20.53 www.banquehorizon.com
```
```
.	3600000	IN	NS	a.root-servers.net.
a.root-servers.net.	3600000	IN	A	198.51.100.1
;; Received 64 bytes from 10.20.20.53#53(10.20.20.53) in 0 ms
com.	86400	IN	NS	a.nic.com.
a.nic.com.	86400	IN	A	198.51.100.2
;; Received 75 bytes from 198.51.100.1#53(198.51.100.1) in 0 ms
banquehorizon.com.	3600	IN	NS	ns1.banquehorizon.com.
banquehorizon.com.	3600	IN	NS	ns2.banquehorizon.com.
ns1.banquehorizon.com.	3600	IN	A	203.0.113.10
ns2.banquehorizon.com.	3600	IN	A	203.0.113.11
;; Received 107 bytes from 198.51.100.2#53(198.51.100.2) in 0 ms
www.banquehorizon.com.	3600	IN	CNAME	web.banquehorizon.com.
web.banquehorizon.com.	3600	IN	A	203.0.113.20
;; Received 73 bytes from 203.0.113.10#53(203.0.113.10) in 0 ms
```

À observer : la première ligne vient du résolveur (les indices racine), puis chaque étape est une **délégation** (`NS` + *glue* `A` dans la section additionnelle) renvoyée par le serveur du niveau au-dessus. Le dernier serveur interrogé, 203.0.113.10, est NS1-BANK.

**Question :** pourquoi `dig` n'a-t-il jamais demandé `www.banquehorizon.com` à ROOT-NS directement ? (Réponse : la racine ne connaît que la délégation de `com`.)

## 2. Qui répond quoi : le bit de récursion

```bash
# sur ROOT-NS
dig @127.0.0.1 www.banquehorizon.com +norecurse
```
```
;; flags: qr; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1
;; AUTHORITY SECTION:
com.	86400	IN	NS	a.nic.com.
;; ADDITIONAL SECTION:
a.nic.com.	86400	IN	A	198.51.100.2
```

Un serveur faisant autorité ne recurse pas : il **renvoie** (*referral*). Sur **DNS-RES** la même question sans récursion :

```bash
dig @127.0.0.1 www.banquehorizon.com +norecurse
```
```
;; flags: qr ra; QUERY: 1, ANSWER: 0, AUTHORITY: 1, ADDITIONAL: 1
;; AUTHORITY SECTION:
.	3600000	IN	NS	a.root-servers.net.
```

Le drapeau `ra` (recursion available) signale un résolveur ; sans cache pour ce nom, il renvoie les serveurs racine connus de son fichier d'indices. Refaites la requête **avec** récursion (`dig @127.0.0.1 www.banquehorizon.com`) puis de nouveau avec `+norecurse` : la réponse sort maintenant du cache.

## 3. Le cache : client, serveur Windows, résolveur BIND

Sur **PC-GUICHET1** :

```powershell
Clear-DnsClientCache
Resolve-DnsName www.banquehorizon.com
Get-DnsClientCache
```
```
Entry      : www.banquehorizon.com
Name       : www.banquehorizon.com
Type       : CNAME
Status     : Success
Section    : Answer
TimeToLive : 3600
DataLength : 23
Data       : web.banquehorizon.com

Entry      : www.banquehorizon.com
Name       : web.banquehorizon.com
Type       : A
Status     : Success
Section    : Answer
TimeToLive : 3600
DataLength : 4
Data       : 203.0.113.20
```

`ipconfig /displaydns` montre les mêmes enregistrements (un seul cache, deux vues), et `Get-DnsClientCache | Where-Object Name -like "*horizon*"` les filtre comme sur un vrai poste. Sur **DC1**, le cache du serveur DNS :

```powershell
Show-DnsServerCache | Select-Object -First 5
```
```
HostName              RecordType TimeToLive RecordData
--------              ---------- ---------- ----------
www.banquehorizon.com CNAME            3600 web.banquehorizon.com
web.banquehorizon.com A                3600 203.0.113.20
```

Sur **DNS-RES** : `sudo rndc flush` vide le cache du résolveur BIND.

## 4. Les types d'enregistrements

Sur **PC-GUICHET1** :

```powershell
Resolve-DnsName banquehorizon.com -Type MX
Resolve-DnsName banquehorizon.com -Type NS
Resolve-DnsName banquehorizon.com -Type TXT
Resolve-DnsName _imaps._tcp.banquehorizon.com -Type SRV
Resolve-DnsName 203.0.113.20
```

À observer : deux MX (`Preference` 10 puis 20), deux NS (`ns1`, `ns2`), la chaîne SPF `v=spf1 mx -all`, la cible `mail.banquehorizon.com` port 993 pour le SRV, et le PTR `web.banquehorizon.com` pour `203.0.113.20` (la requête inverse part de `20.113.0.203.in-addr.arpa`).

Sur **PC-CONSEILLER** :

```bash
nslookup -type=NS banquehorizon.com
host -t MX banquehorizon.com
```

Un nom inexistant :

```powershell
Resolve-DnsName nexiste.banquehorizon.com
```
```
Resolve-DnsName : nexiste.banquehorizon.com : DNS name does not exist
```

**Avec `nslookup`** (cmd ou PowerShell, sur PC-GUICHET1). L'outil interroge directement un serveur DNS : il ne lit ni le fichier `hosts` ni le cache du client, et il commence par chercher le **nom** du serveur interrogé dans l'enregistrement PTR de son adresse (`UnKnown` s'il n'en a pas).

```
nslookup www.banquehorizon.com
```
```
Server:  dc1.horizon.local
Address:  10.20.20.10

Non-authoritative answer:
Name:    web.banquehorizon.com
Address:  203.0.113.20
Aliases:  www.banquehorizon.com
```

`Non-authoritative answer` : DC1 n'est pas faisant autorité pour `banquehorizon.com`, il a obtenu la réponse par son redirecteur. `Aliases` : le CNAME `www` est suivi jusqu'à `web`. Le type d'enregistrement se choisit avec `-type=` :

```
nslookup -type=MX banquehorizon.com
nslookup -type=SOA banquehorizon.com
nslookup 203.0.113.20
nslookup nexiste.banquehorizon.com
```
```
banquehorizon.com	MX preference = 10, mail exchanger = mail.banquehorizon.com
banquehorizon.com	MX preference = 20, mail exchanger = mail2.banquehorizon.com

banquehorizon.com
	primary name server = ns1.banquehorizon.com
	responsible mail addr = hostmaster.banquehorizon.com
	serial  = 2026103101
	refresh = 7200 (2 hours)
	retry   = 900 (15 mins)
	expire  = 1209600 (14 days)
	default TTL = 3600 (1 hour)

Name:    web.banquehorizon.com
Address:  203.0.113.20

*** dc1.horizon.local can't find nexiste.banquehorizon.com: Non-existent domain
```

`nslookup -debug www.banquehorizon.com` montre chaque paquet reçu : l'en-tête (drapeaux `response`, `want recursion`, `recursion avail.`, `auth. answer` quand le serveur fait autorité), le `rcode`, et le TTL de chaque enregistrement. Sans argument, `nslookup` ouvre une session interactive (`set type=MX`, `set all`, `server 10.20.20.53`, `exit`).

Quand le serveur ne répond pas, l'outil le dit mot pour mot comme Windows :

```
nslookup www.banquehorizon.com 10.20.20.250
```
```
DNS request timed out.
    timeout was 2 seconds.
Server:  UnKnown
Address:  10.20.20.250

DNS request timed out.
    timeout was 2 seconds.
DNS request timed out.
    timeout was 2 seconds.
*** Request to UnKnown timed-out
```

La première attente est la requête PTR qui cherche le nom du serveur ; les deux suivantes sont la question elle-même, essayée `retry+1` fois (`set all` affiche `timeout=2` et `retry=1`).

## 5. Redondance : NS1-BANK tombe, NS2-BANK prend le relais

1. Sur **DNS-RES** : `sudo rndc flush` (pour que le résolveur n'ait plus rien en cache).
2. Sur **NS1-BANK** : `sudo systemctl stop named`.
3. Sur **PC-GUICHET1** :

```powershell
Resolve-DnsName mail.banquehorizon.com
```
```
Name      : mail.banquehorizon.com
Type      : A
TTL       : 3600
Section   : Answer
IPAddress : 203.0.113.25
```

La réponse arrive quand même : la délégation de `com` liste **deux** serveurs, le résolveur essaie l'autre. Redémarrez ensuite NS1-BANK : `sudo systemctl start named`.

## 6. Transfert de zone et NOTIFY (BIND primaire → Windows secondaire)

Sur **NS1-BANK** :

```bash
sudo sed -i 's/2026103101/2026103102/' /etc/bind/db.banquehorizon.com
echo 'api2 IN A 203.0.113.30' | sudo tee -a /etc/bind/db.banquehorizon.com
sudo rndc reload banquehorizon.com
```
```
zone reload successful
```

Le numéro de série augmente (c'est lui que le secondaire compare) ; `named` envoie un **NOTIFY** à NS2-BANK, qui interroge le SOA puis transfère la zone. Sur **PC-GUICHET1**, interrogez directement le secondaire (relancez la commande si le transfert n'est pas encore terminé, comme dans la réalité) :

```powershell
Resolve-DnsName api2.banquehorizon.com -Server 203.0.113.11
```

Sur **NS2-BANK** : `(Get-DnsServerZone -Name banquehorizon.com).RecordCount` passe de 18 à 19.

Le transfert est restreint : sur NS1-BANK, `dig @127.0.0.1 banquehorizon.com AXFR` répond `Transfer failed.` car `allow-transfer` n'autorise que 203.0.113.11. C'est l'ACL qui protège la zone.

## 7. DNS privé et redirection (split DNS)

```powershell
# PC-GUICHET1
Resolve-DnsName dc1.horizon.local
Resolve-DnsName intranet
Resolve-DnsName dc1.horizon.local -Server 10.20.20.53
```

`intranet` (nom court) est complété par le **suffixe DNS** reçu du DHCP (`horizon.local`). La troisième commande passe par le résolveur BIND, qui renvoie `horizon.local` à DC1 (`forward only`) : la même réponse arrive par deux chemins. À l'inverse, `Resolve-DnsName www.banquehorizon.com -Server 10.20.20.10` interroge DC1, qui n'a pas la zone publique et utilise son **redirecteur** :

```powershell
# DC1
Get-DnsServerForwarder
reg query HKLM\SYSTEM\CurrentControlSet\Services\DNS\Parameters
```
```
IPAddress     UseRootHint Timeout EnableReordering
---------     ----------- ------- ----------------
{10.20.20.53} True              3 True

HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Services\DNS\Parameters
    Forwarders    REG_MULTI_SZ    10.20.20.53
```

La cmdlet et `reg query` sont deux vues d'une même valeur du registre.

## 8. DHCP et mise à jour dynamique du DNS

Sur **DC1** :

```powershell
Get-DhcpServerv4Lease -ScopeId 10.20.10.0
Get-DnsServerResourceRecord -ZoneName horizon.local
```

Les postes `pc-guichet1` et `pc-guichet2` apparaissent dans `horizon.local` avec un horodatage et un TTL de 1200 s : c'est le serveur DHCP qui les a inscrits. Sur **PC-GUICHET2** :

```powershell
ipconfig /release
ipconfig /renew
ipconfig
```

Après le `/renew`, le poste retrouve **la même adresse** (10.20.10.51) : le serveur se souvient du bail.

## 9. La NRPT et les cmdlets DnsClient (PC-GUICHET1)

On casse la résolution, puis on la répare avec une **règle de politique de nom** (NRPT) qui envoie `.horizon.local` à DC1 quel que soit le serveur DNS de la carte :

```powershell
Set-DnsClientServerAddress -InterfaceAlias "Ethernet 0" -ServerAddresses 10.20.20.250
Clear-DnsClientCache
Resolve-DnsName dc1.horizon.local
```
```
Resolve-DnsName : dc1.horizon.local : This operation returned because the timeout period expired
    + CategoryInfo          : ResourceUnavailable: (dc1.horizon.local:String) [Resolve-DnsName], Win32Exception
    + FullyQualifiedErrorId : ERROR_TIMEOUT,Microsoft.DnsClient.Commands.ResolveDnsName
```
(10.20.20.250 n'existe pas : le serveur ne répond pas, et l'erreur le dit — « le nom n'existe pas » serait `DNS_ERROR_RCODE_NAME_ERROR`, « l'enregistrement n'existe pas » `DNS_ERROR_RECORD_DOES_NOT_EXIST`, « le serveur refuse » `DNS_ERROR_RCODE_REFUSED`.)

```powershell
Add-DnsClientNrptRule -Namespace ".horizon.local" -NameServers 10.20.20.10
Resolve-DnsName dc1.horizon.local
Get-DnsClientNrptRule
reg query HKLM\SYSTEM\CurrentControlSet\Services\Dnscache\Parameters\DnsPolicyConfig /s
```

`dc1.horizon.local` se résout de nouveau : la règle (la plus spécifique l'emporte ; `.` vaut pour tout nom) remplace les serveurs de la carte pour ce suffixe. La règle est une clé du registre (`Version`, `Name`, `ConfigOptions`, `GenericDNSServers`, et rien d'autre tant qu'un champ facultatif — `-DisplayName`, `-Comment`, `-DnsSecEnable`… — n'est pas renseigné). Retirez-la avec `Get-DnsClientNrptRule | Remove-DnsClientNrptRule -Force`, remettez les serveurs du DHCP avec `ipconfig /renew`.

Autres cmdlets du module DnsClient à essayer : `Get-DnsClient` (suffixe de connexion, enregistrement de l'adresse), `Set-DnsClient -ConnectionSpecificSuffix`, `Get-DnsClientGlobalSetting` / `Set-DnsClientGlobalSetting -SuffixSearchList`, `Get-DnsClientDohServerAddress`, `Register-DnsClient`.

## 10. Le web côté DNS

Sur **PC-CONSEILLER** :

```bash
curl -sI http://www.banquehorizon.com/
```
```
HTTP/1.1 301 Moved Permanently
Server: nginx/1.24.0
Content-Type: text/html
Location: https://www.banquehorizon.com/
Content-Length: 169
```

```bash
curl -skI https://www.banquehorizon.com/
curl -sk https://www.banquehorizon.com/robots.txt
curl -sk https://ebanking.banquehorizon.com/api/taux.json
curl -sk -o /dev/null -w "%{http_code}\n" https://ebanking.banquehorizon.com/connexion
```

À observer : les en-têtes de sécurité (`Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`), le site `ebanking` qui appelle une API JSON, et la page de **maintenance** (code 503) servie sur `/connexion`. Un nom qui n'est pas dans `server_name` tombe sur le bloc par défaut : `curl -s -o /dev/null -w "%{http_code}\n" http://203.0.113.20/` répond 404 (essayez avec `-H "Host: www.banquehorizon.com"` : 301).

Sur **WEB-BANK** :

```bash
sudo nginx -t
ss -ltn
tail /var/log/nginx/www.access.log
```

L'adresse source des journaux est `192.0.2.2` : le **NAT** de R-AGENCE masque les postes (`show ip nat translations` sur R-AGENCE).

## 11. Chemin réseau et NAT

```bash
# PC-CONSEILLER
traceroute -n 203.0.113.20
```
```
 1  10.20.10.1
 2  192.0.2.1
 3  203.0.113.20
```

Trois sauts : R-AGENCE, R-ISP, WEB-BANK. Sur **R-AGENCE** (`enable`) : `show ip nat translations` liste les traductions UDP/53 du résolveur (chaque résolution récursive en crée) et celles du `ping`/`traceroute`.

---

# Reconstruire et vérifier

```bash
npx vitest run src/__tests__/unit/labs/dns-agence-bancaire.test.ts
UPDATE_LABS=1 npx vitest run src/__tests__/unit/labs/dns-agence-bancaire.test.ts   # régénère topology.json
```

| Fichier | Contenu |
|---------|---------|
| `src/labs/dnsAgenceBancaire/plan.ts` | noms, adresses, domaines |
| `src/labs/dnsAgenceBancaire/dnsData.ts` | zones et configurations BIND |
| `src/labs/dnsAgenceBancaire/internet.ts` | routeur du fournisseur, racine, TLD, serveurs de la banque |
| `src/labs/dnsAgenceBancaire/agency.ts` | agence : routeur, commutateur, DC1, résolveur, postes |
| `src/labs/dnsAgenceBancaire/site.ts`, `web.ts` | le site (pages, CSS, JS, JSON) et sa configuration nginx |
| `src/labs/dnsAgenceBancaire/checks.ts` | les vérifications et leurs leçons |

Ce qui est rétabli à l'import : adresses et baux DHCP (côté client et côté serveur), zones DNS et leurs réglages (redirecteur, récursion), services démarrés, liens symboliques (`sites-enabled`), fichiers de configuration, règles NAT, VLAN et trunk.
