import { Dialog } from '@luma/ui'
import { answerCurrent, useCurrentDialog } from '#/lib/dialogs.ts'

/**
 * Renders whatever `askConfirm` / `showMessage` are waiting on. Mounted once,
 * at the app root, so a dialog outlives the component that asked for it — the
 * lightbox closes itself on exclude-folder, and its question has to survive.
 */
export function DialogHost() {
  const current = useCurrentDialog()
  if (!current) return null

  return (
    <Dialog
      // Remount per request, so focus and the key handler are set up again for
      // the next one instead of carrying over from the one just answered.
      key={current.id}
      title={current.title}
      message={current.message}
      confirmLabel={current.confirmLabel}
      cancelLabel={current.cancelLabel}
      tone={current.tone}
      confirmKeys={current.confirmKeys}
      edit={current.edit}
      onConfirm={(value) => answerCurrent(true, value)}
      onCancel={() => answerCurrent(false)}
    />
  )
}
