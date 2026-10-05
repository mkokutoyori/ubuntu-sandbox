/**
 * Ecrire dans `/proc/sys/net/ipv4/<cle>` change ce que `sysctl -w <cle>`
 * change : les deux sont deux interfaces sur UN magasin, et une valeur que le
 * noyau refuse est refusee avec les mots du shell qui l'a ecrite.
 *
 * Mesure de depart (commit precedent), un LinuxPC :
 *
 *   - `echo 1 > /proc/sys/net/ipv4/ip_forward` (par `sudo sh -c`, ou
 *     `echo 1 | sudo tee …`) ne rend aucune erreur et ne change rien : `cat`
 *     rend 0, `sysctl` rend 0. Meme silence pour tcp_ecn, tcp_tw_reuse,
 *     tcp_sack et ip_default_ttl (99 reste 64) ; `tee` affiche meme la valeur
 *     qu'il n'a pas appliquee. C'est l'ecriture la plus courante de tout
 *     tutoriel de routage Linux, et sur un banc passerelle le ping de l'autre
 *     cote reste a 100 % de pertes apres elle ;
 *   - `echo abc > …/tcp_sack` ne dit rien (le noyau repond EINVAL) ; un
 *     utilisateur sans droits n'a aucun refus non plus (le noyau, qui le
 *     refuse a l'ouverture : « Permission denied ») : `VirtualFileSystem`
 *     tenait chaque fichier genere pour inscriptible par tous et en jetait
 *     les ecritures (« Writes are discarded ») ;
 *   - la plage de ports ephemeres etait un fichier ordinaire que
 *     `applyEphemeralRange` recopiait, avec l'etat reel de la pile ailleurs :
 *     apres `echo "40000 40100" > …/ip_local_port_range`, `cat` et `sysctl`
 *     disent 40000 40100, la pile continue de 32768 a 60999 et le SYN suivant
 *     part du port 32768. Deux vues d'une meme machine qui se contredisent ;
 *   - `sysctl -w` avait sa propre table d'ecrivains par cle (`sysctlWriter`),
 *     dupliquee de la liste des fichiers que `LinuxMachine` enregistre.
 *
 * Autorite : noyau 5.15, `kernel/sysctl.c` (`proc_dou8vec_minmax` : « Negative
 * strings are not allowed », une erreur a l'ecriture quand la borne n'est pas
 * respectee ; un mot qui n'est pas un nombre est refuse de meme, EINVAL) ;
 * l'ouverture en ecriture suit les droits du fichier (0644, proprietaire
 * root), d'ou la faute classique `sudo echo 1 > /proc/…` : la redirection est
 * faite par le shell de l'appelant ; les mots de l'erreur sont ceux de bash
 * (`builtins/echo.def` : `write error: %s`, precede de `bash: echo:`) pour un
 * builtin, et de coreutils (`cat: write error: Invalid argument`) pour un
 * programme externe.
 *
 * Ce qui est construit : un noeud genere du VFS peut porter un ecrivain
 * (`registerWritableGeneratedFile`) qui est le SEUL endroit ou la cle est
 * appliquee ; `LinuxMachine` y inscrit ip_forward,
 * icmp_echo_ignore_broadcasts, tcp_tw_reuse, ip_local_port_range,
 * ip_unprivileged_port_start et la table `LINUX_IPV4_KNOBS`, et `sysctl -w`
 * ne fait plus qu'ecrire le noeud (sa table d'ecrivains disparait) ; la plage
 * de ports est un fichier genere depuis la pile ; une redirection que
 * l'ecrivain refuse dit `bash: echo: write error: Invalid argument` (ou
 * `cat: write error: …`), avec le code de sortie 1 ; une ecriture vide
 * (`: > fichier`) n'ecrit rien, comme `write(2)` de zero octet.
 *
 * Ce qui n'est PAS construit : `tee` ne rend aucune erreur quand une ecriture
 * est refusee, ce qui vaut pour tous les fichiers et non pour les seuls
 * `/proc/sys` ; les cles dont le noeud n'a pas d'ecrivain (ARP, voisinage,
 * noyau) gardent leur refus de `sysctl -w` (EPERM) et leur silence a la
 * redirection.
 *
 * Discrimination (fichier copie sur le commit precedent) : VINGT-CINQ cas sur
 * trente-deux tombent. Les sept autres passent des deux cotes : cinq temoins
 * construits dans le meme banc que le cas qu'ils gardent (les valeurs par
 * defaut d'une machine intacte, le SYN qui propose SACK, la plage de ports
 * par defaut, la passerelle qui ne fait pas suivre, `sysctl -w` qui refuse
 * les memes valeurs) et deux non-regressions (une ecriture vide laisse la
 * valeur ; `sysctl -w` d'une plage de ports est lu par `cat`).
 */
import { describe, it, expect } from 'vitest';
import { scriptedPeer, type ScriptedPeer } from '../../support/tcpScriptedPeer';
import { pingOnSimulatedClock } from '../../support/fastPing';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';

const PROC = '/proc/sys/net/ipv4';

function asRoot(peer: ScriptedPeer, key: string, value: string): Promise<string> {
  return peer.dut.executeCommand(`sudo sh -c 'echo ${value} > ${PROC}/${key}'`);
}

async function read(peer: ScriptedPeer, key: string): Promise<string> {
  return (await peer.dut.executeCommand(`cat ${PROC}/${key}`)).trim();
}

async function viaSysctl(peer: ScriptedPeer, key: string): Promise<string> {
  return (await peer.dut.executeCommand(`sysctl -n net.ipv4.${key}`)).trim();
}

describe('echo VALUE > /proc/sys/net/ipv4/KEY changes what sysctl -w KEY=VALUE changes', () => {
  it.each([
    ['tcp_sack', '0'], ['tcp_timestamps', '0'], ['tcp_window_scaling', '0'],
    ['tcp_slow_start_after_idle', '0'], ['ip_default_ttl', '37'], ['tcp_tw_reuse', '1'],
    ['icmp_echo_ignore_broadcasts', '0'], ['ip_forward', '1'], ['ip_unprivileged_port_start', '2000'],
    ['tcp_ecn', '1'], ['tcp_ecn_fallback', '0'],
  ])('net.ipv4.%s = %s: both views read it back', async (key, value) => {
    const peer = scriptedPeer();
    expect(await asRoot(peer, key, value)).toBe('');
    expect(await read(peer, key)).toBe(value);
    expect(await viaSysctl(peer, key)).toBe(value);
  });

  it('WITNESS: the same keys keep their defaults on a machine nobody wrote to', async () => {
    const peer = scriptedPeer();
    expect(await read(peer, 'tcp_sack')).toBe('1');
    expect(await read(peer, 'ip_default_ttl')).toBe('64');
    expect(await read(peer, 'ip_forward')).toBe('0');
  });

  it('through tee: the value is applied and echoed', async () => {
    const peer = scriptedPeer();
    expect((await peer.dut.executeCommand(`echo 0 | sudo tee ${PROC}/tcp_sack`)).trim()).toBe('0');
    expect(await viaSysctl(peer, 'tcp_sack')).toBe('0');
  });

  it('both directions of one store: sysctl -w is read by cat, echo is read by sysctl', async () => {
    const peer = scriptedPeer();
    await peer.dut.executeCommand('sudo sysctl -w net.ipv4.tcp_timestamps=0');
    expect(await read(peer, 'tcp_timestamps')).toBe('0');
    await asRoot(peer, 'tcp_timestamps', '1');
    expect(await viaSysctl(peer, 'tcp_timestamps')).toBe('1');
  });

  it('a write that carries nothing does not write: truncating alone leaves the value', async () => {
    const peer = scriptedPeer();
    await peer.dut.executeCommand(`sudo sh -c ': > ${PROC}/tcp_sack'`);
    expect(await read(peer, 'tcp_sack')).toBe('1');
  });

  it('the write acts on the stack, not only on the file: a SYN no longer offers SACK', async () => {
    const peer = scriptedPeer();
    await asRoot(peer, 'tcp_sack', '0');
    peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer);
    expect(peer.last()!.options.map((option) => option.kind)).not.toContain('sack-permitted');
  });

  it('WITNESS: the same SYN offers SACK before anyone wrote', () => {
    const peer = scriptedPeer();
    peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer);
    expect(peer.last()!.options.map((option) => option.kind)).toContain('sack-permitted');
  });

  it('ip_local_port_range: both numbers, the file, sysctl and the next source port agree', async () => {
    const peer = scriptedPeer();
    expect(await asRoot(peer, 'ip_local_port_range', '"40000 40100"')).toBe('');
    expect(await read(peer, 'ip_local_port_range')).toBe('40000\t40100');
    expect((await peer.dut.executeCommand('sysctl net.ipv4.ip_local_port_range')).trim())
      .toBe('net.ipv4.ip_local_port_range = 40000\t40100');
    expect(peer.dut.getTcpStack().getEphemeralRange()).toEqual({ min: 40000, max: 40100 });
    peer.dut.getTcpStack().connect(peer.addresses.peer, peer.ports.peer);
    const source = peer.last()!.sourcePort;
    expect(source).toBeGreaterThanOrEqual(40000);
    expect(source).toBeLessThanOrEqual(40100);
  });

  it('ip_local_port_range written by sysctl is read back by cat as before', async () => {
    const peer = scriptedPeer();
    await peer.dut.executeCommand('sudo sysctl -w net.ipv4.ip_local_port_range="41000 41100"');
    expect(await read(peer, 'ip_local_port_range')).toBe('41000\t41100');
    expect(peer.dut.getTcpStack().getEphemeralRange()).toEqual({ min: 41000, max: 41100 });
  });

  it('WITNESS: the default range is the Linux one', async () => {
    const peer = scriptedPeer();
    expect(await read(peer, 'ip_local_port_range')).toBe('32768\t60999');
  });
});

describe('the classic lab: a Linux gateway forwards once ip_forward is written', () => {
  async function labThroughGateway(): Promise<{ client: LinuxPC; gateway: LinuxPC }> {
    const client = new LinuxPC('linux-pc', 'PC1');
    const gateway = new LinuxPC('linux-pc', 'GW');
    const server = new LinuxPC('linux-pc', 'PC2');
    new Cable('pc1-gw').connect(client.getPort('eth0')!, gateway.getPort('eth0')!);
    new Cable('gw-pc2').connect(gateway.getPort('eth1')!, server.getPort('eth0')!);
    client.configureInterface('eth0', new IPAddress('192.168.1.10'), new SubnetMask('255.255.255.0'));
    client.setDefaultGateway(new IPAddress('192.168.1.1'));
    gateway.configureInterface('eth0', new IPAddress('192.168.1.1'), new SubnetMask('255.255.255.0'));
    gateway.configureInterface('eth1', new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
    server.configureInterface('eth0', new IPAddress('10.0.0.2'), new SubnetMask('255.255.255.0'));
    server.setDefaultGateway(new IPAddress('10.0.0.1'));
    return { client, gateway };
  }

  it('WITNESS: with forwarding off the far side is unreachable', async () => {
    const { client } = await labThroughGateway();
    expect(await pingOnSimulatedClock(client, 'ping -c 1 -W 1 10.0.0.2')).toContain('100% packet loss');
  });

  it('echo 1 > /proc/sys/net/ipv4/ip_forward on the gateway opens the path', async () => {
    const { client, gateway } = await labThroughGateway();
    await gateway.executeCommand(`sudo sh -c 'echo 1 > ${PROC}/ip_forward'`);
    expect(await pingOnSimulatedClock(client, 'ping -c 1 -W 1 10.0.0.2')).toContain('1 received');
  });

  it('echo 0 > /proc/sys/net/ipv4/ip_forward closes it again', async () => {
    const { client, gateway } = await labThroughGateway();
    await gateway.executeCommand('sudo sysctl -w net.ipv4.ip_forward=1');
    await gateway.executeCommand(`sudo sh -c 'echo 0 > ${PROC}/ip_forward'`);
    expect(await pingOnSimulatedClock(client, 'ping -c 1 -W 1 10.0.0.2')).toContain('100% packet loss');
  });
});

describe('what the kernel refuses to take is refused, in bash\'s words, and nothing changes', () => {
  it.each(['abc', '256', '-1', '1.5'])('echo %s to a one-byte setting: Invalid argument', async (value) => {
    const peer = scriptedPeer();
    expect(await asRoot(peer, 'tcp_sack', value)).toBe('bash: echo: write error: Invalid argument');
    expect(await read(peer, 'tcp_sack')).toBe('1');
  });

  it('ip_default_ttl 0 is below its bound', async () => {
    const peer = scriptedPeer();
    expect(await asRoot(peer, 'ip_default_ttl', '0')).toBe('bash: echo: write error: Invalid argument');
    expect(await read(peer, 'ip_default_ttl')).toBe('64');
  });

  it('a range whose upper end is below its lower end is refused', async () => {
    const peer = scriptedPeer();
    expect(await asRoot(peer, 'ip_local_port_range', '"50000 40000"'))
      .toBe('bash: echo: write error: Invalid argument');
    expect(await read(peer, 'ip_local_port_range')).toBe('32768\t60999');
  });

  it('an external command is named without the shell prefix', async () => {
    const peer = scriptedPeer();
    await peer.dut.executeCommand('sudo sh -c \'echo notanumber > /tmp/value\'');
    expect(await peer.dut.executeCommand(`sudo sh -c 'cat /tmp/value > ${PROC}/tcp_sack'`))
      .toBe('cat: write error: Invalid argument');
    expect(await read(peer, 'tcp_sack')).toBe('1');
  });

  it('an unprivileged user cannot write, and sudo does not reach a redirection the shell makes', async () => {
    const peer = scriptedPeer();
    expect(await peer.dut.executeCommand(`echo 0 > ${PROC}/tcp_sack`))
      .toBe(`bash: ${PROC}/tcp_sack: Permission denied`);
    expect(await peer.dut.executeCommand(`sudo echo 0 > ${PROC}/tcp_sack`))
      .toBe(`bash: ${PROC}/tcp_sack: Permission denied`);
    expect(await read(peer, 'tcp_sack')).toBe('1');
  });

  it('WITNESS: sysctl -w refuses the same values with its own words', async () => {
    const peer = scriptedPeer();
    expect(await peer.dut.executeCommand('sudo sysctl -w net.ipv4.tcp_sack=abc'))
      .toContain('Invalid argument');
    expect(await peer.dut.executeCommand('sudo sysctl -w net.ipv4.tcp_sack=0')).toContain('net.ipv4.tcp_sack = 0');
  });
});
