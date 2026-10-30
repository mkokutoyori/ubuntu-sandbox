import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useLocale } from '@/i18n/useLocale';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}

/** Shared replacement for `window.confirm` (rapport 09 audit, item #54) —
 *  every destructive/overwrite confirmation in the designer routes
 *  through this instead of a blocking, unstyled native dialog. */
export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel, destructive, onConfirm,
}: ConfirmDialogProps) {
  const { t } = useLocale();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('dialog.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={destructive ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : undefined}
          >
            {confirmLabel ?? t('dialog.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
