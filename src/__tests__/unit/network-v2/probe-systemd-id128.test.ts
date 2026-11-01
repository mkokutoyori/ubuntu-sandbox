/**
 * `systemd-id128` (systemd 255, src/id128/id128.c + shared/verbs.c) : `new`, `machine-id`, `boot-id`, `invocation-id`, `show`. La commande n'existait pas
 * (« command not found »). Toutes les attentes ci-dessous sont des sorties RELEVEES du vrai binaire de la machine de reference (texte d'aide, messages de verbe,
 * tableau `show`, mode `-p`, erreurs de getopt) ; les identifiants propres a une application (`-a`) sont des vecteurs releves avec le machine-id et le boot-id
 * de cette machine, que le laboratoire reprend : machine-id 4c398f73..., application 4c398f73..., boot-id 9675cd6a... Le tableau de `show` (177 lignes) est
 * extrait de la sortie de l'outil, pas ecrit a la main. Les verbes lisent les memes fichiers que le reste de la machine (/etc/machine-id,
 * /proc/sys/kernel/random/boot_id) : une seule identite.
 *
 * Discrimine par `git stash` sur src/network : les 41 cas tombent avant (commande inconnue). Aucun temoin : la commande n'existait pas.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

const MACHINE = '4c398f739c8447eb99d3fe100ad1b0fa';
const BOOT = '9675cd6a8fde4b5ca21ceb5f8900d4c3';
const APP = MACHINE;

async function lab() {
  const pc = new LinuxPC('linux-pc', 'P');
  pc.powerOn();
  const machine = pc as unknown as {
    identity: { bootId: string };
    executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> };
  };
  machine.identity.bootId = BOOT;
  await machine.executor.runAsUser('root', () => pc.executeCommand(`echo ${MACHINE} > /etc/machine-id`));
  return async (command: string): Promise<string> => String(await pc.executeCommand(`${command}; echo rc=$?`)).trimEnd();
}

const HELP = [
  'systemd-id128 [OPTIONS...] COMMAND', '', 'Generate and print 128-bit identifiers.', '', 'Commands:',
  '  new                     Generate a new ID',
  '  machine-id              Print the ID of current machine',
  '  boot-id                 Print the ID of current boot',
  '  invocation-id           Print the ID of current invocation',
  '  show [NAME|UUID]        Print one or more UUIDs',
  '  help                    Show this help', '', 'Options:',
  '  -h --help               Show this help',
  '  -p --pretty             Generate samples of program code',
  '  -P --value              Only print the value',
  '  -a --app-specific=ID    Generate app-specific IDs',
  '  -u --uuid               Output in UUID format', '',
  'See the systemd-id128(1) man page for details.', 'rc=0',
].join('\n');

const sample = (name: string, id: string): string => {
  const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
  return ['As string:', id, '', 'As UUID:', uuid, '', 'As systemd-id128(1) macro:',
    `#define ${name} SD_ID128_MAKE(${id.match(/../g)!.join(',')})`, '', 'As Python constant:', '>>> import uuid', `>>> ${name} = uuid.UUID('${id}')`].join('\n');
};

describe('systemd-id128 identifiers', () => {
  it('machine-id prints /etc/machine-id', async () => {
    expect(await (await lab())('systemd-id128 machine-id')).toBe(`${MACHINE}\nrc=0`);
  });

  it('boot-id prints the boot id that /proc names', async () => {
    const run = await lab();
    expect(await run('systemd-id128 boot-id')).toBe(`${BOOT}\nrc=0`);
    expect((await run('sysctl -n kernel.random.boot_id')).split('\n')[0]).toBe('9675cd6a-8fde-4b5c-a21c-eb5f8900d4c3');
  });

  it('-u prints a UUID', async () => {
    expect(await (await lab())('systemd-id128 -u boot-id')).toBe('9675cd6a-8fde-4b5c-a21c-eb5f8900d4c3\nrc=0');
  });

  it('-P prints the bare value, and a later -p wins over it', async () => {
    const run = await lab();
    expect(await run('systemd-id128 boot-id -pP')).toBe(`${BOOT}\nrc=0`);
    expect(await run('systemd-id128 -P -p boot-id')).toBe(`${sample('XYZ', BOOT)}\nrc=0`);
  });

  it('-p prints the code samples', async () => {
    expect(await (await lab())('systemd-id128 -p machine-id')).toBe(`${sample('XYZ', MACHINE)}\nrc=0`);
  });

  it('-a derives an application-specific machine id (HMAC-SHA256 keyed by the machine id)', async () => {
    expect(await (await lab())(`systemd-id128 -a ${APP} machine-id`)).toBe('f4dd390f092d4f33bb4ba96b4806be61\nrc=0');
  });

  it('-a derives an application-specific boot id, in UUID form with -u', async () => {
    const run = await lab();
    expect(await run(`systemd-id128 -a ${APP} boot-id`)).toBe('d1861503fc8a4427b4fe4c1c47a6705f\nrc=0');
    expect(await run(`systemd-id128 -a ${APP} -u boot-id`)).toBe('d1861503-fc8a-4427-b4fe-4c1c47a6705f\nrc=0');
  });

  it('-a accepts the dashed form and abbreviated long options', async () => {
    const run = await lab();
    expect(await run('systemd-id128 --app=4c398f73-9c84-47eb-99d3-fe100ad1b0fa machine-id')).toBe('f4dd390f092d4f33bb4ba96b4806be61\nrc=0');
    expect(await run(`systemd-id128 --app ${APP} machine-id`)).toBe('f4dd390f092d4f33bb4ba96b4806be61\nrc=0');
  });

  it('-a refuses an application id that does not parse, or that is all zeros', async () => {
    const run = await lab();
    expect(await run('systemd-id128 -a zz machine-id')).toBe('Failed to parse "zz" as application-ID: Invalid argument\nrc=1');
    expect(await run('systemd-id128 -a 00000000000000000000000000000000 machine-id')).toBe('Application ID cannot be all zeros.\nrc=1');
  });

  it('invocation-id fails outside a service, and cannot be combined with -a', async () => {
    const run = await lab();
    expect(await run('systemd-id128 invocation-id')).toBe('Failed to get invocation-ID: No such device or address\nrc=1');
    expect(await run(`systemd-id128 -a ${APP} invocation-id`)).toBe('Verb "invocation-id" cannot be combined with --app-specific=.\nrc=1');
  });

  it('new prints a version 4 id, a different one each time', async () => {
    const run = await lab();
    const first = (await run('systemd-id128 new')).split('\n')[0];
    expect(first).toMatch(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
    expect((await run('systemd-id128 new')).split('\n')[0]).not.toBe(first);
    expect((await run('systemd-id128 new -u')).split('\n')[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('-a leaves new random', async () => {
    expect((await (await lab())(`systemd-id128 -a ${APP} new`)).split('\n')[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('a missing /etc/machine-id is an error in the tool\'s words', async () => {
    const pc = new LinuxPC('linux-pc', 'P');
    pc.powerOn();
    const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
    await machine.executor.runAsUser('root', () => pc.executeCommand('rm /etc/machine-id'));
    expect(String(await pc.executeCommand('systemd-id128 machine-id; echo rc=$?')).trim())
      .toBe('Failed to get machine-ID: No such file or directory\nrc=1');
  });
});

describe('systemd-id128 verbs and options', () => {
  it.each([['help'], ['-h'], ['--help']])('%s prints the help', async (arg) => {
    expect(await (await lab())(`systemd-id128 ${arg}`)).toBe(HELP);
  });

  it.each([
    ['', 'Command verb required.'],
    ['n', "Unknown command verb 'n', did you mean 'new'?"],
    ['boo', "Unknown command verb 'boo', did you mean 'boot-id'?"],
    ['mach', "Unknown command verb 'mach', did you mean 'machine-id'?"],
    ['inv', "Unknown command verb 'inv', did you mean 'invocation-id'?"],
    ['sh', "Unknown command verb 'sh', did you mean 'show'?"],
    ['h', "Unknown command verb 'h', did you mean 'help'?"],
    ['b', "Unknown command verb 'b', did you mean 'boot-id'?"],
    ['x', "Unknown command verb 'x', did you mean 'new'?"],
    ['foo', "Unknown command verb 'foo', did you mean 'new'?"],
    ['zzzzzzzzzzzz', "Unknown command verb 'zzzzzzzzzzzz'."],
    ['new extra', 'Too many arguments.'],
    ['machine-id extra', 'Too many arguments.'],
  ])('verb "%s"', async (arg, message) => {
    expect(await (await lab())(`systemd-id128 ${arg}`)).toBe(`${message}\nrc=1`);
  });

  it.each([
    ['-x', "systemd-id128: invalid option -- 'x'"],
    ['--bogus', "systemd-id128: unrecognized option '--bogus'"],
    ['-a', "systemd-id128: option requires an argument -- 'a'"],
    ['--value=3 new', "systemd-id128: option '--value' doesn't allow an argument"],
  ])('option error %s', async (arg, message) => {
    expect(await (await lab())(`systemd-id128 ${arg}`)).toBe(`${message}\nrc=1`);
  });
});

describe('systemd-id128 show', () => {
  it('lists the 177 known identifiers with a header', async () => {
    const lines = (await (await lab())('systemd-id128 show')).split('\n');
    expect(lines[0]).toBe('NAME                        ID');
    expect(lines[1]).toBe('root-alpha                  6523f8ae3eb14e2aa05a18b695ae656f');
    expect(lines[177]).toBe('linux-generic               0fc63daf848347728e793d69d8477de4');
    expect(lines).toHaveLength(179);
  });

  it('shows named identifiers in a table sized to them', async () => {
    expect(await (await lab())('systemd-id128 show root-alpha usr-alpha')).toBe([
      'NAME       ID', 'root-alpha 6523f8ae3eb14e2aa05a18b695ae656f', 'usr-alpha  e18cf08c33ec4c0d8246c6c6fb3da024', 'rc=0'].join('\n'));
  });

  it('resolves a UUID, dashed or not, to its name, and an unknown one to XYZ', async () => {
    const run = await lab();
    expect(await run('systemd-id128 show 6523f8ae-3eb1-4e2a-a05a-18b695ae656f')).toBe('NAME       ID\nroot-alpha 6523f8ae3eb14e2aa05a18b695ae656f\nrc=0');
    expect(await run('systemd-id128 show 00000000000000000000000000000000')).toBe('NAME ID\nXYZ  00000000000000000000000000000000\nrc=0');
  });

  it('-u switches the column to UUIDs, -P keeps only the values', async () => {
    const run = await lab();
    expect(await run('systemd-id128 -u show root-alpha usr-alpha')).toBe([
      'NAME       ID', 'root-alpha 6523f8ae-3eb1-4e2a-a05a-18b695ae656f', 'usr-alpha  e18cf08c-33ec-4c0d-8246-c6c6fb3da024', 'rc=0'].join('\n'));
    expect(await run('systemd-id128 show -P root-alpha')).toBe('6523f8ae3eb14e2aa05a18b695ae656f\nrc=0');
  });

  it('-p prints one sample per identifier, with the name as the macro', async () => {
    expect(await (await lab())('systemd-id128 show -p root-alpha usr-alpha')).toBe(
      `${sample('ROOT_ALPHA', '6523f8ae3eb14e2aa05a18b695ae656f')}\n\n${sample('USR_ALPHA', 'e18cf08c33ec4c0d8246c6c6fb3da024')}\nrc=0`);
  });

  it('-a derives each identifier from the application id', async () => {
    expect(await (await lab())(`systemd-id128 -a ${APP} show root-alpha`)).toBe('NAME       ID\nroot-alpha 285331bd141542798a880523faef3c97\nrc=0');
  });

  it('an unknown name prints nothing of the table and fails', async () => {
    expect(await (await lab())('systemd-id128 show root-alpha nosuch')).toBe('Unknown identifier "nosuch".\nrc=1');
  });

  it('with -p, the identifiers before an unknown name were already printed', async () => {
    expect(await (await lab())('systemd-id128 -p show root-alpha nosuch')).toBe(`${sample('ROOT_ALPHA', '6523f8ae3eb14e2aa05a18b695ae656f')}\nUnknown identifier "nosuch".\nrc=1`);
  });
});
