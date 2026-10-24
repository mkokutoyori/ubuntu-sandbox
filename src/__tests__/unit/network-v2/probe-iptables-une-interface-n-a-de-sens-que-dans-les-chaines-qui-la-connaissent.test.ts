/**
 * Une interface n'a de sens que dans les chaines ou le paquet la connait. `-o` nomme l'interface de sortie : un paquet qui entre (PREROUTING, INPUT)
 * n'en a pas encore, et `iptables` refuse la regle ; `-i` nomme l'interface d'arrivee : un paquet qui sort (OUTPUT, POSTROUTING) n'en a plus. Le
 * simulateur acceptait les deux, rangeait la regle, l'affichait avec son interface, et ne la faisait jamais correspondre a rien : un critere stocke, rendu et
 * jamais evalue. La verification est celle de l'espace utilisateur, avant tout contact avec le noyau, pour les commandes qui portent une specification de
 * regle (-A, -I, -R, -C, -D avec specification) ; -D par numero ne lit aucune option, FORWARD accepte les deux, et le nom du crochet est celui de la
 * chaine INTEGREE (une chaine utilisateur n'a pas d'orientation).
 *
 * Mesure de depart (origin/mandeng 4bc526c21) :
 *     iptables -A OUTPUT -i eth0 -j DROP          ->  rc=0, la regle est rangee et `iptables -L OUTPUT -v` la montre « in eth0 »
 *     iptables -A INPUT -o eth0 -j DROP           ->  rc=0, idem
 *     iptables -t nat -A POSTROUTING -i eth0 -j MASQUERADE, -I OUTPUT 1 ! -i eth0, -R OUTPUT 1 -i eth0  ->  rc=0
 *     iptables -A INPUT --bogus 1                 ->  rc=1 : une erreur de parametre sortait en 1 la ou `xtables_error(PARAMETER_PROBLEM, ...)` sort en 2
 *
 * Autorites : iptables 1.8.9 (sources.debian.org, iptables/xshared.c `do_parse`) -- pour -A, -D, -C, -I, -R : « if (strcmp(p->chain, "PREROUTING") == 0 ||
 * strcmp(p->chain, "INPUT") == 0) { if (cs->options & OPT_VIANAMEOUT) xtables_error(PARAMETER_PROBLEM, "Can't use -%c with %s\n", ...) » (le commentaire
 * du source : -o n'est pas valide pour un paquet entrant) et le symetrique pour POSTROUTING et OUTPUT avec -i ; libxtables/xtables.c `basic_exit_err` (le pied « Try `iptables -h'
 * or 'iptables --help' for more information. » apres un PARAMETER_PROBLEM) et include/xtables.h `enum xtables_exittype` (OTHER_PROBLEM = 1,
 * PARAMETER_PROBLEM = 2).
 *
 * Discrimination : 26 des 36 cas tombent contre l'arbre sans le lot (LinuxIptablesManager remis a son etat, sonde conservee) et 10 passent des deux cotes,
 * NOMMES : les neuf cas ou la chaine peut honorer l'option (sept couples table-chaine-option, une chaine utilisateur, -D par numero), non-regressions que
 * l'ancien chemin tenait deja, et « une regle que le noyau refuse garde son propre statut » (1 : « No chain/target/match by that name. »).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { LinuxServer } from '@/network/devices/LinuxServer';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const host = (): LinuxServer => new LinuxServer('linux-server', 'H');
const run = (machine: LinuxServer, command: string): Promise<string> => Promise.resolve(machine.executeCommand(`${command}; echo "rc=$?"`)).then(String);
const refusal = (tool: string, flag: string, chain: string): string =>
  `${tool} v1.8.7 (nf_tables): Can't use -${flag} with ${chain}\n\nTry \`${tool} -h' or '${tool} --help' for more information.\nrc=2`;

const MISPLACED: ReadonlyArray<readonly [string, string, string]> = [
  ['filter', 'INPUT', 'o'],
  ['filter', 'OUTPUT', 'i'],
  ['nat', 'PREROUTING', 'o'],
  ['nat', 'POSTROUTING', 'i'],
  ['mangle', 'PREROUTING', 'o'],
  ['mangle', 'INPUT', 'o'],
  ['mangle', 'OUTPUT', 'i'],
  ['mangle', 'POSTROUTING', 'i'],
];

const tableOption = (table: string): string => (table === 'filter' ? '' : `-t ${table} `);

describe('an interface option the chain cannot honour is refused, in every command that carries a rule', () => {
  it.each(MISPLACED)('%s %s : -%s', async (table, chain, flag) => {
    const machine = host();
    expect(await run(machine, `sudo iptables ${tableOption(table)}-A ${chain} -${flag} eth0 -j ACCEPT`)).toBe(refusal('iptables', flag, chain));
  });

  it.each(MISPLACED)('%s %s : -%s, and nothing is stored', async (table, chain, flag) => {
    const machine = host();
    await run(machine, `sudo iptables ${tableOption(table)}-A ${chain} -${flag} eth0 -j ACCEPT`);
    expect(await run(machine, `sudo iptables ${tableOption(table)}-S ${chain}`)).toMatch(/^-P \w+ ACCEPT\nrc=0$/);
  });

  it('a negated interface is refused as well', async () => {
    expect(await run(host(), 'sudo iptables -A OUTPUT ! -i eth0 -j ACCEPT')).toBe(refusal('iptables', 'i', 'OUTPUT'));
  });

  it.each([
    ['-I OUTPUT 1 -i eth0 -j ACCEPT', 'i', 'OUTPUT'],
    ['-I INPUT -o eth0 -j ACCEPT', 'o', 'INPUT'],
    ['-C OUTPUT -i eth0 -j ACCEPT', 'i', 'OUTPUT'],
    ['-D INPUT -o eth0 -j ACCEPT', 'o', 'INPUT'],
  ])('%s', async (rule, flag, chain) => {
    expect(await run(host(), `sudo iptables ${rule}`)).toBe(refusal('iptables', flag, chain));
  });

  it('-R refuses it and leaves the rule it was to replace', async () => {
    const machine = host();
    await run(machine, 'sudo iptables -A OUTPUT -o eth0 -j ACCEPT');
    expect(await run(machine, 'sudo iptables -R OUTPUT 1 -i eth0 -j DROP')).toBe(refusal('iptables', 'i', 'OUTPUT'));
    expect(await run(machine, 'sudo iptables -S OUTPUT')).toBe('-P OUTPUT ACCEPT\n-A OUTPUT -o eth0 -j ACCEPT\nrc=0');
  });

  it('ip6tables refuses them in the same words under its own name', async () => {
    expect(await run(host(), 'sudo ip6tables -A INPUT -o eth0 -j ACCEPT')).toBe(refusal('ip6tables', 'o', 'INPUT'));
  });

  it('iptables-restore refuses the line and the exit status says so', async () => {
    const machine = host();
    const restored = await run(machine, 'printf "*filter\\n-A INPUT -o eth0 -j ACCEPT\\nCOMMIT\\n" | sudo iptables-restore');
    expect(restored).not.toMatch(/rc=0$/);
  });
});

describe('an interface option the chain can honour is stored as before', () => {
  it.each([
    ['filter', 'INPUT', 'i'],
    ['filter', 'OUTPUT', 'o'],
    ['filter', 'FORWARD', 'i'],
    ['filter', 'FORWARD', 'o'],
    ['nat', 'PREROUTING', 'i'],
    ['nat', 'POSTROUTING', 'o'],
    ['mangle', 'FORWARD', 'o'],
  ])('%s %s : -%s', async (table, chain, flag) => {
    const machine = host();
    expect(await run(machine, `sudo iptables ${tableOption(table)}-A ${chain} -${flag} eth0 -j ACCEPT`)).toBe('rc=0');
    expect(await run(machine, `sudo iptables ${tableOption(table)}-S ${chain}`)).toContain(`-${flag} eth0`);
  });

  it('a user-defined chain has no orientation : it takes both', async () => {
    const machine = host();
    await run(machine, 'sudo iptables -N CHECKS');
    expect(await run(machine, 'sudo iptables -A CHECKS -i eth0 -o eth1 -j ACCEPT')).toBe('rc=0');
  });

  it('-D by number reads no option, so the number is deleted whatever the chain', async () => {
    const machine = host();
    await run(machine, 'sudo iptables -A OUTPUT -j ACCEPT');
    expect(await run(machine, 'sudo iptables -D OUTPUT 1')).toBe('rc=0');
  });
});

describe('a parameter problem exits with the status of PARAMETER_PROBLEM', () => {
  it('an unknown option', async () => {
    expect(await run(host(), 'sudo iptables -A INPUT --bogus 1')).toMatch(/unknown option "--bogus"\nTry `iptables -h' or 'iptables --help' for more information\.\nrc=2$/);
  });

  it('an option that lacks its argument', async () => {
    expect(await run(host(), 'sudo iptables -A INPUT -p tcp --dport')).toMatch(/\nrc=2$/);
  });

  it('a rule that the kernel side refuses keeps its own status', async () => {
    expect(await run(host(), 'sudo iptables -A NOCHAIN -j ACCEPT')).toBe('iptables: No chain/target/match by that name.\nrc=1');
  });
});
