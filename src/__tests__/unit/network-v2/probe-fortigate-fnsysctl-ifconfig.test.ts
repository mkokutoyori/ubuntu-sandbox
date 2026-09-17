/**
 * `fnsysctl ifconfig' n'existait pas sur la FortiGate.
 *
 * MESURE DE DEPART sur `50d5966e', sur une FortiGate dont `port1' porte
 * 10.0.0.1/24 :
 *
 *   fnsysctl ifconfig -> Unknown action 0
 *                        Command fail. Return code -61
 *
 * La commande EXISTE sur un vrai FortiOS : `fnsysctl' donne acces aux
 * utilitaires du Linux sous-jacent, et `ifconfig' est celui que l'on tape
 * pour lire les compteurs d'une interface quand `get system interface' ne
 * les montre pas.
 *
 * AUTORITE. FortiOS est proprietaire : il n'y a pas de source a cloner, et
 * la documentation de Fortinet n'est pas joignable depuis cet
 * environnement. La reference est donc une SORTIE CAPTUREE — celle que
 * `ntc-templates' conserve pour eprouver son gabarit
 * `fortinet_fnsysctl_ifconfig.textfsm', c'est-a-dire le texte qu'un vrai
 * equipement a rendu. C'est exactement la source que CLAUDE.md nomme pour
 * les mises en page en colonnes, la documentation HTML ecrasant les
 * blancs.
 *
 *   wan     Link encap:Ethernet  HWaddr 12:34:56:78:90:AA
 *           inet addr:1.2.3.4  Bcast:1.2.3.5  Mask:255.255.255.252
 *           UP BROADCAST RUNNING MULTICAST  MTU:1500  Metric:1
 *           RX packets:7513822 errors:0 dropped:0 overruns:0 frame:0
 *           TX packets:12533342 errors:0 dropped:0 overruns:0 carrier:0
 *           collisions:0 txqueuelen:1000
 *           RX bytes:1116754241 (1.0 GB)  TX bytes:2218288063 (2.1 GB)
 *
 * CE QUE LA CAPTURE FIXE, et qu'on mettrait mal autrement :
 *
 * 1. LE NOM EST SUIVI D'UNE TABULATION. La capture, elle, porte des
 *    ESPACES : elle est passee par un terminal, qui rend une tabulation en
 *    poussant jusqu'au taquet. C'est l'ALIGNEMENT qui prouve le caractere
 *    d'origine. Sur les 21 noms distincts des deux captures, tous ceux de
 *    sept lettres ou moins amenent `Link' a la colonne 8, et tous ceux de
 *    huit a treize a la colonne 16 — des taquets de huit, jamais une
 *    largeur fixe. Aucun `ifconfig' connu ne produirait cela : busybox
 *    ecrit `%-9s ' (`networking/interface.c', l.924) et net-tools 1.60
 *    `%-9.9s ' (`lib/interface.c', l.673), qui poseraient `Link' a la
 *    colonne 10 pour `wan' comme pour `nturbo_rx', et tronqueraient
 *    `Loopback772'. On ecrit donc la tabulation, que le `<pre>' du
 *    terminal rend avec les memes taquets de huit.
 * 2. LE CORPS EST INDENTE DE HUIT ESPACES, et DEUX espaces separent les
 *    champs d'une meme ligne (`Ethernet  HWaddr', `MULTICAST  MTU:').
 * 3. UNE INTERFACE SANS ADRESSE N'A PAS DE LIGNE `inet addr:' du tout —
 *    elle n'est pas rendue vide.
 * 4. `RUNNING' NE PARAIT QUE SI LE LIEN EST ETABLI ; `UP' suit
 *    l'administration. Les deux sont distincts, et la capture porte les
 *    deux cas.
 * 5. LES OCTETS PORTENT LEUR FORME LISIBLE, en base 1024, a une decimale,
 *    ARRONDIE — et non tronquee comme le fait busybox par son
 *    `(reste * 10) / 1024'. Les 25 couples `bytes:N (V UNITE)' des deux
 *    captures ont ete recalcules : 25 sur 25 suivent l'arrondi, et deux
 *    d'entre eux le discriminent — 2218288063 rend `2.1 GB' quand la
 *    troncature rendrait `2.0', et 365165072 rend `348.2 MB' quand
 *    l'arrondi de 348.2355 le confirme. Sous 1024 la capture montre
 *    l'entier brut et DEUX espaces : `(0  Bytes)', `(152  Bytes)'.
 *    L'echelle s'arrete a `GB' parce que c'est la derniere unite que la
 *    capture atteste ; `TB' n'est pas invente.
 * 6. LA CASSE DU `HWaddr' NE VIENT PAS DE LA CAPTURE. Les adresses y sont
 *    anonymisees (`12:34:56:78:90:AA'), donc leur casse est celle de
 *    l'outil d'anonymisation, pas celle de l'equipement — la capture de
 *    `get hardware nic' porte d'ailleurs la casse inverse. L'autorite ici
 *    est la source des `ifconfig', qui s'accordent : busybox et net-tools
 *    impriment le `HWaddr' en `%02X'. On rend donc les majuscules, en
 *    derivant du seul `MACAddress' du port au lieu d'en reformater les
 *    octets.
 *
 * CE QUE LA MACHINE PORTAIT DEJA. Aucun de ces chiffres n'est invente :
 * `PortCounters' compte les trames, octets, erreurs et rejets des deux
 * sens depuis toujours, et `get hardware nic' les rend deja par un autre
 * chemin. Cette commande est une VUE de plus sur le meme magasin, ce que
 * la regle 3 demande — pas un second comptage. L'adresse est lue sur le
 * `Port' en `IPAddress'/`SubnetMask', et la diffusion en decoule par
 * `broadcastAddress' ; une interface a 0.0.0.0 est tenue pour sans
 * adresse, comme le fait deja `diagnose ip address list'.
 *
 * `overruns', `frame', `carrier' et `collisions' ne sont comptes nulle
 * part dans ce simulateur. Ils sont rendus a zero parce que c'est leur
 * valeur VRAIE ici — rien ne les incremente — et non pour meubler la
 * colonne. `txqueuelen:1000' est la valeur par defaut d'une interface
 * ethernet sous Linux.
 *
 * MESURE : 9 cas tombent sur 11.
 * Les deux cas qui passent des deux cotes sont nommes :
 *   - TEMOIN : `get hardware nic' rendait DEJA les compteurs du port —
 *     sans lui, une sonde faite de refus ne prouverait pas que le
 *     magasin existe ni que le lab cable quoi que ce soit ;
 *   - NON-REGRESSION : une sous-commande inconnue de `fnsysctl' reste
 *     refusee, et ce lot n'ouvre pas une porte de plus qu'il n'en decrit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function lab(): Promise<{ fw: FortiGate; pc: LinuxPC }> {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  fw.powerOn();
  pc.powerOn();
  new Cable('c1').connect(fw.getPorts()[0], pc.getPorts()[0]);
  const m = new SubnetMask('255.255.255.0');
  fw.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), m);
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), m);
  return { fw, pc };
}

const run = (fw: FortiGate, cmd: string): Promise<string> =>
  fw.executeCommand(cmd).then(String);

describe('`fnsysctl ifconfig` rend les compteurs que la machine porte deja', () => {
  it('TEMOIN : `get hardware nic` rend deja les compteurs du port', async () => {
    const { fw } = await lab();
    expect(await run(fw, 'get hardware nic port1')).toMatch(/rxp=\d+/);
  });

  it('la commande est acceptee', async () => {
    const { fw } = await lab();
    const out = await run(fw, 'fnsysctl ifconfig');
    expect(out).not.toContain('Unknown action');
    expect(out).not.toContain('Command fail');
  });

  it('le nom est suivi d une TABULATION, puis `Link encap:`', async () => {
    const { fw } = await lab();
    expect(await run(fw, 'fnsysctl ifconfig')).toContain('port1\tLink encap:Ethernet  HWaddr ');
  });

  it('le corps est indente de huit espaces', async () => {
    const { fw } = await lab();
    const lignes = (await run(fw, 'fnsysctl ifconfig')).split('\n');
    const corps = lignes.filter(l => l.includes('MTU:'));
    expect(corps.length).toBeGreaterThan(0);
    for (const l of corps) expect(l.startsWith('        ')).toBe(true);
  });

  it('l adresse posee parait avec son masque et sa diffusion', async () => {
    const { fw } = await lab();
    expect(await run(fw, 'fnsysctl ifconfig'))
      .toContain('inet addr:10.0.0.1  Bcast:10.0.0.255  Mask:255.255.255.0');
  });

  it('une interface SANS adresse n a pas de ligne `inet addr:`', async () => {
    const { fw } = await lab();
    const blocs = (await run(fw, 'fnsysctl ifconfig')).split('\n\n');
    const sansIp = blocs.find(b => b.startsWith('port2'));
    expect(sansIp).toBeDefined();
    expect(sansIp).not.toContain('inet addr:');
  });

  it('`RUNNING` ne parait que sur un lien etabli', async () => {
    const { fw } = await lab();
    const blocs = (await run(fw, 'fnsysctl ifconfig')).split('\n\n');
    expect(blocs.find(b => b.startsWith('port1'))).toContain('RUNNING');
    expect(blocs.find(b => b.startsWith('port2'))).not.toContain('RUNNING');
  });

  it('les compteurs sont ceux du port, et suivent le trafic', async () => {
    const { fw, pc } = await lab();
    await pc.executeCommand('ping -c 2 10.0.0.1');
    const bloc = (await run(fw, 'fnsysctl ifconfig')).split('\n\n')
      .find(b => b.startsWith('port1')) ?? '';
    const recus = /RX packets:(\d+)/.exec(bloc)?.[1] ?? '0';
    expect(Number(recus)).toBeGreaterThan(0);
    expect(Number(recus)).toBe(fw.getPorts()[0].getCounters().framesIn);
  });

  it('les octets portent leur forme lisible', async () => {
    const { fw } = await lab();
    const bloc = (await run(fw, 'fnsysctl ifconfig')).split('\n\n')
      .find(b => b.startsWith('port2')) ?? '';
    expect(bloc).toContain('RX bytes:0 (0  Bytes)  TX bytes:0 (0  Bytes)');
  });

  it('au-dela de 1024 octets la forme lisible est arrondie a une decimale', async () => {
    const { fw, pc } = await lab();
    await pc.executeCommand('ping -c 2 -s 1400 10.0.0.1');
    const bloc = (await run(fw, 'fnsysctl ifconfig')).split('\n\n')
      .find(b => b.startsWith('port1')) ?? '';
    const lu = /RX bytes:(\d+) \(([\d.]+) KB\)/.exec(bloc);
    expect(lu).not.toBeNull();
    const octets = Number(lu?.[1]);
    expect(octets).toBeGreaterThanOrEqual(1024);
    expect(lu?.[2]).toBe((Math.round(octets / 1024 * 10) / 10).toFixed(1));
  });

  it('NON-REGRESSION : une sous-commande inconnue de `fnsysctl` reste refusee', async () => {
    const { fw } = await lab();
    expect(await run(fw, 'fnsysctl zorglub')).toMatch(/Unknown action|Command fail/);
  });
});
