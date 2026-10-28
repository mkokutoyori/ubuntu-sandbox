/**
 * @vitest-environment jsdom
 *
 * Le panneau de journal (NetworkLogsPanel), son hook (useNetworkLogs), le bouton « Logs » de la barre d'outils,
 * l'entree d'aide correspondante et le handle `window.__logger` des specs e2e ont ete retires de l'interface :
 * la fonction n'etait plus voulue. Le Logger reste une source cote simulation, lue par le `logging` des appareils.
 *
 * Mesure de depart (arbre d'avant, git stash) : 3 cas sur 5 tombent — la barre d'outils rendait un bouton « Logs » des
 * qu'on lui passait onToggleLogs, l'aide listait « Logs — open the network event log panel », et les deux modules existaient.
 * Passent des deux cotes, et pourquoi : « the toolbar keeps its other buttons » est un TEMOIN (la barre est rendue,
 * donc l'absence du bouton « Logs » n'est pas un rendu vide) ; « the Logger still feeds its subscribers » est une
 * NON-REGRESSION (le backend est conserve : `logging` des appareils en depend).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Toolbar } from '@/components/network/Toolbar';
import { HelpDialog } from '@/components/network/HelpDialog';
import { Logger } from '@/network/core/Logger';

afterEach(cleanup);

const legacyLogsProps = { logsOpen: false, onToggleLogs: () => undefined } as object;

const toolbar = () => render(
  <Toolbar
    projectName="p" onProjectNameChange={() => undefined}
    onSave={() => undefined} onOpen={() => undefined} onExport={() => undefined} onImport={() => undefined}
    onReset={() => undefined} onSettings={() => undefined} onHelp={() => undefined}
    {...legacyLogsProps}
  />,
);

describe('Probe — the interface carries no log panel', () => {
  it('the toolbar keeps its other buttons', () => {
    toolbar();
    for (const title of ['Save', 'Open', 'Export', 'Import', 'Reset', 'Settings', 'Help']) {
      expect(screen.getByTitle(title)).toBeTruthy();
    }
  });

  it('the toolbar has no Logs button even when a caller still passes the old props', () => {
    toolbar();
    expect(screen.queryByTitle('Logs')).toBeNull();
  });

  it('the help dialog lists no Logs entry', () => {
    render(<HelpDialog open onOpenChange={() => undefined} />);
    expect(screen.queryByText('Logs')).toBeNull();
    expect(screen.queryByText(/event log panel/)).toBeNull();
  });

  it('the panel and its hook are gone', () => {
    const components = Object.keys(import.meta.glob('/src/components/network/*.tsx'));
    const hooks = Object.keys(import.meta.glob('/src/hooks/*.{ts,tsx}'));
    expect(components.length).toBeGreaterThan(5);
    expect(components.some((path) => path.includes('NetworkLogsPanel'))).toBe(false);
    expect(hooks.some((path) => path.includes('useNetworkLogs'))).toBe(false);
  });

  it('the Logger still feeds its subscribers', () => {
    const seen: string[] = [];
    const id = Logger.subscribe((entry) => seen.push(entry.event));
    Logger.info('probe', 'probe:event', 'message');
    Logger.unsubscribe(id);
    expect(seen).toEqual(['probe:event']);
  });
});
