import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, CircleAlert, ExternalLink, Lightbulb, LogOut, MessageSquareWarning, RefreshCw } from 'lucide-react'
import { Badge, Button, Input } from './components/ui'
import { ProviderIcon } from './components/provider-icon'
import { failureMessage, management } from './management'

interface Auth { signedIn: boolean; login: string }
interface Start { session: string; userCode: string; verifyUrl: string; expiresIn: number }
const POLL_MS = 3000

/**
 * 插件内反馈：GitHub 登录后提交问题或功能愿望。
 *
 * 为什么要求登录：匿名问题单无法回访，也无法判断同一个抱怨出现了几次。
 * 登录只索取 GitHub 的只读身份（read:user），不请求任何仓库写权限，
 * 令牌也只用来向本项目自己的反馈服务证明"这条是谁提的"。
 *
 * 令牌全程留在本地服务里（见 packages/standalone/feedback.mjs），
 * 页面只拿得到 login 字符串 —— 即便页面被注入脚本也偷不走凭据。
 */
export function Feedback({ version, active }: { version: string; active: boolean }) {
  const [auth, setAuth] = useState<Auth>({ signedIn: false, login: '' })
  const [login, setLogin] = useState<Start>()
  const [kind, setKind] = useState<'bug' | 'wish'>('bug')
  const [title, setTitle] = useState('')
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [sent, setSent] = useState('')
  const live = useRef(true)
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { live.current = false; clearTimeout(pollTimer.current) }, [])

  const readAuth = useCallback(async () => {
    try {
      const value = await management<Auth>('/feedback')
      if (live.current) setAuth(value)
    } catch { /* 状态读取失败不该挡住表单，登录按钮会再报一次 */ }
  }, [])
  useEffect(() => { if (active) void readAuth() }, [active, readAuth])

  const signIn = async () => {
    if (busy) return
    setBusy('signin'); setError(''); setStatus('')
    try {
      const value = await management<Start>('/feedback/start', {})
      if (!live.current) return
      setLogin(value)
      setStatus('已打开 GitHub 授权页。输入下面的验证码后回到这里。')
      window.open(value.verifyUrl, '_blank', 'noopener,noreferrer')
    } catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { if (live.current) setBusy('') }
  }

  // 轮询授权结果。只在登录流程进行中运行，成功后立刻停 —— 常驻轮询
  // 会让一台已经登录的机器每隔几秒向外部服务发一次无意义的请求。
  useEffect(() => {
    if (!login) return undefined
    let cancelled = false
    const tick = async () => {
      try {
        const value = await management<{ status: string; login?: string; error?: string }>('/feedback/poll', { session: login.session })
        if (cancelled || !live.current) return
        if (value.status === 'ok') {
          setLogin(undefined); setAuth({ signedIn: true, login: value.login ?? '' })
          setStatus('已登录 GitHub，可以提交反馈了。'); return
        }
        if (value.status === 'expired') { setLogin(undefined); setError('验证码已过期，请重新发起登录。'); return }
        if (value.status === 'denied') { setLogin(undefined); setError('GitHub 授权未完成。'); return }
        pollTimer.current = setTimeout(() => { void tick() }, POLL_MS)
      } catch (reason) {
        if (cancelled || !live.current) return
        setLogin(undefined); setError(failureMessage(reason))
      }
    }
    pollTimer.current = setTimeout(() => { void tick() }, POLL_MS)
    return () => { cancelled = true; clearTimeout(pollTimer.current) }
  }, [login])

  const signOut = async () => {
    setBusy('signout'); setError(''); setStatus('')
    try { const value = await management<Auth>('/feedback/signout', {}); if (live.current) { setAuth(value); setStatus('已退出反馈登录。') } }
    catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { if (live.current) setBusy('') }
  }

  const submit = async () => {
    if (busy) return
    setBusy('submit'); setError(''); setStatus(''); setSent('')
    try {
      const result = await management<{ id: string }>('/feedback/submit', {
        kind, title, detail,
        version, platform: navigator.platform, page: 'feedback',
      }, undefined, { signOutOn401: false })
      if (!live.current) return
      setTitle(''); setDetail(''); setSent(result.id)
      setStatus('反馈已提交，谢谢。')
    } catch (reason) {
      if (!live.current) return
      // 401 是 GitHub 登录失效（反馈服务重启丢了内存会话，或 7 天到期），不是管理
      // 会话失效：留在本页、把登录态重置，让用户重新点一次登录。正文留在输入框里，
      // 不必重打一遍。
      if ((reason as { status?: number })?.status === 401) {
        setAuth({ signedIn: false, login: '' })
        setError('反馈登录已失效，请重新用 GitHub 登录后再次提交（正文已保留）。')
        return
      }
      setError(failureMessage(reason))
    }
    finally { if (live.current) setBusy('') }
  }

  return <div className="fb-page">
    <header className="wb-heading"><div><span className="wb-eyebrow">FEEDBACK</span><h1>反馈与许愿</h1><p>报告问题，或告诉我们你想要什么</p></div>
      {auth.signedIn
        ? <Button variant="outline" disabled={!!busy} busy={busy === 'signout'} onClick={() => void signOut()}><LogOut size={15} /><span>退出 {auth.login}</span></Button>
        : <Button variant="outline" disabled={!!busy} busy={busy === 'signin'} onClick={() => void signIn()}><ProviderIcon id="github" name="GitHub" size={15} /><span>使用 GitHub 登录</span></Button>}</header>

    {error && <div className="wb-feedback wb-error" role="alert"><CircleAlert size={16} /><span>{error}</span></div>}
    {status && <div className="wb-feedback wb-status" role="status"><Check size={16} /><span>{status}</span></div>}

    {login && <section className="fb-code" aria-label="GitHub 验证码">
      <div><strong>{login.userCode}</strong><small>在 GitHub 页面输入这串验证码</small></div>
      <a href={login.verifyUrl} target="_blank" rel="noopener noreferrer">打开 github.com/login/device<ExternalLink size={13} /></a>
      <p><RefreshCw size={13} />正在等待授权完成…</p>
    </section>}

    {!auth.signedIn && !login && <section className="fb-gate">
      <ProviderIcon id="github" name="GitHub" size={26} />
      <h2>先登录再提交</h2>
      <p>登录只用于确认这条反馈来自谁，方便我们在修好后回来找你。只索取 GitHub 的公开身份，不请求任何仓库权限，也不会发布到公开的 issue 列表。</p>
      <Button disabled={!!busy} busy={busy === 'signin'} onClick={() => void signIn()}><ProviderIcon id="github" name="GitHub" size={15} />使用 GitHub 登录</Button>
    </section>}

    {auth.signedIn && <form className="fb-form" onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="wb-segments" aria-label="反馈类型">
        <button type="button" aria-pressed={kind === 'bug'} disabled={!!busy} onClick={() => setKind('bug')}><MessageSquareWarning size={14} />报告问题</button>
        <button type="button" aria-pressed={kind === 'wish'} disabled={!!busy} onClick={() => setKind('wish')}><Lightbulb size={14} />功能许愿</button>
      </div>
      <label>标题<Input value={title} maxLength={120} disabled={!!busy} placeholder={kind === 'bug' ? '一句话说明出了什么问题' : '一句话说明你希望有什么'} onChange={event => setTitle(event.target.value)} /></label>
      <label>详细描述<textarea rows={9} value={detail} maxLength={8000} disabled={!!busy} placeholder={kind === 'bug'
        ? '复现步骤、你期望的结果、实际发生了什么。有报错原文请一并贴上。'
        : '你现在的做法是什么、卡在哪里、希望这个功能怎么用。'} onChange={event => setDetail(event.target.value)} /></label>
      <div className="fb-meta"><Badge>v{version}</Badge><span>{detail.length} / 8000</span></div>
      {sent && <p className="fb-receipt" role="status"><Check size={14} />已提交，单号 {sent}</p>}
      <div className="fb-actions"><Button type="submit" disabled={!!busy || !title.trim() || !detail.trim()} busy={busy === 'submit'}>提交反馈</Button></div>
    </form>}
  </div>
}
