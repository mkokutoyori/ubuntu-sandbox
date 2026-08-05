/**
 * `ssh <nom>` résout le nom avant d'ouvrir quoi que ce soit.
 *
 * Défaut signalé depuis l'application : `ssh localhost` descendait
 * jusqu'à `TcpStack.resolveEgress` avec le mot « localhost » pour
 * adresse, où `new IPAddress()` levait. L'exception traversait
 * `connect()` et ressortait en promesse non rattrapée — l'utilisateur
 * voyait une trace de pile dans la console au lieu d'une session ou
 * d'un refus.
 *
 * Deux garanties distinctes sont vérifiées ici, parce que ce sont deux
 * défauts distincts : le client résout le nom (fidélité), et la pile ne
 * lève jamais sur une adresse illisible (robustesse) — cette seconde
 * protège TOUS les appelants, pas seulement ssh.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createSessionForDevice } from '@/terminal/sessions/sessionFactory';
import type { KeyEvent, TerminalSession } from '@/terminal/sessions/TerminalSession';

beforeEach(() => { EquipmentRegistry.getInstance().clear(); });

function key(k: string): KeyEvent {
  return { key: k, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false } as KeyEvent;
}

async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
    await new Promise<void>((r) => setTimeout(r, 0));
  }
}

async function type(session: TerminalSession, line: string): Promise<void> {
  const fg = session.foreground;
  fg.setInput(line);
  fg.setInputBuf(line);
  session.handleKey(key('Enter'));
  await flush();
}

describe('ssh — résolution du nom d\'hôte', () => {
  it('`ssh localhost` ne lève plus, et n\'affiche pas de trace de pile', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    srv.powerOn();
    const session = createSessionForDevice(srv, 'T1')!;
    await flush();

    const rejets: unknown[] = [];
    const onRejet = (e: PromiseRejectionEvent | unknown) => rejets.push(e);
    process.on('unhandledRejection', onRejet);
    try {
      await type(session, 'ssh localhost');
      await flush(20);
    } finally {
      process.off('unhandledRejection', onRejet);
    }

    const texte = session.lines.map((l) => l.text).join('\n');
    expect(rejets, 'aucune promesse non rattrapée').toHaveLength(0);
    expect(texte).not.toContain('Invalid IP address');
    expect(texte).not.toContain('at TcpStack');
  }, 30_000);

  it('un nom inconnu donne le message d\'OpenSSH, pas une exception', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    srv.powerOn();
    const session = createSessionForDevice(srv, 'T1')!;
    await flush();

    await type(session, 'ssh machine-qui-nexiste-pas');
    await flush();

    const texte = session.lines.map((l) => l.text).join('\n');
    expect(texte).toContain('Could not resolve hostname machine-qui-nexiste-pas');
    expect(texte).not.toContain('Invalid IP address');
  }, 30_000);

  it('la pile TCP refuse une adresse illisible au lieu de lever', async () => {
    const srv = new LinuxServer('linux-server', 'SRV');
    srv.powerOn();

    // Le garde-fou, éprouvé directement : n'importe quel appelant, pas
    // seulement ssh, obtient un échec propre au lieu d'une exception.
    expect(() => srv.getTcpStack().connect('pas-une-adresse', 22, {})).not.toThrow();
  }, 30_000);
});
