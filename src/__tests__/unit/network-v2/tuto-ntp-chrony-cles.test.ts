/**
 * PRD-NTP-Tutoriel.md §12 / lot N10 — chrony lit ses cles, et
 * `ntp authenticate` gouverne le bon sens.
 *
 * ── Les deux defauts que cette sonde discrimine ──────────────────────
 *
 * 1. **`keyfile` etait lu par personne.** La directive etait analysee et
 *    rangee ; aucun secret n'atteignait le moteur. Donc `server X key 1`
 *    faisait partir un paquet portant un numero de cle SANS condensé —
 *    exactement la forme qu'un serveur rejette. Une machine Linux ne
 *    pouvait pas authentifier NTP.
 *
 * 2. **`ntp authenticate` filtrait dans le mauvais sens.** La porte
 *    d'authentification s'appliquait a TOUS les paquets recus, donc un
 *    routeur arme refusait de servir un client ordinaire. La
 *    documentation Cisco dit l'inverse en toutes lettres : la commande
 *    fait que « the system will not synchronize to a device unless the
 *    device carries one of the specified authentication keys » — elle
 *    gouverne ce que la machine CROIT, pas ce qu'elle SERT — et elle
 *    « does not ensure authentication of peer associations ». C'est
 *    `ntp access-group` qui restreint la clientele, pas elle.
 *
 * ── Ce qui passe des deux cotes, et pourquoi c'est dit ───────────────
 *
 * Les cas portant sur `parseChronyKeys` et `genererCleChrony` seuls
 * exercent des modules NEUFS : ils ne peuvent pas tomber avant, et ce
 * sont des garde-fous de format, pas des preuves de correction. Ceux qui
 * comptent passent par une vraie machine et un vrai cable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress } from '@/network/core/types';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { parseChronyKeys, genererCleChrony, CHRONY_KEYS_PATH } from '@/network/devices/linux/time/ChronyKeys';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

/**
 * Ecrire un fichier de `/etc/chrony`. Les deux appartiennent a root —
 * comme sur une vraie machine — d'ou le `sudo tee`, qui est aussi ce que
 * le tutoriel fait ecrire.
 */
async function ecrire(pc: LinuxPC, chemin: string, texte: string): Promise<string> {
  return pc.executeCommand(
    `printf '${texte.replace(/\n/g, '\\n')}' | sudo tee ${chemin}`);
}

/** Un routeur `ntp master` authentifiant, et un PC Linux sous chrony. */
async function labo(o: {
  cleServeur?: string;
  /** Le contenu de `/etc/chrony/chrony.keys` du PC. */
  clesClient?: string;
  /** La ligne `server` du `chrony.conf` du PC. */
  ligneServeur?: string;
  /** Le routeur arme-t-il `ntp authenticate` ? */
  authServeur?: boolean;
}) {
  const rtr = new CiscoRouter(`R${++serie}`);
  const pc = new LinuxPC(`P${serie}`);
  new Cable(`c${serie}`).connect(
    rtr.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);

  const cmds = ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit'];
  if (o.authServeur !== false) cmds.push('ntp authenticate');
  if (o.cleServeur) {
    cmds.push(`ntp authentication-key 1 md5 ${o.cleServeur}`, 'ntp trusted-key 1');
  }
  cmds.push('ntp master 2', 'end');
  for (const c of cmds) await rtr.executeCommand(c);

  await pc.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  if (o.clesClient !== undefined) await ecrire(pc, CHRONY_KEYS_PATH, o.clesClient);
  await ecrire(pc, '/etc/chrony/chrony.conf', [
    'keyfile /etc/chrony/chrony.keys',
    o.ligneServeur ?? 'server 10.0.0.1 iburst',
  ].join('\n'));
  await pc.executeCommand('sudo systemctl restart chrony');
  return { rtr, pc };
}

describe('le fichier de cles a le format du vrai chrony', () => {
  it('les trois formes de l\'exemple livre avec chrony sont lues', () => {
    // Ce sont les lignes du `chrony.keys.example` du projet, decommentees.
    const r = parseChronyKeys([
      '1 MD5 AVeryLongAndRandomPassword',
      '2 MD5 HEX:12114855C7931009B4049EF3EFC48A139C3F989F',
      '3 SHA1 HEX:B2159C05D6A219673A3B7E896B6DE07F6A440995',
    ].join('\n'));
    expect(r.refusees).toHaveLength(0);
    expect(r.cles.map((k) => `${k.id}/${k.algo}`)).toEqual(['1/MD5', '2/MD5', '3/SHA1']);
  });

  it('la forme historique a deux champs vaut MD5', () => {
    const r = parseChronyKeys('7 monsecret');
    expect(r.cles).toEqual([{ id: 7, algo: 'MD5', cle: 'monsecret' }]);
  });

  it('AES128 est REFUSE en nommant la fonction, pas ignore en silence', () => {
    // C'est une vraie entree du fichier de chrony, et ce depot n'a pas
    // de CMAC : l'accepter donnerait un condensé qu'aucune machine reelle
    // ne reconnaitrait.
    const r = parseChronyKeys('4 AES128 HEX:2DA837C4B6573748CA692B8C828E4891');
    expect(r.cles).toHaveLength(0);
    expect(r.refusees[0].raison).toContain('AES128');
  });

  it('une ligne fautive ne fait pas tomber les autres', () => {
    const r = parseChronyKeys(['pasunnumero cle', '5 MD5 bonne'].join('\n'));
    expect(r.cles).toHaveLength(1);
    expect(r.refusees).toHaveLength(1);
  });

  it('un numero repete : la PREMIERE ligne gagne', () => {
    // Sans cette regle, ajouter une ligne en fin de fichier detournerait
    // une cle existante.
    const r = parseChronyKeys(['3 MD5 originale', '3 MD5 detournee'].join('\n'));
    expect(r.cles).toEqual([{ id: 3, algo: 'MD5', cle: 'originale' }]);
  });

  it('le numero zero est refuse : il est reserve au crypto-NAK', () => {
    expect(parseChronyKeys('0 MD5 cle').cles).toHaveLength(0);
  });

  it('les commentaires `#` et `!` sont ignores, comme dans chrony.conf', () => {
    expect(parseChronyKeys('#1 MD5 exemple\n!2 MD5 autre\n3 MD5 vraie').cles)
      .toHaveLength(1);
  });
});

describe('`chronyc keygen` produit une ligne collable, avec les vrais defauts', () => {
  it('sans argument : numero 1, SHA1, 160 bits', async () => {
    const pc = new LinuxPC(`K${++serie}`);
    const out = await pc.executeCommand('chronyc keygen');
    // 160 bits = 20 octets = 40 caracteres hexadecimaux.
    expect(out.trim()).toMatch(/^1 SHA1 HEX:[0-9A-F]{40}$/);
  });

  it('les arguments sont honores : `keygen 73 SHA1 256`', async () => {
    const pc = new LinuxPC(`K${++serie}`);
    const out = await pc.executeCommand('chronyc keygen 73 SHA1 256');
    expect(out.trim()).toMatch(/^73 SHA1 HEX:[0-9A-F]{64}$/);
  });

  it('la ligne produite est relue par l\'analyseur du fichier de cles', () => {
    // La propriete qui compte : la commande de generation et le lecteur
    // du fichier doivent s'accorder, sinon la cle generee est inutilisable.
    const r = genererCleChrony(9, 'SHA1', 128);
    expect(r.ok).toBe(true);
    if (r.ok === false) return;
    const lu = parseChronyKeys(r.ligne);
    expect(lu.cles[0]).toMatchObject({ id: 9, algo: 'SHA1' });
  });

  it('une longueur hors bornes est refusee', () => {
    expect(genererCleChrony(1, 'SHA1', 40).ok).toBe(false);
  });

  it('elle repond sans demon : on prepare le fichier AVANT de demarrer', async () => {
    const pc = new LinuxPC(`K${++serie}`);
    expect(await pc.executeCommand('chronyc tracking')).toContain('506 Cannot talk to daemon');
    expect(await pc.executeCommand('chronyc keygen')).toMatch(/^1 SHA1 HEX:/);
  });
});

describe('une machine Linux authentifie NTP pour de vrai', () => {
  it('memes cles : la synchronisation aboutit', async () => {
    const { pc } = await labo({
      cleServeur: 'LeSecretPartage',
      clesClient: '1 MD5 LeSecretPartage',
      ligneServeur: 'server 10.0.0.1 iburst key 1',
    });
    const t = await pc.executeCommand('chronyc tracking');
    expect(t).toContain('10.0.0.1');
    expect(t).toMatch(/Stratum\s+:\s+3/);
  });

  it('cles DIFFERENTES : la synchronisation echoue', async () => {
    // Le cas central. Avant le correctif il aboutissait, parce que le
    // client ne signait rien du tout et que le routeur ne verifiait que
    // ce qui portait deja une cle.
    const { pc } = await labo({
      cleServeur: 'LeVraiSecret',
      clesClient: '1 MD5 CelleDeLAttaquant',
      ligneServeur: 'server 10.0.0.1 iburst key 1',
    });
    expect(await pc.executeCommand('chronyc tracking')).toMatch(/Stratum\s+:\s+16/);
  });

  it('`key 1` sans fichier de cles ne suffit pas', async () => {
    const { pc } = await labo({
      cleServeur: 'LeVraiSecret',
      clesClient: '# aucune cle ici',
      ligneServeur: 'server 10.0.0.1 iburst key 1',
    });
    expect(await pc.executeCommand('chronyc tracking')).toMatch(/Stratum\s+:\s+16/);
  });

  it('une cle SHA1 fonctionne, entre deux chrony', async () => {
    // Sans SHA1, la cle que `chronyc keygen` vient d'ecrire serait
    // inutilisable — le defaut le plus penible possible.
    //
    // Le laboratoire est Linux CONTRE Linux, et c'est une mesure et non
    // une commodite : `ntp authentication-key` d'IOS classique ne prend
    // que `md5`, donc un serveur Cisco ne saurait PAS repondre en SHA1.
    // Monter ce cas contre un routeur ferait echouer la sonde pour une
    // raison qui n'est pas celle qu'elle teste.
    const cle = 'HEX:B2159C05D6A219673A3B7E896B6DE07F6A440995';
    const srv = new LinuxPC(`SS${++serie}`);
    const cli = new LinuxPC(`CC${serie}`);
    new Cable(`d${serie}`).connect(srv.getPort('eth0')!, cli.getPort('eth0')!);
    await srv.executeCommand('ip addr add 10.0.0.1/24 dev eth0');
    await cli.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
    for (const pc of [srv, cli]) await ecrire(pc, CHRONY_KEYS_PATH, `4 SHA1 ${cle}`);
    await ecrire(srv, '/etc/chrony/chrony.conf',
      'keyfile /etc/chrony/chrony.keys\nlocal stratum 2\nallow 10.0.0.0/24');
    await ecrire(cli, '/etc/chrony/chrony.conf',
      'keyfile /etc/chrony/chrony.keys\nserver 10.0.0.1 iburst key 4');
    for (const pc of [srv, cli]) await pc.executeCommand('sudo systemctl restart chrony');
    expect(await cli.executeCommand('chronyc tracking')).toMatch(/Stratum\s+:\s+3/);
  });

  it('une cle `HEX:` est lue comme des OCTETS et non comme du texte', async () => {
    // Deux ecritures de la meme cle doivent donner deux secrets
    // differents : `HEX:41` note l'octet 0x41, pas les lettres `4` et `1`.
    const { pc } = await labo({
      cleServeur: 'HEX:41424344',
      clesClient: '1 MD5 41424344',
      ligneServeur: 'server 10.0.0.1 iburst key 1',
    });
    expect(await pc.executeCommand('chronyc tracking')).toMatch(/Stratum\s+:\s+16/);
  });

  it('retirer la cle du fichier et recharger la retire de la source', async () => {
    // La preuve que le fichier EST le magasin, et non une copie lue une
    // fois pour toutes au demarrage.
    //
    // Ce qui est observe est `authdata` et NON `tracking`, et la nuance
    // a ete mesuree : une machine deja synchronisee GARDE sa strate quand
    // son authentification se casse — elle ne revient pas a 16 —, donc
    // `tracking` aurait passe des deux cotes et n'aurait rien prouve.
    const { pc } = await labo({
      cleServeur: 'LeSecretPartage',
      clesClient: '1 MD5 LeSecretPartage',
      ligneServeur: 'server 10.0.0.1 iburst key 1',
    });
    const avant = (await pc.executeCommand('chronyc authdata'))
      .split('\n').find((l) => l.includes('10.0.0.1'))!;
    expect(avant.trim().split(/\s+/).slice(1, 3)).toEqual(['SK', '1']);
    await ecrire(pc, CHRONY_KEYS_PATH, '# plus de cle');
    await pc.executeCommand('chronyc reload');
    const apres = (await pc.executeCommand('chronyc authdata'))
      .split('\n').find((l) => l.includes('10.0.0.1'))!;
    expect(apres.trim().split(/\s+/).slice(1, 3)).toEqual(['-', '0']);
  });
});

describe('`chronyc authdata` decrit ce qui authentifie chaque source', () => {
  it('l\'en-tete est celui de la documentation de chrony', async () => {
    const { pc } = await labo({ ligneServeur: 'server 10.0.0.1 iburst' });
    const out = await pc.executeCommand('chronyc authdata');
    expect(out.split('\n')[0])
      .toBe('Name/IP address             Mode KeyID Type KLen Last Atmp  NAK Cook CLen');
  });

  it('une source a cle symetrique est `SK`, avec son numero et sa longueur', async () => {
    const { pc } = await labo({
      cleServeur: 'LeSecretPartage',
      clesClient: '1 MD5 LeSecretPartage',
      ligneServeur: 'server 10.0.0.1 iburst key 1',
    });
    const ligne = (await pc.executeCommand('chronyc authdata'))
      .split('\n').find((l) => l.includes('10.0.0.1'))!;
    // `Type` 1 = MD5 dans la table de chrony ; 15 caracteres = 120 bits.
    expect(ligne).toContain('SK');
    expect(ligne.trim().split(/\s+/).slice(1, 5)).toEqual(['SK', '1', '1', '120']);
  });

  it('une source SHA1 porte le code 2, pas le nom', async () => {
    const r = parseChronyKeys('2 SHA1 HEX:B2159C05D6A219673A3B7E896B6DE07F6A440995');
    expect(r.cles[0].algo).toBe('SHA1');
    const { pc } = await labo({
      cleServeur: 'HEX:B2159C05D6A219673A3B7E896B6DE07F6A440995',
      clesClient: '2 SHA1 HEX:B2159C05D6A219673A3B7E896B6DE07F6A440995',
      ligneServeur: 'server 10.0.0.1 iburst key 2',
    });
    const ligne = (await pc.executeCommand('chronyc authdata'))
      .split('\n').find((l) => l.includes('10.0.0.1'))!;
    // 20 octets = 160 bits, et le code 2 designe SHA1.
    expect(ligne.trim().split(/\s+/).slice(1, 5)).toEqual(['SK', '2', '2', '160']);
  });

  it('une source SANS authentification porte `-` et des zeros', async () => {
    const { pc } = await labo({ ligneServeur: 'server 10.0.0.1 iburst' });
    const ligne = (await pc.executeCommand('chronyc authdata'))
      .split('\n').find((l) => l.includes('10.0.0.1'))!;
    expect(ligne.trim().split(/\s+/).slice(1, 5)).toEqual(['-', '0', '0', '0']);
  });

  it('`Authenticated NTP packets` est MESURE et non deduit', async () => {
    // Il valait `recus - echecs`, donc il comptait comme authentifie tout
    // paquet nu. Sur une machine sans cle, la reponse juste est zero.
    const { pc } = await labo({ ligneServeur: 'server 10.0.0.1 iburst' });
    expect(await pc.executeCommand('chronyc serverstats'))
      .toContain('Authenticated NTP packets  : 0');
  });
});

describe('`ntp authenticate` gouverne ce que la machine CROIT, pas ce qu\'elle SERT', () => {
  it('un routeur authentifiant sert un client ORDINAIRE', async () => {
    // Le defaut mesure : la porte lisait `authenticate` et s'appliquait a
    // tous les paquets, donc ce client nu etait refuse. La documentation
    // Cisco dit que la commande ne concerne que les sources de temps.
    const { pc } = await labo({
      cleServeur: 'LeSecretDuRouteur',
      ligneServeur: 'server 10.0.0.1 iburst',
      clesClient: '# le client n\'a pas de cle, et n\'en demande pas',
    });
    expect(await pc.executeCommand('chronyc tracking')).toMatch(/Stratum\s+:\s+3/);
  });

  it('mais il refuse une requete qui PRESENTE une mauvaise cle', async () => {
    // Ce qui presente une cle est verifie : c'est la difference entre
    // « servir tout le monde » et « ne rien verifier ».
    const { pc } = await labo({
      cleServeur: 'LeVraiSecret',
      clesClient: '1 MD5 CelleDeLAttaquant',
      ligneServeur: 'server 10.0.0.1 iburst key 1',
    });
    expect(await pc.executeCommand('chronyc tracking')).toMatch(/Stratum\s+:\s+16/);
  });

  it('cote Cisco, le client sans `ntp authenticate` accepte une reponse nue', async () => {
    // Le pendant IOS de la meme regle : sans la commande, le routeur ne
    // verifie rien de ce qu'il RECOIT — c'est la cause la plus frequente
    // de « je croyais authentifier ».
    const srv = new CiscoRouter(`M${++serie}`);
    const cli = new CiscoRouter(`N${serie}`);
    new Cable(`e${serie}`).connect(
      srv.getPort('GigabitEthernet0/0')!, cli.getPort('GigabitEthernet0/0')!);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.1 255.255.255.0', 'no shutdown', 'exit',
      'ntp authenticate', 'ntp authentication-key 1 md5 Secret', 'ntp trusted-key 1',
      'ntp master 2', 'end']) await srv.executeCommand(c);
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
      'ip address 10.0.0.2 255.255.255.0', 'no shutdown', 'exit',
      'ntp server 10.0.0.1', 'end']) await cli.executeCommand(c);
    expect(await cli.executeCommand('show ntp status')).toMatch(/stratum 3/);
  });
});
