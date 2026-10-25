/**
 * Tuto NAT, ALG FTP a travers le natlab : `curl -P` (FTP actif) de PC-LINUX vers le vsftpd d'EXT, a travers R-AKWA.
 *
 * Mesure avant correction (git stash de src/network) : 8 cas, 6 tombent. L'ALG ne reconnaissait que `PORT` (un `EPRT` traversait intact et
 * vsftpd repondait « 500 Illegal EPRT command. »), annoncait l'adresse de l'interface de sortie et non l'adresse traduite (avec un pool, la
 * commande PORT portait 203.0.113.2 alors que le controle partait de 203.0.113.4), ne recalculait ni la somme de controle TCP ni la longueur IP
 * du segment reecrit (le serveur le jetait : la reponse n'arrivait jamais et curl attendait son delai), ne decalait pas les numeros de sequence
 * et d'acquittement du reste de la connexion de controle, et le trou ouvert pour la connexion de donnees ne laissait passer que le port source 21
 * du serveur, alors que vsftpd se connecte depuis le port 20 (connect_from_port_20) : la session de donnees etait recreee a part, avec un autre
 * port global. Un hote exterieur quelconque pouvait aussi se connecter au port global annonce.
 * Passent avant comme apres : le temoin « a passive transfer crosses the pool » (le banc est sain) et « without the ALG... » (le serveur refuse
 * l'adresse interieure quand l'ALG est coupee : cas de non-regression).
 */
import { describe, it, expect } from 'vitest';
import { tutoNatLab, type TutoNatLab } from './_helpers/tutoNatLab';

const INTERFACE_PAT = ['ip nat inside source list 1 interface GigabitEthernet0/1 overload'];
const POOL = ['ip nat pool P1 203.0.113.4 203.0.113.6 netmask 255.255.255.240', 'ip nat inside source list 1 pool P1'];

async function labWithFtp(lines: readonly string[], extraConf = ''): Promise<TutoNatLab> {
  const lab = await tutoNatLab(lines);
  await lab.ext.executeCommand('apt install -y vsftpd');
  await lab.ext.executeCommand('echo HELLO_FTP > /srv/ftp/test.txt');
  await lab.ext.executeCommand('mkdir /srv/ftp/up');
  await lab.ext.executeCommand('chmod 777 /srv/ftp/up');
  if (extraConf !== '') {
    for (const line of extraConf.split('\n')) await lab.ext.executeCommand(`echo '${line}' >> /etc/vsftpd.conf`);
    await lab.ext.executeCommand('systemctl restart vsftpd');
  }
  return lab;
}

const rows = (out: string, proto: string): string[] => out.split('\n').filter((l) => l.startsWith(proto));

describe('FTP active mode through the NAT ALG', () => {
  it('witness: a passive transfer crosses the pool', async () => {
    const { lin } = await labWithFtp(POOL);
    expect(await lin.executeCommand('curl -s -m 8 ftp://203.0.113.9/test.txt')).toContain('HELLO_FTP');
  });

  it('EPRT through interface overload: the data connection follows', async () => {
    const { lin } = await labWithFtp(INTERFACE_PAT);
    const out = await lin.executeCommand('curl -sv -m 8 -P - ftp://203.0.113.9/test.txt 2>&1; echo exit=$?');
    expect(out).toContain('HELLO_FTP');
    expect(out).toContain('exit=0');
  });

  it('PORT through interface overload', async () => {
    const { lin } = await labWithFtp(INTERFACE_PAT);
    expect(await lin.executeCommand('curl -s -m 8 -P - --disable-eprt ftp://203.0.113.9/test.txt')).toContain('HELLO_FTP');
  });

  it('PORT announces the translated pool address, not the interface address', async () => {
    const { r, lin } = await labWithFtp(POOL);
    expect(await lin.executeCommand('curl -s -m 8 -P - --disable-eprt ftp://203.0.113.9/test.txt')).toContain('HELLO_FTP');
    const table = await r.executeCommand('show ip nat translations');
    const data = rows(table, 'tcp').find((l) => l.includes('203.0.113.9:20'));
    expect(data).toBeDefined();
    expect(data).toMatch(/^tcp\s+203\.0\.113\.4:\d+\s+192\.168\.10\.22:\d+\s+203\.0\.113\.9:20\s/);
  });

  it('keeps one data session when the server connects from port 20', async () => {
    const { r, lin } = await labWithFtp(INTERFACE_PAT);
    await lin.executeCommand('curl -s -m 8 -P - ftp://203.0.113.9/test.txt');
    const withPort20 = rows(await r.executeCommand('show ip nat translations'), 'tcp').filter((l) => l.includes('203.0.113.9:20'));
    expect(withPort20).toHaveLength(1);
  });

  it('an active upload crosses the NAT with its sequence numbers corrected', async () => {
    const { lin, ext } = await labWithFtp(INTERFACE_PAT, 'write_enable=YES\nanon_upload_enable=YES');
    await lin.executeCommand('echo uploaded > /tmp/up.txt');
    const out = await lin.executeCommand('curl -s -S -m 8 -P - -T /tmp/up.txt ftp://203.0.113.9/up/active.txt; echo exit=$?');
    expect(out).toContain('exit=0');
    expect(await ext.executeCommand('cat /srv/ftp/up/active.txt')).toContain('uploaded');
  });

  it('refuses the announced port to a host that is not the FTP server', async () => {
    const { r, lin, ext } = await labWithFtp(INTERFACE_PAT);
    await ext.executeCommand('ip addr add 203.0.113.10/28 dev eth0');
    lin.getTcpStack().listen(40139, { onAccept: () => {} });
    const replies: string[] = [];
    const control = lin.getTcpStack().connect('203.0.113.9', 21, { onData: (d) => replies.push(String(d)) });
    control!.write('USER anonymous\r\nPASS x\r\nPORT 192,168,10,22,156,203\r\n');
    expect(replies.join('')).toContain('200 PORT command successful');
    const table = await r.executeCommand('show ip nat translations');
    const hole = rows(table, 'tcp').find((l) => l.includes('203.0.113.9:0'));
    expect(hole).toBeDefined();
    const globalPort = Number(/203\.0\.113\.2:(\d+)/.exec(hole!)![1]);
    const intruder = ext.getTcpStack().connect('203.0.113.2', globalPort, { localIp: '203.0.113.10' });
    expect(intruder?.state === 'established').toBe(false);
    const server = ext.getTcpStack().connect('203.0.113.2', globalPort, { localIp: '203.0.113.9' });
    expect(server?.state === 'established').toBe(true);
  });

  it('without the ALG the server refuses the inside address in PORT', async () => {
    const { r, lin } = await labWithFtp(INTERFACE_PAT);
    await r.executeCommand('configure terminal');
    await r.executeCommand('no ip nat service ftp');
    await r.executeCommand('end');
    const out = await lin.executeCommand('curl -s -S -m 8 -P - ftp://203.0.113.9/test.txt; echo exit=$?');
    expect(out).not.toContain('HELLO_FTP');
    expect(out).toContain('exit=30');
  });
});
