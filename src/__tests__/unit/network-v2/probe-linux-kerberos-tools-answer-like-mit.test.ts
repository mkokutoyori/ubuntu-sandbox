/**
 * Sonde : `kinit`, `klist` et `kdestroy` d'un poste Linux (paquet krb5-user)
 * repondent comme les vrais outils MIT Kerberos, face a un controleur de
 * domaine Active Directory dont le KDC est le seul a signer les tickets.
 *
 * Autorite : les vrais binaires MIT (Ubuntu, krb5 1.20.1) executes ici face
 * a un vrai krb5kdc (royaume CORP.LOCAL, max_life 10h, max_renewable_life
 * 7j) ; `mit-kerberos-tools-corpus.json` garde, pour 80 commandes reparties
 * en cinq sessions, les arguments, l'entree standard, la sortie standard,
 * la sortie d'erreur et le code de sortie. Les textes d'erreur du KDC
 * (« KDC can't fulfill requested option », « Client's credentials have been
 * revoked », ...) sont ceux de la table d'erreurs de libkrb5.so lue sur le
 * binaire.
 *
 * Le laboratoire reproduit les conditions de l'enregistrement : le poste agit
 * en root (cache /tmp/krb5cc_0), /etc/krb5.conf nomme CORP.LOCAL et son KDC,
 * et alice n'exige pas de pre-authentification, comme le principal MIT
 * enregistre (sinon le drapeau `A`, pre-authentifie, apparaitrait dans
 * `klist -f`). Les dates sont comparees par leur ecart a la premiere date
 * de la meme sortie : la duree de vie (10h, 1h), le renouvellement (24h, 2j)
 * sont donc compares, pas l'horloge.
 *
 * Mesure avant correction (depot sans les trois commandes) : 8 des 10 cas
 * tombent, « command not found » partout, et les 80 commandes enregistrees
 * different toutes. Passent avant comme apres, par construction : le temoin
 * « le laboratoire est sain », qui obtient un TGT par le client Kerberos que
 * le poste utilisait deja, et le decompte de l'enregistrement.
 *
 * Divergences assumees, hors corpus : `klist -V` rend la version du paquet
 * Ubuntu 22.04 simule (1.19.2, de memoire) et non celle de l'enregistrement
 * (1.20.1) ; les drapeaux `T` (politique de transit verifiee) que le KDC MIT
 * pose sur un ticket renouvele ne sont pas ceux d'un KDC Active Directory,
 * dont la valeur n'est pas attestable ici ; `-k` (keytab), `-s`, `-v`, `-a`,
 * `-n`, `-E`, `-C`, `-T`, `-I`, `-X` sont refuses explicitement faute d'un KDC
 * Active Directory attestable pour les honorer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { dialKdc } from '@/network/kerberos/KerberosClient';
import { loadJson } from './openldap-replay-support';

interface RecordedStep {
  readonly name: string;
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly before?: string;
}

interface RecordedChain {
  readonly name: string;
  readonly steps: readonly RecordedStep[];
}

const SAFE_MODE = '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd!" -AsPlainText -Force)';
const DC_ADDRESS = '10.0.0.10';
const KRB5_CONF = [
  '[libdefaults]',
  ' default_realm = CORP.LOCAL',
  ' dns_lookup_kdc = false',
  ' dns_lookup_realm = false',
  ' rdns = false',
  '[realms]',
  ' CORP.LOCAL = {',
  `  kdc = ${DC_ADDRESS}`,
  ' }',
  '[domain_realm]',
  ' .corp.local = CORP.LOCAL',
  ' corp.local = CORP.LOCAL',
  '',
].join('\n');

async function buildLab(): Promise<{ workstation: LinuxPC }> {
  const workstation = new LinuxPC('linux-pc', 'PC1');
  const controller = new WindowsServer('DC01');
  const hub = new GenericSwitch('switch-generic', 'SW1');
  workstation.powerOn();
  controller.powerOn();
  new Cable('c-pc').connect(workstation.getPort('eth0') as never, hub.getPorts()[0]);
  new Cable('c-dc').connect(controller.getPort('eth0') as never, hub.getPorts()[1]);
  await workstation.executeCommand('ip addr add 10.0.0.2/24 dev eth0');
  await workstation.executeCommand('ip link set eth0 up');
  await controller.executeCommand(`netsh interface ip set address "Ethernet0" static ${DC_ADDRESS} 255.255.255.0`);
  const shell = PowerShellSubShell.create(controller as never).subShell;
  await shell.processLine('Install-WindowsFeature -Name AD-Domain-Services');
  await shell.processLine(`Install-ADDSForest -DomainName "corp.local" -Force ${SAFE_MODE}`);
  await shell.processLine('New-ADUser -Name alice -SamAccountName alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -Enabled $true');
  await shell.processLine('Set-ADAccountControl -Identity alice -DoesNotRequirePreAuth $true');
  const escaped = KRB5_CONF.replace(/\n/g, '\\n');
  await workstation.executeCommand(`printf '${escaped}' | sudo tee /etc/krb5.conf > /dev/null`);
  return { workstation };
}

function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function runAsRoot(workstation: LinuxPC, argv: readonly string[], stdin: string): Promise<Outcome> {
  const words = argv.map(shellQuote).join(' ');
  const feed = stdin === '' ? 'true' : `printf %s ${shellQuote(stdin)}`;
  await workstation.executeCommand(`${feed} | sudo ${words} > /tmp/probe.out 2> /tmp/probe.err; echo $? > /tmp/probe.rc`);
  const stdout = await workstation.executeCommand('cat /tmp/probe.out');
  const stderr = await workstation.executeCommand('cat /tmp/probe.err');
  const exitCode = Number((await workstation.executeCommand('cat /tmp/probe.rc')).trim());
  return { stdout, stderr, exitCode };
}

const STAMP = /\d\d\/\d\d\/\d\d \d\d:\d\d:\d\d/g;

function relativeTimes(text: string): string {
  let base: number | null = null;
  return text.replace(STAMP, (found) => {
    const [month, day, year, hour, minute, second] = found.match(/\d+/g)!.map(Number);
    const seconds = Date.UTC(2000 + year, month - 1, day, hour, minute, second) / 1000;
    if (base === null) base = seconds;
    return `T+${seconds - base}`;
  });
}

function comparable(text: string): string {
  return relativeTimes(text).replace(/\n$/, '');
}

const corpus = loadJson<{ chains: readonly RecordedChain[] }>('mit-kerberos-tools-corpus.json');

describe('kinit, klist and kdestroy answer like the real MIT tools', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T19:36:34Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the lab is sound: the workstation obtains a ticket-granting ticket from the controller', async () => {
    const { workstation } = await buildLab();
    const connection = dialKdc(workstation.getTcpStack(), DC_ADDRESS);
    expect(connection.ok).toBe(true);
    const exchange = connection.client!.asExchange('alice', 'alicepw', 'CORP.LOCAL');
    expect(exchange.ok).toBe(true);
    expect(exchange.encKdcRepPart!.sname.nameString).toEqual(['krbtgt', 'CORP.LOCAL']);
  });

  it('the recording is not empty', () => {
    expect(corpus.chains.reduce((sum, chain) => sum + chain.steps.length, 0)).toBe(80);
  });

  it.each(corpus.chains.map((chain) => [chain.name, chain] as const))('replays the %s session byte for byte', async (_name, chain) => {
    const { workstation } = await buildLab();
    const problems: string[] = [];
    for (const step of chain.steps) {
      if (step.before !== undefined) await workstation.executeCommand(step.before);
      const outcome = await runAsRoot(workstation, step.argv, step.stdin);
      if (comparable(outcome.stdout) !== comparable(step.stdout)) {
        problems.push(`${step.name}: stdout\n--- real\n${step.stdout}\n--- simulated\n${outcome.stdout}`);
      }
      if (comparable(outcome.stderr) !== comparable(step.stderr)) {
        problems.push(`${step.name}: stderr\n--- real\n${step.stderr}\n--- simulated\n${outcome.stderr}`);
      }
      if (outcome.exitCode !== step.exitCode) {
        problems.push(`${step.name}: exit status real=${step.exitCode} simulated=${outcome.exitCode}`);
      }
    }
    expect(problems).toEqual([]);
  });

  it('prints the verbose lines before the password prompt on the terminal', async () => {
    const { workstation } = await buildLab();
    const terminal = await workstation.executeCommand('printf "alicepw\\n" | sudo kinit -V alice@CORP.LOCAL');
    expect(terminal).toBe([
      'Using default cache: /tmp/krb5cc_0',
      'Using principal: alice@CORP.LOCAL',
      'Password for alice@CORP.LOCAL: Authenticated to Kerberos v5',
    ].join('\n'));
  });

  it('a redirected error stream leaves only the prompt on the terminal', async () => {
    const { workstation } = await buildLab();
    const terminal = await workstation.executeCommand('printf "alicepw\\n" | sudo kinit -V alice@CORP.LOCAL 2>/dev/null');
    expect(terminal).toBe('Password for alice@CORP.LOCAL: ');
  });

  it('refuses the options it cannot honour instead of ignoring them', async () => {
    const { workstation } = await buildLab();
    for (const flag of ['-k', '-s 1h', '-v', '-a', '-n', '-E', '-C', '-T /tmp/x', '-I /tmp/x', '-X a=b']) {
      const outcome = await runAsRoot(workstation, ['kinit', ...flag.split(' '), 'alice@CORP.LOCAL'], 'alicepw\n');
      expect(outcome.stderr, flag).toContain('this simulator does not implement');
      expect(outcome.exitCode, flag).toBe(1);
    }
    const afterwards = await runAsRoot(workstation, ['klist'], '');
    expect(afterwards.exitCode).toBe(1);
  });
});
