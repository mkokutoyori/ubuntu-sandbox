/**
 * `pba-timeout` PERIME vraiment un bloc de ports.
 *
 * §6.4 du carnet nomme le point : « `pba-timeout` est stocke et ne perime
 * rien : l'allocateur de blocs n'a pas d'horloge ». Meme famille que les
 * quatorze phases precedentes — un reglage accepte, rendu par `show`, et
 * lu par personne. Le pare-feu porte pourtant une horloge
 * (`services.now`), donc la brique existe.
 *
 * Ecrite A L'AVEUGLE contre ce que dit la documentation Fortinet : la
 * valeur est en SECONDES, bornee 3-300, defaut 30, et elle mesure une
 * INACTIVITE — « how long a port block allocation will remain active on
 * an idle IP pool before the FortiGate releases it back to the pool for
 * reallocation to other clients ». Donc :
 *
 *   1. Un bloc en cours d'usage n'est PAS repris.
 *   2. Un bloc inutilise depuis plus longtemps que `pba-timeout` est
 *      rendu au pool.
 *   3. **L'usage repousse l'echeance** : un client qui continue d'allouer
 *      garde son bloc au-dela du delai. C'est la difference entre un
 *      delai d'INACTIVITE et un bail a duree fixe, et c'est ce que la
 *      documentation dit.
 *   4. Une base rendue est REUTILISABLE : la reservation suivante
 *      reprend la plus basse libre, sinon le pool fuirait ses blocs.
 *   5. Les autres types de pool ne sont pas concernes.
 *
 * Discrimination (`git stash push -- src/network/`) : les cas d'expiration
 * tombent avant correctif. Les cas de bornes et le temoin « un bloc en
 * cours d'usage reste » passent des deux cotes et c'est dit ici — les
 * bornes sont deja tenues par le schema, et sans horloge AUCUN bloc
 * n'etait jamais repris, donc « il reste » etait vrai pour la mauvaise
 * raison.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { IpPoolAllocator, makeIpPool } from '@/network/devices/firewall/nat/IpPool';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

function run(sh: FortiShell, ...lines: string[]): string {
  let last = '';
  for (const line of lines) last = sh.execute(line);
  return last;
}

function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  return { fw, sh: fw.getShell() };
}

function poolDeBlocs(sh: FortiShell, timeout: number): string {
  return run(sh,
    'config firewall ippool',
    'edit "pba"',
    'set type port-block-allocation',
    'set startip 203.0.113.10',
    'set endip 203.0.113.10',
    'set block-size 64',
    'set num-blocks-per-user 2',
    `set pba-timeout ${timeout}`,
    'next', 'end');
}

function demande(sourceIP: string, sourcePort: number) {
  return { sourceIP, sourcePort, fixedPort: false, simulated: false };
}

/** Un allocateur dont on tient l'horloge, pour eprouver l'echeance. */
function allocateurAHorloge(pbaTimeout: number) {
  let instant = 1_000_000;
  const allocator = new IpPoolAllocator(() => instant);
  allocator.upsert(makeIpPool({
    name: 'pba',
    type: 'port-block-allocation',
    startIP: '203.0.113.10',
    endIP: '203.0.113.10',
    blockSize: 64,
    blocksPerUser: 2,
    pbaTimeout,
  }));
  return { allocator, avancer: (seconds: number) => { instant += seconds * 1000; } };
}

beforeEach(() => { Logger.reset(); });

describe('`pba-timeout` est accepte et transmis', () => {
  it('la valeur est rendue par `show`', () => {
    const { sh } = laboratoire();

    poolDeBlocs(sh, 5);

    expect(sh.execute('show firewall ippool')).toMatch(/set pba-timeout 5/);
  });

  it('la valeur atteint le pool', () => {
    const { fw, sh } = laboratoire();

    poolDeBlocs(sh, 45);

    expect(fw.getIpPools().get('pba')?.pbaTimeout).toBe(45);
  });

  it('le defaut est 30 secondes, comme sur une vraie machine', () => {
    const { fw, sh } = laboratoire();

    run(sh, 'config firewall ippool', 'edit "pba"',
      'set type port-block-allocation',
      'set startip 203.0.113.10', 'next', 'end');

    expect(fw.getIpPools().get('pba')?.pbaTimeout).toBe(30);
  });

  it('une valeur sous la borne est refusee', () => {
    const { sh } = laboratoire();
    run(sh, 'config firewall ippool', 'edit "pba"',
      'set type port-block-allocation');

    expect(run(sh, 'set pba-timeout 2')).toMatch(/Command fail|value parse error/i);
    run(sh, 'abort');
  });

  it('une valeur au-dessus de la borne est refusee', () => {
    const { sh } = laboratoire();
    run(sh, 'config firewall ippool', 'edit "pba"',
      'set type port-block-allocation');

    expect(run(sh, 'set pba-timeout 301')).toMatch(/Command fail|value parse error/i);
    run(sh, 'abort');
  });
});

describe('un bloc de ports expire pour de bon', () => {
  it('un bloc en cours d`usage n`est pas repris', () => {
    const { allocator, avancer } = allocateurAHorloge(10);
    const premier = allocator.allocate('pba', demande('10.0.0.1', 1000));

    avancer(5);
    allocator.allocate('pba', demande('10.0.0.1', 1001));
    avancer(5);

    expect(allocator.blocksHeldBy('pba', '10.0.0.1')).toHaveLength(1);
    expect(premier).not.toBeNull();
  });

  it('un bloc inutilise plus longtemps que le delai est rendu', () => {
    const { allocator, avancer } = allocateurAHorloge(10);
    allocator.allocate('pba', demande('10.0.0.1', 1000));
    expect(allocator.blocksHeldBy('pba', '10.0.0.1')).toHaveLength(1);

    avancer(11);
    allocator.allocate('pba', demande('10.0.0.9', 2000));

    expect(allocator.blocksHeldBy('pba', '10.0.0.1')).toHaveLength(0);
  });

  it('l`usage repousse l`echeance', () => {
    const { allocator, avancer } = allocateurAHorloge(10);
    allocator.allocate('pba', demande('10.0.0.1', 1000));

    for (let tour = 0; tour < 5; tour++) {
      avancer(8);
      allocator.allocate('pba', demande('10.0.0.1', 1000 + tour));
    }

    expect(allocator.blocksHeldBy('pba', '10.0.0.1')).toHaveLength(1);
  });

  it('une base rendue est reutilisee plutot que perdue', () => {
    const { allocator, avancer } = allocateurAHorloge(10);
    const premier = allocator.allocate('pba', demande('10.0.0.1', 1000));
    const basePremiere = allocator.blocksHeldBy('pba', '10.0.0.1')[0]?.port;

    avancer(11);
    allocator.allocate('pba', demande('10.0.0.2', 1000));

    expect(allocator.blocksHeldBy('pba', '10.0.0.2')[0]?.port).toBe(basePremiere);
    expect(premier).not.toBeNull();
  });

  it('un pool `overload` n`est pas concerne', () => {
    let instant = 1_000_000;
    const allocator = new IpPoolAllocator(() => instant);
    allocator.upsert(makeIpPool({
      name: 'over', type: 'overload',
      startIP: '203.0.113.20', endIP: '203.0.113.20',
    }));

    const premier = allocator.allocate('over', demande('10.0.0.1', 1000));
    instant += 600_000;
    const second = allocator.allocate('over', demande('10.0.0.1', 1000));

    expect(second).toEqual(premier);
  });
});
