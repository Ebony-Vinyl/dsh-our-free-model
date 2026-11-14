import { useEffect, useRef, useState } from 'react'
import { providers } from 'ofm-provider-list'
import { Activity, ArrowRight, ArrowUpRight, Boxes, Check, CircleCheck, Copy, Handshake, Layers3, Network, RefreshCw, Terminal, Zap } from 'lucide-react'
import { Badge, Button, Card } from './ui'
import { useCountUp, useReveal, useSpotlight, useTilt } from '../motion/hooks'
import type { Host, Snapshot } from '../types'

const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value)
const compact = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : number(value)

/** 把一串数字压成一条通栏趋势带（viewBox 宽 100 高 26，preserveAspectRatio=none 拉伸）。 */
function sparkGeometry(values: number[]): { line: string; area: string } | undefined {
  if (values.length < 2 || values.every(value => value === 0)) return undefined
  const max = Math.max(1, ...values)
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 100
    const y = 22 - (value / max) * 18
    return [x, y] as const
  })
  return {
    line: points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
    area: `0,26 ${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')} 100,26`,
  }
}

/** 单张 KPI 卡：数字滚动 + 迷你趋势线 + 聚光灯。 */
function MetricCard({ name, value, detail, icon: Icon, trend }: {
  name: string; value: string; detail: string
  icon: typeof Boxes; trend: number[]
}) {
  const tilt = useTilt<HTMLDivElement>(4, 3)
  const spot = useSpotlight<HTMLDivElement>()
  const attach = (node: HTMLDivElement | null) => {
    tilt.current = node
    spot.current = node
  }
  const spark = sparkGeometry(trend)
  return <Card className="ov-metric m-tilt m-spot" ref={attach}>
    <div><span>{name}</span><div className="ov-metric-icon"><Icon size={15} /></div></div>
    <strong>{value}</strong><p>{detail}</p>
    {spark ? <svg className="ov-spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={spark.area} /><polyline points={spark.line} />
    </svg> : null}
  </Card>
}

export function Overview({ summary, stats, host }: Snapshot & { host: Host }) {
  const [refreshing, setRefreshing] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  const routable = summary.catalog.filter(model => model.routable).length
  const totalTokens = stats.grand.input + stats.grand.output
  const turns = useCountUp(stats.turns)
  const recovered = useCountUp(stats.recoveredTurns)
  const tokens = useCountUp(totalTokens)
  const models = useCountUp(routable)

  const today = new Date()
  const days = Array.from({ length: 7 }, (_, index) => {
    const at = new Date(today); at.setDate(at.getDate() - 6 + index)
    const id = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    return { id, value: stats.days.find(row => row.day === id)?.total ?? 0 }
  })
  const total = days.reduce((sum, row) => sum + row.value, 0)
  const max = Math.max(1, ...days.map(row => row.value))
  const failures = [...stats.samples].reverse().filter(row => row.ok === false).slice(0, 4)

  // 趋势带只给真正有逐日数据的两张卡（用户回合、累计 Token）。
  // 可接入模型与已恢复回合没有逐日历史——宁可不画，也不编造一条假曲线。
  const metricRows = [
    { name: '可接入模型', value: number(Math.round(models)), icon: Boxes, detail: '当前公开的模型清单', trend: [] },
    { name: '用户回合', value: number(Math.round(turns)), icon: Layers3, detail: `${number(stats.requests)} 次物理请求`, trend: days.map(day => day.value) },
    { name: '累计 Token', value: compact(Math.round(tokens)), icon: Zap, detail: `输入 ${compact(stats.grand.input)} · 输出 ${compact(stats.grand.output)}`, trend: days.map(day => day.value) },
    { name: '已恢复回合', value: number(Math.round(recovered)), icon: Activity, detail: `最终未完成 ${number(stats.failedTurns)} 回合`, trend: [] },
  ]

  const sources = [
    { name: '匿名与 Kilo', sub: '无需账号的免费模型', icon: Zap, count: summary.catalog.filter(row => row.channel === 'anonymous' || row.channel === 'kilo').length, page: 'models' as const },
    { name: 'EAC router', sub: `${providers.length} 个供应商，独立账号池`, icon: Network, count: summary.catalog.filter(row => !['anonymous', 'kilo', 'eac'].includes(row.channel)).length, page: 'channels' as const },
    { name: 'EAC 协付渠道', sub: summary.eacAuth?.local ? '已保存本机授权' : '尚未保存本机授权', icon: Handshake, count: summary.catalog.filter(row => row.channel === 'eac').length, page: 'eac' as const },
  ]

  const reveal = useReveal<HTMLDivElement>(sources.length)
  const quickTilt = useTilt<HTMLDivElement>(3, 2)
  const quickSpot = useSpotlight<HTMLDivElement>()
  const attachQuick = (node: HTMLDivElement | null) => {
    quickTilt.current = node
    quickSpot.current = node
  }

  const copyEndpoint = () => {
    void host.copy(`${summary.baseUrl}/v1`).then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 2000)
    }).catch(host.error)
  }

  return <div className="dashboard" data-testid="overview-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">WORKSPACE / OVERVIEW</div><h1>工作空间概览</h1><p>查看你的模型连接与运行情况。</p></div>
      <Button variant="outline" disabled={refreshing} onClick={() => {
        setRefreshing(true); void host.refresh().catch(host.error).finally(() => setRefreshing(false))
      }}><RefreshCw size={14} className={refreshing ? 'spinning' : ''} />{refreshing ? '正在更新' : '更新状态'}</Button></header>

    <div className="dashboard-metrics">{metricRows.map(metric => <MetricCard key={metric.name} {...metric} />)}</div>

    <div className="dashboard-main-grid">
      <Card className="ov-chart-panel">
        <div className="card-heading"><div><h2>Token 用量</h2><p>最近 7 天的输入与输出</p></div><Badge>最近 7 天</Badge></div>
        <div className="ov-chart-total">{compact(total)} <span>Token</span></div>
        <div className="ov-chart" role="img" aria-label={`最近七天 Token 用量：${days.map(day => `${day.id} ${day.value}`).join('；')}`}>
          <div className="chart-grid-lines"><span /><span /><span /><span /></div>
          {days.map(day => <div className="ov-chart-col" key={day.id} title={`${day.id} · ${number(day.value)} Token`}>
            <div className={`ov-chart-bar ${day.value === 0 ? 'zero' : ''}`} style={{ height: `${Math.max(2, day.value / max * 80)}%` }} />
            <span>{day.id.slice(5).replace('-', '/')}</span>
          </div>)}
          {total === 0 && <div className="ov-chart-empty"><Activity size={20} /><span>还没有调用记录</span><small>接入客户端后，用量会显示在这里</small></div>}
        </div>
        <div className="card-foot"><span>按实际请求记录统计</span><button onClick={() => host.navigate('usage')}>查看全部用量 <ArrowRight size={13} /></button></div>
      </Card>

      <Card className="ov-quick m-tilt m-spot" ref={attachQuick}>
        <div className="ov-quick-icon"><Terminal size={18} /></div>
        <h2>API 接入</h2><p>OpenAI 兼容 · Chat Completions / Responses</p>
        <label>API BASE URL</label>
        <div className="ov-endpoint"><code>{summary.baseUrl}/v1</code>
          <Button variant="ghost" aria-label="复制 API 地址" onClick={copyEndpoint} title="复制 API 地址"
            className={copied ? 'ov-copied' : ''}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </Button>
        </div>
        {copied && <span className="copy-feedback" role="status">地址已复制</span>}
        <div className="connect-steps"><span>管理会话：本机独立会话</span><span>推理鉴权：Bearer API Key</span><span>监听范围：仅回环地址</span></div>
        <Button className="connect-button" onClick={() => host.navigate('connection')}>查看接入配置 <ArrowUpRight size={15} /></Button>
        <div className="connection-footnote"><span className={`status-dot ${summary.settings.enabled ? '' : 'paused'}`} />{summary.settings.enabled ? '推理服务已启用' : '推理服务已暂停'}</div>
      </Card>
    </div>

    <div className="dashboard-bottom-grid">
      <Card className="ov-panel">
        <div className="card-heading"><div><h2>模型来源</h2><p>所有渠道，共用一个接入地址</p></div><Network size={16} /></div>
        <div className="ov-source-list m-reveal" ref={reveal}>{sources.map((source, index) => <button className="ov-source-row" key={source.name} onClick={() => host.navigate(source.page)}
          style={{ '--i': index } as React.CSSProperties}>
          <span className="ov-source-icon"><source.icon size={16} /></span>
          <span><strong>{source.name}</strong><small>{source.sub}</small></span>
          <Badge>{source.count} 个模型</Badge><ArrowRight size={13} />
        </button>)}</div>
      </Card>

      <Card className="ov-panel">
        <div className="card-heading"><div><h2>运行检查</h2><p>服务与最近的失败请求</p></div>
          <Badge tone={failures.length ? 'warning' : 'success'}>{failures.length ? '有失败记录' : '暂无失败记录'}</Badge></div>
        <div className="runtime-check"><CircleCheck size={16} /><span>渠道模块</span><strong>{summary.channels.state === 'ready' ? '已就绪' : summary.channels.state === 'failed' ? '加载失败' : '初始化中'}</strong></div>
        <div className="runtime-check"><RefreshCw size={16} /><span>模型自动刷新</span><strong>{summary.automaticRefresh ? `每 ${summary.settings.probeIntervalMinutes} 分钟` : '已暂停'}</strong></div>
        {failures.length ? <div className="ov-failure-list">{failures.map((row, index) =>
          <div key={`${row.at}-${index}`} className="ov-failure-row">
            <span>{row.model ?? '未知模型'}</span>
            <small>{row.at ? new Date(row.at).toLocaleTimeString('zh-CN') : '时间未知'} · 请求未完成</small>
          </div>)}</div>
          : <div className="ov-runtime-empty"><CircleCheck size={16} /><span>最近的请求样本中没有失败记录</span></div>}
        <div className="card-foot"><span title={summary.dataDir}>数据仅保存在本机独立目录</span><button onClick={() => host.navigate('settings')}>服务设置 <ArrowRight size={13} /></button></div>
      </Card>
    </div>
  </div>
}
