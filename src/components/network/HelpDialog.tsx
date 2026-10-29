import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLocale } from '@/i18n/useLocale';

interface HelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
  const { t } = useLocale();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('help.title')}</DialogTitle>
          <DialogDescription>{t('help.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <section>
            <h3 className="font-semibold text-foreground mb-1">{t('help.building')}</h3>
            <ul className="list-disc list-inside text-muted-foreground space-y-1">
              <li>{t('help.buildingDrag')}</li>
              <li>{t('help.buildingCable')}</li>
              <li>{t('help.buildingTerminal')}</li>
            </ul>
          </section>

          <section>
            <h3 className="font-semibold text-foreground mb-1">{t('help.toolbar')}</h3>
            <ul className="list-disc list-inside text-muted-foreground space-y-1">
              <li><strong>{t('toolbar.save')}</strong> — {t('help.toolbarSave')}</li>
              <li><strong>{t('toolbar.open')}</strong> — {t('help.toolbarOpen')}</li>
              <li><strong>{t('toolbar.export')}</strong> — {t('help.toolbarExport')}</li>
              <li><strong>{t('export.image.button')}</strong> — {t('help.toolbarImage')}</li>
              <li><strong>{t('toolbar.import')}</strong> — {t('help.toolbarImport')}</li>
              <li><strong>{t('toolbar.reset')}</strong> — {t('help.toolbarReset')}</li>
              <li><strong>{t('toolbar.settings')}</strong> — {t('help.toolbarSettings')}</li>
            </ul>
          </section>

          <section>
            <h3 className="font-semibold text-foreground mb-1">{t('help.protocols')}</h3>
            <p className="text-muted-foreground">{t('help.protocolsList')}</p>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
