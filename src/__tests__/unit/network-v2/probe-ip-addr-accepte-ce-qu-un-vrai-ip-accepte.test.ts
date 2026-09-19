/**
 * `ip addr add' refusait ce qu'un vrai `ip' accepte, et inventait ses refus.
 *
 * MESURE DE DEPART sur `2acb7b5b', sur un LinuxPC dont eth0 porte
 * 10.0.0.1/24 :
 *
 *   ip addr add 10.0.0.5 dev eth0       -> Error: either "local" or "peer"
 *                                          address is required.
 *   ip addr add 10.0.0.5/0 dev eth0     -> Error: invalid prefix length.
 *   ip addr add 10.0.0.5/33 dev eth0    -> Error: invalid prefix length.
 *   ip addr add 999.999.999.999/24 …    -> Error: 999.999.999.999 is not a
 *                                          valid IPv4 address.
 *   ip neigh add 10.0.0.9 dev eth0      -> RTNETLINK answers: Invalid
 *                                          argument (missing lladdr)
 *   ip neigh add 10.0.0.9 lladdr aa:… … -> RTNETLINK answers: Invalid
 *                                          argument (missing dev)
 *
 * AUTORITE. iproute2-6.1.0, le binaire de l'Ubuntu 24.04.4 hote de cette
 * session, dans un netns dedie, et la source `iproute2/iproute2'.
 * Transcriptions capturees :
 *
 *   # ip addr add 10.4.4.5 dev eth0            -> rc=0, sans un mot
 *   # ip addr add 10.4.4.4/0 dev eth0          -> rc=0, sans un mot
 *   # ip -br addr show dev eth0
 *       eth0@eth1  UP  10.0.0.1/24 10.4.4.4/0 10.4.4.5/32
 *   # ip addr add 10.9.9.9/33 dev eth0
 *       Error: any valid prefix is expected rather than "10.9.9.9/33".
 *   # ip addr add 999.999.999.999/24 dev eth0
 *       Error: any valid prefix is expected rather than "999.999.999.999/24".
 *   # ip neigh add 10.0.0.9 dev eth0
 *       Error: No link layer address given.
 *   # ip neigh add 10.0.0.9 lladdr 00:11:22:33:44:55
 *       Device and destination are required arguments.
 *
 * TROIS ECARTS, de trois natures.
 *
 * 1. UNE ADRESSE SANS PREFIXE EST ACCEPTEE, et vaut /32. `get_prefix_1'
 *    ne rend une erreur que si l'adresse elle-meme est invalide ; sans
 *    `/', `bytelen * 8' fait le prefixe, donc 32 en IPv4. La machine la
 *    REFUSAIT, avec une phrase qui parle de `local'/`peer' — deux
 *    mots-cles d'une autre commande. C'est la nuance que la regle 6
 *    nomme dans l'autre sens : refuser ce qu'un vrai equipement accepte
 *    fait perdre une ligne a l'import d'une configuration.
 *
 * 2. `/0' EST UN PREFIXE VALIDE. La borne etait `prefix < 1'.
 *
 * 3. LES MOTS DU REFUS ETAIENT INVENTES. Le vrai `ip' n'a qu'une phrase
 *    pour un prefixe illisible, et elle cite l'argument ENTIER :
 *    `lib/utils.c:789' — « Error: %s prefix is expected rather than
 *    "%s". » avec `family_name_verbose(AF_UNSPEC)' = « any valid ». Ni
 *    « invalid prefix length », ni « is not a valid IPv4 address » ne
 *    figurent dans iproute2. Pas davantage que le « RTNETLINK answers:
 *    Invalid argument (missing …) » du voisinage : `ipneigh.c:183' rend
 *    « Device and destination are required arguments. » et
 *    `lib/ll_addr.c:56' « "%s" is invalid lladdr. ».
 *
 * DEUX ECARTS DE PLUS, trouves par le TEMOIN qui est tombe.
 *
 * Le temoin relit l'adresse posee par `ip -br addr show dev eth0'. Il
 * echouait — et pas a cause de l'ajout : `ip addr show' montrait bien
 * l'adresse. `ip -br addr' en cachait deux choses.
 *
 * 4. LE FILTRE `dev' ETAIT ANALYSE PUIS IGNORE. `ipAddrBrief' recevait
 *    `args' et ne les lisait jamais : `ip -br addr show dev eth0'
 *    listait TOUTES les interfaces. `ipLinkBrief', juste en dessous,
 *    honorait le meme filtre — un meme fait ecrit deux fois, dont la
 *    copie permissive. La selection est desormais commune aux deux.
 *
 * 5. SEULE L'ADRESSE PRIMAIRE PARAISSAIT. Le vrai `-br' les aligne
 *    toutes sur la ligne :
 *      eth0@eth1  UP  10.0.0.1/24 10.0.0.5/32 10.4.4.4/0 10.4.4.5/32
 *
 * Et les COLONNES ne tombaient pas au bon endroit : `ipaddress.c:857'
 * ecrit `"%-16s "' pour le nom et `ip.c:136' `"%-14s "' pour l'etat —
 * seize et quatorze, chacun SUIVI d'une espace. La machine remplissait a
 * seize et quatorze sans les separateurs, donc chaque colonne arrivait un
 * cran trop tot. Verifie au caractere pres contre le binaire.
 *
 * MESURE : 9 cas tombent sur 10. Le seul qui passe des deux cotes est la
 * NON-REGRESSION — un peripherique inconnu garde `Cannot find device
 * "X"' et une adresse deja posee `RTNETLINK answers: File exists', deux
 * phrases qui etaient DEJA celles d'iproute2. Le temoin, lui, tombe : il
 * a servi a trouver les ecarts 4 et 5 au lieu de garantir le lab, et
 * c'est la NON-REGRESSION qui tient ce role ici.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

async function poste(): Promise<LinuxPC> {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  pc.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  return pc;
}

const run = (pc: LinuxPC, cmd: string): Promise<string> =>
  pc.executeCommand(cmd).then(String);

describe('`ip addr add` suit iproute2 sur ce qu il accepte et sur ce qu il refuse', () => {
  it('TEMOIN : une adresse avec son prefixe s ajoute et se relit', async () => {
    const pc = await poste();
    expect((await run(pc, 'ip addr add 10.0.0.8/24 dev eth0')).trim()).toBe('');
    expect(await run(pc, 'ip -br addr show dev eth0')).toContain('10.0.0.8/24');
  });

  it('une adresse SANS prefixe est acceptee', async () => {
    const pc = await poste();
    expect((await run(pc, 'ip addr add 10.0.0.5 dev eth0')).trim()).toBe('');
  });

  it('une adresse sans prefixe vaut /32', async () => {
    const pc = await poste();
    await run(pc, 'ip addr add 10.0.0.5 dev eth0');
    expect(await run(pc, 'ip -br addr show dev eth0')).toContain('10.0.0.5/32');
  });

  it('le prefixe /0 est valide', async () => {
    const pc = await poste();
    expect((await run(pc, 'ip addr add 10.4.4.4/0 dev eth0')).trim()).toBe('');
  });

  it('un prefixe hors bornes cite l argument ENTIER', async () => {
    const pc = await poste();
    expect((await run(pc, 'ip addr add 10.9.9.9/33 dev eth0')).trim())
      .toBe('Error: any valid prefix is expected rather than "10.9.9.9/33".');
  });

  it('une adresse illisible cite l argument ENTIER', async () => {
    const pc = await poste();
    expect((await run(pc, 'ip addr add 999.999.999.999/24 dev eth0')).trim())
      .toBe('Error: any valid prefix is expected rather than "999.999.999.999/24".');
  });

  it('aucune phrase inventee ne subsiste pour un prefixe', async () => {
    const pc = await poste();
    const sorties = [
      await run(pc, 'ip addr add 10.9.9.9/33 dev eth0'),
      await run(pc, 'ip addr add 999.999.999.999/24 dev eth0'),
    ].join('\n');
    expect(sorties).not.toContain('invalid prefix length');
    expect(sorties).not.toContain('is not a valid IPv4 address');
    expect(sorties).not.toContain('local');
  });

  it('`ip neigh add` sans lladdr emploie les mots d iproute2', async () => {
    const pc = await poste();
    expect((await run(pc, 'ip neigh add 10.0.0.9 dev eth0')).trim())
      .toBe('Error: No link layer address given.');
  });

  it('`ip neigh add` sans dev emploie les mots d iproute2', async () => {
    const pc = await poste();
    expect((await run(pc, 'ip neigh add 10.0.0.9 lladdr 00:11:22:33:44:55')).trim())
      .toBe('Device and destination are required arguments.');
  });

  it('NON-REGRESSION : peripherique inconnu et adresse deja posee', async () => {
    const pc = await poste();
    expect((await run(pc, 'ip addr add 10.0.0.9/24 dev nosuchdev')).trim())
      .toBe('Cannot find device "nosuchdev"');
    await run(pc, 'ip addr add 10.0.0.12/24 dev eth0');
    expect((await run(pc, 'ip addr add 10.0.0.12/24 dev eth0')).trim())
      .toBe('RTNETLINK answers: File exists');
  });
});
