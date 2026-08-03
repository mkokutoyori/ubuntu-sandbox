/**
 * docs/PRD-Curl.md §6 — vérification.
 *
 * Le PRD demande qu'« un test couvre le transit réel (compteurs de trames
 * sur un câble intermédiaire) au moins une fois, pour que P3 ne puisse pas
 * régresser en silence ». P3 est le principe qui dit que le transport
 * reste réel : c'est ce qui fait toute la valeur de `curl` ici, et c'est
 * aussi ce qu'un futur raccourci « ça va plus vite en lisant directement
 * l'objet distant » détruirait sans qu'aucun autre test ne le remarque.
 *
 * Ce fichier couvre aussi les deux points de fidélité que P2 a exigés du
 * reste de la plateforme :
 *
 *   - **IIS honore la méthode.** `WindowsIisRole.buildResponse()` servait
 *     le fichier pour n'importe quel verbe. Un serveur de contenu statique
 *     réel répond `405 Method Not Allowed` avec un en-tête `Allow`. Sans
 *     cette correction, `-X DELETE` aurait été une option acceptée sans
 *     effet observable, ce que §P0 interdit.
 *   - **TLS est vérifié pour de bon, des deux côtés.** Windows n'avait
 *     aucun magasin de racines de confiance pour ses clients sortants
 *     (limitation qui était documentée dans `sendMailMessage`) ; il en a un
 *     maintenant, et c'est le même `CertificateVerifier` que Linux.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { Http1ServerSession } from '@/network/http/http1/Http1ServerSession';
import { HttpsServerSession } from '@/network/http/https/HttpsServerSession';
import { createResponse, type HttpMessage } from '@/network/http/semantics/types';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const SRV_IP = '10.43.0.10';
const LNX_IP = '10.43.0.20';
const WIN_IP = '10.43.0.30';
const PORT = 8080;
const NOW = Date.now();

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

function ok(body: string): HttpMessage {
  const res = createResponse(200, 'OK');
  res.headers.set('Content-Type', 'text/plain');
  res.body = new TextEncoder().encode(body);
  return res;
}

describe('§6 — le transfert traverse vraiment le câble intermédiaire', () => {
  it('les compteurs de trames du câble bougent, depuis Linux comme depuis Windows', async () => {
    const server = new LinuxServer('linux-server', 'WEB');
    const linux = new LinuxPC('linux-pc', 'LNX');
    const windows = new WindowsPC('windows-pc', 'WIN');
    const sw = new GenericSwitch('switch-generic', 'SW');
    const uplink = new Cable('uplink');
    uplink.connect(server.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(linux.getPorts()[0], sw.getPorts()[1]);
    new Cable('c3').connect(windows.getPorts()[0], sw.getPorts()[2]);
    const mask = new SubnetMask('255.255.255.0');
    server.getPorts()[0].configureIP(new IPAddress(SRV_IP), mask);
    linux.getPorts()[0].configureIP(new IPAddress(LNX_IP), mask);
    windows.getPorts()[0].configureIP(new IPAddress(WIN_IP), mask);
    server.powerOn();
    linux.powerOn();
    windows.powerOn();
    new Http1ServerSession(server.getTcpStack(), PORT, () => ok('over-the-wire')).start();

    const url = `http://${SRV_IP}:${PORT}/`;

    uplink.resetStats();
    expect(await linux.executeCommand(`curl -sS ${url}`)).toContain('over-the-wire');
    const afterLinux = uplink.getStats().framesTransmitted;
    expect(afterLinux).toBeGreaterThan(0);

    expect(await windows.executeCommand(`curl -sS ${url}`)).toContain('over-the-wire');
    expect(uplink.getStats().framesTransmitted).toBeGreaterThan(afterLinux);
  });

  it('câble coupé : le transfert échoue vraiment, il n\'y a pas de chemin de secours', async () => {
    const server = new LinuxServer('linux-server', 'WEB');
    const client = new LinuxPC('linux-pc', 'CLI');
    const sw = new GenericSwitch('switch-generic', 'SW');
    const uplink = new Cable('uplink');
    uplink.connect(server.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    server.getPorts()[0].configureIP(new IPAddress(SRV_IP), mask);
    client.getPorts()[0].configureIP(new IPAddress(LNX_IP), mask);
    server.powerOn();
    client.powerOn();
    new Http1ServerSession(server.getTcpStack(), PORT, () => ok('reachable')).start();

    const url = `http://${SRV_IP}:${PORT}/`;
    expect(await client.executeCommand(`curl -sS ${url}`)).toContain('reachable');

    uplink.disconnect();

    // Si `curl` lisait l'équipement distant en mémoire, ce cas passerait
    // encore. C'est exactement la régression que §6 demande d'empêcher.
    const out = await client.executeCommand(`curl -sS ${url}`);
    expect(out).not.toContain('reachable');
    expect(out).toContain('curl: (7)');
  });
});

describe('§P2 — IIS honore désormais la méthode HTTP', () => {
  async function iisLab() {
    const server = new WindowsServer('IIS');
    const client = new LinuxPC('linux-pc', 'CLI');
    const sw = new GenericSwitch('switch-generic', 'SW');
    new Cable('c1').connect(server.getPorts()[0], sw.getPorts()[0]);
    new Cable('c2').connect(client.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    server.getPorts()[0].configureIP(new IPAddress(SRV_IP), mask);
    client.getPorts()[0].configureIP(new IPAddress(LNX_IP), mask);
    server.setCurrentUser('Administrator');
    const shell = PowerShellSubShell.create(server).subShell;
    await shell.processLine('Install-WindowsFeature Web-Server');
    return { client };
  }

  it('GET sert la page par défaut', async () => {
    const { client } = await iisLab();

    expect(await client.executeCommand(`curl -sS http://${SRV_IP}/`))
      .toContain('IIS Windows Server');
  });

  it('DELETE reçoit 405 avec la liste des verbes autorisés', async () => {
    const { client } = await iisLab();

    const out = await client.executeCommand(`curl -sS -i -X DELETE http://${SRV_IP}/`);

    expect(out).toContain('HTTP/1.1 405 Method Not Allowed');
    expect(out).toContain('Allow: GET, HEAD, OPTIONS, TRACE');
    expect(out).not.toContain('IIS Windows Server');
  });

  it('POST sur un fichier statique est refusé de la même manière', async () => {
    const { client } = await iisLab();

    const out = await client.executeCommand(
      `curl -s -o /dev/null -w "%{http_code}" -d "a=1" http://${SRV_IP}/`,
    );

    expect(out.trim()).toBe('405');
  });

  it('OPTIONS répond 200 et annonce ce qu\'il accepte', async () => {
    const { client } = await iisLab();

    const out = await client.executeCommand(`curl -sS -i -X OPTIONS http://${SRV_IP}/`);

    expect(out).toContain('HTTP/1.1 200 OK');
    expect(out).toContain('Allow: GET, HEAD, OPTIONS, TRACE');
  });

  it('HEAD reste servi, avec les en-têtes du GET et sans corps', async () => {
    const { client } = await iisLab();

    const out = await client.executeCommand(`curl -sS -I http://${SRV_IP}/`);

    expect(out).toContain('HTTP/1.1 200 OK');
    expect(out).toContain('Server: Microsoft-IIS/10.0');
    expect(out).not.toContain('IIS Windows Server</h1>');
  });
});

describe('§P3 — TLS : la même vérification de certificat sur les deux plateformes', () => {
  function tlsLab() {
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

    const ca = CertificateAuthority.generate('CN=lab-ca', { now: NOW });
    const issued = ca.issueCertificate({
      subject: `CN=${SRV_IP}`, notBefore: NOW - 1000, notAfter: NOW + 1e9,
      subjectAltNames: [SRV_IP],
    });
    new HttpsServerSession(
      server.getTcpStack(), 443,
      { serverCert: issued.cert, serverPrivateKey: issued.privateKey },
      () => ok('tls-body'),
    ).start();

    return { linux, windows, ca };
  }

  it('sans ancre de confiance, les deux refusent avec (60)', async () => {
    const { linux, windows } = tlsLab();
    const url = `https://${SRV_IP}/`;

    expect(await linux.executeCommand(`curl -sS ${url}`)).toContain('curl: (60)');
    expect(await windows.executeCommand(`curl -sS ${url}`)).toContain('curl: (60)');
  });

  it('avec l\'autorité installée, les deux acceptent et rendent le corps', async () => {
    const { linux, windows, ca } = tlsLab();
    linux.addTrustedCertificateAuthority(ca.rootCertificate);
    windows.addTrustedCertificateAuthority(ca.rootCertificate);
    const url = `https://${SRV_IP}/`;

    expect(await linux.executeCommand(`curl -sS ${url}`)).toContain('tls-body');
    expect(await windows.executeCommand(`curl -sS ${url}`)).toContain('tls-body');
  });

  it('-k passe outre la vérification, des deux côtés', async () => {
    const { linux, windows } = tlsLab();
    const url = `https://${SRV_IP}/`;

    expect(await linux.executeCommand(`curl -sS -k ${url}`)).toContain('tls-body');
    expect(await windows.executeCommand(`curl -sS -k ${url}`)).toContain('tls-body');
  });
});
