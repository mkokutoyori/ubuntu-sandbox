# ldapsearch : ce qui n'est pas porte, ce qui n'est pas atteste

Etat au commit `884558f5a` de la branche `mandeng`. Ce document est le releve
de tout ce que le clone d'`ldapsearch` (OpenLDAP 2.6.10, GnuTLS 3.8.3, Cyrus
SASL 2.1.28, MIT krb5 1.20.1) ne reproduit pas, ou reproduit sans pouvoir
l'attester contre un vrai binaire. Il remplace les listes de limites qui
n'existaient que dans les messages de commit et les en-tetes de sondes.

Trois statuts, jamais melanges :

- **Non porte** : la brique manque. Le simulateur refuse explicitement, ou le
  comportement reel n'existe pas du tout cote simulateur.
- **Accepte sans effet** : la configuration est lue, rendue et ignoree. C'est
  le cas que `CLAUDE.md` (regle 6) tolere uniquement quand le vrai logiciel
  accepte la commande et que le moteur ne peut pas l'honorer ; chaque entree
  de cette categorie est un ecart a fermer.
- **Non atteste** : le simulateur fait un choix raisonnable, mais aucun
  binaire accessible depuis cet environnement ne permet de le comparer
  (Active Directory, par exemple).

La methode qui a produit les sondes (relais TCP enregistreurs devant slapd et
le KDC, `/etc/hosts` remplace par montage prive, aleatoire et horloge relus
dans la capture) est decrite dans l'en-tete de
`probe-ldapsearch-gss-spnego-replays-the-real-client.test.ts`. Les
generateurs de corpus ne sont pas dans le depot ; les corpus le sont.

## 1. TLS (libldap, GnuTLS)

### 1.1 Cryptographie non calculee

| Element | Statut | Constat | Ou |
| --- | --- | --- | --- |
| Echange de cles P-384, P-521, X448, FFDHE | Non porte | Seuls X25519 et P-256 sont calcules. `SECURE192`, `SECURE256`, `SUITEB192` echouent par une alerte, la ou le vrai client conduit l'echange. Les sondes nomment le cas. | `src/crypto/ecc`, `src/network/tls/` |
| Signatures SHA-384 et SHA-512 | Non porte | Idem : ni producteur ni verificateur dans la pile TLS. | `src/network/tls/legacy/LegacyHandshake.ts` |
| Certificats autres que RSA et ECDSA P-256 / SHA-256 | Non porte | Les autres cles et empreintes ne sont couvertes que par descripteurs (`ProfiledCertificate`), pas par de vrais certificats. | `src/network/pki/` |
| Deux `key_share` du ClientHello | Non porte | GnuTLS en envoie deux, le simulateur un seul : un tour HelloRetryRequest supplementaire est possible face a un serveur qui n'accepte que l'autre groupe. | `src/network/tls/TlsClientSession.ts` |
| Reponse a l'absence de suite commune | Ecart connu | Un vrai slapd ferme la connexion sans alerte ; le simulateur envoie une alerte. | `src/network/tls/TlsServerSession.ts` |
| Preference du serveur simule, 3DES dans `ALL` | Non atteste | Differe de la liste OpenSSL d'Ubuntu. | `src/network/tls/` |

### 1.2 Chaines de priorite GnuTLS (`TLS_CIPHER_SUITE`)

- **Accepte sans effet** : les modificateurs `%COMPAT`, `%DUMBFW`,
  `%NEW_PADDING`, `%NO_TICKETS`, `%NO_TICKETS_TLS12`, `%SERVER_PRECEDENCE`,
  `%SAFE_RENEGOTIATION`, `%UNSAFE_RENEGOTIATION`, `%PARTIAL_RENEGOTIATION`,
  `%DISABLE_SAFE_RENEGOTIATION`, `%FALLBACK_SCSV`, `%VERIFY_DISABLE_CRL_CHECKS`,
  `%VERIFY_ALLOW_X509_V1_CA_CRT`, `%ALLOW_SMALL_RECORDS`, `%FORCE_ETM`,
  `%NO_ETM`, `%FORCE_SESSION_HASH`, `%NO_SESSION_HASH`, `%NO_STATUS_REQUEST`,
  `%NO_SHUFFLE_EXTENSIONS`, `%DISABLE_TLS13_COMPAT_MODE`, `%DISABLE_WILDCARDS`,
  `%DEBUG_ALLOW_KEY_USAGE_VIOLATIONS`, `%LATEST_RECORD_VERSION`,
  `%SSL3_RECORD_VERSION`, `%STATELESS_COMPRESSION`. Le noyau les valide (les
  39 noms de `MODIFIER_NAMES`, sensibles a la casse) ; seuls `%PROFILE_*`,
  `%VERIFY_ALLOW_SIGN_WITH_SHA1`, `%VERIFY_ALLOW_BROKEN`,
  `%VERIFY_ALLOW_SIGN_RSA_MD5` et `%NO_EXTENSIONS` agissent
  (`GnutlsPriority.ts`, `gnutlsClientOffer.ts`).
- **Non porte** : `@KEYWORD`, la syntaxe qui lit `/etc/gnutls/config`. Elle
  echoue toujours, alors que le vrai GnuTLS la resout avec ce fichier.
- **Non atteste** : le niveau `ULTRA`/`FUTURE` du plancher de premier DH
  n'est mesure qu'a 3072 et 4096 bits ; l'etat combine « defaut de profil +
  autre defaut » est calcule par OU, pas mesure ; le controle de temps de
  l'ancre n'est pas mesure.

### 1.3 Certificat client et CRL

- **Non porte** : la liste `certificate_authorities` de la `CertificateRequest`
  n'est ni emise par le serveur simule, ni consultee par le client : le client
  presente son certificat a tout serveur qui le demande, la ou le vrai client
  ne l'envoie que si son emetteur figure dans la liste
  (`TlsClientSession.ts`, `tlsConnect.ts`).
- **Non porte** : le DC simule n'offre pas SASL EXTERNAL, donc la
  correspondance certificat vers compte AD n'est pas mesurable
  (`LdapServer.ts`, `SUPPORTED_SASL_MECHANISMS`).
- **Non atteste** : l'echappement des caracteres speciaux dans le format DN
  de libldap (`ldapDistinguishedName`, `src/network/pki/der/DistinguishedName.ts`)
  n'a pas pu etre mesure, openssl ayant refuse de creer le certificat de test.
- **Sans effet par fidelite** (source, non mesure) : `TLS_RANDFILE`,
  `TLS_ECNAME` et `TLS_CRLCHECK` sont lus et ignores ; `tls_g.c`
  (OPENLDAP_REL_ENG_2_6_10, backend GnuTLS) ne les reference pas, seul
  `TLS_DHFILE` y est lu, et uniquement cote serveur. Le simulateur ne les
  honore donc pas non plus. `TLS_CRLFILE` agit, lui, et est mesure
  (`probe-ldapsearch-honours-tls-crlfile-like-libldap`).

## 2. SASL et Kerberos

### 2.1 Mecanismes

| Element | Statut | Constat |
| --- | --- | --- |
| `GS2-IAKERB` | Non porte | Le vrai greffon l'annonce ; il relaie les echanges du KDC par le serveur (IAKERB). `-Y GS2-IAKERB` se dit indisponible. |
| `GS2-KRB5-PLUS`, en-tete GS2 `p=` et `y` | Non atteste | Le vrai greffon ne propose pas `-PLUS` ici ; `n` est la seule forme mesuree (libldap marque la liaison de canal non critique et ldapsearch impose le mecanisme). Les formes `p=ldap` et `y` sont codees d'apres `gs2.c`, pas mesurees avec TLS. |
| `GS2-KRB5` par mot de passe | Non porte | `gss_acquire_cred_with_password` est refuse avec un texte du simulateur (`gs2.ts`). Jamais atteint avec un cache chaud. |
| Acceptation de mecanismes autres que Kerberos par l'accepteur SPNEGO | Non porte | Pas de repli NTLM, pas de `REQUEST_MIC` ni de mecanisme choisi en deuxieme position (`SpnegoAcceptor.ts`). L'initiateur n'offre que Kerberos, donc le cas n'est pas atteint par `ldapsearch`. |
| Mecanismes MS-KRB5 et krb5 ancien dans la liste de l'initiateur SPNEGO | Non porte | Seul l'OID Kerberos est offert, comme le vrai client dans ce laboratoire. Un client Windows offre l'OID MS en premier : l'accepteur l'accepte, mais les reponses portent l'OID Kerberos. |

### 2.2 FAST et chiffrement

- **Non porte** : FAST (RFC 6113). MIT 1.20 enveloppe *toutes* ses requetes
  TGS dans un `PA-FX-FAST` et le KDC repond de meme. Consequences :
  - aucune reponse TGS reussie du vrai KDC ne peut etre rejouee ; les
    requetes TGS ne sont comparees que par options, noms et domaine
    (`kdcRequestSummary`, `openldap-gssapi-replay-support.ts`) ;
  - la delegation reussie n'est verifiee que sur les octets du jeton
    (`probe-gssapi-delegation-matches-mit`), pas sur l'echange avec le KDC ;
  - la requete AS envoyee devant un TGT expire est comparee champ a champ
    parce qu'elle n'est pas enveloppee.
- **Non porte** : types de chiffrement autres qu'AES256-CTS-HMAC-SHA1-96.
  MIT propose huit types ; le simulateur n'en propose qu'un (`crypto.ts`,
  `KerberosClient.ts`).
- **Non porte** : `kinit -k -t`, `klist -k`, `ktutil`, `kvno`, et plus
  generalement les keytabs. Consequence mesuree : devant un TGT proche de
  l'expiration le vrai client tente un renouvellement depuis le keytab client
  par defaut ; le simulateur envoie la requete AS sans cle et suppose qu'il
  n'existe pas de keytab (`attemptClientKeytabRefresh`, `Krb5GssClient.ts`).
  Si un keytab client existait, le comportement divergerait.

### 2.3 Delegation (`-O passcred`)

- **Non porte** : le KDC simule ne lie pas les adresses demandees au TGT
  transmis (`KdcSession.handleForward`) ; le client n'envoie pas d'adresses
  parce que les TGT du simulateur n'en portent pas.
- **Non atteste** : ce qu'Active Directory fait d'un TGT transmis. Il
  l'accepte si le compte du service est approuve pour la delegation ; le DC
  simule ne modelise pas cette approbation pour LDAP.
- **Non porte** : delegation contrainte (S4U2proxy) cote client
  `ldapsearch` ; le KDC en a une version pour les services, sans lien avec le
  bind LDAP.

### 2.4 Domaine et serveur LDAP simule

- **Non atteste** : la reponse exacte d'Active Directory a un `NegTokenInit`
  (le simulateur repond comme MIT : `accept-completed`, mecanisme Kerberos,
  AP-REP, sans `mechListMIC`).
- **Non atteste** : la taille de tampon d'emission du DC lorsque aucune
  negociation de couche n'a lieu (65536, valeur par defaut de Cyrus SASL ;
  celle d'AD n'est pas atteignable).
- **Non porte** : `EXTERNAL` et `DIGEST-MD5`, que MS-ADTS fait annoncer a un
  vrai DC en plus de `GSSAPI` et `GSS-SPNEGO`.
- **Non atteste** : le diagnostic textuel qu'AD joint au refus d'un bind par
  un mecanisme inconnu (le DC simule renvoie le code 7 sans texte).
- **Non porte** : controles LDAP que le vrai AD traite et que le DC simule
  ignore ou refuse (un controle non critique est ignore, un controle critique
  recoit `unavailableCriticalExtension`, ce qui est correct) : VLV
  (`2.16.840.1.113730.3.4.9`), DirSync, notifications, `ShowDeleted`,
  `ExtendedDN`, `SD_FLAGS`, arborescence a supprimer, etc. Seuls la pagination,
  le tri cote serveur et `DomainScope` sont evalues
  (`LdapServer.ts`, `SUPPORTED_CONTROLS`).
- **Non porte** : serveur OpenLDAP (`slapd`) et clients `ldapadd`,
  `ldapmodify`, `ldapdelete`, `ldapmodrdn`, `ldappasswd`, `ldapwhoami`,
  `ldapcompare`. `ldapsearch` ne se teste, dans le simulateur, que contre le
  DC Active Directory.

## 3. Limites de l'outillage de sondes

- Les en-tetes de sondes indiquent le nombre de cas qui tombent avant
  correction ; ce chiffre est mesure par `git stash` de `src/network`.
  Quand le module n'existait pas, il n'y a pas de temoin et le texte le dit.
- Les generateurs de corpus (scripts Python d'enregistrement) ne sont pas
  dans le depot. Les corpus rejouables sont :
  `openldap-ldapsearch-{corpus,chase-corpus,sasl-corpus,sasl-trace-corpus,trace-corpus,gssapi-corpus,gss-spnego-corpus,gs2-krb5-corpus,passcred-corpus}.json`,
  `openldap-tls-{context,peer}-corpus.json`, `gnutls-*-corpus.json`,
  et `openldap-ldapsearch-passcred-forwardable-capture.json` (enregistrement
  non rejouable, lu par une sonde d'octets).
- Les clients et serveurs reels utilises pour mesurer (ldapsearch 2.6.10,
  slapd, MIT KDC, gnutls-cli, openssl s_server) sont ceux du paquet Ubuntu
  24.04 de l'environnement de travail. Le jeu de greffons SASL du simulateur
  modelise celui de 22.04 dans les anciennes sondes GSSAPI.

## 4. Backlog anterieur, hors ldapsearch

Releve tel qu'il avait ete consigne avant ce travail ; non remesure ici.

- Verification d'un AP-REQ nu par SMB et WinRM cote Kerberos (lie a la
  delegation et a SPNEGO ci-dessus : le codec SPNEGO existe desormais dans
  `src/network/kerberos/gssapi/spnego/`).
- Keytabs Kerberos (`kinit -k -t`, `klist -k`, `ktutil`, `kvno`) : voir 2.2.
- IIS, SNMP, programmes clients Oracle, Samba / `smbclient` : numeros #71 a
  #74 du carnet de travail.
- FortiGate : `execute interface dhcp6client-renew` et `pppoe-reconnect`.

## 5. Pour fermer

L'ordre qui reduit le plus d'ecarts par unite de travail :

1. FAST (RFC 6113) : debloque le rejeu des reponses TGS reelles, la
   comparaison complete des requetes TGS et la delegation de bout en bout.
2. Un accepteur SPNEGO complet (NTLM, `REQUEST_MIC`) : sert aussi SMB et WinRM.
3. Les modificateurs GnuTLS « sans effet » : chacun demande une brique TLS
   precise (tickets de session, renegociation, ETM, session hash).
4. Echange de cles P-384/P-521/X448/FFDHE et signatures SHA-384/512.
5. Keytabs et `kinit -k`.
