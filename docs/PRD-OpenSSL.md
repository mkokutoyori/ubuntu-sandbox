# PRD — `openssl`

## 1. Pourquoi ce document

`docs/PRD-Manquements.md` §M4 a mesuré ceci : **`openssl` n'existe pas
comme commande dans ce simulateur.** Pas « le sous-mode `req` manque »,
pas « les options sont incomplètes » — il n'y a aucun fichier de
commande, aucun `case`, aucun point d'entrée. Le seul endroit du dépôt
qui prononce ce nom est `src/network/devices/linux/packages/PackageDatabase.ts` :

```ts
{ name: 'openssl', version: '3.0.2-0ubuntu1', arch: 'amd64', installed: true, … }
```

Une machine affirme donc, par `dpkg -l openssl` et par
`apt list --installed`, qu'elle dispose d'un outil dont le binaire
n'existe pas. C'est exactement la famille de défaut qui a motivé
`PRD-Nginx` §P0 et tout `PRD-Sockets-Une-Seule-Verite` — un fait affiché
que rien ne soutient — appliquée cette fois à un paquet plutôt qu'à un
port. C'est la cinquième fois que ce motif se présente dans ce projet.

Ce n'est pas une lacune anodine. `openssl` est l'outil par lequel passe
le premier geste de presque tout TP de sécurité réseau : « générez-vous
un certificat », « regardez ce que contient celui-ci », « vérifiez que
cette chaîne est valide », « chiffrez ce fichier ». Son absence bloque
aussi, nommément :

- `docs/PRD-Nginx.md` §P5 (HTTPS), déclaré bloqué faute d'un chemin
  `openssl req` → PEM ;
- les clés d'hôte sshd, qui existent en mémoire et n'ont pas de fichier
  que l'opérateur puisse fabriquer lui-même ;
- `curl --cacert`, qui sait vérifier une chaîne mais dont personne ne
  peut produire l'ancre depuis un terminal ;
- toute la famille « faites-vous une PKI de labo » (CA racine, CSR,
  signature, révocation), dont les objets existent déjà en TypeScript et
  n'ont aucune porte de commande.

## 2. Le constat, mesuré

Trois vérifications, faites avant d'écrire une ligne de ce document.

1. `grep -rn "'openssl'" src/network --include=*.ts` ne rend que
   `PackageDatabase.ts`. Aucune commande, aucun alias, aucun stub.
2. Aucun `toPem`/`fromPem` nulle part sous `src/network/pki/` : un
   certificat est un objet TypeScript et ne sait pas devenir un fichier.
3. `src/crypto/` est en revanche **beaucoup plus riche que prévu** — et
   c'est ce qui change tout le dimensionnement de ce chantier (§3).

## 3. Ce qui existe déjà, et qui décide de tout

C'est la section la plus importante de ce document, parce qu'elle
détermine ce que `openssl` pourra faire **pour de vrai** et ce qu'il
devra simuler ou refuser. Rien ici n'est supposé : chaque ligne
correspond à un export lu dans le dépôt.

### 3.1 Primitives réellement implémentées (`src/crypto/`)

| Famille | Exports | Conséquence pour `openssl` |
|---|---|---|
| Hachage | `md4`, `md5`/`md5Hex`/`MD5`, `sha1`/`sha1Hex`/`SHA1`, `sha256`/`sha256Hex`/`SHA256`, `sha512`/`sha512Hex`/`SHA512` | `dgst`, `md5`, `sha1`, `sha256`, `sha512` : **réels** |
| Chiffrement | `aesEncryptBlock`/`aesDecryptBlock`, `aesCbcEncrypt`/`aesCbcDecrypt`, `aesGcmEncrypt`/`aesGcmDecrypt`, `desEncryptBlock`/`desCbcEncrypt` | `enc -aes-*-cbc`, `-aes-*-gcm`, `-des-cbc` : **réels** |
| KDF | `pbkdf2`/`pbkdf2Hex`, `scrypt`/`scryptHex`, `prfPlus` | `enc -pbkdf2`, `kdf`, `passwd` : **réels** |
| MAC | `hmac`/`hmacHex`, `PrecomputedHmac` | `dgst -hmac`, `mac -macopt` : **réels** |
| Mots de passe | `md5Crypt`, `ciscoType7/8/9`, `huaweiIrreversibleCipher`, `oracle10gHash`… | `passwd -1` : **réel** |
| Encodage | `utf8ToBytes`, `bytesToUtf8`, `bytesToHex`, `hexToBytes`, `base64ToBytes`, `bytesToBase64` | `base64`, `enc -a`, `rand -hex/-base64` : **réels** |

**Il n'y a donc pas à simuler la cryptographie symétrique ni le
hachage.** C'est une bonne nouvelle et elle doit être exploitée : un
`openssl dgst -sha256 fichier` qui rend le vrai SHA-256 du contenu est
vérifiable par l'apprenant contre n'importe quelle autre machine, et
c'est ce qui donne sa valeur pédagogique à la commande.

### 3.2 PKI : la forme est réelle, la signature est simulée

`src/network/pki/` porte :

| Fichier | Ce qu'il offre |
|---|---|
| `PkiKeyPair.ts` | `PkiKeyPair.generate('rsa'\|'ecdsa')`, `sign()`, `verify()`, types `PkiPublicKey`/`PkiPrivateKey` (`{algorithm, material}`) |
| `X509Certificate.ts` | `X509Certificate`, `X509CertificateFields` (version, serialNumber, subject, issuer, notBefore, notAfter, publicKey, signatureAlgorithm, extensions), `tbsPayload()` |
| `SelfSignedCertificate.ts` | `generateSelfSignedCertificate(subject, {now, validityMs, extKeyUsage})` → `{cert, privateKey}` |
| `CertificateAuthority.ts` | émission de certificats signés par une racine dont la clé reste privée |
| `CertificateRevocationList.ts` | CRL |
| `CertificateVerifier.ts` | vérification de chaîne, déjà utilisée par `curl` et les TLS du simulateur |
| `OcspResponder.ts` | OCSP |
| `PkiCaRegistry.ts` | registre des CA |

Le module énonce lui-même sa convention, dans l'en-tête de
`SelfSignedCertificate.ts` : *« simulated crypto, real protocol
shape »*. Une signature RSA n'est pas calculée sur un vrai modulo ; la
**structure** du certificat, elle, est fidèle et la vérification de
chaîne est réelle.

**Ce PRD n'a pas le droit de changer cette convention**, et il n'en a
pas besoin. Il doit en revanche la dire à l'utilisateur plutôt que de la
laisser croire (§5, P3).

### 3.3 Ce qui manque, et c'est un seul verrou

Un certificat ne sait pas devenir un **fichier**. Aucun `toPem`, aucun
`fromPem`, aucun encodeur DER, nulle part.

C'est le verrou unique de tout ce chantier : sans lui, `openssl req`
n'a rien à écrire, `openssl x509 -in` n'a rien à lire, nginx n'a pas de
`ssl_certificate` à charger et l'apprenant n'a pas de fichier à
regarder. **Avec** lui, tout le reste devient de l'assemblage.

## 4. Ce qu'est `openssl`, et ce que nous en faisons

Le vrai `openssl` est trois choses empilées :

1. `libcrypto` — primitives (hachage, chiffrement, grands nombres, ASN.1) ;
2. `libssl` — la pile TLS ;
3. l'exécutable `openssl` — un multiplexeur de sous-commandes au-dessus
   des deux.

**Ce PRD ne traite que le troisième niveau**, en le branchant sur ce que
le simulateur possède déjà : `src/crypto/` pour libcrypto,
`src/network/pki/` + les transports TLS existants pour libssl.

Conséquence assumée et écrite : aucune interopérabilité binaire avec un
vrai openssl. Un fichier PEM produit ici n'est pas lisible par un
openssl réel, et l'inverse est vrai aussi. C'est le prix de la
convention du §3.2, et il faut le dire (§5, P3) plutôt que de laisser
un apprenant croire qu'il peut exporter son certificat vers une vraie
machine.

## 5. Principes

- **P1 — Ce qui peut être réel doit l'être.** Le hachage, le
  chiffrement symétrique, les KDF, les encodages et l'aléa sont déjà
  implémentés : `openssl` les utilise, il ne les imite pas. Un
  `sha256sum fichier` et un `openssl dgst -sha256 fichier` sur la même
  machine doivent rendre la même empreinte — ils lisent le même moteur.
- **P2 — Une seule vérité par fait.** `openssl x509 -in c.pem -noout
  -subject` et ce que nginx charge depuis `ssl_certificate c.pem`
  doivent décrire le même certificat, parce que c'est le même codec qui
  les sert. Le motif est celui de `PRD-Curl` : un moteur, plusieurs
  portes.
- **P3 — La simulation se déclare.** Là où la signature est simulée, la
  commande le dit — pas dans une note de bas de page, mais dans sa
  sortie, à l'endroit où un opérateur la lirait. Un `openssl x509 -text`
  qui affiche un module RSA inventé sans le signaler enseignerait une
  fausse confiance.
- **P4 — Trois familles d'options, pas deux.** Reprise de `PRD-Curl`
  §P0, qui l'a éprouvée : une option **implémentée** agit ; une option
  **que le vrai openssl connaît et que ce build n'implémente pas** est
  refusée par un message explicite ; une option **qui n'existe pas** est
  refusée avec le message du vrai openssl. Le message du milieu n'est
  volontairement pas un message d'openssl — aucun openssl réel n'est
  jamais dans cette situation, et répondre « unknown option » pour une
  option qu'openssl connaît serait un second mensonge.
- **P5 — Un sous-mode refusé ne fait pas semblant.** `openssl speed`
  qui inventerait des chiffres de débit serait pire qu'un refus : ces
  chiffres seraient lus comme une mesure.
- **P6 — Les codes de sortie sont ceux d'openssl.** `openssl verify`
  qui rend 0 sur une chaîne invalide casse tout script de TP. Le code
  de sortie fait partie de la commande.

## 6. Architecture

Contrainte de projet, non négociable : **une commande est un
`LinuxCommand`, et chacune réside dans son propre fichier.** `openssl`
est une commande ; ses sous-modes n'en sont pas.

```
src/network/crypto/openssl/          ← le moteur, partagé
  OpenSslHost.ts        port étroit (VFS, aléa, horloge, PKI, réseau)
  OpenSslArgs.ts        découpage argv → {subcommand, options, operands}
  OpenSslErrors.ts      messages + codes de sortie
  OpenSslEngine.ts      dispatch des sous-modes → {stdout, stderr, exitCode}
  subcommands/
    dgst.ts  enc.ts  base64.ts  rand.ts  passwd.ts  prime.ts
    genrsa.ts  genpkey.ts  rsa.ts  pkey.ts
    req.ts  x509.ts  verify.ts  crl.ts  ca.ts
    s_client.ts  s_server.ts  ciphers.ts
    version.ts  errstr.ts  list.ts  help.ts  info.ts
src/network/pki/pem.ts               ← le verrou du §3.3
src/network/devices/linux/commands/crypto/OpenSsl.ts   ← le LinuxCommand
```

Pourquoi un moteur séparé du `LinuxCommand`, comme pour `curl` : parce
que le jour où une seconde porte en a besoin (un script de service, un
rôle Windows qui voudrait `certutil`-vers-PEM, un test), elle doit
pouvoir appeler le moteur sans passer par un terminal. `PRD-Curl` a
montré le coût de l'inverse.

`OpenSslHost` est le port que la plateforme remplit :

```ts
export interface OpenSslHost {
  readFile(path: string): string | null;
  writeFile(path: string, content: string): boolean;
  fileExists(path: string): boolean;
  now(): number;
  randomBytes(n: number): Uint8Array;
  stdin(): string | null;
  caRegistry(): PkiCaRegistry;
  tcpConnect(host: string, port: number): Promise<TcpSocketLike | null>;
  resolveHostname(name: string): Promise<string | null>;
}
```

`randomBytes` passe par le port plutôt que par `Math.random` direct :
un test doit pouvoir rendre l'aléa déterministe, sinon `openssl rand`
n'est pas testable et `genrsa` produit une clé différente à chaque
exécution du même scénario.

## 7. Le verrou : `src/network/pki/pem.ts`

### 7.1 Ce qu'il doit faire

```ts
export function certToPem(cert: X509Certificate): string;
export function pemToCert(pem: string): X509Certificate | null;
export function privateKeyToPem(key: PkiPrivateKey): string;
export function pemToPrivateKey(pem: string): PkiPrivateKey | null;
export function publicKeyToPem(key: PkiPublicKey): string;
export function pemToPublicKey(pem: string): PkiPublicKey | null;
export function csrToPem(csr: CertificateRequest): string;
export function pemToCsr(pem: string): CertificateRequest | null;
export function crlToPem(crl: CertificateRevocationList): string;
export function pemToCrl(pem: string): CertificateRevocationList | null;
export function splitPemChain(pem: string): string[];
```

### 7.2 Le format, et pourquoi celui-là

L'armure est **réelle** — c'est elle que l'apprenant voit, c'est elle
que `cat` affiche, c'est sur elle que porte l'exercice :

```
-----BEGIN CERTIFICATE-----
<base64, lignes de 64 colonnes>
-----END CERTIFICATE-----
```

Les étiquettes sont celles de la RFC 7468, sans invention :
`CERTIFICATE`, `PRIVATE KEY`, `RSA PRIVATE KEY`, `PUBLIC KEY`,
`CERTIFICATE REQUEST`, `X509 CRL`, `EC PRIVATE KEY`, `ENCRYPTED PRIVATE KEY`.

La charge est le JSON canonique de l'objet TypeScript, encodé en
base64 par `bytesToBase64` — **pas** du DER. Écrire un encodeur ASN.1
DER serait un chantier à part entière, et il n'achèterait rien : la
signature étant simulée (§3.2), un DER exact ne serait de toute façon
pas vérifiable par un vrai openssl. Mieux vaut une charge honnêtement
non-DER qu'un DER qui prétendrait à une interopérabilité qu'il n'a pas.

Le découpage en lignes de 64 colonnes est respecté, parce qu'il est
visible et qu'un apprenant qui compare avec un vrai fichier le
remarquerait.

### 7.3 Les règles que le codec doit tenir, et qui seront testées

1. **Aller-retour fidèle** : `pemToCert(certToPem(c))` rend un
   certificat égal à `c`, champ par champ, extensions comprises.
2. **Un PEM invalide rend `null`**, jamais une exception et jamais un
   objet partiel : c'est ce qui permet à `openssl x509 -in` de rendre
   l'erreur d'openssl plutôt que de planter le shell.
3. **Une armure sans corps, un base64 corrompu, une étiquette de fin
   qui ne correspond pas à celle de début** sont trois erreurs
   distinctes et reconnues comme telles.
4. **Une chaîne** (plusieurs blocs concaténés dans un fichier) se
   découpe dans l'ordre du fichier ; c'est ainsi que `ssl_certificate`
   reçoit `fullchain.pem` sur une vraie machine.
5. **Le texte hors armure est ignoré** — un vrai fichier de certificat
   porte souvent un en-tête lisible (`subject=…`, `issuer=…`) avant le
   `-----BEGIN`.

## 8. Inventaire complet des sous-commandes

La liste ci-dessous est celle d'`openssl help` d'un OpenSSL 3.x, prise
entièrement. Chaque entrée porte un verdict, et aucune n'est passée
sous silence : celles que nous n'implémentons pas doivent être refusées
par le message du §11.2, pas ignorées.

Légende : **R** réel (branché sur `src/crypto/`) · **S** forme réelle,
charge simulée (branché sur `src/network/pki/`) · **X** refus honnête ·
**—** hors périmètre, nommé au §12.

### 8.1 Commandes standard

| Sous-commande | Verdict | Phase | Note |
|---|---|---|---|
| `asn1parse` | X | — | suppose un DER réel ; §7.2 explique pourquoi il n'y en a pas |
| `ca` | S | P5 | CA de labo : signer un CSR, révoquer, tenir l'index |
| `ciphers` | R | P4 | liste les suites que les transports TLS du simulateur offrent réellement |
| `cmp` | X | — | RFC 4210, aucun pair |
| `cms` | X | — | |
| `crl` | S | P5 | afficher/convertir une CRL |
| `crl2pkcs7` | X | — | |
| `dgst` | R | P1 | **pierre angulaire** : `-sha256`, `-sha1`, `-md5`, `-sha512`, `-md4`, `-hmac`, `-hex`, `-binary`, `-r`, `-out` |
| `dhparam` | X | — | aucun échange DH modélisé côté commande |
| `dsa`/`dsaparam`/`gendsa` | X | — | `PkiKeyPair` ne connaît que RSA et ECDSA |
| `ec`/`ecparam` | S | P6 | ECDSA existe dans `PkiKeyPair` |
| `enc` | R | P2 | `-aes-128/192/256-cbc`, `-aes-*-gcm`, `-des-cbc`, `-des3`, `-a`/`-base64`, `-d`, `-k`/`-pass`, `-pbkdf2`, `-iter`, `-salt`/`-nosalt`, `-in`/`-out`, `-p` |
| `engine` | X | — | notion absente |
| `errstr` | R | P4 | table de codes d'erreur réelle |
| `fipsinstall` | X | — | |
| `genpkey` | S | P3 | `-algorithm RSA/EC`, `-pkeyopt`, `-out` |
| `genrsa` | S | P3 | `-out`, `numbits`, `-traditional` |
| `help` | R | P0 | liste les sous-commandes de CE build, pas celles d'un openssl réel |
| `info` | R | P4 | `-configdir`, `-modulesdir`, `-enginesdir` |
| `kdf` | R | P2 | `PBKDF2`, `scrypt` — les deux existent |
| `list` | R | P4 | `-digest-algorithms`, `-cipher-algorithms`, `-commands`, `-kdf-algorithms` |
| `mac` | R | P2 | `HMAC` |
| `nseq` | X | — | |
| `ocsp` | S | P6 | `OcspResponder` existe |
| `passwd` | R | P2 | `-1` (md5Crypt, réel), `-5`/`-6` (voir §9.6), `-apr1`, `-salt`, `-stdin`, `-noverify` |
| `pkcs12` | X | — | conteneur binaire ; §12 |
| `pkcs7` | X | — | |
| `pkcs8` | S | P6 | conversion de forme de clé |
| `pkey` | S | P3 | `-in`, `-pubout`, `-text`, `-noout` |
| `pkeyparam` | S | P6 | |
| `pkeyutl` | S | P6 | `-sign`, `-verify`, `-encrypt`, `-decrypt` via `PkiKeyPair` |
| `prime` | R | P4 | arithmétique pure : `-hex`, `-generate`, `-bits`, `-checks` |
| `rand` | R | P1 | `-hex`, `-base64`, `-out`, nombre d'octets |
| `rehash` | R | P6 | `c_rehash` sur un répertoire d'ancres |
| `req` | S | P3 | **le geste attendu** : `-x509`, `-new`, `-newkey rsa:N`, `-key`, `-keyout`, `-out`, `-days`, `-subj`, `-nodes`, `-noenc`, `-text`, `-noout`, `-verify`, `-config`, `-addext`, `-sha256` |
| `rsa` | S | P3 | `-in`, `-out`, `-pubout`, `-text`, `-noout`, `-modulus`, `-check` |
| `rsautl` | S | P6 | déprécié en faveur de `pkeyutl`, gardé pour les TP anciens |
| `s_client` | S | P7 | vrai TCP + TLS simulé du dépôt : `-connect`, `-servername`, `-showcerts`, `-CAfile`, `-verify`, `-quiet`, `-tls1_2`, `-tls1_3` |
| `s_server` | S | P7 | `-accept`, `-cert`, `-key`, `-www` |
| `s_time` | X | — | mesure de débit : P5 du §5 l'interdit |
| `sess_id` | X | — | |
| `smime` | X | — | |
| `speed` | X | — | inventerait une mesure |
| `spkac` | X | — | |
| `srp` | X | — | |
| `storeutl` | X | — | |
| `ts` | X | — | horodatage RFC 3161 |
| `verify` | S | P5 | `-CAfile`, `-CApath`, `-untrusted`, `-purpose`, `-show_chain` — s'appuie sur `CertificateVerifier`, déjà réel |
| `version` | R | P0 | `-a`, `-v`, `-b`, `-d`, `-p` |
| `x509` | S | P3 | `-in`, `-out`, `-noout`, `-text`, `-subject`, `-issuer`, `-dates`, `-startdate`, `-enddate`, `-fingerprint`, `-serial`, `-purpose`, `-req`, `-CA`, `-CAkey`, `-CAcreateserial`, `-days`, `-checkend`, `-modulus`, `-ext` |

### 8.2 Commandes de hachage (alias de `dgst`)

`md4`, `md5`, `sha1`, `sha224`, `sha256`, `sha384`, `sha512`,
`sha3-224`, `sha3-256`, `sha3-384`, `sha3-512`, `shake128`, `shake256`,
`blake2b512`, `blake2s256`, `rmd160`, `sm3`.

- **R** pour `md4`, `md5`, `sha1`, `sha256`, `sha512` — les cinq que
  `src/crypto/hash/` implémente réellement.
- **X** pour tous les autres. `sha224` et `sha384` sont des troncatures
  de `sha256`/`sha512` avec des vecteurs d'initialisation différents :
  les implémenter serait faisable, mais ce serait de la cryptographie
  neuve, pas du branchement — donc une phase à part (§12), pas un
  ajout en passant.
- Le refus doit nommer l'algorithme (§11.2), parce qu'un apprenant qui
  tape `openssl sha384` doit comprendre que c'est CE build qui ne
  l'offre pas, et non openssl.

### 8.3 Commandes de chiffrement (alias de `enc`)

`base64`, `aes-128-cbc`, `aes-128-ecb`, `aes-192-cbc`, `aes-192-ecb`,
`aes-256-cbc`, `aes-256-ecb`, `aes-128-gcm`, `aes-256-gcm`,
`aria-*`, `camellia-*`, `sm4-*`, `des`, `des-ede3`, `des-ede3-cbc`,
`des3`, `desx`, `rc2`, `rc4`, `chacha20`, `chacha20-poly1305`, `seed`.

- **R** : `base64`, `aes-128-cbc`, `aes-192-cbc`, `aes-256-cbc`,
  `aes-128-gcm`, `aes-256-gcm`, `des`, `des3`/`des-ede3-cbc`.
- **R avec réserve, et la réserve est écrite** : les modes `-ecb`
  peuvent être servis par `aesEncryptBlock` bloc à bloc, mais ECB ne
  doit jamais être présenté comme un choix ordinaire — la sortie porte
  l'avertissement qu'un vrai cours porterait.
- **X** : `aria`, `camellia`, `sm4`, `rc2`, `rc4`, `chacha20`, `seed`,
  `desx` — aucune implémentation dans `src/crypto/cipher/`.

## 9. Phases

### P0 — le squelette, et le mensonge qui cesse

- Le `LinuxCommand` `openssl`, `binaryPath: '/usr/bin/openssl'`, déclaré
  dans `STANDARD_BIN_PATHS` afin que `rm /usr/bin/openssl` le fasse
  disparaître comme n'importe quel autre binaire (`CriticalFiles.ts`).
- `version` (avec `-a`), `help`, dispatch des sous-modes, les trois
  familles du §5 P4, les codes de sortie du §11.
- `openssl` sans argument entre en mode interactif sur un vrai openssl.
  Ici : un message qui le dit et refuse, plutôt qu'un faux prompt.

- **Acceptation :** `dpkg -l openssl` et l'existence du binaire
  s'accordent ; `openssl version` répond ; un sous-mode inconnu est
  refusé avec le message d'openssl ; un sous-mode connu mais non
  implémenté est refusé avec le nôtre.

### P1 — ce qui est déjà réel : empreintes et aléa

`dgst` et ses alias, `rand`.

Le point de vérification qui compte, et qui est le vrai contrat de
cette phase : **`sha256sum f` et `openssl dgst -sha256 f` sur la même
machine rendent la même empreinte**, parce qu'ils appellent le même
`sha256Hex`. Un simulateur où les deux divergeraient enseignerait qu'une
empreinte dépend de l'outil.

Formats de sortie fidèles :
`SHA2-256(f)= <hex>` pour `dgst -sha256 f`, `<hex> *f` pour `-r`.

### P2 — chiffrement symétrique, KDF, mots de passe

`enc` (et ses alias), `base64`, `kdf`, `mac`, `passwd`.

`enc` est la commande la plus piégeuse d'openssl et il faut la faire
juste :

- l'en-tête `Salted__` + 8 octets de sel, qui est ce que voit un
  `xxd` sur le fichier chiffré ;
- `-pbkdf2` et `-iter`, sans lesquels openssl 3 avertit ;
- l'aller-retour `-d` doit **rendre exactement l'entrée**, et un mot de
  passe faux doit échouer (`bad decrypt`), pas rendre du bruit.

### P3 — le geste attendu : clés, CSR, certificats

`genrsa`, `genpkey`, `rsa`, `pkey`, `req`, `x509`.

C'est la phase qui lève le verrou de `PRD-Nginx` §P5. Elle suppose
`src/network/pki/pem.ts` (§7) livré d'abord.

Le scénario complet à faire marcher, et c'est celui de tout TP :

```sh
openssl genrsa -out serveur.key 2048
openssl req -new -key serveur.key -out serveur.csr -subj "/CN=www.lab"
openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.crt \
        -days 365 -nodes -subj "/CN=Lab Root CA"
openssl x509 -req -in serveur.csr -CA ca.crt -CAkey ca.key \
        -CAcreateserial -out serveur.crt -days 90
openssl x509 -in serveur.crt -noout -subject -issuer -dates
```

`-subj` doit accepter la forme `/C=FR/ST=…/O=…/CN=…` réelle, y compris
les composants répétés, et `-addext "subjectAltName=DNS:…,IP:…"`.

### P4 — les commandes de description

`ciphers`, `list`, `errstr`, `info`, `prime`.

`ciphers` ne doit **pas** réciter la liste d'un vrai openssl : il
énumère ce que les transports TLS de ce dépôt offrent réellement,
sinon il décrit une autre machine.

### P5 — la PKI de labo

`ca`, `verify`, `crl`.

`verify` s'appuie sur `CertificateVerifier`, déjà réel et déjà utilisé
par `curl` : c'est une porte, pas un moteur neuf. Les codes de sortie
et les messages (`error 18 at 0 depth lookup: self signed certificate`,
`error 10 … certificate has expired`) sont ceux d'openssl.

### P6 — le reste de la PKI

`ec`, `ecparam`, `pkcs8`, `pkeyutl`, `rsautl`, `ocsp`, `pkeyparam`,
`rehash`.

### P7 — le réseau

`s_client`, `s_server`.

`s_client -connect hôte:443` ouvre une **vraie** connexion par la pile
TCP du simulateur — comme `curl` et `nc` le font déjà — et rend la
chaîne présentée, le sujet, l'émetteur, le résultat de vérification.
C'est l'outil de diagnostic TLS que les TP réclament, et il n'y a rien
à inventer : le transport existe.

## 10. Ce que `openssl` débloque ailleurs

Écrit ici pour que ces suites ne soient pas oubliées une fois le
chantier livré :

1. **`PRD-Nginx` §P5 (HTTPS)** — `ssl_certificate`/`ssl_certificate_key`
   lisent des fichiers que P3 sait produire.
2. **apache2 en HTTPS**, même mécanisme (`PRD-Manquements` §M4a).
3. **Clés d'hôte sshd** — `/etc/ssh/ssh_host_rsa_key` devient un
   fichier qu'on peut régénérer, ce que `docs/PRD-Pannes.md` §F7.2
   suppose déjà en le supprimant.
4. **`curl --cacert`** — l'ancre devient fabricable depuis un terminal.
5. **PKI Windows** — `certutil` et le rôle AD CS peuvent exporter vers
   le même format, donc les deux plateformes échangent des certificats
   comme sur un vrai réseau.

## 11. Messages et codes de sortie

### 11.1 Codes

| Code | Cas |
|---|---|
| 0 | succès |
| 1 | erreur d'usage, fichier illisible, option refusée |
| 2 | `verify` : la chaîne est invalide |
| 3 | `x509 -checkend` : le certificat expire dans l'intervalle |

### 11.2 Les trois familles du §5 P4

```
# implémentée → agit
$ openssl dgst -sha256 f
SHA2-256(f)= 9f86d0…

# connue d'openssl, non implémentée ici
$ openssl speed
openssl: 'speed' is not implemented in this simulator

# inexistante
$ openssl frobnicate
openssl:Error: 'frobnicate' is an invalid command.
```

Le message du milieu n'est pas un message d'openssl, et c'est
délibéré : aucun openssl réel n'est jamais dans cette situation.
Répondre `is an invalid command` pour `speed` serait affirmer qu'openssl
ne connaît pas `speed`, ce qui est faux et ce qu'un apprenant retiendrait.

### 11.3 Où la simulation se déclare

`openssl x509 -text` affiche la structure réelle du certificat, et
ajoute, à l'endroit où un vrai openssl imprimerait le module :

```
        RSA Public-Key: (2048 bit)
            Modulus:
                <simulated key material — this build does not compute
                 real RSA moduli; see docs/PRD-OpenSSL.md §3.2>
```

C'est le §5 P3 appliqué : l'information est là où elle est lue.

## 12. Hors périmètre, nommé plutôt que tu

- **Interopérabilité binaire** avec un vrai openssl (§4). Elle
  supposerait un encodeur/décodeur DER **et** une vraie arithmétique
  RSA/EC : deux chantiers, dont le second change la convention du §3.2.
- **`sha224`, `sha384`, la famille SHA-3, BLAKE2, SM3, RIPEMD** —
  faisables mais c'est écrire de la cryptographie, pas brancher
  l'existante. Une phase à part, avec ses vecteurs de test officiels.
- **`aria`, `camellia`, `sm4`, `rc2`, `rc4`, `chacha20-poly1305`,
  `seed`** — idem côté chiffrement.
- **`pkcs12`, `pkcs7`, `cms`, `smime`, `ts`, `srp`, `spkac`,
  `storeutl`, `nseq`, `crl2pkcs7`, `asn1parse`** — conteneurs et
  protocoles binaires, sans usage pédagogique atteignable tant que le
  DER n'existe pas.
- **`speed`, `s_time`** — mesures de performance : §5 P5 les interdit.
- **`engine`, `fipsinstall`** — notions absentes du simulateur.
- **DSA et Diffie-Hellman** (`dsa`, `dsaparam`, `gendsa`, `dhparam`) —
  `PkiKeyPair` ne connaît que RSA et ECDSA ; les ajouter est un travail
  sur la PKI, pas sur la commande.
- **Le mode interactif** (`openssl` sans argument) — refusé avec un
  message qui le dit, plutôt qu'un prompt qui ne saurait rien faire.
- **Windows** — le vrai Windows ne livre pas `openssl`. Contrairement à
  `curl` (livré depuis 1803, d'où `PRD-Curl` et son moteur partagé),
  il n'y a **pas** lieu de le porter. Si un besoin apparaît côté
  Windows, la bonne réponse est `certutil`, et le moteur PKI est déjà
  partagé — c'est la porte qui diffère.

## 13. Spécification détaillée, sous-commande par sous-commande

Cette section est écrite pour être suivie sans retourner au vrai
`openssl`. Les formats de sortie y sont littéraux : ce sont eux que les
tests compareront, et une chaîne approximative ne se rattrape pas plus
tard.

### 13.1 `openssl version`

| Option | Effet |
|---|---|
| *(aucune)* | `OpenSSL 3.0.2 15 Mar 2022 (Library: OpenSSL 3.0.2 15 Mar 2022)` |
| `-v` | la même première ligne, seule |
| `-b` | `built on: <date de compilation simulée, stable>` |
| `-d` | `OPENSSLDIR: "/usr/lib/ssl"` |
| `-e` | `ENGINESDIR: "/usr/lib/x86_64-linux-gnu/engines-3"` |
| `-m` | `MODULESDIR: "/usr/lib/x86_64-linux-gnu/ossl-modules"` |
| `-p` | `platform: debian-amd64` |
| `-f` | `compiler: …` |
| `-a` | tout ce qui précède, dans cet ordre |

La version annoncée doit être **celle du paquet** déclaré dans
`PackageDatabase.ts` (`3.0.2-0ubuntu1`), sinon `dpkg -l openssl` et
`openssl version` se contredisent — le défaut même que ce chantier
corrige, réintroduit à un autre endroit.

### 13.2 `openssl dgst` et ses alias

```
openssl dgst [-sha256|-sha1|-md5|-sha512|-md4] [-hex|-binary|-r]
             [-hmac clé] [-out fichier] [fichier...]
```

| Option | Effet |
|---|---|
| `-<algo>` | choisit l'empreinte ; défaut `-sha256` (openssl 3) |
| `-hex` | sortie hexadécimale (défaut) |
| `-binary` | octets bruts, sans nom de fichier ni retour |
| `-r` | format « coreutils » : `<hex> *<fichier>` |
| `-hmac <clé>` | HMAC au lieu de l'empreinte simple |
| `-out <f>` | écrit au lieu d'afficher |
| *(aucun fichier)* | lit l'entrée standard |

Sorties littérales :

```
$ openssl dgst -sha256 message.txt
SHA2-256(message.txt)= 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08

$ openssl dgst -md5 message.txt
MD5(message.txt)= 78e731027d8fd50ed642340b7c9a63b3

$ openssl dgst -sha256 -r message.txt
9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 *message.txt

$ echo -n test | openssl dgst -sha1
SHA1(stdin)= a94a8fe5ccb19ba61c4c0873d391e987982fbbd3
```

Le préfixe est `SHA2-256` et non `SHA256` : c'est le nom d'algorithme
d'OpenSSL 3, et il a changé entre la 1.1 et la 3. Se tromper là-dessus
est le genre de détail qu'un apprenant compare avec sa propre machine.

Un fichier absent : `<f>: No such file or directory`, code 1.

### 13.3 `openssl enc`

```
openssl enc -<chiffre> [-d] [-a|-base64] [-k mdp|-pass arg]
            [-pbkdf2] [-iter n] [-md algo] [-S sel] [-salt|-nosalt]
            [-in f] [-out f] [-p|-P] [-nopad]
```

| Option | Effet |
|---|---|
| `-d` | déchiffre (défaut : chiffre) |
| `-a`/`-base64` | armure base64 autour du résultat |
| `-k <mdp>` | mot de passe en clair (déconseillé par openssl, gardé) |
| `-pass pass:X` / `-pass file:F` / `-pass env:V` | les trois formes réelles |
| `-pbkdf2` | dérivation PBKDF2 (sans quoi openssl 3 avertit) |
| `-iter <n>` | itérations, défaut 10000 avec `-pbkdf2` |
| `-md <algo>` | empreinte de la dérivation, défaut `sha256` |
| `-S <hex>` | sel imposé — indispensable pour un test déterministe |
| `-nosalt` | sans sel (et sans en-tête `Salted__`) |
| `-p` | affiche sel/clé/IV puis opère |
| `-P` | les affiche et **n'opère pas** |

Le format de fichier est celui d'openssl et il est visible :

```
"Salted__" (8 octets ASCII) ‖ sel (8 octets) ‖ texte chiffré
```

`-p` affiche exactement :

```
salt=A1B2C3D4E5F60718
key=603DEB1015CA71BE2B73AEF0857D77811F352C073B6108D72D9810A30914DFF4
iv =000102030405060708090A0B0C0D0E0F
```

Un mot de passe faux au déchiffrement donne, code 1 :

```
bad decrypt
40E7F1B8C87F0000:error:1C800064:Provider routines:ossl_cipher_unpadblock:bad decrypt:../providers/implementations/ciphers/ciphercommon_block.c:107:
```

Cette seconde ligne est verbeuse et laide, et c'est exactement ce
qu'affiche un vrai openssl : la reproduire évite qu'un apprenant croie
à un bug du simulateur quand il verra la vraie.

### 13.4 `openssl base64`

Alias de `enc -base64`, sans chiffrement.

```
$ echo -n "Bonjour" | openssl base64
Qm9uam91cg==
$ echo Qm9uam91cg== | openssl base64 -d
Bonjour
```

Le retour à la ligne tous les 64 caractères est celui d'openssl ;
`-A` le supprime.

### 13.5 `openssl rand`

```
openssl rand [-hex|-base64] [-out fichier] <nombre d'octets>
```

Sans `-hex` ni `-base64`, la sortie est binaire — dans un terminal
simulé, elle s'affiche comme un vrai terminal l'afficherait, et le sens
de l'exercice est justement d'apprendre à rediriger. `-out` est le
geste correct et doit marcher.

L'aléa vient de `OpenSslHost.randomBytes()` (§6), donc un test peut le
fixer. Sans cela, `openssl rand -hex 16` n'est pas testable.

### 13.6 `openssl passwd`

| Option | Effet |
|---|---|
| `-1` | MD5-crypt — **réel**, `md5Crypt` existe |
| `-apr1` | variante Apache, même moteur, préfixe `$apr1$` |
| `-5` / `-6` | SHA-256 / SHA-512 crypt |
| `-salt <s>` | sel imposé |
| `-stdin` | lit le mot de passe sur l'entrée standard |
| `-noverify` | ne redemande pas la confirmation |

**Le cas `-5`/`-6` demande une décision, et il faut la prendre
explicitement.** Le projet stocke déjà les secrets sous la forme
`$6$simulated$<clair>` (voir `LinuxUserManager`, documenté dans
`CLAUDE.md`). Deux options, et une seule est cohérente :

- inventer un vrai sha512-crypt (l'algorithme de Drepper, 5000 tours
  d'une construction précise) : ce serait de la cryptographie neuve, et
  surtout cela **casserait** la convention de stockage existante, donc
  l'authentification de tous les comptes du simulateur ;
- rendre la forme que la plateforme utilise déjà, `$6$<sel>$<…>`, avec
  la même construction que `LinuxUserManager` — de sorte qu'un
  `openssl passwd -6 secret` copié dans `/etc/shadow` **fonctionne
  réellement**.

**La seconde est la bonne**, et pour une raison qui n'est pas la
facilité : le TP qui compte est « fabriquez une empreinte et posez-la
dans `/etc/shadow` », et il n'a de sens que si le compte s'authentifie
ensuite. Une empreinte cryptographiquement exacte que le simulateur
refuserait serait un exercice qui échoue en enseignant que la méthode
est fausse. La divergence avec un vrai `openssl passwd -6` est écrite
dans la sortie de `--help` et dans ce PRD.

### 13.7 `openssl genrsa` / `genpkey` / `rsa` / `pkey`

```
openssl genrsa [-out f] [-traditional] [numbits]
openssl genpkey -algorithm RSA [-pkeyopt rsa_keygen_bits:N] [-out f]
openssl rsa -in f [-out f] [-pubout] [-text] [-noout] [-modulus] [-check]
```

`genrsa` écrit une clé privée PEM (`-----BEGIN PRIVATE KEY-----`, ou
`RSA PRIVATE KEY` avec `-traditional`, comme openssl 3). La taille
demandée est **enregistrée dans l'objet clé** et ressortie par
`rsa -text`, sinon `-out` et `-text` se contrediraient sur la même clé.

`rsa -check` rend `RSA key ok` — et c'est une affirmation que ce build
peut honnêtement faire, puisqu'elle porte sur la cohérence de
l'objet, pas sur une primalité qu'il ne calcule pas. La nuance est
écrite au §11.3.

### 13.8 `openssl req`

La sous-commande la plus riche, et le geste par lequel tout commence.

| Option | Effet |
|---|---|
| `-new` | crée un CSR |
| `-x509` | crée directement un certificat auto-signé |
| `-newkey rsa:N` | génère la clé en même temps |
| `-key <f>` | utilise une clé existante |
| `-keyout <f>` | où écrire la clé générée |
| `-out <f>` | où écrire le CSR ou le certificat |
| `-days <n>` | validité avec `-x509` (défaut 30) |
| `-subj <dn>` | sujet non interactif, forme `/C=FR/O=…/CN=…` |
| `-nodes` / `-noenc` | ne chiffre pas la clé privée |
| `-addext <ext>` | extension, p. ex. `subjectAltName=DNS:a,DNS:b,IP:10.0.0.1` |
| `-text` | affiche le contenu en clair en plus de l'écrire |
| `-noout` | n'écrit pas l'objet encodé |
| `-verify` | vérifie la signature du CSR |
| `-config <f>` | fichier de configuration |
| `-sha256` | empreinte de signature |

**Le mode interactif est le comportement par défaut** d'un `openssl req`
sans `-subj` : il pose une à une les questions Country/State/Locality/
Organization/OU/Common Name/Email. Le simulateur possède déjà
l'infrastructure pour cela (`terminal/intent/`, `InteractiveFlow`,
utilisée par `passwd` et `ssh`), donc **il faut le faire** plutôt que
d'exiger `-subj` : c'est la première chose que voit quiconque tape
`openssl req` pour la première fois, et l'omettre changerait la leçon.

Les invites sont littérales, valeurs par défaut comprises :

```
Country Name (2 letter code) [AU]:
State or Province Name (full name) [Some-State]:
Locality Name (eg, city) []:
Organization Name (eg, company) [Internet Widgits Pty Ltd]:
Organizational Unit Name (eg, section) []:
Common Name (e.g. server FQDN or YOUR name) []:
Email Address []:
```

### 13.9 `openssl x509`

| Option | Effet |
|---|---|
| `-in <f>` | certificat d'entrée |
| `-out <f>` | sortie |
| `-noout` | n'affiche pas l'objet encodé |
| `-text` | description complète |
| `-subject` / `-issuer` | `subject=CN = www.lab` / `issuer=CN = Lab Root CA` |
| `-dates` | `notBefore=…` et `notAfter=…` |
| `-startdate` / `-enddate` | l'une des deux |
| `-serial` | `serial=5001` |
| `-fingerprint [-sha256]` | `SHA256 Fingerprint=AB:CD:…` |
| `-checkend <s>` | code 1 si le certificat expire dans `s` secondes |
| `-purpose` | usages autorisés |
| `-modulus` | `Modulus=<…>` (voir §11.3) |
| `-ext <noms>` | n'affiche que ces extensions |
| `-req` | l'entrée est un CSR, à signer |
| `-CA <f>` / `-CAkey <f>` | l'autorité signataire |
| `-CAcreateserial` | crée le fichier `.srl` |
| `-days <n>` | validité du certificat signé |

Le format de date est celui d'openssl et pas celui de la locale :
`notBefore=Aug  5 08:00:00 2026 GMT` — trois lettres de mois, jour sur
deux colonnes (donc deux espaces avant un jour à un chiffre), `GMT`.

`-checkend` est le seul sous-mode dont le **code de sortie est le
résultat** : 0 si le certificat tient encore, 1 sinon, avec
`Certificate will expire` / `Certificate will not expire` sur la
sortie. C'est ce qu'utilisent les scripts de supervision, donc c'est ce
qu'un TP de supervision utilisera.

### 13.10 `openssl verify`

```
openssl verify [-CAfile f] [-CApath d] [-untrusted f]
               [-purpose p] [-show_chain] certificat...
```

Sorties littérales, succès et échec :

```
$ openssl verify -CAfile ca.crt serveur.crt
serveur.crt: OK

$ openssl verify serveur.crt
C = FR, CN = www.lab
error 20 at 0 depth lookup: unable to get local issuer certificate
error serveur.crt: verification failed
```

Les codes d'erreur sont ceux d'openssl et doivent être exacts, parce
qu'ils sont ce qu'un opérateur cherche dans un moteur de recherche :
`10` expiré, `18` auto-signé, `19` racine auto-signée dans la chaîne,
`20` émetteur introuvable, `21` impossible de vérifier le premier
certificat, `24` certificat d'autorité invalide.

Le code de sortie est `2` en cas d'échec de vérification (§11.1) — pas
`1`, qui signale une erreur d'usage.

### 13.11 `openssl s_client`

```
openssl s_client -connect hôte:port [-servername nom] [-showcerts]
                 [-CAfile f] [-verify n] [-quiet] [-tls1_2|-tls1_3]
```

Ouvre une **vraie** connexion par la pile TCP du simulateur. La sortie
reprend la forme d'openssl :

```
CONNECTED(00000003)
depth=1 CN = Lab Root CA
verify return:1
depth=0 CN = www.lab
verify return:1
---
Certificate chain
 0 s:CN = www.lab
   i:CN = Lab Root CA
 1 s:CN = Lab Root CA
   i:CN = Lab Root CA
---
SSL handshake has read 1234 bytes and written 567 bytes
Verification: OK
---
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
```

Une connexion refusée donne `connect:errno=111`, comme le vrai client,
et non un message inventé.

## 14. Scénarios de bout en bout

Ces trois scénarios sont le contrat d'acceptation du chantier : ils
doivent marcher tapés à la main dans le terminal du navigateur.

**S1 — la PKI de labo.** Créer une CA, signer un certificat serveur,
le vérifier, l'installer dans nginx, l'atteindre en HTTPS depuis un
autre poste avec `curl --cacert`.

**S2 — le fichier chiffré.** Chiffrer un fichier avec
`enc -aes-256-cbc -pbkdf2`, vérifier avec `xxd` que l'en-tête
`Salted__` est là, le déchiffrer, comparer avec `diff` — puis échouer
délibérément avec un mauvais mot de passe et lire `bad decrypt`.

**S3 — l'empreinte partagée.** Calculer l'empreinte d'un fichier avec
`sha256sum`, puis avec `openssl dgst -sha256`, puis l'envoyer sur une
autre machine par `scp` et vérifier qu'elle y est identique. C'est le
§5 P1 rendu visible bout en bout.

## 15. Vérification

Comme les PRD précédents :

- unitaires sur le comportement observable, pas sur les internes ;
- un équivalent e2e Playwright, parce que la valeur de cette commande
  est qu'un opérateur la tape lui-même ;
- discrimination par neutralisation ou `git stash` : un correctif dont
  on n'a pas vu le défaut tomber n'est pas un correctif ;
- régression complète avant de pousser, mesurée contre une baseline en
  worktree.

Trois vérifications propres à ce chantier, parce qu'elles ne se
déduisent d'aucune autre :

1. **L'accord entre outils.** `sha256sum`, `openssl dgst -sha256` et
   `openssl sha256` rendent la même empreinte du même fichier. C'est le
   §5 P1 rendu observable.
2. **L'aller-retour PEM.** Écrire un certificat, le relire, le comparer
   champ par champ — puis le donner à nginx et obtenir un vrai HTTPS.
   C'est le §5 P2 : un fichier, un codec, deux lecteurs.
3. **Le mensonge du paquet.** `dpkg -l openssl` dit installé **et** le
   binaire existe ; après `rm /usr/bin/openssl`, la commande échoue
   comme n'importe quel binaire supprimé. C'est le défaut du §1, rendu
   impossible à revenir.
