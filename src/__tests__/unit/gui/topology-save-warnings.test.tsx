/**
 * @vitest-environment jsdom
 *
 * Silent topology-save data loss (rapport 09 audit, item #55).
 *
 * Before this fix, Save/Export never told the user that terminal
 * sessions, live TCP/SSH connections, and dynamic protocol state don't
 * round-trip — and Open/Import discarded the current canvas with no
 * confirmation at all. Covers the two user-facing pieces: the caveat
 * text surfaced on Save, and the new "replace current canvas?" confirm
 * gating Open when the canvas isn't empty.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SaveTopologyDialog } from '@/components/network/SaveTopologyDialog';
import { OpenTopologyDialog } from '@/components/network/OpenTopologyDialog';
import { saveTopologyToBrowser } from '@/store/localStorageTopology';
import { TOPOLOGY_SAVE_CAVEATS } from '@/store/topologySerializer';
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

describe('SaveTopologyDialog — data-loss caveat', () => {
  it('tells the user up front what will not be preserved', () => {
    render(<SaveTopologyDialog open onOpenChange={() => {}} defaultName="lab" onSave={() => {}} />);
    expect(screen.getByText(TOPOLOGY_SAVE_CAVEATS)).toBeInTheDocument();
  });
});

describe('OpenTopologyDialog — confirm before replacing a non-empty canvas', () => {
  it('does NOT call onOpen immediately when confirmReplace is set; asks first', () => {
    saveTopologyToBrowser('lab-1', fakeTopology('lab-1'));
    const onOpen = vi.fn();
    render(<OpenTopologyDialog open onOpenChange={() => {}} onOpen={onOpen} confirmReplace />);

    fireEvent.click(screen.getByText('lab-1'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByText('Replace current topology?')).toBeInTheDocument();
  });

  it('cancelling the replace-confirm leaves the canvas untouched', () => {
    saveTopologyToBrowser('lab-1', fakeTopology('lab-1'));
    const onOpen = vi.fn();
    render(<OpenTopologyDialog open onOpenChange={() => {}} onOpen={onOpen} confirmReplace />);

    fireEvent.click(screen.getByText('lab-1'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('confirming Replace calls onOpen with the chosen entry', () => {
    saveTopologyToBrowser('lab-1', fakeTopology('lab-1'));
    const onOpen = vi.fn();
    render(<OpenTopologyDialog open onOpenChange={() => {}} onOpen={onOpen} confirmReplace />);

    fireEvent.click(screen.getByText('lab-1'));
    fireEvent.click(screen.getByText('Replace'));
    expect(onOpen).toHaveBeenCalledWith('lab-1');
  });

  it('without confirmReplace (empty canvas), still opens immediately — unchanged default', () => {
    saveTopologyToBrowser('lab-1', fakeTopology('lab-1'));
    const onOpen = vi.fn();
    render(<OpenTopologyDialog open onOpenChange={() => {}} onOpen={onOpen} />);

    fireEvent.click(screen.getByText('lab-1'));
    expect(onOpen).toHaveBeenCalledWith('lab-1');
    expect(screen.queryByText('Replace current topology?')).not.toBeInTheDocument();
  });
});
