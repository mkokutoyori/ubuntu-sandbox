/**
 * @vitest-environment jsdom
 *
 * Save/Open/Clear-All/Reset dialogs (rapport 09 audit, item #54).
 *
 * Replaces window.prompt (Save: type a name; Open: type a number, or
 * "delete N" to remove an entry in the same prompt) and window.confirm
 * (Clear All, Reset, overwrite, delete) with the shadcn Dialog/AlertDialog
 * primitives already used by HelpDialog — blocking, unstyled, script-
 * breakable native dialogs replaced by a real clickable list + delete
 * button + confirm step.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { SaveTopologyDialog } from '@/components/network/SaveTopologyDialog';
import { OpenTopologyDialog } from '@/components/network/OpenTopologyDialog';
import { ConfirmDialog } from '@/components/network/ConfirmDialog';
import { saveTopologyToBrowser } from '@/store/localStorageTopology';
import type { TopologyExport } from '@/store/topologySerializer';

function fakeTopology(name: string): TopologyExport {
  return {
    projectName: name,
    exportedAt: new Date().toISOString(),
    devices: [],
    connections: [],
  } as unknown as TopologyExport;
}

beforeEach(() => {
  localStorage.clear();
});

describe('SaveTopologyDialog', () => {
  it('pre-fills the name field and saves on submit without any window.prompt', () => {
    const promptSpy = vi.spyOn(window, 'prompt');
    const onSave = vi.fn();
    render(<SaveTopologyDialog open onOpenChange={() => {}} defaultName="My Network" onSave={onSave} />);

    const input = screen.getByPlaceholderText('Topology name') as HTMLInputElement;
    expect(input.value).toBe('My Network');

    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith('My Network');
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('asks for overwrite confirmation instead of silently overwriting', () => {
    saveTopologyToBrowser('existing', fakeTopology('existing'));
    const onSave = vi.fn();
    render(<SaveTopologyDialog open onOpenChange={() => {}} defaultName="existing" onSave={onSave} />);

    fireEvent.click(screen.getByText('Save'));
    // Not saved yet — the overwrite confirmation must appear first.
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('Overwrite existing topology?')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Overwrite'));
    expect(onSave).toHaveBeenCalledWith('existing');
  });

  it('does not overwrite when the confirmation is cancelled', () => {
    saveTopologyToBrowser('existing', fakeTopology('existing'));
    const onSave = vi.fn();
    render(<SaveTopologyDialog open onOpenChange={() => {}} defaultName="existing" onSave={onSave} />);

    fireEvent.click(screen.getByText('Save'));
    const confirm = screen.getByRole('alertdialog');
    fireEvent.click(within(confirm).getByText('Cancel'));
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe('OpenTopologyDialog', () => {
  it('shows an empty state instead of an alert() when there is nothing saved', () => {
    const alertSpy = vi.spyOn(window, 'alert');
    render(<OpenTopologyDialog open onOpenChange={() => {}} onOpen={() => {}} />);
    expect(screen.getByText(/No saved topologies/)).toBeInTheDocument();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('lists saved topologies as clickable rows, without any window.prompt', () => {
    saveTopologyToBrowser('lab-1', fakeTopology('lab-1'));
    saveTopologyToBrowser('lab-2', fakeTopology('lab-2'));
    const promptSpy = vi.spyOn(window, 'prompt');
    const onOpen = vi.fn();
    render(<OpenTopologyDialog open onOpenChange={() => {}} onOpen={onOpen} />);

    expect(screen.getByText('lab-1')).toBeInTheDocument();
    expect(screen.getByText('lab-2')).toBeInTheDocument();

    fireEvent.click(screen.getByText('lab-2'));
    expect(onOpen).toHaveBeenCalledWith('lab-2');
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('deletes an entry via its own button + confirm, not a "delete N" prompt string', () => {
    saveTopologyToBrowser('lab-1', fakeTopology('lab-1'));
    const onOpen = vi.fn();
    render(<OpenTopologyDialog open onOpenChange={() => {}} onOpen={onOpen} />);

    fireEvent.click(screen.getByLabelText('Delete lab-1'));
    expect(screen.getByText('Delete saved topology?')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Delete'));

    expect(screen.getByText(/No saved topologies/)).toBeInTheDocument();
    // Deleting must never have triggered a load.
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('ConfirmDialog (Clear All / Reset)', () => {
  it('only calls onConfirm when the action button is clicked, not Cancel', () => {
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Remove all devices?"
        description="Remove all 3 device(s)? This cannot be undone."
        confirmLabel="Remove all"
        destructive
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText('Cancel'));
    expect(onConfirm).not.toHaveBeenCalled();

    rerender(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Remove all devices?"
        description="Remove all 3 device(s)? This cannot be undone."
        confirmLabel="Remove all"
        destructive
        onConfirm={onConfirm}
      />,
    );
    fireEvent.click(screen.getByText('Remove all'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
