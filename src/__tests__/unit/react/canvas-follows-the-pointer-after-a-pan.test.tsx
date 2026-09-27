/**
 * @vitest-environment jsdom
 *
 * Une fois la carte deplacee (ou zoomee), le canevas ne suivait plus la
 * souris : glisser un equipement le faisait sauter, et le cable en cours
 * de trace partait a cote du pointeur.
 *
 * Mesure de depart, rapportee par l'utilisateur (« quand on deplace toute
 * la topologie, quand on veut deplacer un nouvel equipement, ou faire des
 * cablages, l'UI bug ») et lue dans le code :
 *
 *   depot d'un equipement   (x - rect.left - panX) / zoom     juste
 *   glisser un equipement   (x - rect.left) / zoom - decalage  sans le pan,
 *                           decalage en pixels d'ecran, borne a 0
 *   cable en cours          (x - rect.left) / zoom             sans le pan
 *
 * Trois conversions ecran -> carte pour une seule question, dont une
 * seule juste. S'y ajoutait le fond : un appui gauche sur une zone vide
 * tombait sur le calque SVG des cables, pas sur le canevas, et
 * `e.target === e.currentTarget` refusait d'y voir le fond — la carte ne
 * se deplacait pas a la souris la ou elle etait vide.
 *
 * L'AUTORITE est la transformation que le canevas applique lui-meme a
 * son contenu, `translate(panX, panY) scale(zoom)` d'origine 0 0 : un
 * point d'ecran p est le point de carte (p - rect - pan) / zoom. Toute
 * vue qui convertit doit faire cet inverse-la, et un seul.
 *
 * Ecrite a l'aveugle contre cette transformation, avant de toucher aux
 * gestionnaires.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/components`) :
 * 5 des 6 cas tombent. Le TEMOIN, un appui sur le canevas lui-meme, passe
 * des deux cotes : c'etait le seul fond que l'ancien test reconnaissait.
 * `clearAll` ne rend ni le zoom ni le deplacement : chaque cas repart
 * d'un cadrage neutre, faute de quoi le zoom d'un cas fausse le suivant.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { useNetworkStore } from '@/store/networkStore';
import { NetworkCanvas } from '@/components/network/NetworkCanvas';

beforeEach(() => {
  useNetworkStore.getState().clearAll();
  useNetworkStore.getState().setZoom(1);
  useNetworkStore.getState().setPan(0, 0);
});

afterEach(() => {
  useNetworkStore.getState().clearAll();
});

function place(x: number, y: number): string {
  return useNetworkStore.getState().addDevice('linux-pc', x, y).id;
}

function positionOf(id: string): { x: number; y: number } {
  const device = useNetworkStore.getState().getDevices().find((d) => d.id === id)!;
  return { x: device.x, y: device.y };
}

function deviceNode(container: HTMLElement, id: string): HTMLElement {
  const name = useNetworkStore.getState().getDevices().find((d) => d.id === id)!.name;
  return [...container.querySelectorAll<HTMLElement>('[role="button"]')]
    .find((n) => n.getAttribute('aria-label')?.includes(name))!;
}

function drag(node: HTMLElement, from: [number, number], to: [number, number]): void {
  fireEvent.mouseDown(node, { button: 0, clientX: from[0], clientY: from[1] });
  fireEvent.mouseMove(window, { clientX: to[0], clientY: to[1] });
  fireEvent.mouseUp(window, { clientX: to[0], clientY: to[1] });
}

describe('dragging a device follows the pointer whatever the framing', () => {
  it('map panned by (100, 50): the device follows the pointer', () => {
    const id = place(200, 150);
    useNetworkStore.getState().setPan(100, 50);
    const { container } = render(<NetworkCanvas />);

    drag(deviceNode(container, id), [300, 200], [400, 260]);

    expect(positionOf(id)).toEqual({ x: 300, y: 210 });
  });

  it('zoom 2: a 60-pixel screen step is a 30-unit map step', () => {
    const id = place(100, 100);
    useNetworkStore.getState().setZoom(2);
    const { container } = render(<NetworkCanvas />);

    drag(deviceNode(container, id), [200, 200], [260, 240]);

    expect(positionOf(id)).toEqual({ x: 130, y: 120 });
  });

  it('the map has no edge at 0: a device goes where the pointer takes it', () => {
    const id = place(50, 50);
    useNetworkStore.getState().setPan(200, 200);
    const { container } = render(<NetworkCanvas />);

    drag(deviceNode(container, id), [250, 250], [100, 100]);

    expect(positionOf(id)).toEqual({ x: -100, y: -100 });
  });
});

describe('the cable being drawn heads for the pointer', () => {
  it('map panned by (100, 50): the loose end is under the pointer', () => {
    const id = place(40, 40);
    useNetworkStore.getState().setPan(100, 50);
    useNetworkStore.getState().startConnecting(id, 'eth0');
    const { container } = render(<NetworkCanvas />);

    fireEvent.mouseMove(container.querySelector('#network-canvas')!, { clientX: 300, clientY: 200 });

    const line = container.querySelector('line[stroke="#22c55e"]')!;
    expect([line.getAttribute('x2'), line.getAttribute('y2')]).toEqual(['200', '150']);
  });
});

describe('the empty background pans the map', () => {
  it('a left press on the cable layer, then a drag, pans the map', () => {
    const { container } = render(<NetworkCanvas />);
    const canvas = container.querySelector<HTMLElement>('#network-canvas')!;
    const layer = canvas.querySelector('svg')!;

    fireEvent.mouseDown(layer, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 30 });
    fireEvent.mouseUp(canvas, { clientX: 60, clientY: 30 });

    const { panX, panY } = useNetworkStore.getState();
    expect({ panX, panY }).toEqual({ panX: 50, panY: 20 });
  });

  it('a press on the canvas itself pans the map — WITNESS', () => {
    const { container } = render(<NetworkCanvas />);
    const canvas = container.querySelector<HTMLElement>('#network-canvas')!;

    fireEvent.mouseDown(canvas, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(canvas, { clientX: 60, clientY: 30 });
    fireEvent.mouseUp(canvas, { clientX: 60, clientY: 30 });

    const { panX, panY } = useNetworkStore.getState();
    expect({ panX, panY }).toEqual({ panX: 50, panY: 20 });
  });
});
