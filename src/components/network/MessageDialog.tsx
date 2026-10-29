import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useLocale } from '@/i18n/useLocale';

interface MessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
}

/** Shared replacement for `window.alert` (rapport 09 audit, item #54) —
 *  Save/Open failure messages route through this instead of a blocking,
 *  unstyled native dialog. */
export function MessageDialog({ open, onOpenChange, title, description }: MessageDialogProps) {
  const { t } = useLocale();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t('dialog.ok')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
