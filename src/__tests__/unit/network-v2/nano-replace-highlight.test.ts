/**
 * Nano — surligner l'occurrence concernée pendant "Replace this
 * instance?". Le moteur expose `pendingReplaceMatch` (ligne, colonnes de
 * début/fin en coordonnées RAW du buffer) et son écran la peint en
 * inversion vidéo, aux colonnes AFFICHÉES : un caractère de contrôle
 * `^X` qui la précède sur la même ligne la décale de deux colonnes par
 * caractère, une tabulation jusqu'au taquet suivant.
 */
import { describe, it, expect } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import { plainRowText } from '@/network/devices/linux/editors/screen/EditorScreen';

function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) engine.applyKey(editorKey(ch));
}
function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function ctrl(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { ctrl: true }));
}

function highlighted(nano: NanoEngine): string[] {
  const screen = nano.screen;
  const out: string[] = [];
  for (const row of screen.rows) {
    for (const span of row.spans) {
      if (span.style !== 'reverse') continue;
      const text = plainRowText(row);
      if (span.from === 0 && span.to >= row.text.length - 1) continue;
      out.push(text.slice(span.from, span.to));
    }
  }
  return out;
}

function sized(content: string): NanoEngine {
  const nano = new NanoEngine(new InMemoryEditorFsContext({ '/tmp/x.txt': content }), '/tmp/x.txt', content, false);
  nano.resize(24, 80);
  return nano;
}

function askToReplace(nano: NanoEngine, search: string, replacement: string): void {
  ctrl(nano, '\\');
  typeText(nano, search);
  press(nano, 'Enter');
  typeText(nano, replacement);
  press(nano, 'Enter');
}

describe('Scénario — l\'occurrence proposée est peinte en inversion vidéo', () => {
  it('les cellules inversées encadrent exactement le texte trouvé', () => {
    const nano = sized('eth0 up\neth1 up\n');
    askToReplace(nano, 'eth', 'ens');
    expect(nano.pendingReplaceMatch!.line).toBe(0);
    expect(highlighted(nano).filter((text) => text !== '')).toContain('eth');
  });

  it('un caractère de contrôle avant le match décale la surbrillance de deux colonnes (^A)', () => {
    const nano = sized('x\x01eth0\n');
    askToReplace(nano, 'eth', 'ens');
    const row = nano.screen.rows[1];
    const span = row.spans.find((s) => s.style === 'reverse')!;
    expect(plainRowText(row).slice(span.from, span.to)).toBe('eth');
    expect(span.from).toBe(3);
  });

  it('sur une ligne autre que la première, ne compte que les caractères de CETTE ligne', () => {
    const nano = sized('aaaa\nbbbb\n');
    askToReplace(nano, 'bb', 'cc');
    const row = nano.screen.rows[2];
    const span = row.spans.find((s) => s.style === 'reverse')!;
    expect(plainRowText(row).slice(span.from, span.to)).toBe('bb');
  });
});
