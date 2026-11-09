/**
 * tcpdump -r sur des savefiles NULL (BSD loopback), LOOP (OpenBSD loopback) et RAW (IP brut), contre le vrai tcpdump 4.99.4 / libpcap 1.10.4.
 *
 * scripts/oracle/record_tcpdump_linktypes.py fabrique les paquets (SYN TCP, echo ICMP, requete DNS en UDP, segment HTTP, echo ICMPv6), les range
 * dans les en-tetes de chaque type de liaison (famille en ordre de l'hote pour NULL, en ordre reseau pour LOOP, rien pour RAW, le fichier en
 * gros-boutiste, des familles que print-null.c ne connait pas, des versions IP inconnues, un enregistrement coupe dans l'en-tete de famille) et
 * garde ce que le vrai outil affiche pour 14 jeux d'options d'affichage et 25 filtres ; un fichier Linux cooked v1 sert aux erreurs de filtre qui
 * dependent du type de liaison. Pour NULL, LOOP et RAW, `-w` garde aussi les octets que l'outil ecrit. Le simulateur lit les memes octets et doit
 * afficher le meme texte (l'heure normalisee, le chemin temporaire du recorder remplace).
 *
 * Mesure avant la correction (git stash push -- src/network) : 254 cas sur 285 tombent. Tous ceux des types NULL, LOOP et RAW (« this simulator has no ... link-layer
 * printer »), ceux des fichiers aux en-tetes d'enregistrement invalides (`[Invalid header: caplen==0, len==0]`, affiche par tous les types de liaison : le simulateur
 * imprimait un paquet vide), et, sur le fichier cooked, les filtres `ether ...`, `vlan`, `broadcast` et `multicast` (le simulateur les acceptait sans rien dire alors que
 * le vrai refuse). Passent des deux cotes (31) : les 14 jeux d'affichage du fichier cooked et ses filtres que le simulateur evaluait deja bien (TEMOIN : le fichier, le
 * laboratoire et la lecture sont sains), et le temoin du fichier a deux paquets IPv4 de la famille 2.
 *
 * Non rejoue : les familles AF_ISO (7), AF_APPLETALK (16) et AF_IPX (23), que le vrai tcpdump imprime avec des imprimeurs que le simulateur n'a pas (il s'arrete avec
 * « this simulator has no OSI printer » ; cas ecrit plus bas), et les paquets coupes dans l'en-tete IP ou dans celui de TCP (`IP  [|ip]`, `truncated-ip - N bytes missing!`),
 * dont l'affichage est l'ecart deja consigne dans TODO.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { bytesToFileText, fileTextToBytes } from '@/crypto/encoding';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

interface Run { flags: string; expression: string; status: number; output: string }
interface Case { name: string; hex: string; runs: Run[]; written: string | null }
const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/tcpdump-linktypes-4.99.4.json', import.meta.url), 'utf8')) as { cases: Case[] };

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

function normalised(text: string): string {
  return text.split('\n')
    .map((line) => line.replace(/^(\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d(?=\.\d)/, 'T').replace(/\/tmp\/tmp\w+\/capture\.pcap/, '/tmp/capture.pcap'))
    .join('\n').replace(/\n+$/, '');
}

function machineHolding(hex: string): LinuxPC {
  const pc = new LinuxPC('PC1', 0, 0);
  const vfs = (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.writeFile('/tmp/capture.pcap', bytesToFileText(bytesOf(hex)), 0, 0, 0o022);
  return pc;
}

for (const entry of fixture.cases) {
  describe(`tcpdump -r on ${entry.name}`, () => {
    for (const run of entry.runs) {
      it(`${run.flags} ${run.expression}`.trim(), async () => {
        const output = await machineHolding(entry.hex).executeCommand(`sudo tcpdump ${run.flags} -r /tmp/capture.pcap${run.expression === '' ? '' : ` '${run.expression}'`}`);
        expect(normalised(output)).toBe(normalised(run.output));
      });
    }
  });
}

describe('tcpdump -r -w on NULL, LOOP and RAW keeps the link type and the bytes', () => {
  for (const entry of fixture.cases.filter((candidate) => candidate.written !== null)) {
    it(entry.name, async () => {
      const pc = machineHolding(entry.hex);
      await pc.executeCommand('sudo tcpdump -nn -r /tmp/capture.pcap -c 3 -w /tmp/out.pcap');
      const vfs = (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
      expect(hexOf(fileTextToBytes(vfs.readFile('/tmp/out.pcap') ?? ''))).toBe(entry.written);
    });
  }
});

describe('a family tcpdump prints with a printer the simulator does not have', () => {
  const FIRST_PACKET_AT = (24 + 16) * 2;
  const FIRST_PACKET_BYTES = 52;
  const packet = (): string => fixture.cases.find((entry) => entry.name === 'raw')!.hex.slice(FIRST_PACKET_AT, FIRST_PACKET_AT + 2 * FIRST_PACKET_BYTES);

  const savefile = (families: readonly string[]): string => {
    const records = families.map((family, at) => {
      const data = `${family}${packet()}`;
      const length = (data.length / 2).toString(16).padStart(2, '0');
      return `${(at + 1).toString(16).padStart(2, '0')}000000` + '00000000' + `${length}000000` + `${length}000000` + data;
    });
    return ['d4c3b2a1', '0200', '0400', '00000000', '00000000', '00000400', '00000000', ...records].join('');
  };

  it('stops with its own sentence after the packets it can print', async () => {
    const output = await machineHolding(savefile(['02000000', '07000000', '02000000'])).executeCommand('sudo tcpdump -nn -r /tmp/capture.pcap');
    expect(output.split('\n').filter((line) => line.includes('Flags [S]'))).toHaveLength(1);
    expect(output).toContain('tcpdump: NULL: this simulator has no OSI printer');
  });

  it('temoin : le meme fichier sans la famille inconnue imprime ses deux paquets', async () => {
    const output = await machineHolding(savefile(['02000000', '02000000'])).executeCommand('sudo tcpdump -nn -r /tmp/capture.pcap');
    expect(output.split('\n').filter((line) => line.includes('Flags [S]'))).toHaveLength(2);
  });
});
