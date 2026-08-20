/**
 * Probes — la résolution de noms de lien sur les machines Windows.
 *
 * LLMNR est une invention de Microsoft, et un Windows le parle par
 * défaut. Ce simulateur n'en avait pourtant rien : une machine Windows
 * ne trouvait aucun voisin par son nom, et aucun voisin ne la trouvait.
 * Deux machines sur le même câble, chacune sachant se nommer, restaient
 * mutuellement invisibles — c'est le manque que cette série mesure.
 *
 * Ce qui change ici du côté Linux, ce n'est pas le protocole mais la
 * commande qui l'allume : Windows n'a pas de `resolvectl`, il a une clé
 * de stratégie dans la base de registre, et il écoute par défaut.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import {
  DNS_CLIENT_POLICY_KEY, ENABLE_MULTICAST_VALUE, ENABLE_MDNS_VALUE,
} from '@/network/devices/windows/WinDnsClientPolicy';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

const LONG = 40_000;
const MASK = new SubnetMask('255.255.255.0');

interface Claimable { whenReady(): Promise<void> }
type Win = WindowsPC & { getMdnsAgent(): Claimable; getLlmnrAgent(): Claimable };
type Lin = LinuxPC & { getMdnsAgent(): Claimable; getLlmnrAgent(): Claimable };

/** `reg add` en une ligne, pour la clé de stratégie du client DNS. */
function regAdd(value: string, data: number): string {
  return `reg add "${DNS_CLIENT_POLICY_KEY}" /v ${value} /t REG_DWORD /d ${data} /f`;
}

/**
 * Un Windows et un Linux sur le même commutateur. Le Linux doit qu'on
 * lui demande d'allumer ses deux répondeurs ; le Windows, non — et
 * c'est précisément la différence que ces probes vérifient.
 */
async function mixte(): Promise<{ win: Win; lin: Lin }> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const win = new WindowsPC('windows-pc', 'WIN10', 0, 0);
  const lin = new LinuxPC('linux-pc', 'alpha', 0, 0);
  sw.powerOn(); win.powerOn(); lin.powerOn();
  new Cable('c1').connect(win.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(lin.getPorts()[0], sw.getPorts()[1]);
  win.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
  lin.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
  await lin.executeCommand("sudo sh -c 'printf \"nameserver 127.0.0.53\\n\" > /etc/resolv.conf'");
  await lin.executeCommand('sudo resolvectl llmnr eth0 yes');
  await lin.executeCommand('sudo resolvectl mdns eth0 yes');
  const w = win as Win, l = lin as Lin;
  await Promise.all([
    w.getMdnsAgent().whenReady(), w.getLlmnrAgent().whenReady(),
    l.getMdnsAgent().whenReady(), l.getLlmnrAgent().whenReady(),
  ]);
  return { win: w, lin: l };
}

/** Deux Windows, et rien d'autre : le cas de parité le plus net. */
async function deuxWindows(): Promise<{ a: Win; b: Win }> {
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  const a = new WindowsPC('windows-pc', 'WIN10', 0, 0);
  const b = new WindowsPC('windows-pc', 'WIN11', 0, 0);
  sw.powerOn(); a.powerOn(); b.powerOn();
  new Cable('c1').connect(a.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(b.getPorts()[0], sw.getPorts()[1]);
  a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), MASK);
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), MASK);
  const x = a as Win, y = b as Win;
  await Promise.all([
    x.getMdnsAgent().whenReady(), x.getLlmnrAgent().whenReady(),
    y.getMdnsAgent().whenReady(), y.getLlmnrAgent().whenReady(),
  ]);
  return { a: x, b: y };
}

describe('Scénario 1 — une machine Windows se laisse trouver', () => {
  it('un Linux la résout par LLMNR', async () => {
    const { lin } = await mixte();
    const out = await lin.executeCommand('resolvectl query win10');
    expect(out).toContain('win10: 10.0.0.1');
    expect(out, 'le protocole qui a répondu doit être nommé').toContain('LLMNR');
  }, LONG);

  it('et par mDNS sous son nom `.local`', async () => {
    const { lin } = await mixte();
    const out = await lin.executeCommand('resolvectl query win10.local');
    expect(out).toContain('win10.local: 10.0.0.1');
    expect(out).toContain('mDNS');
  }, LONG);

  it('`ping` depuis le Linux atteint la machine par son nom', async () => {
    const { lin } = await mixte();
    const out = await lin.executeCommand('ping -c1 win10');
    expect(out).toContain('10.0.0.1');
    expect(out).not.toContain('Name or service not known');
  }, LONG);

  it('une machine éteinte ne répond plus pour son nom', async () => {
    const { win, lin } = await mixte();
    win.powerOff();
    expect(
      await lin.executeCommand('resolvectl query win10'),
      'un hôte éteint ne peut pas continuer de revendiquer son nom',
    ).toContain('Name or service not known');
  }, LONG);
});

describe('Scénario 2 — une machine Windows trouve ses voisins', () => {
  it('un nom mono-label passe par LLMNR', async () => {
    const { win } = await mixte();
    expect(String(await win.resolveHostname('alpha'))).toBe('10.0.0.2');
    expect(await win.executeCommand('ping alpha')).toContain('Reply from 10.0.0.2');
  }, LONG);

  it('un nom `.local` passe par mDNS', async () => {
    const { win } = await mixte();
    expect(String(await win.resolveHostname('alpha.local'))).toBe('10.0.0.2');
  }, LONG);

  it('deux Windows se trouvent l\'un l\'autre, sans Linux au milieu', async () => {
    const { a, b } = await deuxWindows();
    expect(String(await a.resolveHostname('win11'))).toBe('10.0.0.2');
    expect(String(await b.resolveHostname('win10'))).toBe('10.0.0.1');
    expect(String(await a.resolveHostname('win11.local'))).toBe('10.0.0.2');
  }, LONG);

  it('`Resolve-DnsName` rend le même résultat que `ping`', async () => {
    const { win } = await mixte();
    const out = await win.executeCommand('powershell -Command "Resolve-DnsName alpha"');
    expect(out).toContain('10.0.0.2');
    expect(out).not.toContain('does not exist');
  }, LONG);

  it('un nom que personne ne porte reste introuvable', async () => {
    const { win } = await mixte();
    expect(
      await win.resolveHostname('fantome'),
      'le silence du lien n\'est pas une adresse',
    ).toBeNull();
  }, LONG);
});

describe('Scénario 3 — la stratégie du registre commande les répondeurs', () => {
  const ports = async (win: WindowsPC): Promise<number[]> => {
    const out = String(await win.executeCommand('netstat -an'));
    return [5355, 5353].filter((p) => new RegExp(`UDP\\s+\\S*:${p}\\b`).test(out));
  };

  it('par défaut les deux ports sont tenus', async () => {
    const { win } = await mixte();
    expect(
      await ports(win),
      'un Windows sorti de l\'installation parle les deux protocoles',
    ).toEqual([5355, 5353]);
  }, LONG);

  it('`Get-NetUDPEndpoint` les montre aussi', async () => {
    const { win } = await mixte();
    const out = await win.executeCommand(
      'powershell -Command "Get-NetUDPEndpoint -LocalPort 5355"');
    expect(out).toContain('5355');
  }, LONG);

  it('`EnableMulticast` à zéro ferme LLMNR, et lui seul', async () => {
    const { win } = await mixte();
    await win.executeCommand(regAdd(ENABLE_MULTICAST_VALUE, 0));
    expect(await ports(win)).toEqual([5353]);
  }, LONG);

  it('`EnableMDNS` à zéro ferme mDNS, et lui seul', async () => {
    const { win } = await mixte();
    await win.executeCommand(regAdd(ENABLE_MDNS_VALUE, 0));
    expect(await ports(win)).toEqual([5355]);
  }, LONG);

  it('un répondeur éteint ne répond plus, pas seulement n\'écoute plus', async () => {
    const { win, lin } = await mixte();
    await win.executeCommand(regAdd(ENABLE_MULTICAST_VALUE, 0));
    await lin.executeCommand('sudo resolvectl flush-caches');
    expect(await lin.executeCommand('resolvectl query win10'))
      .toContain('Name or service not known');
    expect(
      await lin.executeCommand('resolvectl query win10.local'),
      'éteindre LLMNR ne doit pas emporter mDNS',
    ).toContain('10.0.0.1');
  }, LONG);

  it('éteindre ferme aussi la résolution, pas seulement la réponse', async () => {
    const { win } = await mixte();
    await win.executeCommand(regAdd(ENABLE_MULTICAST_VALUE, 0));
    expect(
      await win.resolveHostname('alpha'),
      'un protocole éteint ne peut pas servir à demander',
    ).toBeNull();
    expect(String(await win.resolveHostname('alpha.local'))).toBe('10.0.0.2');
  }, LONG);

  it('remettre la valeur à un rallume', async () => {
    const { win } = await mixte();
    await win.executeCommand(regAdd(ENABLE_MULTICAST_VALUE, 0));
    expect(await ports(win)).toEqual([5353]);
    await win.executeCommand(regAdd(ENABLE_MULTICAST_VALUE, 1));
    expect(await ports(win)).toEqual([5355, 5353]);
  }, LONG);

  it('supprimer la valeur rallume aussi : l\'absence vaut « activé »', async () => {
    const { win } = await mixte();
    await win.executeCommand(regAdd(ENABLE_MULTICAST_VALUE, 0));
    await win.executeCommand(
      `reg delete "${DNS_CLIENT_POLICY_KEY}" /v ${ENABLE_MULTICAST_VALUE} /f`);
    expect(await ports(win)).toEqual([5355, 5353]);
  }, LONG);

  it('`Set-ItemProperty` a le même effet que `reg add`', async () => {
    const { win } = await mixte();
    await win.executeCommand(regAdd(ENABLE_MULTICAST_VALUE, 1));
    await win.executeCommand(
      `powershell -Command "Set-ItemProperty -Path 'HKLM:\\${DNS_CLIENT_POLICY_KEY.slice(5)}'`
      + ` -Name ${ENABLE_MULTICAST_VALUE} -Value 0"`);
    expect(
      await ports(win),
      'les deux chemins d\'écriture mènent à la même base, donc au même service',
    ).toEqual([5353]);
  }, LONG);

  it('une ruche sans son lecteur est refusée, pas ignorée', async () => {
    const { win } = await mixte();
    // `reg.exe` écrit `HKLM\...`, PowerShell exige `HKLM:\...`. La forme
    // de reg.exe passée à `Set-ItemProperty` retombait sur un chemin muet :
    // aucune erreur, aucun effet. Une écriture perdue ne doit pas se
    // présenter comme réussie.
    const out = await win.executeCommand(
      `powershell -Command "Set-ItemProperty -Path '${DNS_CLIENT_POLICY_KEY}'`
      + ` -Name ${ENABLE_MULTICAST_VALUE} -Value 0"`);
    expect(out).toContain("A drive with the name 'HKLM' does not exist");
    expect(
      await ports(win),
      'et puisqu\'elle est refusée, elle ne change rien',
    ).toEqual([5355, 5353]);
  }, LONG);
});

describe('Scénario 4 — l\'ordre de résolution du client DNS', () => {
  const resolve = (win: WindowsPC, args: string): Promise<string> =>
    win.executeCommand(`powershell -Command "Resolve-DnsName ${args}"`);

  it('`-DnsOnly` ne voit pas un nom qui n\'existe que sur le lien', async () => {
    const { win } = await mixte();
    expect(await resolve(win, 'alpha')).toContain('10.0.0.2');
    // Le cache retient ce que la ligne précédente a résolu : sans le
    // vider, `-DnsOnly` y trouverait la réponse du lien et la probe
    // mesurerait le cache au lieu de l'ordre de résolution.
    await win.executeCommand('ipconfig /flushdns');
    expect(
      await resolve(win, 'alpha -DnsOnly'),
      'sans le lien, ce nom n\'a aucune autre source',
    ).toContain('does not exist');
  }, LONG);

  it('un `.local` non plus, et pour la même raison', async () => {
    const { win } = await mixte();
    expect(
      await resolve(win, 'alpha.local -DnsOnly'),
      'RFC 6762 §3 : `.local` ne part jamais vers un serveur unicast',
    ).toContain('does not exist');
    expect(await resolve(win, 'alpha.local')).toContain('10.0.0.2');
  }, LONG);

  it('`-LlmnrOnly` ignore le fichier hosts', async () => {
    const { win } = await mixte();
    await win.executeCommand(
      'powershell -Command "Add-Content C:\\Windows\\System32\\drivers\\etc\\hosts'
      + ' \'192.0.2.7 spectre\'"');
    expect(await resolve(win, 'spectre')).toContain('192.0.2.7');
    expect(
      await resolve(win, 'spectre -LlmnrOnly'),
      'le lien ne connaît pas ce nom, le fichier si',
    ).toContain('does not exist');
  }, LONG);

  it('`-NoHostsFile` l\'ignore aussi, mais laisse le reste', async () => {
    const { win } = await mixte();
    await win.executeCommand(
      'powershell -Command "Add-Content C:\\Windows\\System32\\drivers\\etc\\hosts'
      + ' \'192.0.2.8 alpha\'"');
    expect(await resolve(win, 'alpha')).toContain('192.0.2.8');
    await win.executeCommand('ipconfig /flushdns');
    expect(
      await resolve(win, 'alpha -NoHostsFile'),
      'le fichier écarté, c\'est le lien qui répond',
    ).toContain('10.0.0.2');
  }, LONG);

  it('`-CacheOnly` ne va pas sur le fil', async () => {
    const { win } = await mixte();
    await win.executeCommand('ipconfig /flushdns');
    expect(
      await resolve(win, 'alpha -CacheOnly -NoHostsFile'),
      'un cache vide ne répond rien, il ne va pas chercher',
    ).toContain('does not exist');
    await resolve(win, 'alpha');
    expect(await resolve(win, 'alpha -CacheOnly -NoHostsFile')).toContain('10.0.0.2');
  }, LONG);
});

describe('Scénario 5 — le cache du client dit ce que le lien a répondu', () => {
  it('un nom résolu par LLMNR y entre avec le TTL de LLMNR', async () => {
    const { win } = await mixte();
    await win.executeCommand('ipconfig /flushdns');
    await win.resolveHostname('alpha');
    const out = await win.executeCommand('powershell -Command "Get-DnsClientCache"');
    expect(out).toContain('alpha');
    expect(out).toContain('10.0.0.2');
    expect(out, 'TTL LLMNR : 30 s (RFC 4795 §2.1.1)').toContain('30');
  }, LONG);

  it('et par mDNS avec le sien', async () => {
    const { win } = await mixte();
    await win.executeCommand('ipconfig /flushdns');
    await win.resolveHostname('alpha.local');
    expect(
      await win.executeCommand('powershell -Command "Get-DnsClientCache"'),
      'TTL mDNS : 120 s (RFC 6762 §10)',
    ).toContain('120');
  }, LONG);

  it('`ipconfig /displaydns` montre la même entrée', async () => {
    const { win } = await mixte();
    await win.executeCommand('ipconfig /flushdns');
    await win.resolveHostname('alpha');
    const out = await win.executeCommand('ipconfig /displaydns');
    expect(
      out,
      'deux commandes du même système ne peuvent pas se contredire',
    ).toContain('alpha');
    expect(out).toContain('10.0.0.2');
  }, LONG);

  it('`Clear-DnsClientCache` la retire', async () => {
    const { win } = await mixte();
    await win.resolveHostname('alpha');
    await win.executeCommand('powershell -Command "Clear-DnsClientCache"');
    expect(await win.executeCommand('ipconfig /displaydns')).toContain('(no entries)');
  }, LONG);
});
