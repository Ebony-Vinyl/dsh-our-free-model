import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from './ui'

export function WorkbenchDialog({ title, onClose, busy, children }: {
  title: string; onClose(): void; busy?: boolean; children: ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
    return () => { dialog.current?.close() }
  }, [])
  return <dialog ref={dialog} className="wb-dialog" aria-labelledby="wb-dialog-title"
    onCancel={event => { event.preventDefault(); if (!busy) onClose() }}
    onClick={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <header><h2 id="wb-dialog-title">{title}</h2><Button variant="ghost" size="icon" title="关闭" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18} /></Button></header>
    {children}
  </dialog>
}
