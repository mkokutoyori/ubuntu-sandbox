import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from './ConfirmDialog';
import { listSavedTopologies } from '@/store/localStorageTopology';
import { TOPOLOGY_SAVE_CAVEATS } from '@/store/topologySerializer';

interface SaveTopologyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  onSave: (name: string) => void;
}

/** Replaces the `window.prompt('Save topology as:', ...)` flow (rapport
 *  09 audit, item #54) — silent overwrite is now a confirmed decision. */
export function SaveTopologyDialog({ open, onOpenChange, defaultName, onSave }: SaveTopologyDialogProps) {
  const [name, setName] = useState(defaultName);
  const [pendingOverwrite, setPendingOverwrite] = useState<string | null>(null);

  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (listSavedTopologies().some((t) => t.name === trimmed)) {
      setPendingOverwrite(trimmed);
      return;
    }
    onSave(trimmed);
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save topology</DialogTitle>
            <DialogDescription>Saved to your browser's local storage.</DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder="Topology name"
            autoFocus
          />
          <p className="text-xs text-muted-foreground">{TOPOLOGY_SAVE_CAVEATS}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!name.trim()}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingOverwrite !== null}
        onOpenChange={(o) => { if (!o) setPendingOverwrite(null); }}
        title="Overwrite existing topology?"
        description={`A saved topology named "${pendingOverwrite}" already exists. Overwriting it cannot be undone.`}
        confirmLabel="Overwrite"
        destructive
        onConfirm={() => {
          if (pendingOverwrite) onSave(pendingOverwrite);
          setPendingOverwrite(null);
          onOpenChange(false);
        }}
      />
    </>
  );
}
