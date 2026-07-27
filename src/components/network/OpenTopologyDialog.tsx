import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Trash2 } from 'lucide-react';
import { ConfirmDialog } from './ConfirmDialog';
import { deleteTopologyFromBrowser, listSavedTopologies, type SavedTopologyEntry } from '@/store/localStorageTopology';

interface OpenTopologyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpen: (name: string) => void;
  /** True when the current canvas has devices on it — opening a saved
   *  topology discards them, so that needs a confirmation first
   *  (rapport 09, item #55: this used to happen with no warning at all). */
  confirmReplace?: boolean;
}

/** Replaces the `window.prompt(...)` (pick-by-number, "delete N" syntax)
 *  flow (rapport 09 audit, item #54) with a clickable list + delete
 *  button per entry. */
export function OpenTopologyDialog({ open, onOpenChange, onOpen, confirmReplace }: OpenTopologyDialogProps) {
  const [entries, setEntries] = useState<SavedTopologyEntry[]>([]);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);

  useEffect(() => {
    if (open) setEntries(listSavedTopologies());
  }, [open]);

  const selectEntry = (name: string) => {
    if (confirmReplace) {
      setPendingOpen(name);
      return;
    }
    onOpen(name);
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Open topology</DialogTitle>
            <DialogDescription>Choose a topology saved to your browser's local storage.</DialogDescription>
          </DialogHeader>
          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No saved topologies. Use "Save" first, or "Import" to load a JSON file.
            </p>
          ) : (
            <ScrollArea className="max-h-80">
              <div className="space-y-1 pr-3">
                {entries.map((entry) => (
                  <div
                    key={entry.name}
                    role="button"
                    tabIndex={0}
                    className="group flex items-center justify-between gap-2 rounded-md px-3 py-2 cursor-pointer hover:bg-accent"
                    onClick={() => selectEntry(entry.name)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        selectEntry(entry.name);
                      }
                    }}
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{entry.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {entry.deviceCount} device{entry.deviceCount === 1 ? '' : 's'} · saved {new Date(entry.savedAt).toLocaleString()}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 shrink-0"
                      aria-label={`Delete ${entry.name}`}
                      onClick={(e) => { e.stopPropagation(); setPendingDelete(entry.name); }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => { if (!o) setPendingDelete(null); }}
        title="Delete saved topology?"
        description={`"${pendingDelete}" will be permanently removed from your browser's storage. This cannot be undone.`}
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (pendingDelete) {
            deleteTopologyFromBrowser(pendingDelete);
            setEntries(listSavedTopologies());
          }
          setPendingDelete(null);
        }}
      />
      <ConfirmDialog
        open={pendingOpen !== null}
        onOpenChange={(o) => { if (!o) setPendingOpen(null); }}
        title="Replace current topology?"
        description={`Loading "${pendingOpen}" will replace everything on the canvas now. Any unsaved changes will be lost.`}
        confirmLabel="Replace"
        destructive
        onConfirm={() => {
          if (pendingOpen) onOpen(pendingOpen);
          setPendingOpen(null);
          onOpenChange(false);
        }}
      />
    </>
  );
}
