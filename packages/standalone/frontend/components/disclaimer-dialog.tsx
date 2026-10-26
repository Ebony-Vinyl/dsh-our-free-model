import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DISCLAIMER, DISCLAIMER_VERSION } from '../../../../src/disclaimer.js'
import { management } from '../management'
import '../disclaimer.css'

/**
 * The disclaimer, shown once on the first console visit and reopenable from the
 * sidebar afterwards.
 *
 * It is not a gate: acknowledging writes a settings key, and the model lanes
 * work whether or not it has been read. The copy itself lives in
 * `src/disclaimer.js` so the plugin's settings page says exactly the same thing.
 */
export function DisclaimerDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (open && !node.open) node.showModal()
    if (!open && node.open) node.close()
  }, [open])
  if (!open) return null
  const dismiss = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      await management('/disclaimer/ack', {})
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败，请重试。')
    } finally { setBusy(false) }
  }
  return createPortal(
    <dialog ref={dialog} className="ofm-disclaimer-dialog" aria-labelledby="ofm-disclaimer-title"
      onCancel={event => { event.preventDefault(); if (!busy) void dismiss() }}>
      <header>
        <span className="ofm-disclaimer-eyebrow">OUR FREE MODEL</span>
        <h2 id="ofm-disclaimer-title">{DISCLAIMER.title}</h2>
        <p>{DISCLAIMER.subtitle}</p>
      </header>
      <div className="ofm-disclaimer-body">
        <p className="ofm-disclaimer-intro">{DISCLAIMER.intro}</p>
        {DISCLAIMER.sections.map((section: { id: string; heading: string; body: string }) => (
          <section key={section.id}>
            <h3>{section.heading}</h3>
            <p>{section.body}</p>
          </section>
        ))}
      </div>
      <footer>
        <span className="ofm-disclaimer-version">免责声明版本 v{DISCLAIMER_VERSION}</span>
        {error && <span className="ofm-disclaimer-error" role="alert">{error}</span>}
        <button type="button" className="primary" disabled={busy} onClick={() => void dismiss()}>
          {busy ? '保存中…' : DISCLAIMER.accept}
        </button>
      </footer>
    </dialog>,
    document.body,
  )
}
