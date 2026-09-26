/**
 * Un routeur vieillit ses entrees ARP selon le delai de l'interface, sur
 * l'horloge de la machine.
 *
 * Mesure de depart (389d8db5) : le routeur effacait toute entree
 * dynamique apres 60 s, codes en dur, quel que soit `arp timeout`
 * (IOS) ou `arp expire-time` (VRP) — la valeur etait rangee sur le port
 * et rendue par `show interfaces` sans etre evaluee. L'age etait mesure
 * par `Date.now()`, si bien qu'en temps virtuel rien ne vieillissait.
 * IOS ne rendait pas `arp timeout` dans la running-config et refusait
 * `no arp timeout` ; VRP ramenait `undo arp expire-time` au defaut
 * d'IOS (4 h), rendait `arp expire-time 1200` alors que c'est son defaut,
 * acceptait toute valeur, et imprimait dans EXPIRE(M) l'age de l'entree
 * au lieu du temps qui lui reste.
 *
 * Autorites :
 * - reference de commandes Cisco IOS (IP Addressing Services),
 *   `arp timeout seconds` : « Time (in seconds) that an entry remains in
 *   the ARP cache », 14400 par defaut, affiche par `show interfaces` ;
 *   la note TAC « ARP FAQ » (117398) pour l'exemple `show arp`, colonne
 *   Age (min) ;
 * - reference de commandes Huawei, `arp expire-time` : 60 a 86400 s,
 *   1200 par defaut ;
 * - captures VRP de ntc-templates (`huawei_vrp_display_arp_all.raw`,
 *   `huawei_vrp_display_arp_brief.raw`) : EXPIRE(M) vaut 17, 19, 20, 3
 *   pour des entrees dynamiques sous un delai de 20 minutes — le temps
 *   restant, arrondi a la minute superieure, 20 pour une entree neuve.
 *
 * Discrimination, mesuree sur le commit de base (389d8db5) avec ce
 * fichier copie : 9 des 11 cas tombent. Passent des deux cotes : le
 * TEMOIN (le routeur apprend son voisin) et « the IOS default keeps the
 * entry past ten minutes » sous temps virtuel, que la base tient parce
 * que rien n'y vieillissait ; le meme defaut mene sous minuteurs
 * factices, ou l'horloge murale de la base avance, y tombe sur les 60 s
 * codees en dur.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<string[]> {
  const outputs: string[] = [];
  for (const command of commands) outputs.push(await device.executeCommand(command));
  return outputs;
}

const MINUTE = 60_000;
let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

afterEach(() => { vi.useRealTimers(); });

async function neighbour(router: CiscoRouter | HuaweiRouter, port: string): Promise<void> {
  const pc = new LinuxPC('linux-pc', 'PC');
  new Cable('r-pc').connect(router.getPort(port)!, pc.getPorts()[0]);
  await type(pc, ['sudo ip addr add 10.0.0.2/24 dev eth0', 'sudo ip link set eth0 up', 'ping -c 1 10.0.0.1']);
}

async function ciscoLab(timeout: readonly string[] = []): Promise<CiscoRouter> {
  const router = new CiscoRouter('R1', 0, 0);
  await type(router, ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 10.0.0.1 255.255.255.0', 'no shutdown', ...timeout, 'end']);
  await neighbour(router, 'GigabitEthernet0/0');
  return router;
}

function arpLine(table: string): string | undefined {
  return table.split('\n').find((line) => /\b10\.0\.0\.2\b/.test(line));
}

describe('IOS: the entry lives as long as `arp timeout` says', () => {
  it('WITNESS: the router learns its neighbour', async () => {
    const router = await ciscoLab();
    expect(arpLine(await router.executeCommand('show ip arp'))).toMatch(/^Internet\s+10\.0\.0\.2\s+0\s/);
  });

  it('Age (min) counts the minutes that passed on the router', async () => {
    const router = await ciscoLab();
    clock.advance(3 * MINUTE);
    expect(arpLine(await router.executeCommand('show ip arp'))).toMatch(/^Internet\s+10\.0\.0\.2\s+3\s/);
  });

  it('arp timeout 600: the entry is gone after ten minutes', async () => {
    const router = await ciscoLab(['arp timeout 600']);
    clock.advance(11 * MINUTE);
    expect(arpLine(await router.executeCommand('show ip arp'))).toBeUndefined();
  });

  it('the IOS default keeps the entry past ten minutes (virtual time)', async () => {
    const router = await ciscoLab();
    clock.advance(10 * MINUTE);
    expect(arpLine(await router.executeCommand('show ip arp'))).toBeDefined();
  });

  it('the IOS default keeps the entry past ten minutes (fake timers)', async () => {
    __setDefaultScheduler(null);
    vi.useFakeTimers();
    const router = await ciscoLab();
    vi.advanceTimersByTime(10 * MINUTE);
    expect(arpLine(await router.executeCommand('show ip arp'))).toBeDefined();
  });

  it('the IOS default is four hours', async () => {
    const router = await ciscoLab();
    clock.jump(4 * 60 * MINUTE + MINUTE);
    expect(arpLine(await router.executeCommand('show ip arp'))).toBeUndefined();
  });

  it('arp timeout is in the running-config, and no arp timeout restores four hours', async () => {
    const router = await ciscoLab(['arp timeout 600']);
    expect((await router.executeCommand('show running-config')).split('\n')).toContain(' arp timeout 600');
    const [, , noForm] = await type(router, ['configure terminal', 'interface GigabitEthernet0/0', 'no arp timeout', 'end']);
    expect(noForm).toBe('');
    expect(await router.executeCommand('show interfaces GigabitEthernet0/0')).toContain('ARP Timeout 04:00:00');
  });
});

async function huaweiLab(expireTime: readonly string[] = []): Promise<HuaweiRouter> {
  const router = new HuaweiRouter('AR1', 0, 0);
  await type(router, ['system-view', 'interface GigabitEthernet0/0/0',
    'ip address 10.0.0.1 255.255.255.0', 'undo shutdown', ...expireTime, 'quit', 'quit']);
  await neighbour(router, 'GE0/0/0');
  return router;
}

function expireOf(table: string): string | undefined {
  return arpLine(table)?.split(/\s+/)[2];
}

describe('VRP: EXPIRE(M) is the time left, and arp expire-time decides it', () => {
  it('a fresh entry has the twenty minutes of the default left', async () => {
    const router = await huaweiLab();
    expect(expireOf(await router.executeCommand('display arp'))).toBe('20');
  });

  it('with arp expire-time 600, a fresh entry has ten minutes left, and none after them', async () => {
    const router = await huaweiLab(['arp expire-time 600']);
    expect(expireOf(await router.executeCommand('display arp'))).toBe('10');
    clock.advance(11 * MINUTE);
    expect(arpLine(await router.executeCommand('display arp'))).toBeUndefined();
  });

  it('the VRP default of 1200 s is not written in the configuration', async () => {
    const router = await huaweiLab(['arp expire-time 1200']);
    const config = await router.executeCommand('display current-configuration');
    expect(config).not.toContain('arp expire-time');
  });

  it('arp expire-time below 60 s is refused', async () => {
    const router = new HuaweiRouter('AR1', 0, 0);
    const [, , refusal] = await type(router, ['system-view', 'interface GigabitEthernet0/0/0', 'arp expire-time 30']);
    expect(refusal).toContain('Wrong parameter');
  });
});
