import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from './ConfirmDialog';
import { listSavedTopologies } from '@/store/localStorageTopology';
import { useLocale } from '@/i18n/useLocale';

interface SaveTopologyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName: string;
  onSave: (name: string) => void;
}

/** Replaces the `window.prompt('Save topology as:', ...)` flow (rapport
 *  09 audit, item #54) — silent overwrite is now a confirmed decision. */
export function SaveTopologyDialog({ open, onOpenChange, defaultName, onSave }: SaveTopologyDialogProps) {
  const { t } = useLocale();
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
            <DialogTitle>{t('save.title')}</DialogTitle>
            <DialogDescription>{t('save.description')}</DialogDescription>
          </DialogHeader>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
            placeholder={t('save.placeholder')}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">{t('topology.saveCaveats')}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>{t('dialog.cancel')}</Button>
            <Button onClick={submit} disabled={!name.trim()}>{t('save.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={pendingOverwrite !== null}
        onOpenChange={(o) => { if (!o) setPendingOverwrite(null); }}
        title={t('save.overwriteTitle')}
        description={t('save.overwriteDescription', { name: pendingOverwrite ?? '' })}
        confirmLabel={t('save.overwrite')}
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
