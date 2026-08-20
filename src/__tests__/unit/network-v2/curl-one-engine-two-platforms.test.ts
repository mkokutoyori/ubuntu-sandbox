/**
 * `curl` n'est pas une commande Linux, c'est une commande de poste de
 * travail : Windows en livre une depuis la 1803, à
 * `C:\Windows\System32\curl.exe`. Une machine Windows de ce simulateur n'en
 * avait aucune — `curl` répondait « is not recognized as an internal or
 * external command ».
 *
 * L'ajouter en dupliquant l'implémentation aurait produit exactement la
 * dérive que ce projet corrige ailleurs (deux registres Windows, deux
 * implémentations SSH, deux moteurs HTTP) : deux `curl` qui finissent par
 * ne plus dire la même chose de la même situation. Le moteur vit donc dans
 * `src/network/http/curl/`, à côté de `HttpClient.ts` que Linux et Windows
 * partagent déjà, et chaque plateforme n'apporte que son propre
 * branchement — `CurlHost` : résolution de noms, pile TCP, ancres de
 * confiance, écriture de fichier.
 *
 * Ce fichier vérifie la propriété qui compte : **la même situation donne le
 * même verdict des deux côtés**, sans que le test ait à connaître le
 * chemin emprunté.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { createResponse, type HttpMessage } from '@/network/http/semantics/types';

const SRV_IP = '10.42.0.10';
const LNX_IP = '10.42.0.20';
const WIN_IP = '10.42.0.30';
const PORT = 8080;

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

interface Lab {
  linux: LinuxPC;
  windows: WindowsPC;
  serve(handler: (req: HttpMessage) => HttpMessage): void;
  seen(): HttpMessage[];
}

function lab(): Lab {
  const server = new LinuxServer('linux-server', 'WEB');
  const linux = new LinuxPC('linux-pc', 'LNX');
  const windows = new WindowsPC('windows-pc', 'WIN');
  const sw = new GenericSwitch('switch-generic', 'SW');
  new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(linux.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(windows.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  server.getPorts()[0].configureIP(new IPAddress(SRV_IP), mask);
  linux.getPorts()[0].configureIP(new IPAddress(LNX_IP), mask);
  windows.getPorts()[0].configureIP(new IPAddress(WIN_IP), mask);
  server.powerOn();
  linux.powerOn();
  windows.powerOn();

  const requests: HttpMessage[] = [];
  return {
    linux,
    windows,
    serve(handler) {
      new Http1ServerSession(server.getTcpStack(), PORT, (req) => {
        requests.push(req);
        return handler(req);
      }).start();
    },
    seen: () => requests,
  };
}

function ok(body: string): HttpMessage {
  const res = createResponse(200, 'OK');
  res.headers.set('Content-Type', 'text/plain');
  res.body = new TextEncoder().encode(body);
  return res;
}

const url = (path = '/') => `http://${SRV_IP}:${PORT}${path}`;

describe('curl existe des deux côtés', () => {
  it('cmd.exe le connaît et rend le corps servi par le vrai serveur', async () => {
    const l = lab();
    l.serve(() => ok('from-the-wire'));

    const out = await l.windows.executeCommand(`curl ${url()}`);

    expect(out).toContain('from-the-wire');
    expect(out).not.toContain('is not recognized');
  });

  it('`curl.exe` est la même commande, comme sur une vraie machine', async () => {
    const l = lab();
    l.serve(() => ok('same-binary'));

    expect(await l.windows.executeCommand(`curl.exe ${url()}`)).toContain('same-binary');
  });

  it('PowerShell aussi', async () => {
    const l = lab();
    l.serve(() => ok('from-powershell'));

    const out = await l.windows.executeCommand(`powershell -Command "curl ${url()}"`);

    expect(out).toContain('from-powershell');
  });
});

describe('les deux plateformes disent la même chose de la même situation', () => {
  it('rien n\'écoute : le même (7) des deux côtés', async () => {
    const l = lab();

    const fromLinux = await l.linux.executeCommand(`curl ${url()}`);
    const fromWindows = await l.windows.executeCommand(`curl ${url()}`);

    const refusal = `curl: (7) Failed to connect to ${SRV_IP} port ${PORT}: Connection refused`;
    expect(fromLinux).toContain(refusal);
    expect(fromWindows).toContain(refusal);
  });

  it('nom introuvable : le même (6) des deux côtés', async () => {
    const l = lab();

    expect(await l.linux.executeCommand('curl http://nowhere.invalid/'))
      .toContain('curl: (6) Could not resolve host: nowhere.invalid');
    expect(await l.windows.executeCommand('curl http://nowhere.invalid/'))
      .toContain('curl: (6) Could not resolve host: nowhere.invalid');
  });

  it('option inconnue : le même refus, avec le même message de curl', async () => {
    const l = lab();

    for (const out of [
      await l.linux.executeCommand(`curl -Z ${url()}`),
      await l.windows.executeCommand(`curl -Z ${url()}`),
    ]) {
      expect(out).toContain('curl: option -Z: is unknown');
      expect(out).toContain("curl: try 'curl --help' for more information");
    }
  });

  it('protocole hors périmètre : le même refus des deux côtés', async () => {
    const l = lab();

    for (const out of [
      await l.linux.executeCommand('curl ftp://files.example.com/x'),
      await l.windows.executeCommand('curl ftp://files.example.com/x'),
    ]) {
      expect(out).toContain('curl: (1) Protocol "ftp" not supported or disabled in libcurl');
    }
  });

  it('-s tait l\'erreur des deux côtés, -sS la rétablit', async () => {
    const l = lab();

    expect((await l.linux.executeCommand(`curl -s ${url()}`)).trim()).toBe('');
    expect((await l.windows.executeCommand(`curl -s ${url()}`)).trim()).toBe('');
    expect(await l.linux.executeCommand(`curl -sS ${url()}`)).toContain('curl: (7)');
    expect(await l.windows.executeCommand(`curl -sS ${url()}`)).toContain('curl: (7)');
  });

  it('-w rend les mêmes faits, mesurés sur le même transfert', async () => {
    const l = lab();
    l.serve(() => ok('abcde'));

    const format = '"%{http_code}|%{size_download}|%{remote_port}"';
    const fromLinux = await l.linux.executeCommand(`curl -s -o /dev/null -w ${format} ${url()}`);
    const fromWindows = await l.windows.executeCommand(`curl -s -o NUL -w ${format} ${url()}`);

    expect(fromLinux.trim()).toBe(`200|5|${PORT}`);
    expect(fromWindows.trim()).toBe(`200|5|${PORT}`);
  });
});

describe('chaque plateforme apporte son propre branchement, pas sa propre implémentation', () => {
  it('-o écrit dans le système de fichiers Windows', async () => {
    const l = lab();
    l.serve(() => ok('windows-file'));

    await l.windows.executeCommand(`curl -o C:\\Users\\User\\page.txt ${url()}`);

    expect(await l.windows.executeCommand('type C:\\Users\\User\\page.txt'))
      .toContain('windows-file');
  });

  it('la requête part de la pile TCP de la machine qui a tapé la commande', async () => {
    const l = lab();
    l.serve(() => ok('x'));

    await l.windows.executeCommand(`curl -H "X-From: windows" ${url('/w')}`);
    await l.linux.executeCommand(`curl -H "X-From: linux" ${url('/l')}`);

    expect(l.seen().map((r) => [r.target, r.headers.get('X-From')])).toEqual([
      ['/w', 'windows'],
      ['/l', 'linux'],
    ]);
  });

  it('-X et -d fonctionnent depuis Windows aussi', async () => {
    const l = lab();
    l.serve(() => createResponse(201, 'Created'));

    await l.windows.executeCommand(`curl -s -X PUT -d "k=v" ${url('/thing')}`);

    const req = l.seen()[0];
    expect(req.method).toBe('PUT');
    expect(req.body ? new TextDecoder().decode(req.body) : '').toBe('k=v');
  });
});
