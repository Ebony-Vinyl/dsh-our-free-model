import { useState } from 'react'
import { Cable, Check, CircleCheck, Copy, Eye, EyeOff, KeyRound, Link2, LockKeyhole, RotateCcw, ShieldAlert, Terminal } from 'lucide-react'
import { Button, Card } from './components/ui'
import { t } from './i18n.mjs'
import type { Host, Summary } from './types'

export function Connection({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState('')
  if (!active) return null
  const endpoint = `${summary.baseUrl}/v1`
  const model = summary.catalog.find(row => row.routable)?.id ?? 'MODEL_ID'
  const example = `curl ${summary.baseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify({ model, messages: [{ role: 'user', content: t('conn.samplePrompt') }] })}'`
  const run = async (action: () => Promise<void>, message = '') => {
    setBusy(true); setNotice(''); setError('')
    try { await action(); if (message) setNotice(message) }
    catch (reason) { setError(reason instanceof Error ? reason.message : t('err.operationFailed')) }
    finally { setBusy(false) }
  }
  const copy = async (id: string, text: string, message: string) => run(async () => {
    await host.copy(text)
    setCopied(id)
    window.setTimeout(() => setCopied(current => current === id ? '' : current), 1600)
  }, message)
  const toggleKey = () => void run(async () => {
    if (apiKey) { setApiKey(''); return }
    setApiKey(await host.getApiKey())
  })
  const rotate = () => {
    if (!window.confirm(t('conn.rotateConfirm'))) return
    void run(async () => setApiKey(await host.rotateKey()), t('conn.rotated'))
  }
  return <div className="connection-browser" data-testid="connection-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">CONNECT YOUR TOOLS</div>
      <h1>{t('conn.heading')}</h1><p>{t('conn.sub')}</p></div>
      <Cable size={22} aria-hidden="true" /></header>
    {notice && <p className="connection-feedback" role="status"><CircleCheck size={15} />{notice}</p>}
    {error && <p className="connection-error" role="alert"><ShieldAlert size={16} />{error}</p>}
    <Card className="connection-card"><div className="connection-card-heading"><span className="cx-icon"><KeyRound size={16} /></span><div><h2>{t('conn.credentials')}</h2><p>{t('conn.credentialsSub')}</p></div></div>
      <label className="field-label" htmlFor="connection-endpoint">API Base URL</label>
      <div className="copy-field"><div className="cx-field"><Link2 size={14} /><input id="connection-endpoint" readOnly value={endpoint} /></div>
        <Button variant="outline" className={copied === 'endpoint' ? 'cx-copied' : undefined} disabled={busy} onClick={() => void copy('endpoint', endpoint, t('conn.copied'))}>{copied === 'endpoint' ? <Check size={14} /> : <Copy size={14} />}{t('conn.copyAddress')}</Button></div>
      <label className="field-label" htmlFor="connection-key">API Key</label>
      <div className="copy-field"><div className={`cx-field${apiKey ? ' cx-revealed' : ''}`}><LockKeyhole size={14} /><input id="connection-key" type={apiKey ? 'text' : 'password'} readOnly value={apiKey} placeholder={t('conn.revealPlaceholder')} /></div>
        <Button variant="outline" disabled={busy} onClick={toggleKey}>{apiKey ? <EyeOff size={14} /> : <Eye size={14} />}{apiKey ? t('conn.hideKey') : t('conn.showKey')}</Button>
        <Button variant="outline" className={copied === 'key' ? 'cx-copied' : undefined} disabled={!apiKey || busy} onClick={() => void copy('key', apiKey, t('conn.keyCopied'))}>{copied === 'key' ? <Check size={14} /> : <Copy size={14} />}{t('conn.copy')}</Button></div>
      <p className="footnote">{t('conn.keyNote')}</p>
    </Card>
    <Card className="connection-card"><div className="connection-card-heading"><span className="cx-icon"><Terminal size={16} /></span><div><h2>{t('conn.quickStart')}</h2><p>{t('conn.quickStartSub')}</p></div>
      <Button variant="ghost" className={copied === 'example' ? 'cx-copied' : undefined} disabled={busy} onClick={() => void copy('example', example, t('conn.exampleCopied'))}>{copied === 'example' ? <Check size={14} /> : <Copy size={14} />}{t('conn.copyExample')}</Button></div>
      <pre className="connection-example cx-code">{example}</pre>
    </Card>
    <Card className="connection-card connection-danger"><div className="connection-card-heading"><span className="cx-icon cx-icon-danger"><ShieldAlert size={16} /></span><div><h2>{t('conn.rotateTitle')}</h2><p>{t('conn.rotateSub')}</p></div></div>
      <Button variant="outline" className="cx-danger-btn" disabled={busy} onClick={rotate}><RotateCcw size={15} />{t('conn.rotate')}</Button></Card>
  </div>
}
