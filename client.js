/**
 * Our Free Model — browser half.
 *
 * Contributes three things to the web shell:
 *   1. a settings section (`settings.section` id `our-free-model`) holding the
 *      model roster with live availability, the usage dashboard, the OpenAI
 *      forward listener and the plugin's own switches;
 *   2. a first-run announcement (`settings.onboarding`) that is versioned, so
 *      bumping the copy re-announces once and never nags again;
 *   3. nothing else — no shadowing of the stock model picker, whose grouping by
 *      provider route is exactly the mechanism this plugin uses for its tag.
 *
 * Data is read over the plugin's own same-origin `/api/our-free-model/*` routes
 * rather than a typed Remote binding, because those routes are served by the same
 * host process on every kernel line this plugin targets.
 *
 * Hand-written ModuleLoader bundle: no build step, no dependency beyond the
 * `react` the shell already provides. All colour comes from theme variables so
 * the page survives a scheme switch.
 */
window.__ModuleLoader__.load({
  id: 'dsh-our-free-model',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const ReactDOM = require('react-dom')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useRef, useCallback } = React

    const NS = 'settings.ourFreeModel'
    const inject = ['slots', 'locale']
    const SPONSOR_CARD_URL = 'https://beichenapi.com/register?aff=DL49WAC2DQNG'
    // Sponsor artwork, scaled proportionally for the existing 56px tile.
    const SPONSOR_LOGO = 'data:image/png;base64,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'


    // ── copy ──────────────────────────────────────────────────────────────────
    const DICT = {
      zh: {
        'meta.title': 'Our Free Model',
        'meta.description': '在 DeepSeek Harness 内直连免密免费模型：清单随上游更新、地区可用性按需探测、思考强度真实生效，并附 Token 看板与 OpenAI 兼容转发端口。',
        'ann.pitch': '你只需在 dsh 里装上这个插件，无需登录、注册、填 API Key 或任何其它操作，就能用上包括 Muse Spark 1.3、MiMo V2.6 在内的前沿模型——完全免费，不限量。',
        nav: 'Our Free Model',
        title: 'Our Free Model',
        refresh: '刷新清单',
        reprobe: '重新探测可用性',
        probing: '探测中…',
        loading: '正在加载…',
        loadFailed: '无法连接插件后端',
        retry: '重试',
        'effects.enabled': '视觉特效',
        'effects.hint': '控制背景光晕、毛玻璃和装饰动画；鱼缸和模型功能始终保留。',
        'state.available': '可用',
        'state.region-blocked': '地区受限',
        'state.unavailable': '暂不可用',
        'state.throttled': '限流',
        'state.unknown': '未探测',
        'state.listed': '已列出 · 未实测',
        'roster.selectable': '可选模型',
        'hint.listed': '来自渠道目录，未做逐模型推理测试；不代表对话或工具调用成功。',
        'hint.region': '该模型按出口地区放行。开启网络代理后，插件会在下一次探测自动把它移入可用分组。',
        'hint.unknown': '尚未探测，默认保持可达。',
        'hint.hidden': '探测显示网关点名了它却不路由它，因此已从模型选择器中移除；某一次探测重新通过，它会自己回来。',
        'hint.sharedBudget': '该模型思考不可关闭：思考与可见回答共用同一份额度，档位越低留给正文的越少。',
        'tag.vision': '视觉',
        'tag.text': '纯文本',
        'tag.thinking': '可调思考',
        'tag.thinkingShared': '思考不可关',
        'tag.rung': '默认档上限',
        'tag.rungTitle': '各档位实际发出的输出上限：{ladder}。档位是思考与回答共用的额度，且不会超过上面的最长输出与设置里的单次上限。',
        'tag.levels': '思考档',
        'tag.levelsTitle': '该模型自己声明的思考档位，选中后按原值下发到上游的 reasoning_effort 字段；档位之外的取值会被上游拒绝。',
        'effort.off': '关闭',
        'effort.minimal': '最小',
        'effort.low': '低',
        'effort.medium': '中',
        'effort.high': '高',
        'effort.xhigh': '极高',
        'effort.max': '最大',
        'tag.context': '上下文',
        'tag.output': '最长输出',
        'tag.latency': '首字',
        'tag.eacChannel': 'EAC 渠道 · 协付',
        'tag.new': 'NEW',
        'tag.newTitle': '新上线的模型，经 EAC 渠道转发自 OpenCode 免费车道。',
        'tag.hot': '爆',
        'tag.hotTitle': '当前最热门的免费模型之一。',
        'tag.fast': '高速',
        'tag.fastTitle': '响应快、吞吐高，适合长对话与连续调用。',
        'tag.kiloChannel': 'Kilo 渠道 · 免费池（prompt 可能被上游记录用于改进服务，勿发送敏感内容）',
        'roster.noLane': 'EAC 协付模型在当前运行环境不可用：宿主未提供可识别的桌面 / Web 配置，因此不加载该渠道。',
        'section.models': '模型清单',
        'section.modelsHint': '名称与能力来自上游清单与公开能力表，可用性由本机出口实测得出。',
        'section.dash': '用量看板',
        'section.dashHint': '数据只写入本机，不会上传。',
        'pool.levelOk': '畅通',
        'pool.levelBusy': '繁忙',
        'pool.capacity': '号池容量',
        'pool.levelOver': '过载',
        'pool.reach': '容量占用',
        'pool.formula': 'Star {stars} × 1.5',
        'pool.configured': '按实际配号数',
        'pool.active': '24h 活跃',
        'pool.live': '进行中',
        'pool.unavailable': '号池数据暂不可用 · {reason}',
        'pool.reasonNoLane': '当前运行环境未解锁协付车道',
        'pool.reasonGateway': '网关应答异常',
        'pool.reasonMalformed': '网关数据异常',
        'pool.reasonUnreachable': '网关暂不可达',
        'pool.reasonUnknown': '原因未知',
        'pool.capacityUnknown': 'Star 数据暂不可用',
        'section.eac': 'EAC 渠道授权',
        'section.eacHint': 'EAC（协付）模型需要 GitHub 登录并 star 仓库；免费车道的模型不受影响。',
        'eac.pillOk': '已授权',
        'eac.pillLocked': '未授权',
        'eac.pillRequired': '已开启强制',
        'eac.pillCompat': '兼容期',
        'eac.pillUnknown': '授权策略未确认',
        'eac.pollFailed': '领取授权失败（{reason}），正在自动重试；无需重新授权。',
        'eac.saveFailed': '授权已完成，但本机无法保存登录记录。请检查 DSH_HOME 目录权限；修复后将自动重试。',
        'eac.cancel': '取消此次登录',
        'eac.cancelFailed': '无法确认取消登录，请稍后重试。',
        'eac.pillUnverified': '网关暂不可达',
        'eac.intro': 'EAC 渠道的对话在服务器侧校验授权：用 GitHub 登录，并给 {repo} 点一个 Star，即可解锁。登录在浏览器里完成，无需复制粘贴；取消 Star 后授权会自动失效。',
        'eac.login': '使用 GitHub 登录',
        'eac.starting': '正在打开浏览器…',
        'eac.waiting': '已打开浏览器授权页；若没有自动打开，请手动访问下面的地址完成授权。完成后本页会自动确认。',
        'eac.copy': '复制链接',
        'eac.copied': '已复制',
        'eac.done': '授权成功：@{login}，现在可以使用 EAC 模型了。',
        'eac.needStar': '已用 @{login} 登录，但还没有 star 仓库；请先 Star，再在授权页点「我已 star，重新检查」。',
        'eac.expired': '这次登录等待超时了，请重新发起。',
        'eac.sessionExpired': '登录链接已失效（服务器不再认识它），请重新发起 GitHub 登录。',
        'eac.openManually': '浏览器没有自动打开，请手动访问下面的地址完成授权。',
        'eac.startFailed': '无法发起登录（{reason}）。',
        'eac.loggedIn': '已授权：@{login} · 上次复查 {when}',
        'eac.recheck': '重新检查',
        'eac.logout': '退出登录',
        'eac.noLane': '当前运行环境未解锁 EAC 协付车道，无法进行 GitHub 授权。',
        'eac.lockedTitle': '需要 GitHub 授权并 star 仓库后使用',
        'eac.lockedNote': '未授权：点下方按钮用 GitHub 登录并 star 仓库，或到「EAC 渠道授权」区完成。',
        'section.forward': '本地转发（OpenAI 兼容）',
        'section.forwardHint': '让其它本地工具用一个 base URL 调用这些模型。',
        'section.egress': '出口代理（订阅分流）',
        'section.egressHint': '把推理与探测请求从代理出口发出，缓解按 IP 的频率限制。',
        'egress.enabled': '启用出口',
        'egress.modeSubscription': '订阅模式（本地 mihomo 自动测速分流）',
        'egress.url': '订阅 / 代理 URL',
        'egress.urlNew': '替换订阅地址',
        'egress.urlPlaceholder': '粘贴新的订阅 / 代理地址（留空则保持当前不变）',
        'egress.urlNone': '未设置',
        'egress.urlClear': '清除',
        'egress.urlClearWarn': '清除本机保存的订阅 / 代理地址，并关闭出口',
        'egress.mihomoPath': 'mihomo 路径',
        'egress.mihomoHint': '订阅模式留空则自动查找本机 mihomo（如 Clash Verge）。',
        'egress.apply': '应用',
        'egress.active': '出口生效中',
        'egress.inactive': '未启用',
        'egress.outlet': '当前出口',
        'egress.node': '当前最佳节点',
        'egress.latency': '访问 opencode',
        'egress.measuring': '测量中…',
        'egress.direct': '关闭时请求直连发出；订阅地址按密钥对待——只存在本机设置里，不随常规接口数据下发，仅点「显示」时读取，面板默认打码。',
        'egress.error': '出口启动失败：{message}',
        'section.prefs': '插件设置',
        'section.prefsHint': '改动在下一次加载完全生效。',
        'heat.title': 'Token 热力图',
        'heat.legend': '少',
        'heat.legendMore': '多',
        'heat.empty': '还没有用量记录。用一次对话后回来看看。',
        'curve.title': '总量曲线',
        'curve.tokens': 'Token',
        'curve.requests': '请求数',
        'curve.total': '总计',
        'stat.output': '输出 Token',
        'stat.reasoning': '推理 Token',
        'col.reason': '推理',
        'col.output': '输出',
        'last.title': '最近一回合',
        'last.justNow': '刚刚',
        'last.minAgo': '{n} 分钟前',
        'last.hourAgo': '{n} 小时前',
        'last.dayAgo': '{n} 天前',
        'last.input': '输入',
        'last.originChat': '对话',
        'last.originHarness': '桌面',
        'last.originForward': '转发',
        'last.originBench': '测速',
        'speed.title': '速度',
        'speed.tps': '输出速度',
        'speed.ttft': '首帧延迟',
        'speed.model': '模型',
        'speed.calls': '上游请求',
        'speed.failed': '请求失败',
        'speed.turns': '对话回合',
        'speed.turnFailed': '回合失败',
        'speed.recovered': '已恢复',
        'speed.estimated': '升级前历史按上游请求估算；升级后回合按最终结果精确记录。',
        'speed.scope': '请求、回合和 Token 为累计；速度和首帧按最近 40 次调用计算，热力图按天汇总。',
        'speed.none': '暂无样本',
        'speed.note': '输出速度只统计 {n}/{total} 次可测的调用：那些没流式送出的思考 token 不计入分子，解码窗口短到测不出的也不算。',
        'unit.tokPerSec': 'tok/s',
        'unit.ms': 'ms',
        'forward.enabled': '启用转发端口',
        'forward.host': '监听地址',
        'forward.port': '端口',
        'forward.apply': '应用',
        'settings.failed': '设置未保存',
        'forward.running': '正在监听',
        'forward.stopped': '未启用',
        'forward.baseUrl': 'Base URL',
        'forward.key': 'API Key',
        'forward.show': '显示',
        'forward.hide': '隐藏',
        'forward.rotate': '重新生成',
        'forward.rotateWarn': '重新生成后，所有使用旧 Key 的工具都会失效。',
        'forward.copy': '复制',
        'forward.copied': '已复制',
        'forward.example': '调用示例',
        'forward.error': '启动失败：{message}',
        'forward.notice': '端口提示：{message}',
        'forward.lanTitle': '局域网访问',
        'forward.lanHint': '让同一网络里的其它设备也用这个转发端口。默认关闭；开启后中继需要一把单独的 Key。',
        'forward.lanEnabled': '允许局域网访问',
        'forward.lanPort': '局域网端口',
        'forward.lanAuto': '0 = 自动分配',
        'forward.lanApply': '应用局域网设置',
        'forward.lanRunning': '局域网中继已监听',
        'forward.lanStopped': '局域网中继未启用',
        'forward.lanError': '局域网中继启动失败：{message}',
        'forward.lanKey': '局域网 Key',
        'forward.lanRotateWarn': '重新生成后，局域网里的设备都要换新 Key；本机工具不受影响。',
        'forward.lanWarn': '开启后，能连到这台机器的任何人都可以用这个 Key 花掉本机的免费额度。请只在信任的网络里开启，必要时用防火墙限制来源。',
        'forward.lanUrl': '局域网地址',
        'forward.lanNoAddress': '没有检测到局域网 IPv4 地址',
        'forward.lanAlso': '其它地址：{list}',
        'pref.enabled': '启用免费模型',
        'pref.exposeRegion': '展示地区受限模型',
        'pref.hideFreeModels': '隐藏匿名与 Kilo 免费模型',
        'pref.hideEacModels': '隐藏 EAC 模型',
        'visibility.showModel': '在模型选择器中显示',
        'visibility.hidden': '已隐藏',
        'visibility.unlisted': '未公开模型',
        'visibility.groupHidden': '整组已隐藏，请先关闭上方的整组隐藏开关。',
        'visibility.hint': '隐藏仅影响模型选择器和网关清单，不影响历史会话；仍可在这里恢复显示。',
        'routing.capacity': '链路能力交集',
        'routing.capacityUnavailable': '暂时无法读取链路能力交集，请重试。',
        'pref.interval': '自动刷新间隔（分钟）',
        'pref.maxTokens': '单次输出上限（token）',
        'pref.egress': '当前出口',
        'pref.probedAt': '最近探测',
        'pref.measuredAt': '最近测量',
        'bench.run': '测一次',
        'bench.running': '测量中…',
        'bench.notSaved': '结果未能保存，请检查数据目录；刷新后可能丢失。',
        'bench.result': '文本响应通过 · 首帧 {ttft}ms · 输出 {tps} tok/s · 推理 {reasoning} tok',
        'ann.preamble': '前言',
        'ann.models': '模型清单',
        'ann.newlane': '新模型上线',
        'ann.steps': '使用步骤',
        'ann.features': '功能介绍',
        'ann.later': '稍后再说',
        'ann.page': '第 {n} / {total} 页',
        'ann.openSettings': '打开设置页',
        'disclaimer.version': '免责声明版本 v{n}',
        'disclaimer.saving': '保存中…',
        'disclaimer.reopen': '使用须知与免责声明',
        'ann.p1': '免密：安装即可用，不需要注册、不需要填任何 API Key。',
        'ann.p2': '清单跟随上游：模型集合、上下文长度与能力每次刷新都重新拉取。',
        'ann.p3': '诚实的能力声明：探测不出来的能力不会显示，思考强度档位是真实生效的输出上限。',
        'ann.n1': '两个新模型已通过 EAC 渠道上线，由 OpenCode 免费车道转发：DeepSeek V4.1 Flash Free 与 GLM 5.3 Flash Free。',
        'ann.n2': '它们排在 EAC 模型页最前面，带红色 NEW / 爆 徽标和「高速」标签，一眼就能找到。',
        'ann.n3': '两个模型都真实支持思考档位（低 / 高 / 最大），DeepSeek 还能关闭思考；档位直接下发到上游，不是提示词。',
        'ann.s1': '在输入框的模型选择器里选 “Our Free Model” 分组下的任意模型。',
        'ann.s2': '需要更强推理时点开 Effort 档位；它是真实下发的输出预算，不是提示词。',
        'ann.s3': '想被其它本地工具调用：设置页 → 本地转发 → 启用，把 Base URL 和 Key 填进去。',
        'ann.s4': '地区受限模型会在你切换网络出口后自动重新归类，无需手动操作。',
        'ann.f1': '模型清单：可用性、上下文长度、是否支持视觉、是否可调思考。',
        'ann.f2': 'Token 热力图与总量曲线，支持总计与按模型分别查看。',
        'ann.f3': '输出速度（tok/s）与首字延迟（TTFT）逐次采样。',
        'ann.f4': 'OpenAI 兼容转发端口 + 可生成的 API Key。',
        'ann.f5': '全部数据留在本机，不上传任何遥测。',
        'ann.updates': '公告与升级',
        'ann.u1': '公告中心：仓库主人推送的新公告会实时到达，支持图文排版（HTML）。',
        'ann.u2': '系统通知：开启后，新公告与插件更新会弹出系统级通知。',
        'ann.u3': '应用内升级：自主管理的安装可在设置页升级；宿主管理的安装请通过原安装方式更新。',
        'ann.u4': '自主管理的安装可尝试应用内升级与热重载；宿主管理的安装请通过原安装方式更新，按宿主提示重新加载。',
        'section.news': '公告中心',
        'section.newsHint': '公告由仓库主人推送，本页实时接收。',
        'section.upgrade': '插件升级',
        'section.upgradeHint': '更新方式取决于安装来源；由宿主管理的安装请通过原安装方式更新。',
        'upgrade.managed': '此安装由安装它的宿主管理，请通过原安装方式更新；插件内检查、升级和热重载不可用。',
        'news.unread': '{n} 条未读',
        'news.allRead': '全部已读',
        'news.markRead': '标记已读',
        'news.expand': '展开公告',
        'news.collapse': '收起公告',
        'news.refresh': '检查新公告',
        'news.refreshing': '检查中…',
        'news.empty': '暂无公告。仓库主人推送的新公告会出现在这里。',
        'news.emptyHint': '公告内容支持图文排版，由仓库主人在插件仓库中编辑发布。',
        'news.osEnable': '开启系统通知',
        'news.osOn': '系统通知已开启',
        'news.osOff': '系统通知未开启',
        'news.osDenied': '浏览器拒绝了通知权限；需要在系统/浏览器设置里手动恢复。',
        'news.link': '查看详情',
        'news.urgentTitle': '重要公告',
        'news.gotIt': '知道了',
        'news.lastFetch': '最近拉取',
        'news.fetchFailed': '公告源暂不可达（显示的是缓存）',
        'level.info': '通知',
        'level.update': '更新',
        'level.warn': '注意',
        'level.urgent': '紧急',
        'upgrade.current': '运行版本',
        'upgrade.installed': '磁盘版本',
        'upgrade.mismatch': '运行版本与磁盘版本不一致，请先确认安装状态，再重载或重启。',
        'upgrade.restartHint': '当前宿主不能安全地热重载插件。升级文件会先安全安装，之后需要重启宿主应用才能生效。',
        'upgrade.recovery': '上次升级未完整恢复。请关闭应用，使用保留的备份恢复安装目录，重新启动后检查更新。',
        'upgrade.backup': '恢复备份',
        'upgrade.latest': '最新版本',
        'upgrade.checkedAt': '上次检查',
        'upgrade.never': '从未检查',
        'upgrade.check': '检查更新',
        'upgrade.star': '去 GitHub 点 Star',
        'upgrade.checking': '检查中…',
        'upgrade.upToDate': '已是最新版本',
        'upgrade.available': '可升级到 {version}',
        'upgrade.apply': '立即升级',
        'upgrade.applying': '升级中…',
        'upgrade.phase.download': '正在下载新版本…',
        'upgrade.phase.install': '正在安装文件…',
        'upgrade.phase.reload': '正在热重载…',
        'upgrade.done': '已升级到 {version}，插件已热重载生效。',
        'upgrade.doneRefresh': '已升级到 {version}。点击刷新页面加载新界面。',
        'upgrade.restart': '已升级到 {version}。文件已安全安装，请重启宿主应用后生效。',
        'upgrade.failed': '升级失败：{message}',
        'upgrade.history': '最近一次升级',
        'upgrade.from': '由 {from} 升级',
        'upgrade.notes': '更新说明',
        'upgrade.auto': '自动检查：每 {n} 小时',
        'upgrade.autoOff': '自动检查已关闭',
        'reload.now': '热重载插件',
        'reload.reloading': '重载中…',
        'reload.done': '插件已热重载（第 {n} 次）。',
        'reload.refresh': '刷新页面',
        'reload.auto': '文件变化自动热重载',
        'toast.annTitle': '新公告',
        'toast.updateTitle': '插件可升级',
        'toast.updateBody': '发现新版本 {latest}（当前 {current}），可到设置页升级。',
        'nav.tab.free': '免费模型',
        'nav.tab.eac': 'EAC 模型',
        'nav.tab.channels': 'EAC router',
        'nav.tab.picks': '推荐项目',
        'star.cta': '点个 Star',
        'star.title': '在 GitHub 上给本仓库点 Star',
        'picks.title': '推荐项目',
        'picks.sub': '同一作者的一组开源项目：把 Agent 装进原生桌面、让上百个插件和谐共存、把视频和设计留在这台机器上。用得上，就顺手点个 Star。',
        'picks.foot': 'Star 是开源项目唯一的「工资条」——它决定作者还能投入多少时间。这里的项目都免费、开源、无广告，点一下就是最实在的支持。',
        'picks.stars': 'Stars',
        'picks.forks': 'Forks',
        'picks.fork': 'Fork',
        'picks.totalStars': '{c} 个推荐项目共 {n} 个 Star',
        'picks.updated': '最近更新',
        'picks.stale': '缓存数据',
        'picks.liveFailed': '暂时读不到 GitHub 数据，数字稍后自动补上——不影响下面的链接。',
        'picks.getDesktop': '下载安装',
        'picks.getPack': '安装说明',
        'picks.getDesign': '安装说明',
        'picks.star': '点个 Star',
        'picks.starHint': '在 GitHub 上打开并点 Star',
        'picks.desktop.badge': '桌面工作台',
        'picks.desktop.tagline': '把 Agent 的能力，组织成一张真正能工作的桌面。',
        'picks.desktop.body': '基于 DeepSeek Harness 的开源桌面工作台：Tauri 原生窗口、随包 Node 运行时，双击即进入工作。项目文件、会话变更、插件目录与皮肤市场都在一处，Windows / Linux / macOS 都有安装包。',
        'picks.desktop.tag1': 'Tauri 原生窗口',
        'picks.desktop.tag2': '随包运行时',
        'picks.desktop.tag3': '文件协作与还原',
        'picks.desktop.tag4': '插件市场与皮肤',
        'picks.pack.badge': '插件整合包',
        'picks.pack.tagline': '揽尽万象：让数百个 DSH 插件和谐共存。',
        'picks.pack.body': '为 DSH Desktop 提供插件目录、批量安装、更新与移除管理，内置 72 个基线子插件、皮肤预览与 Prompt 合集；固定摘要清单逐字节校验，装出来的环境完整可信。',
        'picks.pack.tag1': '72 个基线插件',
        'picks.pack.tag2': '批量安装 / 更新',
        'picks.pack.tag3': '皮肤预览',
        'picks.pack.tag4': '摘要校验',
        'picks.design.badge': '设计工作台',
        'picks.design.tagline': '在本地把视频和设计做完，不把素材交给别人。',
        'picks.design.body': 'DeepSeek Harness 的本地视频制作与设计插件：多轨剪辑、模板与设计体系、原生预览画布，成品导出为真实文件。全流程在本机完成，素材与工程留在自己硬盘上。',
        'picks.design.tag1': '多轨剪辑',
        'picks.design.tag2': '模板与设计体系',
        'picks.design.tag3': '原生预览画布',
        'picks.design.tag4': '真实文件导出',
        'free.title': '免费模型',
        'free.sub': '匿名免费与 Kilo 模型统一展示：水位表示可选比例，实测状态单独显示。',
        'sponsor.bannerTag': '中转站',
        'sponsor.bannerTitle': '北辰 API 中转站',
        'sponsor.bannerDescription': 'OFM 官方合作中转站，为用户提供稳定、开放、高性价比的大模型 API 接入服务。支持 Claude、ChatGPT、Grok、Gemini、智谱 GLM、Kimi、DeepSeek 等主流模型，适合在 Codex、Gemini CLI、Claude Code 及其他开发工具中统一配置使用。邀请可获百分之十的返现。',
        'sponsor.bannerCta': '立即查看',
        'free.tankLabel': '免费池可选占比',
        'free.tankNote': '水位 = 未受限可选模型 / 总数（{selectable}/{total}）；未探测计为候选，不代表实测成功率。',
        'free.tankEmpty': '免费池暂未发现模型。',
        'free.statHint': '五格状态计数相加 = 匿名免费与 Kilo 模型总数（{total}）；仅列出但未测试的模型计入「未探测」。',
        'free.sources': '匿名免费 {anonymous} · Kilo {kilo}',
        'eac.title': 'EAC 模型',
        'eac.sub': '桌面端协付渠道：GitHub 登录并 star 本仓库后解锁，与免费车道互不影响。',
        'eac.tankLabel': '协付池压力',
        'chan.title': 'EAC router',
        'chan.sub': '账号渠道',
        'chan.search': '搜索渠道、厂商或 ID',
        'chan.filterStatus': '连接状态',
        'chan.filterAll': '全部',
        'chan.filterEmpty': '没有符合筛选条件的渠道。',
        'chan.showing': '{shown} / {total} 个渠道',
        'chan.connect': '连接',
        'chan.manage': '管理',
        'chan.collapse': '收起',
        'chan.state.loading': '读取中',
        'chan.pack.failed': '渠道包未挂载：{reason}（免费车道与 EAC 不受影响）',
        'chan.pack.hint': '渠道包由本插件内置（vendor/channel-pack），随插件一起升级。',
        'chan.state.on': '已连接',
        'chan.state.off': '未连接',
        'chan.state.closed': '已关闭',
        'chan.meta.accounts': '账号',
        'chan.meta.models': '模型',
        'chan.act.add': '添加账号',
        'chan.zcode.provider': '登录渠道',
        'chan.zcode.bigmodel': 'bigmodel.cn',
        'chan.zcode.zai': 'z.ai 国际版',
        'chan.act.refresh': '续期',
        'chan.act.test': '测试',
        'chan.act.delete': '移除',
        'chan.act.claim': '一键领取',
        'chan.fold.accounts': '账号',
        'chan.fold.models': '模型',
        'chan.noAccount': '还没有账号——点「添加账号」开始登录。',
        'chan.enabled': '已启用',
        'chan.act.enable': '启用',
        'chan.act.disable': '停用',
        'chan.expires.never': '长效',
        'chan.disabled': '已停用',
        'chan.login.title': '登录 {name}',
        'chan.login.step1': '在浏览器中完成登录（若没有自动打开，点下面的按钮）。',
        'chan.login.step2': '登录成功后本页会自动完成，无需复制任何东西。',
        'chan.login.open': '打开登录页',
        'chan.login.cancel': '取消',
        'chan.login.waiting': '已打开登录页，等待授权…（最长等待 10 分钟）',
        'chan.login.expired': '等待超时，请重新发起登录。',
        'chan.login.done': '已接入：{login}',
        'chan.login.failed': '登录未完成：{reason}',
        'chan.test.ok': '连接正常（{ms} ms）',
        'chan.test.failed': '测试失败：{reason}',
        'chan.claim.result': '已领取 {count} 个账号，共 {credit} 积分。',
        'chan.claim.none': '今天没有可领取的积分。',
        'chan.credit.today': '今日已领 {credit}',
        'chan.model.free': '免费额度',
        'chan.model.dead': '已下架',
        'chan.model.hidden': '已隐藏',
        'chan.model.restore': '恢复显示',
        'chan.model.off': '关闭',
        'chan.model.on': '开启',
        'chan.model.enableAll': '全部开启',
        'chan.model.disableAll': '全部关闭',
        'chan.model.enabledCount': '已开启 {enabled}/{total}',
        'chan.model.allScope': '仅操作当前渠道的全部模型',
        'chan.error': '操作失败：{reason}',
        'chan.confirm.delete': '移除账号 {name}？该账号的凭据会一并删除。',
        'chan.rpc.unavailable': '宿主未提供 connection 服务，渠道操作暂不可用。',
        'nav.tab.ledger': '数据看板',
        'nav.tab.logs': '运行日志',
        'nav.tab.gateway': '网关设置',
        'nav.tab.upgrade': '插件升级',
        'chan.titleSingle': '渠道',
        'dash.title': '数据看板',
        'dash.sub': '渠道模型的 Token 消耗与推理指标：输入/输出/思考/缓存逐项统计，账号与模型双维度透视。',
        'dash.today': '今日数据',
        'dash.all': '全部历史',
        'dash.refresh': '刷新',
        'dash.kpiToday': '今日消耗 Token',
        'dash.kpiScopeAll': '范围内消耗 Token',
        'dash.kpiCumulative': '累计消耗 Token',
        'dash.kpiSpeed': '平均生成速度',
        'dash.kpiCache': '上下文缓存命中率',
        'dash.kpiRequests': '请求数 & 成功率',
        'dash.input': '输入',
        'dash.output': '输出',
        'dash.reasoning': '思考',
        'dash.ttft': '首字',
        'dash.cacheTokens': '缓存命中',
        'dash.successRate': '成功率',
        'dash.failed': '失败',
        'dash.recentTitle': '总览 · 最近请求',
        'dash.recentHint': '来自渠道包的逐请求账本：时间、账号、首字延迟、生成速度与 Token 细分。',
        'dash.empty': '暂无数据——通过渠道模型发起一次对话后，这里就会开始记录。',
        'dash.accountsTitle': '各账号用量透视与模型消耗分布',
        'dash.accountsHint': '按账号汇总请求数与 Token 细分，附调用量最高的模型。',
        'dash.modelsTitle': '模型性能指标与用量一览',
        'dash.modelsHint': '融合首字延迟、生成速度与 Token 统计 · 用量占比按消耗 Token 计算。',
        'log.time': '时间',
        'log.model': '模型',
        'log.account': '账号',
        'log.via': '通道',
        'log.viaDirect': '对话',
        'log.viaGateway': '网关',
        'log.result': '结果',
        'log.ok': '成功',
        'log.failed': '失败',
        'log.duration': '耗时',
        'log.ttft': '首字',
        'log.speed': '速度',
        'log.input': '输入',
        'log.output': '输出',
        'log.reasoning': '思考',
        'log.cache': '缓存',
        'log.total': '总 token',
        'log.requests': '请求数',
        'log.inputSlash': '输入 / 输出 / 思考',
        'log.cacheHit': '缓存命中率',
        'log.share': '用量占比',
        'log.modelMix': '调用的模型分布',
        'log.unattributed': '未归属',
        'logs.title': '运行日志',
        'logs.sub': '逐条请求明细：结果、耗时、首字、速度与 Token 细分；悬停失败行可看原因。',
        'logs.auto': '每 10 秒自动刷新',
        'logs.count': '共 {total} 条 · 本页 {shown} 条',
        'logs.empty': '还没有请求记录。',
        'logs.page': '第 {page} 页 / 共 {pages} 页',
        'logs.windowNote': '逐条日志保留最近窗口；历史只保留按日聚合（约 90 天），数据看板的「全部历史」即来源于此。',
        'gw.title': '网关设置',
        'gw.sub': '把渠道模型以 OpenAI 兼容接口发给本机与局域网工具：端点、密钥与转发端口都在这里。',
        'gw.gatewayTitle': '渠道模型网关（OpenAI 兼容）',
        'gw.gatewayHint': '覆盖全部已接入渠道；Chat Completions 与 Responses 两套接口同时可用。',
        'gw.running': '运行中',
        'gw.stopped': '未运行',
        'gw.envBlocked': '已被环境变量停用',
        'gw.switch': '启用网关',
        'gw.endpoint': '端点',
        'gw.key': 'API Key',
        'gw.show': '显示',
        'gw.hide': '隐藏',
        'gw.keyNote': '明文凭据：只用于客户端配置，请勿外发。',
        'gw.keyNone': '尚未生成',
        'gw.keyNoneHint': '启用一次网关即会自动生成密钥。',
        'gw.models': '可转发模型',
        'gw.portNote': '端口可用环境变量 DSH_OPENAI_GATEWAY_PORT 调整。',
        'gw.relayTitle': '局域网转发（本插件中继）',
        'gw.relayHint': '把网关再暴露到一个可选的地址与端口：调用方用下面的中继密钥，网关自身只监听本机。',
        'gw.relaySwitch': '启用局域网转发',
        'gw.relayBind': '监听地址',
        'gw.bindLocal': '仅本机（127.0.0.1）',
        'gw.bindLan': '局域网（0.0.0.0）',
        'gw.relayPort': '端口',
        'gw.relayUrl': 'Base URL',
        'gw.relayKey': '中继密钥',
        'gw.rotate': '轮换',
        'gw.relayNote': '中继只放行模型接口（/v1/*），并要求携带中继密钥；局域网绑定意味着同网段的设备都能访问到这个端口。',
        'gw.freeLaneNote': '免费车道（Our Free Model）自己的转发端口在「免费模型」页的「本地转发」分区。',
        'chan.credits.left': '剩余积分',
        'chan.credits.tokens': '剩余 Token',
        'chan.credits.dollars': '剩余余额（USD）',
        'chan.credits.quota': '剩余配额',
        'chan.credits.loaded': '已查询 {count} 个账号',
        'chan.credits.refresh': '刷新余额',
        'chan.credits.loading': '余额查询中…',
        'chan.credits.failed': '余额查询失败：{reason}',
        'chan.credits.partial': '{count} 个账号未能查询余额，请展开账号查看原因并重试。',
        'chan.credits.unavailable': '未返回余额数据',
        'chan.claim.failed': '领取失败：{reason}',
        'chan.auto.title': '每日自动签到',
        'chan.auto.running': '签到进行中…',
        'chan.auto.ran': '今日已自动签到',
        'chan.auto.off': '今日尚未签到',
        'chan.auto.last': '上次结果：{result}',
        'nav.tab.aggregate': '聚合渠道',
        'nav.tab.workspace': '模型工作台',
        'engine.start': '打开工作台',
        'engine.starting': '正在启动工作台…',
        'engine.failed': '工作台启动失败',
        'engine.title': '模型工作台',
        'engine.refresh': '刷新模型',
        'engine.expand': '展开工作台',
        'engine.close': '收起工作台',
        'engine.tools': '工作台',
        'engine.settings': '工作台设置',
        'sub.title': '订阅账号',
        'sub.add': '导入账号',
        'sub.discover': '查找本机账号',
        'sub.candidates': '本机登录记录',
        'sub.noCandidates': '没有找到可导入的本机登录记录。',
        'sub.review': '选择导入',
        'sub.empty': '尚未导入订阅账号。',
        'sub.provider': '服务商',
        'sub.label': '账号名称',
        'sub.models': '模型 ID',
        'sub.credentials': '凭据 JSON',
        'sub.file': '凭据文件',
        'sub.paste': '粘贴 JSON',
        'sub.upload': '选择文件',
        'sub.key': 'API Key',
        'sub.baseUrl': 'Base URL',
        'sub.format': '接口协议',
        'sub.import': '确认导入',
        'sub.cancel': '取消',
        'sub.working': '处理中…',
        'sub.invalidJson': '凭据必须是有效的 JSON 对象。',
        'sub.fileTooLarge': '凭据文件不能超过 1 MB。',
        'sub.fileFailed': '无法读取凭据文件。',
        'sub.invalidEndpoint': '请输入 HTTP(S) 地址，不含登录信息、查询参数或片段。',
        'sub.keyRequired': '请输入 API Key。',
        'sub.invalidModels': '请输入有效的模型 ID，以逗号或换行分隔。',
        'sub.loadFailed': '无法读取订阅账号',
        'sub.operationFailed': '操作未完成，请重试。',
        'sub.enabled': '启用账号',
        'sub.refreshQuota': '刷新额度',
        'sub.remove': '移除',
        'sub.confirmRemove': '确认移除',
        'sub.removeQuestion': '移除此账号及保存的凭据？',
        'sub.unknown': '未知',
        'sub.quotaFailed': '额度查询失败',
        'sub.fiveHour': '5 小时',
        'sub.weekly': '每周',
        'sub.used': '已用 {n}%',
        'sub.remaining': '剩余 {n}%',
        'sub.resets': '重置时间',
        'sub.checked': '查询时间',
        'sub.plan': '订阅方案',
        'sub.balance': '余额',
        'sub.credits': '积分',
        'sub.unlimited': '不限量',
        'sub.noModels': '未指定模型',
        'sub.accounts': '{n} 个账号',
        'nav.tab.saver': '省 Token',
        'nav.tab.routing': '路由',
        'agg.title': '聚合渠道',
        'agg.sub': '第三方提供商',
        'agg.registryCount': '注册表 {n} 家',
        'agg.configuredCount': '已配置 {n} 家',
        'agg.addProvider': '添加提供商',
        'agg.addTitle': '选择提供商',
        'agg.addHint': '可按分类、协议与认证方式筛选。标了「不可驱动」的提供商需要交互式登录或云侧凭据，本车道不会调用它们。',
        'agg.search': '搜索名称或 ID',
        'agg.filterCategory': '分类',
        'agg.filterFormat': '协议',
        'agg.filterAuth': '认证',
        'agg.filterAll': '全部',
        'agg.showing': '显示 {shown} / {total} 家',
        'agg.noMatch': '没有匹配的提供商。',
        'agg.notUsable': '不可驱动',
        'agg.notUsableWhy': '本车道不会调用它：认证方式是「{kind}」，需要交互式登录或云侧凭据，只能由宿主自己接管。',
        'agg.credential': '获取 Key',
        'agg.modelCount': '{n} 个模型',
        'agg.select': '配置',
        'agg.configuredTitle': '提供商目录',
        'agg.configuredHint': '保存后立即生效：清单与模型选择器一起更新。',
        'agg.configured': '已配置',
        'agg.unconfigured': '未连接',
        'agg.connect': '连接',
        'agg.manage': '管理',
        'agg.empty': '还没有接入任何聚合提供商',
        'agg.emptyHint': '这一页把第三方端点接进模型清单：聚合站、免费额度池、本机推理服务都行。填入 Key 与可选的 Base URL，它们的模型就会出现在模型选择器里，也能成为降级链的一环。',
        'agg.filterEmpty': '没有符合筛选条件的提供商。',
        'agg.contributes': '当前贡献 {n} 个模型',
        'agg.contributesNone': '当前未贡献任何模型',
        'agg.hasKey': '已存 Key {hint}',
        'agg.noKey': '未存 Key',
        'agg.enabled': '启用',
        'agg.disabled': '已停用',
        'agg.key': 'API Key',
        'agg.keyPlaceholder': '粘贴新的 API Key（留空则保持不变）',
        'agg.keyKeep': '留空保持当前 Key 不变；要删除请用下面的清除按钮。',
        'agg.keyClear': '清除已保存的 Key',
        'agg.keyClearWarn': '清除后该提供商立即停止贡献模型，直到重新填入 Key。',
        'agg.baseUrl': 'Base URL',
        'agg.baseUrlHint': '留空则使用注册表默认值。',
        'agg.baseUrlDefault': '注册表默认：{url}',
        'agg.baseUrlEnv': '也可用环境变量 {env} 覆盖',
        'agg.models': '模型覆盖',
        'agg.modelsHint': '逗号或换行分隔的模型 ID；留空则用它自己声明的清单。',
        'agg.modelsPlaceholder': 'model-a, model-b',
        'agg.test': '测试',
        'agg.testing': '测试中…',
        'agg.testOk': '验证通过',
        'agg.testFailed': '验证失败',
        'agg.testUnverified': '无法验证',
        'agg.testUnverifiedWhy': '该提供商不提供模型列表接口，验证它要花掉一次真实生成——这里不做。',
        'agg.testAt': '最近测试 {when}',
        'agg.neverTested': '尚未测试',
        'agg.discover': '发现模型',
        'agg.discovering': '发现中…',
        'agg.discovered': '发现 {n} 个模型',
        'agg.discoveredNone': '该提供商不提供模型列表。',
        'agg.discoveredUse': '填入模型覆盖',
        'agg.save': '保存',
        'agg.saving': '保存中…',
        'agg.add': '添加',
        'agg.remove': '移除',
        'agg.removeConfirm': '确认移除',
        'agg.removeWarn': '移除后它贡献的模型立即从清单消失，已保存的 Key 一并删除。',
        'agg.cancel': '取消',
        'agg.saved': '已保存',
        'agg.savedBody': '{name} 的配置已保存。',
        'agg.removedBody': '{name} 已移除。',
        'agg.failed': '操作失败',
        'agg.loadFailed': '无法读取提供商注册表',
        'agg.category.apikey': 'API Key',
        'agg.category.free': '完全免费',
        'agg.category.freeTier': '免费额度',
        'agg.category.local': '本机',
        'agg.category.oauth': 'OAuth',
        'agg.auth.apiKey': 'API Key',
        'agg.auth.none': '免认证',
        'agg.auth.oauth': 'OAuth 登录',
        'agg.auth.adc': '云侧凭据',
        'saver.title': '省 Token',
        'saver.sub': '在请求离开本机之前压缩它：工具输出重编码、提示词瘦身，以及五个不占用上游请求的本地应答。',
        'saver.master': '启用 Token 压缩',
        'saver.masterHint': '关掉后所有压缩立即停止，请求按原样发出；下面的设置保留。',
        'saver.rtk': 'RTK 工具输出压缩',
        'saver.rtkWhat': '压缩的是工具结果：git diff / status / log、grep、find、ls、tree、构建日志、带行号的文件转储，以及重复的日志行。',
        'saver.rtkSafety': '安全边界：报错的工具结果原样保留，小体积内容不碰，替换只在新文本更小且非空时发生——压缩结果永远不会比原文更大。',
        'saver.promptTitle': '提示词压缩',
        'saver.promptHint': '在系统提示里追加一条写作指令。这是唯一能减少输出 Token 的压缩，因为它改变的是模型怎么写。',
        'saver.caveman': 'Caveman',
        'saver.cavemanWhat': '电报体回复：去掉客套与重复解释，只留结论与代码。',
        'saver.ponytail': 'Ponytail',
        'saver.ponytailWhat': 'YAGNI 最小实现：只写被要求的那一件事，不主动加抽象、配置与兜底。',
        'saver.voiceWarn': '注意：这两族会改变助手的说话方式，并且会留在你的对话记录里。默认关闭。',
        'saver.localTitle': '本地应答',
        'saver.localHint': '这五类请求的答案就在请求体里，转发出去只是白花一次上游额度与一个来回。',
        'saver.local.enabled': '启用本地应答',
        'saver.local.quota': '额度探测',
        'saver.local.quotaHint': '回答「额度检查」这类探针，返回一句固定答复。',
        'saver.local.prefix': '命令前缀',
        'saver.local.prefixHint': '回答权限提示要的命令前缀，从 shell 命令里解析。',
        'saver.local.title': '会话标题',
        'saver.local.titleHint': '回答标题生成请求，返回固定标题。',
        'saver.local.suggestion': '建议模式',
        'saver.local.suggestionHint': '回答建议模式的空转回合，不产生上游请求。',
        'saver.local.filepath': '文件路径提取',
        'saver.local.filepathHint': '从命令与输出里解析出文件路径，返回结构化结果。',
        'saver.dashTitle': '节省统计',
        'saver.dashHint': '按字节统计本机实际发生的压缩，只写入本机。',
        'saver.bytesBefore': '压缩前',
        'saver.bytesAfter': '压缩后',
        'saver.bytesSaved': '节省字节',
        'saver.percent': '节省比例',
        'saver.blocks': '压缩块数',
        'saver.calls': '统计调用',
        'saver.promptCalls': '提示词注入',
        'saver.noData': '还没有可统计的请求。发起一次对话后，这里显示的是真实压缩字节数，不是估算。',
        'saver.report': '统计口径',
        'saver.saved': '已保存',
        'saver.savedBody': 'Token 压缩设置已保存。',
        'saver.failed': '保存失败',
        'saver.loadFailed': '无法读取 Token 压缩设置',
        'saver.level.off': '关闭',
        'saver.level.lite': '轻',
        'saver.level.full': '全',
        'saver.level.ultra': '极',
        'saver.level.wenyanLite': '文言·轻',
        'saver.level.wenyan': '文言',
        'saver.level.wenyanUltra': '文言·极',
        'routing.title': '路由',
        'routing.sub': '把若干模型串成一条降级链：链上第一个失败就换下一个，对调用方始终只有一个模型 ID。',
        'routing.chains': '已存链路',
        'routing.chainsHint': '链路按输入顺序保存；引用当前不可用模型的链路会原样保留，车道恢复后自己回来。',
        'routing.empty': '还没有降级链',
        'routing.emptyHint': '一条链就是一个虚拟模型：在模型选择器里选它，请求按顺序尝试链上的每个真实模型。用来兜住某个车道临时不可用的时段。',
        'routing.newChain': '新建链路',
        'routing.name': '名称',
        'routing.namePlaceholder': '例如：先免费后协付',
        'routing.strategy': '策略',
        'routing.strategy.fallback': '顺序降级',
        'routing.strategy.roundRobin': '轮询',
        'routing.strategy.smart': '额度优先',
        'routing.strategy.usage': '最少使用',
        'routing.strategy.pace': '每周额度节奏',
        'routing.stickyLimit': '轮询粘滞次数',
        'routing.stickyHint': '轮询时同一个模型连续用多少次再换下一个。',
        'routing.members': '成员（按顺序）',
        'routing.addMember': '添加成员',
        'routing.memberEmpty': '还没有成员——点「添加成员」从清单里挑一个。',
        'routing.moveUp': '上移',
        'routing.moveDown': '下移',
        'routing.removeMember': '移除',
        'routing.pickModel': '选择模型',
        'routing.searchModel': '搜索模型 ID 或名称',
        'routing.noModel': '没有匹配的模型。',
        'routing.usable': '可用',
        'routing.notUsable': '当前不可用',
        'routing.missing': '不在清单中的成员：{ids}',
        'routing.notUsableWhy': '链路原样保存，不会因为某条车道今天关闭而被改写；这些 ID 回到清单里它就自己恢复。如果是拼写错误，编辑链路改正即可。',
        'routing.resolved': '解析为',
        'routing.memberCount': '{n} 个成员',
        'routing.save': '保存链路',
        'routing.saved': '已保存',
        'routing.savedBody': '链路已保存。',
        'routing.failed': '保存失败',
        'routing.loadFailed': '无法读取链路设置',
        'routing.cancel': '取消',
        'routing.edit': '编辑',
        'routing.delete': '删除',
        'routing.deleteConfirm': '确认删除',
        'routing.deleteWarn': '删除后这个模型 ID 立即从清单消失，正在引用它的客户端会拿到 404。',
        'routing.enabled': '启用',
        'routing.channel.free': '免费车道',
        'routing.channel.eac': 'EAC 协付',
        'routing.channel.kilo': 'Kilo',
        'routing.channel.aggregate': '聚合',
        'routing.channel.combo': '链路',
        'gw.clientsTitle': '接入客户端',
        'gw.clientsHint': '免费车道转发端口（在「免费模型」页的「本地转发」里开关）的接入配方：地址与 Key 按实际绑定的端口与真实密钥生成。',
        'gw.clientsOff': '转发端口未启用',
        'gw.clientsOffHint': '先到「免费模型」页的「本地转发」打开端口，这里才会给出可用的地址与配方。',
        'gw.clientsModels': '可转发模型 {n} 个',
      },
      en: {
        'meta.title': 'Our Free Model',
        'meta.description': 'Free no-key models inside DeepSeek Harness: a roster that follows upstream, on-demand regional availability, genuinely enforced thinking levels, a token dashboard and an OpenAI-compatible local forward port.',
        'ann.pitch': 'All you do is install this plugin in dsh — no login, no sign-up, no API key, no other step of any kind. The frontier models are simply there, Muse Spark 1.3 and MiMo V2.6 among them. Completely free, with no usage cap.',
        nav: 'Our Free Model',
        title: 'Our Free Model',
        refresh: 'Refresh roster',
        reprobe: 'Re-probe availability',
        probing: 'Probing…',
        loading: 'Loading…',
        loadFailed: 'Cannot reach the plugin backend',
        retry: 'Retry',
        'effects.enabled': 'Visual effects',
        'effects.hint': 'Toggle background glow, glass blur and decorative motion. The aquarium and model features stay available.',
        'state.available': 'Available',
        'state.region-blocked': 'Region-limited',
        'state.unavailable': 'Unavailable',
        'state.throttled': 'Throttled',
        'state.unknown': 'Not probed',
        'state.listed': 'Listed · not tested',
        'roster.selectable': 'Selectable models',
        'hint.listed': 'Listed by the channel; inference has not been tested. This does not confirm chat or tool use.',
        'hint.region': 'This model is gated by egress country. Once a proxy changes your egress, the next probe moves it into the available group by itself.',
        'hint.unknown': 'Not probed yet, so it stays reachable.',
        'hint.hidden': 'The gateway names it but refuses to route it, so it is out of the model picker. It returns by itself as soon as a probe gets through.',
        'hint.sharedBudget': 'Thinking cannot be switched off on this model, so thinking and the visible answer share one ceiling — a lower rung leaves the answer less room.',
        'tag.vision': 'Vision',
        'tag.text': 'Text only',
        'tag.thinking': 'Tunable thinking',
        'tag.thinkingShared': 'Thinking always on',
        'tag.rung': 'Default ceiling',
        'tag.rungTitle': 'What each rung actually sends: {ladder}. A rung is one ceiling shared by thinking and the answer, and it never exceeds the max output above or the per-call ceiling in settings.',
        'tag.levels': 'Thinking levels',
        'tag.levelsTitle': 'The levels this model declares itself; the selected one is sent as-is in the upstream reasoning_effort field, and a value outside the set is rejected upstream.',
        'effort.off': 'Off',
        'effort.minimal': 'Minimal',
        'effort.low': 'Low',
        'effort.medium': 'Medium',
        'effort.high': 'High',
        'effort.xhigh': 'Extra high',
        'effort.max': 'Max',
        'tag.context': 'Context',
        'tag.output': 'Max output',
        'tag.latency': 'First token',
        'tag.eacChannel': 'EAC lane · co-paid',
        'tag.new': 'NEW',
        'tag.newTitle': 'Just added: relayed to the EAC lane from OpenCode’s free tier.',
        'tag.hot': '爆',
        'tag.hotTitle': 'One of the most requested free models right now.',
        'tag.fast': 'Fast',
        'tag.fastTitle': 'Quick first token and high throughput — good for long or back-to-back turns.',
        'tag.kiloChannel': 'Kilo channel · free pool (prompts may be logged by the upstream provider — never send sensitive content)',
        'roster.noLane': 'The co-paid EAC models are unavailable in this composition: the host did not present a recognized desktop or web profile, so the lane is not loaded.',
        'section.models': 'Model roster',
        'section.modelsHint': 'Names and capacities come from the upstream roster and published capability tables; availability is measured from this machine.',
        'section.dash': 'Usage dashboard',
        'section.dashHint': 'Written to this machine only; nothing is uploaded.',
        'section.forward': 'Local forward (OpenAI compatible)',
        'section.forwardHint': 'Let other local tools reach these models through one base URL.',
        'section.egress': 'Egress outlet (subscription routing)',
        'section.egressHint': 'Send inference and probe traffic through a proxy outlet to ease per-IP rate limits.',
        'egress.enabled': 'Enable outlet',
        'egress.modeSubscription': 'Subscription mode (local mihomo picks the fastest node)',
        'egress.url': 'Subscription / proxy URL',
        'egress.urlNew': 'Replace the address',
        'egress.urlPlaceholder': 'Paste a new subscription / proxy URL (leave empty to keep the current one)',
        'egress.urlNone': 'not set',
        'egress.urlClear': 'Clear',
        'egress.urlClearWarn': 'Clear the stored subscription / proxy address and turn the outlet off',
        'egress.mihomoPath': 'mihomo path',
        'egress.mihomoHint': 'Leave empty in subscription mode to auto-locate a local mihomo (e.g. Clash Verge).',
        'egress.apply': 'Apply',
        'egress.active': 'Outlet active',
        'egress.inactive': 'Not enabled',
        'egress.outlet': 'Current outlet',
        'egress.node': 'Best node',
        'egress.latency': 'opencode access',
        'egress.measuring': 'measuring…',
        'egress.direct': 'While off, requests go direct; the address is treated as a credential — kept in this machine\'s settings only, never sent down with the regular API payloads, readable only through the reveal button, masked here by default.',
        'egress.error': 'The outlet failed to start: {message}',
        'section.prefs': 'Plugin settings',
        'section.prefsHint': 'Changes take full effect on the next load.',
        'pool.levelOk': 'Healthy',
        'pool.levelBusy': 'Busy',
        'pool.capacity': 'Pool capacity',
        'pool.levelOver': 'Overloaded',
        'pool.reach': 'Capacity in use',
        'pool.formula': '{stars} stars × 1.5',
        'pool.configured': 'configured count',
        'pool.active': '24h active',
        'pool.live': 'in flight',
        'pool.unavailable': 'Pool data unavailable · {reason}',
        'pool.reasonNoLane': 'no co-paid lane in this composition',
        'pool.reasonGateway': 'gateway answered an error',
        'pool.reasonMalformed': 'gateway data malformed',
        'pool.reasonUnreachable': 'gateway unreachable',
        'pool.reasonUnknown': 'unknown cause',
        'pool.capacityUnknown': 'star data unavailable',
        'section.eac': 'EAC lane authorization',
        'section.eacHint': 'EAC (co-paid) models need a GitHub login and a star; the free lane is unaffected.',
        'eac.pillOk': 'authorized',
        'eac.pillLocked': 'not authorized',
        'eac.pillRequired': 'enforced',
        'eac.pillCompat': 'grace period',
        'eac.pillUnknown': 'authorization policy unverified',
        'eac.pollFailed': 'Could not collect authorization ({reason}); retrying automatically. No new sign-in is needed.',
        'eac.saveFailed': 'Authorization completed, but this machine could not save it. Check DSH_HOME permissions; collection will retry automatically.',
        'eac.cancel': 'Cancel this sign-in',
        'eac.cancelFailed': 'Could not confirm cancellation. Please try again.',
        'eac.pillUnverified': 'gateway unreachable',
        'eac.intro': 'EAC turns are checked server-side: sign in with GitHub and star {repo} to unlock them. The browser does the work — nothing to paste — and removing the star revokes access automatically.',
        'eac.login': 'Sign in with GitHub',
        'eac.starting': 'Opening the browser…',
        'eac.waiting': 'The authorization page is open; if the browser did not come up, visit the address below to finish. This page confirms automatically.',
        'eac.copy': 'Copy link',
        'eac.copied': 'Copied',
        'eac.done': 'Authorized as @{login} — EAC models are unlocked.',
        'eac.needStar': 'Signed in as @{login}, but the repository is not starred yet. Star it, then press "I starred it — check again" on the authorization page.',
        'eac.expired': 'This login attempt timed out; please start again.',
        'eac.sessionExpired': 'The login link is no longer valid (the server does not know it) — please start the GitHub login again.',
        'eac.openManually': 'The browser did not open automatically — visit the address below to finish.',
        'eac.startFailed': 'Could not start the login ({reason}).',
        'eac.loggedIn': 'Authorized: @{login} · last checked {when}',
        'eac.recheck': 'Check again',
        'eac.logout': 'Sign out',
        'eac.noLane': 'The EAC co-paid lane is not unlocked in this composition, so GitHub authorization is unavailable.',
        'eac.lockedTitle': 'Needs GitHub authorization and a star',
        'eac.lockedNote': 'Not authorized: sign in with GitHub and star the repository with the button below, or from the EAC authorization section.',
        'heat.title': 'Token heatmap',
        'heat.legend': 'Less',
        'heat.legendMore': 'More',
        'heat.empty': 'No usage yet. Have one conversation and come back.',
        'curve.title': 'Cumulative tokens',
        'curve.tokens': 'Tokens',
        'curve.requests': 'Requests',
        'curve.total': 'Total',
        'stat.output': 'Output tokens',
        'stat.reasoning': 'Reasoning tokens',
        'col.reason': 'reason',
        'col.output': 'output',
        'last.title': 'Last turn',
        'last.justNow': 'just now',
        'last.minAgo': '{n} min ago',
        'last.hourAgo': '{n} h ago',
        'last.dayAgo': '{n} d ago',
        'last.input': 'input',
        'last.originChat': 'chat',
        'last.originHarness': 'desktop',
        'last.originForward': 'forward',
        'last.originBench': 'bench',
        'speed.title': 'Speed',
        'speed.tps': 'Output speed',
        'speed.ttft': 'First frame',
        'speed.model': 'Model',
        'speed.calls': 'Upstream requests',
        'speed.failed': 'Request failures',
        'speed.turns': 'Conversation turns',
        'speed.turnFailed': 'Turn failures',
        'speed.recovered': 'Recovered',
        'speed.estimated': 'Pre-upgrade history is estimated from upstream requests; turns are exact after upgrade.',
        'speed.scope': 'Requests, turns and tokens are lifetime totals; speed and first frame use the last 40 calls, the heatmap is daily.',
        'speed.none': 'No samples yet',
        'speed.note': 'Output speed covers the {n}/{total} calls it could measure: tokens never streamed out are left out of the numerator, and windows too short to time are dropped.',
        'unit.tokPerSec': 'tok/s',
        'unit.ms': 'ms',
        'forward.enabled': 'Enable the forward port',
        'forward.host': 'Bind address',
        'forward.port': 'Port',
        'forward.apply': 'Apply',
        'settings.failed': 'Settings not saved',
        'forward.running': 'Listening',
        'forward.stopped': 'Off',
        'forward.baseUrl': 'Base URL',
        'forward.key': 'API key',
        'forward.show': 'Show',
        'forward.hide': 'Hide',
        'forward.rotate': 'Regenerate',
        'forward.rotateWarn': 'Regenerating invalidates the old key for every tool using it.',
        'forward.copy': 'Copy',
        'forward.copied': 'Copied',
        'forward.example': 'Example',
        'forward.error': 'Could not start: {message}',
        'forward.notice': 'Port notice: {message}',
        'forward.lanTitle': 'Network access',
        'forward.lanHint': 'Let other devices on the same network use this forward port too. Off by default; the relay demands a key of its own.',
        'forward.lanEnabled': 'Allow network access',
        'forward.lanPort': 'Network port',
        'forward.lanAuto': '0 = pick one automatically',
        'forward.lanApply': 'Apply network settings',
        'forward.lanRunning': 'Network relay listening',
        'forward.lanStopped': 'Network relay off',
        'forward.lanError': 'Could not start the network relay: {message}',
        'forward.lanKey': 'Network key',
        'forward.lanRotateWarn': 'Regenerating makes every device on the network switch keys; tools on this machine are unaffected.',
        'forward.lanWarn': 'While this is on, anyone who can reach this machine can spend its free quota with that key. Enable it only on a network you trust, and narrow the sources with a firewall if you can.',
        'forward.lanUrl': 'Network URL',
        'forward.lanNoAddress': 'No network IPv4 address was detected',
        'forward.lanAlso': 'Also reachable at {list}',
        'pref.enabled': 'Enable free models',
        'pref.exposeRegion': 'Show region-limited models',
        'pref.hideFreeModels': 'Hide anonymous and Kilo free models',
        'pref.hideEacModels': 'Hide EAC models',
        'visibility.showModel': 'Show in model picker',
        'visibility.hidden': 'Hidden',
        'visibility.unlisted': 'Unlisted models',
        'visibility.groupHidden': 'This group is hidden. Turn off the group switch above first.',
        'visibility.hint': 'Hiding affects the model picker and gateway listing only. Existing sessions keep working; restore visibility here.',
        'routing.capacity': 'Chain capability intersection',
        'routing.capacityUnavailable': 'Cannot load chain capacities right now. Please retry.',
        'pref.interval': 'Auto-refresh interval (minutes)',
        'pref.maxTokens': 'Output ceiling per call (tokens)',
        'pref.egress': 'Current egress',
        'pref.probedAt': 'Last probe',
        'pref.measuredAt': 'Last measurement',
        'bench.run': 'Run once',
        'bench.running': 'Measuring…',
        'bench.notSaved': 'The result could not be saved. Check the data directory; it may be lost after refresh.',
        'bench.result': 'Text response passed · first frame {ttft}ms · {tps} tok/s · {reasoning} reasoning tokens',
        'ann.preamble': 'Preamble',
        'ann.models': 'Model roster',
        'ann.newlane': 'New models',
        'ann.steps': 'How to use',
        'ann.features': 'What it does',
        'ann.later': 'Later',
        'ann.page': 'Page {n} of {total}',
        'ann.openSettings': 'Open settings',
        'disclaimer.version': 'Disclaimer v{n}',
        'disclaimer.saving': 'Saving…',
        'disclaimer.reopen': 'Terms & disclaimer',
        'ann.p1': 'No credentials: install and use it — no sign-up, no API key to paste.',
        'ann.p2': 'The roster follows upstream: models, context lengths and capabilities are re-fetched on every refresh.',
        'ann.p3': 'Honest capability claims: anything a probe cannot confirm stays hidden, and each effort level is a real output budget.',
        'ann.n1': 'Two new models are live on the EAC lane, relayed from OpenCode’s free tier: DeepSeek V4.1 Flash Free and GLM 5.3 Flash Free.',
        'ann.n2': 'They lead the EAC models page, marked with a red NEW / 爆 badge and a “Fast” tag.',
        'ann.n3': 'Both expose real thinking levels (Low / High / Max), and DeepSeek can also switch thinking off; the level goes to the upstream as-is, not as a prompt hint.',
        'ann.s1': 'Pick any model under the “Our Free Model” group in the composer’s model selector.',
        'ann.s2': 'For harder reasoning, open the Effort menu — it sends a real budget, not a prompt hint.',
        'ann.s3': 'To serve other local tools: Settings → Local forward → enable, then copy the base URL and key.',
        'ann.s4': 'Region-limited models reclassify themselves once your network egress changes.',
        'ann.f1': 'Model roster: availability, context length, vision, tunable thinking.',
        'ann.f2': 'Token heatmap and cumulative curve, per total or per model.',
        'ann.f3': 'Per-call samples of output speed (tok/s) and time to first token.',
        'ann.f4': 'OpenAI-compatible forward port with a generated API key.',
        'ann.f5': 'Everything stays on this machine — no telemetry.',
        'ann.updates': 'News & upgrades',
        'ann.u1': 'Announcement center: pushes from the repository owner arrive live, with rich (HTML) layout.',
        'ann.u2': 'OS notifications: once enabled, new announcements and plugin updates raise system-level toasts.',
        'ann.u3': 'In-app upgrades: self-managed installs can update from settings; host-managed installs use their original installation method.',
        'ann.u4': 'Self-managed installs can use in-app upgrades and hot reload. For host-managed installs, update through the original installation method and reload as instructed by the host.',
        'section.news': 'Announcement center',
        'section.newsHint': 'Published by the repository owner; this page receives them live.',
        'section.upgrade': 'Plugin upgrade',
        'section.upgradeHint': 'Update according to the installation source; host-managed installs use their original installation method.',
        'upgrade.managed': 'This installation is managed by the host that installed it. Update through the original installation method; in-plugin checks, upgrades and hot reload are unavailable.',
        'news.unread': '{n} unread',
        'news.allRead': 'Mark all read',
        'news.markRead': 'Mark read',
        'news.expand': 'Show announcements',
        'news.collapse': 'Hide announcements',
        'news.refresh': 'Check for new announcements',
        'news.refreshing': 'Checking…',
        'news.empty': 'No announcements yet. Anything the owner pushes will appear here.',
        'news.emptyHint': 'Announcements support rich layout and are published by editing the plugin repository.',
        'news.osEnable': 'Enable OS notifications',
        'news.osOn': 'OS notifications on',
        'news.osOff': 'OS notifications off',
        'news.osDenied': 'Notification permission was denied; restore it in your system or browser settings.',
        'news.link': 'Read more',
        'news.urgentTitle': 'Important announcement',
        'news.gotIt': 'Got it',
        'news.lastFetch': 'Last fetch',
        'news.fetchFailed': 'Feed unreachable right now (showing the cached copy)',
        'level.info': 'Notice',
        'level.update': 'Update',
        'level.warn': 'Heads-up',
        'level.urgent': 'Urgent',
        'upgrade.current': 'Running',
        'upgrade.installed': 'On disk',
        'upgrade.mismatch': 'The running and on-disk versions differ. Check the installation before reloading or restarting.',
        'upgrade.restartHint': 'This host cannot safely hot-reload the plugin. Updates are installed safely and take effect after restarting the host application.',
        'upgrade.restart': 'Upgraded to {version}. The files are installed safely; restart the host application to activate them.',
        'upgrade.recovery': 'The last upgrade was not fully restored. Close the app, restore the installation from the retained backup, restart, then check for updates.',
        'upgrade.backup': 'Recovery backup',
        'upgrade.latest': 'Latest',
        'upgrade.checkedAt': 'Last check',
        'upgrade.never': 'never',
        'upgrade.check': 'Check for updates',
        'upgrade.star': 'Star on GitHub',
        'upgrade.checking': 'Checking…',
        'upgrade.upToDate': 'Up to date',
        'upgrade.available': 'Upgrade to {version} available',
        'upgrade.apply': 'Upgrade now',
        'upgrade.applying': 'Upgrading…',
        'upgrade.phase.download': 'Downloading the new version…',
        'upgrade.phase.install': 'Installing files…',
        'upgrade.phase.reload': 'Hot-reloading…',
        'upgrade.done': 'Upgraded to {version}; the plugin hot-reloaded into place.',
        'upgrade.doneRefresh': 'Upgraded to {version}. Reload the page to load the new UI.',
        'upgrade.failed': 'Upgrade failed: {message}',
        'upgrade.history': 'Last upgrade',
        'upgrade.from': 'from {from}',
        'upgrade.notes': 'Release notes',
        'upgrade.auto': 'Auto-check: every {n} h',
        'upgrade.autoOff': 'Auto-check off',
        'reload.now': 'Hot-reload plugin',
        'reload.reloading': 'Reloading…',
        'reload.done': 'Plugin hot-reloaded (#{n}).',
        'reload.refresh': 'Reload page',
        'reload.auto': 'Hot-reload on file change',
        'toast.annTitle': 'New announcement',
        'toast.updateTitle': 'Plugin update available',
        'toast.updateBody': 'Version {latest} is out (installed {current}). Upgrade from the settings page.',
        'nav.tab.free': 'Free models',
        'nav.tab.eac': 'EAC models',
        'nav.tab.channels': 'EAC router',
        'nav.tab.picks': 'Picks',
        'star.cta': 'Star',
        'star.title': 'Star this repository on GitHub',
        'picks.title': 'Recommended projects',
        'picks.sub': 'A set of open-source projects by the same author: bringing the agent to a native desktop, keeping hundreds of plugins working together, and keeping video and design work on this machine. If they are useful, a star is the thanks they understand.',
        'picks.foot': 'A star is the only payslip an open-source project gets — it decides how much more time the author can spend. Every project here is free, open source and ad-free; one click is the most concrete support there is.',
        'picks.stars': 'Stars',
        'picks.forks': 'Forks',
        'picks.fork': 'Fork',
        'picks.totalStars': '{n} stars across {c} projects',
        'picks.updated': 'Last push',
        'picks.stale': 'cached',
        'picks.liveFailed': 'GitHub numbers are unreachable right now; they will fill in later — the links below are unaffected.',
        'picks.getDesktop': 'Download',
        'picks.getPack': 'Install guide',
        'picks.getDesign': 'Install guide',
        'picks.star': 'Star it',
        'picks.starHint': 'Open GitHub and star',
        'picks.desktop.badge': 'Desktop workbench',
        'picks.desktop.tagline': 'Agent capability, organized into a desktop that actually works.',
        'picks.desktop.body': 'An open-source desktop workbench built on DeepSeek Harness: a Tauri native window with Node bundled in, so a double-click lands you in the work. Project files, session changes, a plugin catalog and a skin market in one place — with installers for Windows, Linux and macOS.',
        'picks.desktop.tag1': 'Tauri native window',
        'picks.desktop.tag2': 'Bundled runtime',
        'picks.desktop.tag3': 'File changes & revert',
        'picks.desktop.tag4': 'Plugin market & skins',
        'picks.pack.badge': 'Plugin suite',
        'picks.pack.tagline': 'Embracing all creation: hundreds of DSH plugins, living together.',
        'picks.pack.body': 'A catalog, batch install, update and removal manager for DSH Desktop, carrying 72 baseline sub-plugins, skin previews and prompt sets; a pinned digest manifest verifies every byte, so an install is complete and trustworthy.',
        'picks.pack.tag1': '72 baseline plugins',
        'picks.pack.tag2': 'Batch install / update',
        'picks.pack.tag3': 'Skin previews',
        'picks.pack.tag4': 'Digest verification',
        'picks.design.badge': 'Design workbench',
        'picks.design.tagline': 'Finish video and design work locally, without handing your footage to anyone.',
        'picks.design.body': 'A local video-production and design plugin for DeepSeek Harness: multi-track editing, templates and a design system, a native preview canvas, and exports that are real files. The whole pipeline runs on this machine, so footage and projects stay on your own disk.',
        'picks.design.tag1': 'Multi-track editing',
        'picks.design.tag2': 'Templates & design system',
        'picks.design.tag3': 'Native preview canvas',
        'picks.design.tag4': 'Real file export',
        'free.title': 'Free models',
        'free.sub': 'Anonymous free and Kilo models share this pool. Water shows the selectable share; measured availability is shown separately.',
        'sponsor.bannerTag': 'Relay',
        'sponsor.bannerTitle': 'Beichen API relay',
        'sponsor.bannerDescription': 'OFM’s official relay partner provides stable, open and cost-effective model API access. Claude, ChatGPT, Grok, Gemini, GLM, Kimi and DeepSeek are supported for one consistent setup in Codex, Gemini CLI, Claude Code and other developer tools. Invite others to receive 10% cashback.',
        'sponsor.bannerCta': 'View now',
        'free.tankLabel': 'Selectable free-pool models',
        'free.tankNote': 'Water = unblocked candidates / total ({selectable}/{total}); untested models remain candidates, not verified successes.',
        'free.tankEmpty': 'No models have been discovered in this free pool.',
        'free.statHint': 'The five status counts add up to all anonymous free and Kilo models ({total}); listed but untested models are counted as not probed.',
        'free.sources': 'Anonymous free {anonymous} · Kilo {kilo}',
        'eac.title': 'EAC models',
        'eac.sub': 'The desktop co-paid lane: unlocked by a GitHub login plus a star, independent of the free lane.',
        'eac.tankLabel': 'Co-paid pool pressure',
        'chan.title': 'EAC router',
        'chan.sub': 'Account channels',
        'chan.search': 'Search channel, vendor or ID',
        'chan.filterStatus': 'Connection status',
        'chan.filterAll': 'All',
        'chan.filterEmpty': 'No channel matches the filters.',
        'chan.showing': '{shown} / {total} channels',
        'chan.connect': 'Connect',
        'chan.manage': 'Manage',
        'chan.collapse': 'Collapse',
        'chan.state.loading': 'Loading',
        'chan.pack.failed': 'Channel pack not mounted: {reason} (the free and EAC lanes are unaffected)',
        'chan.pack.hint': 'The pack ships inside this plugin (vendor/channel-pack) and upgrades with it.',
        'chan.state.on': 'Connected',
        'chan.state.off': 'Not connected',
        'chan.state.closed': 'Turned off',
        'chan.meta.accounts': 'Accounts',
        'chan.meta.models': 'Models',
        'chan.act.add': 'Add account',
        'chan.zcode.provider': 'Sign-in route',
        'chan.zcode.bigmodel': 'bigmodel.cn',
        'chan.zcode.zai': 'z.ai international',
        'chan.act.refresh': 'Refresh',
        'chan.act.test': 'Test',
        'chan.act.delete': 'Remove',
        'chan.act.claim': 'Claim daily',
        'chan.fold.accounts': 'Accounts',
        'chan.fold.models': 'Models',
        'chan.noAccount': 'No account yet — press “Add account” to sign in.',
        'chan.enabled': 'Enabled',
        'chan.act.enable': 'Enable',
        'chan.act.disable': 'Disable',
        'chan.expires.never': 'Long-lived',
        'chan.disabled': 'Disabled',
        'chan.login.title': 'Sign in to {name}',
        'chan.login.step1': 'Finish the sign-in in your browser (if it did not open, use the button below).',
        'chan.login.step2': 'This page completes by itself once the browser flow does — nothing to copy.',
        'chan.login.open': 'Open sign-in page',
        'chan.login.cancel': 'Cancel',
        'chan.login.waiting': 'Sign-in page opened; waiting for authorization… (up to 10 minutes)',
        'chan.login.expired': 'Timed out — please start the sign-in again.',
        'chan.login.done': 'Connected: {login}',
        'chan.login.failed': 'Sign-in did not complete: {reason}',
        'chan.test.ok': 'Connection healthy ({ms} ms)',
        'chan.test.failed': 'Test failed: {reason}',
        'chan.claim.result': 'Claimed for {count} account(s), {credit} credits in total.',
        'chan.claim.none': 'Nothing to claim today.',
        'chan.credit.today': '{credit} claimed today',
        'chan.model.free': 'Free quota',
        'chan.model.dead': 'Retired',
        'chan.model.hidden': 'Hidden',
        'chan.model.restore': 'Restore visibility',
        'chan.model.off': 'Hide',
        'chan.model.on': 'Show',
        'chan.model.enableAll': 'Show all',
        'chan.model.disableAll': 'Hide all',
        'chan.model.enabledCount': 'Shown {enabled}/{total}',
        'chan.model.allScope': 'Apply to all models in this channel only',
        'chan.error': 'Action failed: {reason}',
        'chan.confirm.delete': 'Remove account {name}? Its credential is deleted with it.',
        'chan.rpc.unavailable': 'This host exposes no connection service, so channel actions are unavailable.',
        'nav.tab.ledger': 'Dashboard',
        'nav.tab.logs': 'Request log',
        'nav.tab.gateway': 'Gateway',
        'nav.tab.upgrade': 'Plugin upgrade',
        'chan.titleSingle': 'Channel',
        'dash.title': 'Usage dashboard',
        'dash.sub': 'Token spend and inference metrics for the channel models: input/output/reasoning/cache, pivoted by account and by model.',
        'dash.today': 'Today',
        'dash.all': 'All time',
        'dash.refresh': 'Refresh',
        'dash.kpiToday': 'Tokens today',
        'dash.kpiScopeAll': 'Tokens in scope',
        'dash.kpiCumulative': 'Tokens all time',
        'dash.kpiSpeed': 'Average speed',
        'dash.kpiCache': 'Context cache hit rate',
        'dash.kpiRequests': 'Requests & success rate',
        'dash.input': 'Input',
        'dash.output': 'Output',
        'dash.reasoning': 'Reasoning',
        'dash.ttft': 'TTFT',
        'dash.cacheTokens': 'Cache hits',
        'dash.successRate': 'Success',
        'dash.failed': 'Failed',
        'dash.recentTitle': 'Overview · Recent requests',
        'dash.recentHint': 'From the pack\'s per-request ledger: time, account, TTFT, speed and the token breakdown.',
        'dash.empty': 'Nothing yet — one conversation through a channel model starts the record.',
        'dash.accountsTitle': 'Per-account usage & model mix',
        'dash.accountsHint': 'Requests and token breakdown per account, with the most-used models.',
        'dash.modelsTitle': 'Model performance & usage',
        'dash.modelsHint': 'TTFT, speed and token statistics per model · usage share is by tokens spent.',
        'log.time': 'Time',
        'log.model': 'Model',
        'log.account': 'Account',
        'log.via': 'Via',
        'log.viaDirect': 'Chat',
        'log.viaGateway': 'Gateway',
        'log.result': 'Result',
        'log.ok': 'OK',
        'log.failed': 'Failed',
        'log.duration': 'Duration',
        'log.ttft': 'TTFT',
        'log.speed': 'Speed',
        'log.input': 'Input',
        'log.output': 'Output',
        'log.reasoning': 'Reasoning',
        'log.cache': 'Cache',
        'log.total': 'Total tok',
        'log.requests': 'Requests',
        'log.inputSlash': 'Input / Output / Reasoning',
        'log.cacheHit': 'Cache hit',
        'log.share': 'Share',
        'log.modelMix': 'Model mix',
        'log.unattributed': 'Unattributed',
        'logs.title': 'Request log',
        'logs.sub': 'Every request in detail: result, duration, TTFT, speed and the token breakdown; hover a failed row for the reason.',
        'logs.auto': 'Refresh every 10 s',
        'logs.count': '{total} entries · {shown} on this page',
        'logs.empty': 'No requests recorded yet.',
        'logs.page': 'Page {page} of {pages}',
        'logs.windowNote': 'Per-request rows cover a recent window only; history is kept as daily aggregates (~90 days) — the dashboard\'s "All time" reads those.',
        'gw.title': 'Gateway settings',
        'gw.sub': 'Serve the channel models over an OpenAI-compatible API to this machine and the LAN: endpoint, key and relay port live here.',
        'gw.gatewayTitle': 'Channel gateway (OpenAI compatible)',
        'gw.gatewayHint': 'Covers every connected channel; Chat Completions and Responses are both served.',
        'gw.running': 'Running',
        'gw.stopped': 'Not running',
        'gw.envBlocked': 'Disabled by environment',
        'gw.switch': 'Enable gateway',
        'gw.endpoint': 'Endpoint',
        'gw.key': 'API Key',
        'gw.show': 'Show',
        'gw.hide': 'Hide',
        'gw.keyNote': 'A plaintext credential for client configuration — handle with care.',
        'gw.keyNone': 'Not generated yet',
        'gw.keyNoneHint': 'Enabling the gateway once mints a key automatically.',
        'gw.models': 'Servable models',
        'gw.portNote': 'The port can be moved with the DSH_OPENAI_GATEWAY_PORT environment variable.',
        'gw.relayTitle': 'LAN relay (this plugin\'s)',
        'gw.relayHint': 'Re-expose the gateway on an address and port you choose: callers use the relay key below, and the gateway itself stays on the loopback.',
        'gw.relaySwitch': 'Enable LAN relay',
        'gw.relayBind': 'Bind address',
        'gw.bindLocal': 'This machine only (127.0.0.1)',
        'gw.bindLan': 'LAN (0.0.0.0)',
        'gw.relayPort': 'Port',
        'gw.relayUrl': 'Base URL',
        'gw.relayKey': 'Relay key',
        'gw.rotate': 'Rotate',
        'gw.relayNote': 'The relay forwards only the model routes (/v1/*) and demands the relay key; binding to the LAN means every device on the network can reach that port.',
        'gw.freeLaneNote': 'The free lane (Our Free Model) has its own forward port under "Local forward" on the Free models page.',
        'chan.credits.left': 'Credits left',
        'chan.credits.tokens': 'Tokens left',
        'chan.credits.dollars': 'Balance left (USD)',
        'chan.credits.quota': 'Quota left',
        'chan.credits.loaded': '{count} accounts queried',
        'chan.credits.refresh': 'Refresh balance',
        'chan.credits.loading': 'Querying balance…',
        'chan.credits.failed': 'Balance query failed: {reason}',
        'chan.credits.partial': 'Could not query {count} accounts. Expand accounts to see the reasons and retry.',
        'chan.credits.unavailable': 'No balance data returned',
        'chan.claim.failed': 'Claim failed: {reason}',
        'chan.auto.title': 'Daily auto check-in',
        'chan.auto.running': 'Check-in running…',
        'chan.auto.ran': 'Checked in today',
        'chan.auto.off': 'Not checked in today',
        'chan.auto.last': 'Last result: {result}',
        'nav.tab.aggregate': 'Aggregate',
        'nav.tab.workspace': 'Model workspace',
        'engine.start': 'Open workspace',
        'engine.starting': 'Starting workspace…',
        'engine.failed': 'Workspace could not start',
        'engine.title': 'Model workspace',
        'engine.refresh': 'Refresh models',
        'engine.expand': 'Expand workspace',
        'engine.close': 'Collapse workspace',
        'engine.tools': 'Workbench',
        'engine.settings': 'Workspace settings',
        'sub.title': 'Subscriptions',
        'sub.add': 'Import account',
        'sub.discover': 'Find local accounts',
        'sub.candidates': 'Local sign-ins',
        'sub.noCandidates': 'No local sign-ins available to import.',
        'sub.review': 'Select for import',
        'sub.empty': 'No subscription accounts imported.',
        'sub.provider': 'Provider',
        'sub.label': 'Account label',
        'sub.models': 'Model IDs',
        'sub.credentials': 'Credentials JSON',
        'sub.file': 'Credentials file',
        'sub.paste': 'Paste JSON',
        'sub.upload': 'Choose file',
        'sub.key': 'API Key',
        'sub.baseUrl': 'Base URL',
        'sub.format': 'API format',
        'sub.import': 'Confirm import',
        'sub.cancel': 'Cancel',
        'sub.working': 'Working…',
        'sub.invalidJson': 'Credentials must be a valid JSON object.',
        'sub.fileTooLarge': 'Credentials file must be 1 MB or smaller.',
        'sub.fileFailed': 'Could not read credentials file.',
        'sub.invalidEndpoint': 'Enter an HTTP(S) address without userinfo, query parameters or a fragment.',
        'sub.keyRequired': 'Enter an API key.',
        'sub.invalidModels': 'Enter valid model IDs separated by commas or newlines.',
        'sub.loadFailed': 'Could not load subscription accounts',
        'sub.operationFailed': 'Operation failed. Please retry.',
        'sub.enabled': 'Enable account',
        'sub.refreshQuota': 'Refresh quotas',
        'sub.remove': 'Remove',
        'sub.confirmRemove': 'Confirm removal',
        'sub.removeQuestion': 'Remove this account and its saved credentials?',
        'sub.unknown': 'Unknown',
        'sub.quotaFailed': 'Quota query failed',
        'sub.fiveHour': '5 hours',
        'sub.weekly': 'Weekly',
        'sub.used': '{n}% used',
        'sub.remaining': '{n}% remaining',
        'sub.resets': 'Resets',
        'sub.checked': 'Checked',
        'sub.plan': 'Plan',
        'sub.balance': 'Balance',
        'sub.credits': 'credits',
        'sub.unlimited': 'Unlimited',
        'sub.noModels': 'No models specified',
        'sub.accounts': '{n} accounts',
        'nav.tab.saver': 'Token savers',
        'nav.tab.routing': 'Routing',
        'agg.title': 'Aggregate providers',
        'agg.sub': 'Third-party providers',
        'agg.registryCount': '{n} in the registry',
        'agg.configuredCount': '{n} configured',
        'agg.addProvider': 'Add provider',
        'agg.addTitle': 'Choose a provider',
        'agg.addHint': 'Filter by category, wire format and auth kind. A provider marked "not drivable" needs an interactive login or cloud credentials, and this lane never calls it.',
        'agg.search': 'Search name or id',
        'agg.filterCategory': 'Category',
        'agg.filterFormat': 'Format',
        'agg.filterAuth': 'Auth',
        'agg.filterAll': 'All',
        'agg.showing': 'Showing {shown} of {total}',
        'agg.noMatch': 'No provider matches.',
        'agg.notUsable': 'Not drivable',
        'agg.notUsableWhy': 'This lane never calls it: its auth kind is "{kind}", which needs an interactive login or cloud-side credentials, so only the host can take it over.',
        'agg.credential': 'Get a key',
        'agg.modelCount': '{n} models',
        'agg.select': 'Configure',
        'agg.configuredTitle': 'Provider directory',
        'agg.configuredHint': 'Changes take effect immediately: saving updates the roster and the model picker together.',
        'agg.configured': 'Configured',
        'agg.unconfigured': 'Not connected',
        'agg.connect': 'Connect',
        'agg.manage': 'Manage',
        'agg.empty': 'No aggregate provider is connected yet',
        'agg.emptyHint': 'This page brings third-party endpoints into the model roster: an aggregator, a free-tier pool, a local inference server. Fill in a key and an optional base URL and their models appear in the model picker — and can become a link in a fallback chain.',
        'agg.filterEmpty': 'No provider matches the filters.',
        'agg.contributes': 'Contributes {n} models',
        'agg.contributesNone': 'Contributes no model right now',
        'agg.hasKey': 'Key {hint}',
        'agg.noKey': 'No key stored',
        'agg.enabled': 'Enabled',
        'agg.disabled': 'Disabled',
        'agg.key': 'API key',
        'agg.keyPlaceholder': 'Paste a new API key (leave empty to keep the current one)',
        'agg.keyKeep': 'Empty keeps the stored key; use the clear button below to delete it.',
        'agg.keyClear': 'Clear the stored key',
        'agg.keyClearWarn': 'Clearing it stops this provider from contributing models until a key is entered again.',
        'agg.baseUrl': 'Base URL',
        'agg.baseUrlHint': 'Empty uses the registry default.',
        'agg.baseUrlDefault': 'Registry default: {url}',
        'agg.baseUrlEnv': 'Can also be overridden by the {env} environment variable',
        'agg.models': 'Model override',
        'agg.modelsHint': 'Model ids separated by commas or newlines; empty uses the list the provider declares.',
        'agg.modelsPlaceholder': 'model-a, model-b',
        'agg.test': 'Test',
        'agg.testing': 'Testing…',
        'agg.testOk': 'Verified',
        'agg.testFailed': 'Failed',
        'agg.testUnverified': 'Not verifiable',
        'agg.testUnverifiedWhy': 'This provider declares no model listing, so verifying it would cost one real generation — not done here.',
        'agg.testAt': 'Last test {when}',
        'agg.neverTested': 'Not tested yet',
        'agg.discover': 'Discover models',
        'agg.discovering': 'Discovering…',
        'agg.discovered': 'Found {n} models',
        'agg.discoveredNone': 'This provider declares no model listing.',
        'agg.discoveredUse': 'Use these as the override',
        'agg.save': 'Save',
        'agg.saving': 'Saving…',
        'agg.add': 'Add',
        'agg.remove': 'Remove',
        'agg.removeConfirm': 'Confirm removal',
        'agg.removeWarn': 'Removing it drops its models from the roster immediately and deletes the stored key.',
        'agg.cancel': 'Cancel',
        'agg.saved': 'Saved',
        'agg.savedBody': 'The configuration for {name} is saved.',
        'agg.removedBody': '{name} was removed.',
        'agg.failed': 'Action failed',
        'agg.loadFailed': 'Cannot read the provider registry',
        'agg.category.apikey': 'API key',
        'agg.category.free': 'Fully free',
        'agg.category.freeTier': 'Free tier',
        'agg.category.local': 'Local',
        'agg.category.oauth': 'OAuth',
        'agg.auth.apiKey': 'API key',
        'agg.auth.none': 'No auth',
        'agg.auth.oauth': 'OAuth login',
        'agg.auth.adc': 'Cloud credentials',
        'saver.title': 'Token savers',
        'saver.sub': 'Compact a request before it leaves this machine: tool output re-encoded, the prompt slimmed, and five answers produced locally without an upstream call.',
        'saver.master': 'Enable token compaction',
        'saver.masterHint': 'Turning this off stops every saver at once and sends requests as written; the settings below are kept.',
        'saver.rtk': 'RTK tool-output compaction',
        'saver.rtkWhat': 'What it compacts: tool results — git diff / status / log, grep, find, ls, tree, build logs, numbered file dumps and duplicate log lines.',
        'saver.rtkSafety': 'Safety rules: an error result is left untouched, small bodies are not touched, and a blob is replaced only when the new text is non-empty and strictly smaller — a compacted result is never larger than the original.',
        'saver.promptTitle': 'Prompt shaping',
        'saver.promptHint': 'Appends a writing instruction to the system prompt. It is the only saver that can cut output tokens, because it changes what the model writes.',
        'saver.caveman': 'Caveman',
        'saver.cavemanWhat': 'Terse replies: pleasantries and repeated explanation dropped, conclusions and code kept.',
        'saver.ponytail': 'Ponytail',
        'saver.ponytailWhat': 'YAGNI-minimal replies: only the one thing that was asked for, no unrequested abstraction, config or fallback.',
        'saver.voiceWarn': 'Heads-up: both families change how the assistant talks, and that lands in your transcript. Off by default.',
        'saver.localTitle': 'Local answers',
        'saver.localHint': 'The answer to these five requests is already in the request body; forwarding one spends a round trip and upstream quota on a question with one right answer.',
        'saver.local.enabled': 'Enable local answers',
        'saver.local.quota': 'Quota probe',
        'saver.local.quotaHint': 'Answers a "quota check" probe with a fixed line.',
        'saver.local.prefix': 'Command prefix',
        'saver.local.prefixHint': 'Answers the command prefix behind a permission prompt, parsed from the shell command.',
        'saver.local.title': 'Session title',
        'saver.local.titleHint': 'Answers a title-generation request with a fixed title.',
        'saver.local.suggestion': 'Suggestion mode',
        'saver.local.suggestionHint': 'Answers a suggestion-mode turn without producing an upstream request.',
        'saver.local.filepath': 'Filepath extraction',
        'saver.local.filepathHint': 'Parses the file paths out of a command and its output, and returns them structured.',
        'saver.dashTitle': 'Savings',
        'saver.dashHint': 'Bytes actually compacted on this machine, written locally only.',
        'saver.bytesBefore': 'Before',
        'saver.bytesAfter': 'After',
        'saver.bytesSaved': 'Bytes saved',
        'saver.percent': 'Saved',
        'saver.blocks': 'Blocks compacted',
        'saver.calls': 'Calls measured',
        'saver.promptCalls': 'Prompts shaped',
        'saver.noData': 'No request measured yet. One conversation later, this shows real compacted bytes rather than an estimate.',
        'saver.report': 'Reported as',
        'saver.saved': 'Saved',
        'saver.savedBody': 'The token-saver settings are saved.',
        'saver.failed': 'Not saved',
        'saver.loadFailed': 'Cannot read the token-saver settings',
        'saver.level.off': 'Off',
        'saver.level.lite': 'Lite',
        'saver.level.full': 'Full',
        'saver.level.ultra': 'Ultra',
        'saver.level.wenyanLite': 'Classical · lite',
        'saver.level.wenyan': 'Classical',
        'saver.level.wenyanUltra': 'Classical · ultra',
        'routing.title': 'Routing',
        'routing.sub': 'Chain several models into one fallback chain: when a link refuses, the next one answers, and the caller still sees a single model id.',
        'routing.chains': 'Stored chains',
        'routing.chainsHint': 'Chains are stored in the order you entered them; a chain that references a model which is unavailable right now is kept as written and comes back by itself when the lane does.',
        'routing.empty': 'No fallback chain yet',
        'routing.emptyHint': 'A chain is a virtual model: pick it in the model picker and the request tries each real model on the chain in order. Use one to cover the hours when a lane is down.',
        'routing.newChain': 'New chain',
        'routing.name': 'Name',
        'routing.namePlaceholder': 'e.g. free first, co-paid second',
        'routing.strategy': 'Strategy',
        'routing.strategy.fallback': 'Fallback',
        'routing.strategy.roundRobin': 'Round-robin',
        'routing.strategy.smart': 'Quota reset priority',
        'routing.strategy.usage': 'Least used',
        'routing.strategy.pace': 'Weekly quota pace',
        'routing.stickyLimit': 'Round-robin sticky limit',
        'routing.stickyHint': 'How many calls in a row one model serves before the rotation moves on.',
        'routing.members': 'Members (in order)',
        'routing.addMember': 'Add member',
        'routing.memberEmpty': 'No member yet — press "Add member" to pick one from the roster.',
        'routing.moveUp': 'Move up',
        'routing.moveDown': 'Move down',
        'routing.removeMember': 'Remove',
        'routing.pickModel': 'Pick a model',
        'routing.searchModel': 'Search model id or name',
        'routing.noModel': 'No model matches.',
        'routing.usable': 'Usable',
        'routing.notUsable': 'Not usable now',
        'routing.missing': 'Members not in the roster: {ids}',
        'routing.notUsableWhy': 'The chain is stored as written and is never rewritten because a lane is closed today; it comes back by itself once those ids are in the roster again. If an id is a typo, edit the chain and fix it.',
        'routing.resolved': 'Resolves to',
        'routing.memberCount': '{n} members',
        'routing.save': 'Save chain',
        'routing.saved': 'Saved',
        'routing.savedBody': 'The chain is saved.',
        'routing.failed': 'Not saved',
        'routing.loadFailed': 'Cannot read the chain settings',
        'routing.cancel': 'Cancel',
        'routing.edit': 'Edit',
        'routing.delete': 'Delete',
        'routing.deleteConfirm': 'Confirm delete',
        'routing.deleteWarn': 'Deleting it drops this model id from the roster immediately; a client still pointing at it gets a 404.',
        'routing.enabled': 'Enabled',
        'routing.channel.free': 'Free lane',
        'routing.channel.eac': 'EAC co-paid',
        'routing.channel.kilo': 'Kilo',
        'routing.channel.aggregate': 'Aggregate',
        'routing.channel.combo': 'Chain',
        'gw.clientsTitle': 'Connect a client',
        'gw.clientsHint': 'How the free lane\'s forward port (enabled under "Local forward" on the Free models page) plugs into each client: addresses and keys below are generated from the port that actually bound and the real key.',
        'gw.clientsOff': 'The forward port is off',
        'gw.clientsOffHint': 'Enable it under "Local forward" on the Free models page first; only then does this section have a usable address and recipes.',
        'gw.clientsModels': '{n} servable models',
      },
    }

    // ── styles ────────────────────────────────────────────────────────────────
    // Two theme variables are not defined by every shell — measured in the web
    // shell this plugin ships against, `--dsw-alias-state-warning-primary` and
    // `--dsw-alias-label-on-accent` resolve to nothing. A declaration whose
    // var() is invalid at computed-value time is dropped *whole*, so without a
    // fallback every warning-coloured surface disappears: the pool tank's water
    // (level "busy") rendered as an empty box, the region-limited badge lost its
    // colour, callouts lost their border. Every use of those two names carries a
    // fallback for exactly that reason.
    const CSS = `
/* ═══════════════════════════════════════════════════════════════════════
   Our Free Model — visual system
   统一令牌：所有色值取自宿主 --dsw-alias-* 变量，昼夜由宿主切换。
   层级约定：layer-3 凹槽/页面底 · layer-2 面板 · layer-1 浮起元素。
   动效约定：transform/opacity 优先；常规 150–300ms、覆盖层 300–400ms。
   ═══════════════════════════════════════════════════════════════════════ */
.ofm_root{--ease-instrument:cubic-bezier(.16,1,.3,1);--ease-settle:cubic-bezier(.34,1.4,.4,1);--gap:14px;display:flex;flex-direction:column;gap:calc(var(--gap)*1.4);max-width:1080px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
.ofm_root::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.022;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='180' height='180' filter='url(%23n)'/%3E%3C/svg%3E")}
.ofm_root>*{position:relative;z-index:1}
.ofm_root *{box-sizing:border-box}
.ofm_root ::-webkit-scrollbar{width:10px;height:10px}
.ofm_root ::-webkit-scrollbar-track{background:transparent}
.ofm_root ::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 32%,transparent);border-radius:99px;border:2.5px solid transparent;background-clip:padding-box}
.ofm_root ::-webkit-scrollbar-thumb:hover{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 52%,transparent);background-clip:padding-box;border:2.5px solid transparent}
.ofm_root{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 32%,transparent) transparent}

.ofm_root ::selection{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent)}
/* ── 键盘可达性：只给键盘聚焦画聚焦环，鼠标点击不出现 ─────────────────── */
.ofm_root :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,transparent);outline-offset:2px;box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent)}
/* ══ 页头 hero ═════════════════════════════════════════════════════════ */
.ofm_hero{position:relative;display:flex;flex-direction:column;gap:14px;padding:22px 24px;border-radius:20px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 88%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent));overflow:hidden}
.ofm_hero::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 150% at 12% -20%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent),transparent 58%),radial-gradient(90% 120% at 88% 130%,color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent),transparent 60%)}
.ofm_hero>*{position:relative}
.ofm_pagehead{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.ofm_pagetitle{display:flex;flex-direction:column;gap:6px;min-width:0}
.ofm_pagetitle h2{margin:0;font-size:23px;font-weight:760;letter-spacing:-.6px;line-height:1.2;background:linear-gradient(120deg,var(--dsw-alias-label-primary) 20%,color-mix(in srgb,var(--dsw-alias-label-primary) 55%,var(--dsw-alias-state-business-primary)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ofm_pagesub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:70ch}
.ofm_pagehead .ofm_pills{margin-left:auto}
.ofm_pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.ofm_pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;transition:border-color .16s ease,color .16s ease}
.ofm_pill.strong{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ofm_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
@keyframes ofm-dot-breathe{0%,100%{opacity:1}50%{opacity:.55}}
.ofm_dot.ok{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);animation:ofm-dot-breathe 2.6s ease-in-out infinite}
.ofm_dot.warn{background:var(--dsw-alias-state-warning-primary,#f0a441);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 18%,transparent)}
.ofm_dot.err{background:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}
/* ══ 区块与分节 ════════════════════════════════════════════════════════ */
.ofm_sec{display:flex;flex-direction:column;gap:10px}
.ofm_sechead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ofm_sec_title{font-size:14px;font-weight:680;letter-spacing:-.2px}
.ofm_sec_hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.ofm_grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(252px,1fr));gap:10px}
/* ══ 卡片（双层 bezel：hairline 边框 + 顶部内高光 + 柔和外阴影） ═══════ */
.ofm_card{position:relative;display:flex;flex-direction:column;gap:8px;padding:12px 13px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 80%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 1px 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent),0 3px 10px color-mix(in srgb,var(--dsw-alias-state-business-primary) 4%,transparent);transition:transform .2s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .18s ease}
.ofm_card:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 66%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 9%),0 16px 34px color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.ofm_card.dim{opacity:.68}
.ofm_cardhead{display:flex;align-items:center;gap:8px}
.ofm_cardname{font-size:13.5px;font-weight:650;letter-spacing:-.1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_badge{margin-left:auto;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);white-space:nowrap}
.ofm_badge.available{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.ofm_badge.region-blocked{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 10%,transparent)}
.ofm_badge.throttled,.ofm_badge.unavailable{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.ofm_badge.unknown{color:var(--dsw-alias-label-tertiary)}
.ofm_id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_tags{display:flex;gap:5px;flex-wrap:wrap}
.ofm_tag{font-size:10.5px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.ofm_chantag{font-size:10px;font-weight:650;padding:2px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent);color:var(--dsw-alias-state-business-primary);white-space:nowrap}
/* ══ 新品/热门徽标与高速标签（置顶的 opencode 免费模型） ═════════════════ */
.ofm_newtag{flex:none;font-size:9.5px;font-weight:750;letter-spacing:.4px;padding:2px 7px;border-radius:999px;color:#fff;background:var(--dsw-alias-state-error-primary);box-shadow:0 1px 4px color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);white-space:nowrap;text-transform:uppercase}
.ofm_hottag{flex:none;font-size:10px;font-weight:700;line-height:1;padding:2px 6px;border-radius:999px;color:#fff;background:var(--dsw-alias-state-error-primary);box-shadow:0 1px 4px color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);white-space:nowrap}
.ofm_tag.fast{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);font-weight:650}
.ofm_card.pinned{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 2px 6px color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent),0 6px 18px color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.ofm_card.pinned:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 62%,var(--dsw-alias-border-l2))}
.ofm_metrics{display:flex;gap:12px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.ofm_metrics b{color:var(--dsw-alias-label-secondary);font-weight:600;font-variant-numeric:tabular-nums}
.ofm_note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
/* ══ 面板 ══════════════════════════════════════════════════════════════ */
.ofm_panel{padding:16px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 2px 6px rgb(0 0 0 / 4%);display:flex;flex-direction:column;gap:12px}
.ofm_paneltitle{font-size:12px;font-weight:680;letter-spacing:.2px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;gap:8px}
.ofm_paneltitle .ofm_sec_hint{font-weight:400;letter-spacing:0}
.ofm_row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
/* ══ 请求热度图 ════════════════════════════════════════════════════════ */
.ofm_heat{display:grid;grid-auto-flow:column;grid-auto-columns:12px;grid-template-rows:repeat(7,12px);justify-content:start;gap:2px;overflow-x:auto;padding:2px 0 6px}
.ofm_cell{width:12px;height:12px;border-radius:3.5px;background:var(--dsw-alias-bg-layer-1);outline:1px solid var(--dsw-alias-border-l1);outline-offset:-1px;transition:transform .14s ease,background .3s ease}
.ofm_cell:hover{transform:scale(1.25)}
.ofm_cell.l1{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent);outline-color:transparent}
.ofm_cell.l2{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);outline-color:transparent}
.ofm_cell.l3{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 68%,transparent);outline-color:transparent}
.ofm_cell.l4{background:var(--dsw-alias-state-business-primary);outline-color:transparent}
.ofm_scale{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.ofm_scale .ofm_cell{width:10px;height:10px}
/* ══ 分段选择器 ════════════════════════════════════════════════════════ */
.ofm_seg{display:inline-flex;padding:3px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);gap:2px;box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%)}
.ofm_seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:550;padding:3px 11px;border-radius:8px;cursor:pointer;transition:color .16s ease,background .16s ease,box-shadow .16s ease}
.ofm_seg button:hover{color:var(--dsw-alias-label-primary)}
.ofm_seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px rgb(0 0 0 / 12%),inset 0 1px 0 rgb(255 255 255 / 6%)}
.ofm_svg{display:block;width:100%;height:auto;overflow:visible}
/* ══ 筛选 chips ════════════════════════════════════════════════════════ */
.ofm_chips{display:flex;gap:6px;flex-wrap:wrap}
.ofm_chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);cursor:pointer;color:var(--dsw-alias-label-secondary);transition:border-color .16s ease,color .16s ease,background .16s ease}
.ofm_chip:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2)}
.ofm_chip[aria-pressed="true"]{border-color:color-mix(in srgb,currentColor 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent)}
.ofm_swatch{width:8px;height:8px;border-radius:3px;flex:none}
/* ══ 数据表格 ══════════════════════════════════════════════════════════ */
.ofm_table{width:100%;min-width:760px;border-collapse:collapse;font-size:11.5px}
.ofm_tablewrap{overflow-x:auto;max-width:100%}
.ofm_table th{text-align:left;font-weight:560;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);padding:0 10px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.ofm_table td{padding:7px 10px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 62%,transparent);font-variant-numeric:tabular-nums}
.ofm_table td:first-child{font-weight:600}
.ofm_table tbody tr{transition:background .15s ease}
.ofm_table tbody tr:hover td{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 5%,transparent)}
.ofm_table tr:last-child td{border-bottom:0}
.ofm_num{text-align:right}
/* ══ 按钮（分层状态） ══════════════════════════════════════════════════ */
.ofm_btn{font:inherit;font-size:12px;font-weight:580;padding:6px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 84%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 6%);color:var(--dsw-alias-label-primary);cursor:pointer;transition:transform .18s var(--ease-instrument),border-color .2s var(--ease-instrument),background .2s var(--ease-instrument),box-shadow .22s var(--ease-instrument),opacity .16s ease}
.ofm_btn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,var(--dsw-alias-border-l2));background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,var(--dsw-alias-bg-layer-3));transform:translateY(-1px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 3px 8px rgb(0 0 0 / 9%)}
.ofm_btn:active:not(:disabled){transform:scale(.985);transition-duration:.1s;box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%)}
.ofm_btn:disabled{opacity:.45;cursor:default;box-shadow:none;transform:none}
.ofm_btn.primary{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,#fff),var(--dsw-alias-state-business-primary));border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 82%,#000);color:var(--dsw-alias-label-on-accent,#fff);box-shadow:inset 0 1px 0 rgb(255 255 255 / 18%),0 2px 8px color-mix(in srgb,var(--dsw-alias-state-business-primary) 32%,transparent)}
.ofm_btn.primary:hover:not(:disabled){background:linear-gradient(180deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 88%,#000));border-color:var(--dsw-alias-state-business-primary);box-shadow:inset 0 1px 0 rgb(255 255 255 / 20%),0 4px 14px color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,transparent)}
.ofm_btn.ghost{background:transparent;box-shadow:none;border-color:transparent;color:var(--dsw-alias-label-secondary)}
.ofm_btn.ghost:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 80%,transparent);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.ofm_minibtn{font:inherit;font-size:11px;font-weight:540;padding:3px 9px;border-radius:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 85%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 70%,transparent);color:var(--dsw-alias-label-secondary);cursor:pointer;transition:transform .12s ease,border-color .16s ease,color .16s ease,background .16s ease,opacity .16s ease}
.ofm_minibtn:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 60%,transparent);color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent);transform:translateY(-1px)}
.ofm_minibtn:active:not(:disabled){transform:scale(.96)}
.ofm_minibtn:disabled{opacity:.45;cursor:default;transform:none}
.ofm_minibtn.danger:hover:not(:disabled){border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent);color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 7%,transparent)}
/* ══ 表单 ══════════════════════════════════════════════════════════════ */
.ofm_field{display:flex;flex-direction:column;gap:4px;min-width:120px}
.ofm_field>span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ofm_input{font:inherit;font-size:12px;padding:6px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%);color:var(--dsw-alias-label-primary);min-width:0;width:100%;transition:border-color .16s ease,box-shadow .16s ease}
.ofm_input::placeholder{color:var(--dsw-alias-label-tertiary)}
.ofm_input:hover{border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 60%,var(--dsw-alias-label-tertiary))}
.ofm_input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
/* ══ 开关（spring 滑块） ═══════════════════════════════════════════════ */
.ofm_switch{display:inline-flex;align-items:center;gap:9px;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent;appearance:none;background:transparent;border:0;padding:0;font:inherit;color:inherit}
.ofm_switch i{width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);box-shadow:inset 0 1px 3px rgb(0 0 0 / 8%);position:relative;transition:background .2s ease,border-color .2s ease,box-shadow .2s ease;flex:none}
.ofm_switch:hover i{filter:brightness(1.05)}
.ofm_switch[aria-checked="true"]:hover i{filter:brightness(1.08)}
.ofm_switch i::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-secondary);box-shadow:0 1px 3px rgb(0 0 0 / 22%);transition:transform .26s cubic-bezier(.34,1.3,.64,1),background .2s ease,width .16s ease}
.ofm_switch:active i::after{width:17px}
.ofm_switch[aria-checked="true"] i{background:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 85%,#000);box-shadow:inset 0 1px 3px rgb(0 0 0 / 12%)}
.ofm_switch[aria-checked="true"] i::after{transform:translateX(16px);background:#fff}
.ofm_switch[aria-checked="true"]:active i::after{transform:translateX(13px)}
.ofm_switch:focus-visible i{box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.ofm_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;padding:7px 10px;border-radius:9px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow-x:auto;white-space:pre;color:var(--dsw-alias-label-secondary)}
/* ══ 提示条 ════════════════════════════════════════════════════════════ */
.ofm_callout{display:flex;gap:9px;padding:10px 12px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 9%,transparent);font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.ofm_error{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}
/* ══ 小组件统计 ════════════════════════════════════════════════════════ */
.ofm_stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));gap:8px}
.ofm_stat{padding:10px 12px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 78%,transparent);border:1px solid var(--dsw-alias-border-l1);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%)}
.ofm_stat b{display:block;font-size:16px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.3px}
.ofm_stat span{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
/* ══ 公告（首次引导） ══════════════════════════════════════════════════ */
    /* The onboarding slot is mounted inside the shell, but Announcement portals its
       scrim into document.body so third-party sidebar stacking contexts cannot trap
       the fixed overlay. Mask colour, blur and z-index mirror the Modal layer of the
       shell so this reads as first-party. */
.ofm_scrim{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 32%));backdrop-filter:var(--dsw-mask-blur, blur(8px)) saturate(140%);-webkit-backdrop-filter:var(--dsw-mask-blur, blur(8px)) saturate(140%);animation:ofm-fadein .24s ease}
@keyframes ofm-fadein{from{opacity:0}to{opacity:1}}
.ofm_ann{width:min(620px,92vw);max-height:min(86vh,640px);border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 94%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 28px 80px rgb(0 0 0 / 40%);overflow:hidden;display:flex;flex-direction:column;animation:ofm-popin .36s cubic-bezier(.16,1,.3,1)}
@keyframes ofm-popin{from{opacity:0;transform:translateY(16px) scale(.965)}to{opacity:1;transform:none}}
.ofm_annhead{padding:18px 22px 12px;display:flex;flex-direction:column;gap:8px;background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 8%,transparent),transparent 75%)}
.ofm_anntitle{margin:0;font-size:18px;font-weight:730;letter-spacing:-.4px}
.ofm_annsub{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ofm_steps{display:flex;gap:6px;padding:0 22px 14px}
.ofm_step{height:3px;flex:1;border-radius:99px;background:var(--dsw-alias-border-l2);transition:background .3s ease}
.ofm_step[data-on="true"]{background:var(--dsw-alias-state-business-primary);box-shadow:0 0 6px color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent)}
.ofm_annbody{padding:2px 22px 18px;max-height:min(48vh,420px);overflow:auto;display:flex;flex-direction:column;gap:12px}
.ofm_annbody h3{margin:0;font-size:13.5px;font-weight:660}
.ofm_annbody p,.ofm_annbody li{font-size:12.5px;line-height:1.72;color:var(--dsw-alias-label-secondary);margin:0}
.ofm_annbody ul{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px}
.ofm_annfoot{display:flex;align-items:center;gap:10px;padding:13px 22px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent)}
.ofm_annfoot .spacer{margin-left:auto}
.ofm_disclaimersec{display:flex;flex-direction:column;gap:4px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1)}
.ofm_disclaimersec:first-of-type{border-top:0;padding-top:0}
.ofm_disclaimersec h3{margin:0;font-size:13px;font-weight:660;color:var(--dsw-alias-label-primary)}
.ofm_disclaimer{width:min(640px,92vw)}
.ofm_shellfoot{display:flex;justify-content:center;padding:6px 0 2px}
.ofm_linkbtn{appearance:none;background:none;border:0;padding:2px 6px;font:inherit;font-size:11.5px;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:6px;text-decoration:underline;text-underline-offset:3px;text-decoration-color:color-mix(in srgb,currentColor 40%,transparent)}
.ofm_linkbtn:hover{color:var(--dsw-alias-label-secondary)}
.ofm_kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.ofm_kvc{padding:9px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 74%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);display:flex;flex-direction:column;gap:3px}
.ofm_kvc b{font-size:12.5px;font-variant-numeric:tabular-nums}
.ofm_kvc span{font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ofm_two{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
/* ══ 公告中心 ══════════════════════════════════════════════════════════ */
.ofm_news{display:flex;flex-direction:column;gap:10px}
.ofm_newsitem{display:flex;flex-direction:column;gap:7px;padding:13px 15px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 80%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);position:relative;transition:border-color .18s ease,transform .2s cubic-bezier(.32,.72,0,1),box-shadow .22s ease}
.ofm_newsitem:hover{transform:translateY(-1px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 8px 22px rgb(0 0 0 / 10%)}
.ofm_newsitem.unread{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent)}
.ofm_newsdot{position:absolute;top:14px;right:14px;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.ofm_newshead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-right:16px}
.ofm_newstitle{font-size:13px;font-weight:650;letter-spacing:-.1px}
.ofm_level{font-size:10.5px;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.ofm_level.info{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent)}
.ofm_level.update{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}
.ofm_level.warn{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 9%,transparent)}
.ofm_level.urgent{color:#fff;background:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 85%,#000)}
.ofm_newsmeta{display:flex;gap:10px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex-wrap:wrap}
.ofm_newsbody{font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.ofm_newsbody p{margin:0 0 6px}
.ofm_newsbody p:last-child{margin-bottom:0}
.ofm_newsbody h1,.ofm_newsbody h2,.ofm_newsbody h3,.ofm_newsbody h4{margin:6px 0 4px;font-size:13px;line-height:1.4}
.ofm_newsbody ul,.ofm_newsbody ol{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:3px}
.ofm_newsbody code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 5px}
.ofm_newsbody pre{margin:4px 0;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow-x:auto}
.ofm_newsbody pre code{background:transparent;border:0;padding:0}
.ofm_newsbody blockquote{margin:4px 0;padding:2px 10px;border-left:3px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);color:var(--dsw-alias-label-tertiary)}
.ofm_newsbody img{max-width:100%;border-radius:8px}
.ofm_newsbody a{color:var(--dsw-alias-state-business-primary);text-decoration:none}
.ofm_newsbody a:hover{text-decoration:underline}
.ofm_newsbody table{border-collapse:collapse;font-size:12px}
.ofm_newsbody th,.ofm_newsbody td{border:1px solid var(--dsw-alias-border-l1);padding:3px 8px}
.ofm_newsbody hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:8px 0}
.ofm_newsbody mark{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 30%,transparent);border-radius:2px;padding:0 2px}
.ofm_upgradecards{display:flex;gap:8px;flex-wrap:wrap}
.ofm_upnotes{max-height:220px;overflow:auto;padding:10px 12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
/* ══ 进度条 ════════════════════════════════════════════════════════════ */
.ofm_prog{height:4px;border-radius:99px;background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 1px 2px rgb(0 0 0 / 6%);overflow:hidden}
.ofm_prog i{display:block;height:100%;width:40%;border-radius:99px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent),var(--dsw-alias-state-business-primary));animation:ofm-prog-slide 1.1s ease-in-out infinite}
.ofm_prog i{position:relative;overflow:hidden}
.ofm_prog i::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent) 50%,transparent 70%);transform:translateX(-100%);animation:ofm-prog-shine 1.6s ease-in-out infinite}
@keyframes ofm-prog-shine{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
@keyframes ofm-prog-slide{0%{transform:translateX(-100%)}100%{transform:translateX(260%)}}
/* ══ Toast（fixed 到视口，浮在所有层之上） ════════════════════════════ */
.ofm_toasts{position:fixed;right:18px;bottom:18px;z-index:1200;display:flex;flex-direction:column;gap:10px;max-width:min(380px,calc(100vw - 36px));font-family:inherit}
.ofm_toast{position:relative;display:flex;flex-direction:column;gap:6px;padding:12px 14px 12px 16px;border-radius:13px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 94%,transparent);backdrop-filter:blur(14px) saturate(150%);-webkit-backdrop-filter:blur(14px) saturate(150%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 14px 40px rgb(0 0 0 / 26%);font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);animation:ofm-toast-rise .32s cubic-bezier(.16,1,.3,1);overflow:hidden}
.ofm_toast{transform-origin:bottom right;will-change:transform}
.ofm_toast::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--dsw-alias-state-business-primary)}
.ofm_toast.warn::before{background:var(--dsw-alias-state-warning-primary,#f0a441)}
.ofm_toast.urgent::before{background:var(--dsw-alias-state-error-primary)}
.ofm_toast.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 42%,var(--dsw-alias-border-l2))}
.ofm_toast.urgent{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,var(--dsw-alias-border-l2))}
.ofm_toast .ofm_toasttitle{font-weight:660;font-size:12.5px;display:flex;align-items:center;gap:7px}
.ofm_toast .ofm_toastbody{color:var(--dsw-alias-label-secondary);max-height:180px;overflow:auto;overflow-wrap:anywhere}
.ofm_toast .ofm_toastbody p{margin:0 0 5px}
.ofm_toast .ofm_toastbody p:last-child{margin-bottom:0}
.ofm_toast .ofm_toastbody img{max-width:100%}
.ofm_toastactions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.ofm_toastclose{margin-left:auto;background:transparent;border:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:13px;padding:0 2px;transition:color .14s ease}
.ofm_toastclose:hover{color:var(--dsw-alias-label-primary)}
@keyframes ofm-toast-rise{from{opacity:0;transform:translateY(14px) scale(.97)}to{opacity:1;transform:none}}
/* ══ 模态 ══════════════════════════════════════════════════════════════ */
.ofm_modal{width:min(520px,92vw);max-height:min(80vh,600px);border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 95%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 28px 80px rgb(0 0 0 / 42%);display:flex;flex-direction:column;overflow:hidden;animation:ofm-popin .34s cubic-bezier(.16,1,.3,1)}
.ofm_modalhead{padding:17px 20px 11px;display:flex;align-items:center;gap:10px;font-size:15px;font-weight:720;letter-spacing:-.2px}
.ofm_modalbody{padding:4px 20px 16px;overflow:auto;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.ofm_modalbody p{margin:0 0 6px}
.ofm_modalfoot{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent)}
@media (max-width:720px){.ofm_sec_hint{margin-left:0;width:100%}.ofm_pills{margin-left:0;width:100%}}
/* ══ 北辰 API 赞助横幅：免费模型页首屏入口，与桌面端保持独立 ═══════ */
.ofm_sponsor_banner{position:relative;display:grid;grid-template-columns:56px minmax(0,1fr) auto;align-items:center;gap:14px;padding:13px 16px;border:1px solid rgb(121 151 204 / 42%);border-radius:14px;overflow:hidden;background:linear-gradient(115deg,#0b1425 0%,#17253d 54%,#263654 100%);color:#f3f7ff;box-shadow:0 9px 20px rgb(12 24 49 / 20%),inset 0 1px 0 rgb(255 255 255 / 13%)}
.ofm_sponsor_banner::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.36;background-image:linear-gradient(rgb(126 164 225 / 15%) 1px,transparent 1px),linear-gradient(90deg,rgb(126 164 225 / 15%) 1px,transparent 1px);background-size:32px 32px;mask-image:linear-gradient(90deg,black,transparent 85%)}
.ofm_sponsor_banner::after{content:"";position:absolute;inset:auto -12% -80% 35%;height:180%;pointer-events:none;background:radial-gradient(ellipse,rgb(96 137 222 / 22%),transparent 68%);transform:rotate(-7deg)}
.ofm_sponsor_banner>*{position:relative;z-index:1}
.ofm_sponsor_logo{display:flex;flex-direction:column;align-items:center;justify-content:center;width:56px;height:56px;border-radius:14px;background:#f8fbff;color:#c8470b;box-shadow:0 5px 11px rgb(0 0 0 / 22%),inset 0 0 0 1px rgb(255 255 255 / 80%);transform:rotate(4deg);font-weight:800;letter-spacing:-1px;line-height:1}
.ofm_sponsor_logo span{font-size:16px}
.ofm_sponsor_logo small{margin-top:4px;padding-top:3px;border-top:1px solid currentColor;font-size:7px;letter-spacing:1px}
.ofm_sponsor_bannerbody{min-width:0}
.ofm_sponsor_kicker{display:inline-flex;align-items:center;padding:2px 8px;border:1px solid rgb(0 194 232 / 55%);border-radius:999px;background:rgb(0 144 186 / 18%);color:#38d9f4;font-size:10px;font-weight:700;letter-spacing:.2px}
.ofm_sponsor_banner h3{margin:4px 0 3px;color:#f6f8ff;font-size:clamp(17px,2vw,22px);font-weight:780;letter-spacing:-.45px;line-height:1.15}
.ofm_sponsor_banner p{max-width:75ch;margin:0;color:rgb(220 229 246 / 82%);font-size:10.5px;line-height:1.45}
.ofm_sponsor_cta{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:92px;padding:8px 12px;border:1px solid rgb(255 255 255 / 72%);border-radius:10px;background:linear-gradient(180deg,#f9fbff,#dfe8f7);box-shadow:0 4px 10px rgb(0 0 0 / 18%),inset 0 1px 0 #fff;color:#253651;font-size:11px;font-weight:750;text-decoration:none;white-space:nowrap;transition:transform .18s var(--ease-instrument),box-shadow .18s ease,filter .18s ease}
.ofm_sponsor_cta:hover{transform:translateY(-2px);filter:brightness(1.04);box-shadow:0 9px 20px rgb(0 0 0 / 24%),inset 0 1px 0 #fff}
.ofm_sponsor_cta:active{transform:translateY(0)}
/* ══ GitHub star 按钮 ══════════════════════════════════════════════════ */
.ofm_starbtn{position:relative;display:inline-flex;gap:7px;align-items:center;padding:7px 15px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);background:linear-gradient(140deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent),transparent 70%);color:var(--dsw-alias-state-business-primary);text-decoration:none;font-weight:650;font-size:12.5px;transition:transform .18s ease,box-shadow .22s ease,color .22s ease,background .22s ease;white-space:nowrap;overflow:hidden}
.ofm_starbtn svg{transition:transform .5s cubic-bezier(.34,1.56,.64,1)}
.ofm_starbtn:hover svg{transform:rotate(72deg) scale(1.12)}
.ofm_starbtn:hover{box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent),0 6px 16px color-mix(in srgb,var(--dsw-alias-state-business-primary) 22%,transparent)}
.ofm_starbtn:active svg{transform:rotate(72deg) scale(.94)}
.ofm_starbtn svg{width:14px;height:14px;fill:currentColor;transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
.ofm_starbtn:hover{transform:translateY(-1px);box-shadow:0 8px 22px color-mix(in srgb,var(--dsw-alias-state-business-primary) 34%,transparent);background:linear-gradient(140deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,#3ECFA0));color:#fff}
.ofm_starbtn:active{transform:scale(.97)}
.ofm_starbtn:hover svg{transform:rotate(-72deg) scale(1.12)}
.ofm_starbtn::after{content:"";position:absolute;top:0;bottom:0;width:38%;left:-45%;background:linear-gradient(100deg,transparent,rgb(255 255 255 / 34%),transparent);transform:skewX(-18deg);transition:left .55s ease}
.ofm_starbtn:hover::after{left:112%}
.ofm_starlink{display:inline-flex;align-items:center;gap:6px;text-decoration:none}
/* ══ 鱼缸（品牌装饰：玻璃缸 + 水位 + 波光 + 鱼群） ════════════════════ */
.ofm_tank{position:relative;width:206px;height:128px;border-radius:16px;overflow:hidden;flex:none;background:linear-gradient(180deg,rgba(127,166,255,.10),rgba(127,166,255,.03));box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l1)}
.ofm_tankwater{position:absolute;left:0;right:0;bottom:0;height:var(--lvl,0%);transition:height 1.4s cubic-bezier(.22,.61,.36,1)}
.ofm_tank.ok .ofm_tankwater{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,transparent),var(--dsw-alias-state-business-primary))}
.ofm_tank.busy .ofm_tankwater{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 72%,transparent),var(--dsw-alias-state-warning-primary,#f0a441))}
.ofm_tank.over .ofm_tankwater{background:linear-gradient(180deg,color-mix(in srgb,var(--dsw-alias-state-error-primary) 72%,transparent),var(--dsw-alias-state-error-primary))}
.ofm_tankdeep{position:absolute;inset:0;overflow:hidden}
.ofm_wave{position:absolute;left:0;top:-6px;width:200%;height:7px;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 8' preserveAspectRatio='none'%3E%3Cpath d='M0 4 Q15 0 30 4 T60 4 T90 4 T120 4 V8 H0Z' fill='rgba(255,255,255,.45)'/%3E%3C/svg%3E") repeat-x;background-size:60px 7px;animation:ofmwave 5.5s linear infinite}
.ofm_wave.w2{top:-4px;opacity:.45;animation-duration:8.5s;animation-direction:reverse}
@keyframes ofmwave{to{transform:translateX(60px)}}
.ofm_bubble{position:absolute;bottom:-8px;width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.5);opacity:0;animation:ofmbub 7s ease-in infinite}
.ofm_bubble.b1{left:14%;animation-delay:0s}
.ofm_bubble.b2{left:32%;width:3px;height:3px;animation-delay:2.2s;animation-duration:9s}
.ofm_bubble.b3{left:55%;animation-delay:4.1s}
.ofm_bubble.b4{left:71%;width:7px;height:7px;animation-delay:1.3s;animation-duration:8s}
.ofm_bubble.b5{left:86%;width:4px;height:4px;animation-delay:5.4s;animation-duration:10s}
@keyframes ofmbub{0%{transform:translateY(0);opacity:0}12%{opacity:.75}100%{transform:translateY(-136px);opacity:0}}
.ofm_fish{position:absolute;left:-34px;width:26px;height:13px;animation:ofmswim 12s linear infinite;will-change:transform;filter:drop-shadow(0 1px 2px rgb(0 0 0 / 18%))}
.ofm_fish.f1{bottom:14px}
.ofm_fish.f1 svg,.ofm_fish.f3 svg{transform:scaleX(-1)}
.ofm_fish.f2{bottom:44px;animation-duration:16s;animation-delay:-7s;animation-name:ofmswimrev}
.ofm_fish.f3{bottom:68px;width:19px;height:10px;animation-duration:9.5s;animation-delay:-3.5s}
.ofm_fish svg{display:block;width:100%;height:100%;fill:rgba(255,255,255,.82)}
@keyframes ofmswim{0%{transform:translateX(0)}100%{transform:translateX(270px)}}
@keyframes ofmswimrev{0%{transform:translateX(270px)}100%{transform:translateX(0)}}
.ofm_tankglass{position:absolute;inset:0;pointer-events:none;border-radius:16px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.16),inset 0 18px 32px rgba(255,255,255,.06),inset 0 -12px 24px rgba(0,0,0,.10)}
.ofm_tankrays{position:absolute;inset:-30% -12%;pointer-events:none;opacity:.5;background:repeating-linear-gradient(104deg,rgb(255 255 255 / 7%) 0 9px,transparent 9px 30px);mix-blend-mode:soft-light;animation:ofmrays 11s ease-in-out infinite alternate}
@keyframes ofmrays{from{transform:translateX(-14px) rotate(-.4deg)}to{transform:translateX(14px) rotate(.4deg)}}
.ofm_tankshine{position:absolute;inset:0;pointer-events:none;background:linear-gradient(196deg,rgb(255 255 255 / 13%) 0%,transparent 32%)}
@media (prefers-reduced-motion:reduce){.ofm_wave,.ofm_bubble,.ofm_fish,.ofm_tankrays{animation:none}}
/* ══ 三页外壳：极光底 · 毛玻璃导航 · 页过渡 ═════════════════════════════
   The aurora is a fixed layer *inside* our root: a flat shell background gives
   backdrop-filter nothing to sample, so every glass surface would read as a
   plain translucent box. It sits at z-index:-1 with isolation:isolate on the
   shell, which keeps it behind our content and above the app background without
   ever escaping into the shell's own stacking order. */
.ofm_shell{position:relative;display:flex;flex-direction:column;gap:18px;max-width:1120px;isolation:isolate}
@keyframes ofmdrift{0%{transform:translate3d(0,0,0) scale(1)}50%{transform:translate3d(3vw,2vh,0) scale(1.09)}100%{transform:translate3d(-3vw,-2vh,0) scale(.96)}}
.ofm_nav{position:sticky;top:0;z-index:30;display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px 12px;padding:10px 12px;border-radius:16px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 82%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 62%,transparent);backdrop-filter:blur(20px) saturate(160%);-webkit-backdrop-filter:blur(20px) saturate(160%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 8px 26px rgb(0 0 0 / 10%)}
.ofm_navbrand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:14px;letter-spacing:-.2px;white-space:nowrap}
.ofm_navmark{width:26px;height:26px;border-radius:9px;display:grid;place-items:center;flex:none;background:linear-gradient(145deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,#3ECFA0));box-shadow:0 4px 12px color-mix(in srgb,var(--dsw-alias-state-business-primary) 40%,transparent),inset 0 1px 0 rgb(255 255 255 / 22%)}
.ofm_navmark svg{width:16px;height:16px;fill:#fff}
.ofm_tabs{position:relative;grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:13px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 80%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);box-shadow:inset 0 1px 2px rgb(0 0 0 / 4%)}
.ofm_tabglider{position:absolute;top:0;left:0;border-radius:10px;background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 92%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-2) 88%,transparent));box-shadow:0 3px 10px rgb(0 0 0 / 14%),inset 0 1px 0 rgb(255 255 255 / 9%);transition:transform .34s cubic-bezier(.22,.61,.36,1),width .34s cubic-bezier(.22,.61,.36,1),height .34s cubic-bezier(.22,.61,.36,1);pointer-events:none}
.ofm_tab{position:relative;z-index:1;font:inherit;font-size:12px;font-weight:600;padding:6px 13px;border-radius:10px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;transition:color .2s ease}
.ofm_tab[data-on="true"]{color:var(--dsw-alias-label-primary)}
.ofm_tab:hover{color:var(--dsw-alias-label-primary)}
.ofm_tab .ofm_tabnum{font-variant-numeric:tabular-nums;font-weight:600;color:var(--dsw-alias-label-tertiary);margin-left:6px;font-size:11px}
/* The star belongs beside the brand: grid auto-placement would push it below
   the tabs row (they come first in the DOM) and stretch it across the row. */
.ofm_nav .ofm_starbtn{grid-column:2;grid-row:1;justify-self:end}
.ofm_page{display:flex;flex-direction:column;gap:20px;animation:ofmpagein .4s cubic-bezier(.16,1,.3,1)}
@keyframes ofmpagein{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:none}}
/* ── 毛玻璃表面：只给大块面用 backdrop-filter，小卡片用半透明叠层，滚动更顺 */
.ofm_glass{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 68%,transparent);backdrop-filter:blur(16px) saturate(150%);-webkit-backdrop-filter:blur(16px) saturate(150%);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 12px 34px rgb(0 0 0 / 9%)}
.ofm_root .ofm_hero,.ofm_root .ofm_panel,.ofm_root .ofm_ann,.ofm_root .ofm_modal{background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 70%,transparent);backdrop-filter:blur(18px) saturate(155%);-webkit-backdrop-filter:blur(18px) saturate(155%);box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 14px 40px rgb(0 0 0 / 10%)}
/* ══ 鱼缸加大版（页头） ════════════════════════════════════════════════ */
.ofm_tankrow{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.ofm_tankside{flex:1;min-width:236px;display:flex;flex-direction:column;gap:11px;justify-content:center}
.ofm_tank.xl{width:264px;height:148px;border-radius:20px;box-shadow:inset 0 0 0 1px rgb(255 255 255 / 12%),0 16px 40px rgb(0 0 0 / 14%)}
.ofm_tank.xl .ofm_tankglass{border-radius:20px}
/* ══ 渠道接入页 ════════════════════════════════════════════════════════ */
.ofm_chanwrap{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:14px}
.ofm_chan{position:relative;display:flex;flex-direction:column;gap:12px;padding:16px 17px 15px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 5%);overflow:hidden;transition:transform .22s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .2s ease}
.ofm_chan::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,var(--chan-accent,var(--dsw-alias-state-business-primary)),transparent 78%);opacity:.95}
.ofm_chan:hover{transform:translateY(-3px);box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 18px 40px rgb(0 0 0 / 15%);border-color:color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 55%,transparent)}
.ofm_chan.off{opacity:.62}
.ofm_chanhead{display:flex;align-items:center;gap:11px}
.ofm_chanlogo{width:38px;height:38px;border-radius:12px;display:grid;place-items:center;flex:none;font-weight:800;font-size:13px;color:#fff;letter-spacing:-.3px;background:linear-gradient(150deg,var(--chan-accent,var(--dsw-alias-state-business-primary)),color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 45%,#101828));box-shadow:0 6px 16px color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 34%,transparent),inset 0 1px 0 rgb(255 255 255 / 22%)}
.ofm_chan:hover .ofm_chanlogo{transform:scale(1.06) rotate(-3deg);transition:transform .35s cubic-bezier(.34,1.56,.64,1)}
.ofm_chanlogo{transition:transform .35s cubic-bezier(.34,1.56,.64,1)}
.ofm_chanid{display:flex;flex-direction:column;gap:2px;min-width:0}
.ofm_chanid b{font-size:14px;font-weight:700;letter-spacing:-.2px}
.ofm_chanid span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ofm_chanstate{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);padding:3px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);white-space:nowrap}
.ofm_chanmeta{display:flex;gap:14px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.ofm_chanmeta b{color:var(--dsw-alias-label-secondary);font-weight:650;font-variant-numeric:tabular-nums}
.ofm_chanacts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.ofm_acctlist{display:flex;flex-direction:column;gap:6px}
.ofm_acct{display:flex;align-items:center;flex-wrap:wrap;gap:9px;padding:7px 10px;border-radius:11px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 82%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);font-size:12px;transition:border-color .16s ease,background .16s ease}
.ofm_acct:hover{border-color:var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,transparent)}
.ofm_acct.pending{border-style:dashed}
.ofm_acctname{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:180px}
.ofm_acctmeta{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ofm_balanceerror{flex-basis:100%;overflow-wrap:anywhere;color:var(--dsw-alias-state-error-primary);font-size:11px}
.ofm_acctacts{margin-left:auto;display:flex;gap:5px;flex-wrap:wrap}
.ofm_modellist{display:flex;flex-direction:column;gap:4px;max-height:238px;overflow:auto;padding-right:2px}
.ofm_modelrow{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);font-size:11.5px;transition:background .15s ease}
.ofm_modelrow:hover{background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 85%,transparent)}
.ofm_modelrow.off{opacity:.5}
.ofm_modelrow .ofm_id{flex:1;min-width:0}
.ofm_tagpill{font-size:10px;font-weight:560;padding:1px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 90%,transparent);color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ofm_tagpill.free{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.ofm_tagpill.dead{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.ofm_chanfold{border-top:1px dashed color-mix(in srgb,var(--dsw-alias-border-l1) 85%,transparent);padding-top:10px;display:flex;flex-direction:column;gap:8px}
.ofm_foldtoggle{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;cursor:pointer;font-family:inherit;padding:0;transition:color .15s ease}
.ofm_foldtoggle svg{transition:transform .3s cubic-bezier(.32,.72,0,1)}
.ofm_foldtoggle:hover svg{transform:translateY(1px)}
.ofm_foldtoggle:hover{color:var(--dsw-alias-label-primary)}
.ofm_foldtoggle svg{width:10px;height:10px;fill:currentColor;transition:transform .22s ease}
.ofm_foldtoggle[data-open="true"] svg{transform:rotate(90deg)}
/* Compact account and provider directories. */
.ofm_directoryhero{display:flex;flex-direction:column;gap:12px;padding:4px 0 16px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.ofm_directoryhero>.ofm_btn{align-self:flex-start}
.ofm_directoryhero h2{font-size:20px;letter-spacing:0;background:none;-webkit-text-fill-color:currentColor}
.ofm_directorytools{display:flex;align-items:end;flex-wrap:wrap;gap:10px}
.ofm_directorytools label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:var(--dsw-alias-label-secondary);min-width:0;flex:1 1 140px}
.ofm_directorytools label:first-child{flex:3 1 220px}
.ofm_directorytools .ofm_input{width:100%;min-width:0;box-sizing:border-box}
.ofm_directory{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,310px),1fr));align-items:start;gap:10px}
.ofm_directorycount{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ofm_chan.compact,.ofm_provider{min-width:0;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:none;display:flex;flex-direction:column;gap:10px;overflow-wrap:anywhere}
.ofm_chan.compact::before{display:none}
.ofm_chan.compact:hover{transform:none;box-shadow:none}
.ofm_chan.compact .ofm_chanhead{gap:8px;flex-wrap:wrap}
.ofm_chan.compact .ofm_chanid{flex:1;min-width:100px}
.ofm_chan.compact .ofm_chanlogo{width:32px;height:32px;border-radius:6px;letter-spacing:0;box-shadow:none;transform:none}
.ofm_chan.compact .ofm_chanid b{letter-spacing:0}
.ofm_chan.compact .ofm_chanmeta{gap:10px}
.ofm_directoryactions{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px}
.ofm_directorydetail{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);min-width:0}
.ofm_directorydetail .ofm_duo{grid-template-columns:repeat(auto-fit,minmax(min(100%,200px),1fr))}
.ofm_directorydetail .ofm_input{min-width:0;width:100%;box-sizing:border-box}
.ofm_provider .ofm_cardhead{flex-wrap:wrap;gap:8px}
.ofm_provider .ofm_cardname{font-size:14px;letter-spacing:0;white-space:normal;overflow-wrap:anywhere}
.ofm_provider .ofm_starlink{color:var(--dsw-alias-state-business-primary);font-size:11px;text-decoration:none}
.ofm_provider .ofm_starlink:hover{text-decoration:underline}
.ofm_subform{display:flex;flex-direction:column;gap:14px;padding:16px 0;border-block:1px solid var(--dsw-alias-border-l1);min-width:0}
.ofm_subform label{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px}
.ofm_subform .ofm_input{box-sizing:border-box;border-radius:6px;width:100%;max-width:100%}
.ofm_subform textarea{resize:vertical;min-height:84px}
.ofm_subform .ofm_duo{grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))}
.ofm_subscriptions .ofm_row{flex-wrap:wrap;min-width:0}
.ofm_subscriptions .ofm_btn{border-radius:6px;max-width:100%;white-space:normal;overflow-wrap:anywhere}
.ofm_subaccount{display:flex;flex-direction:column;gap:12px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0;overflow-wrap:anywhere}
.ofm_subaccount h3{font-size:14px;font-weight:600;margin:0;letter-spacing:0}
.ofm_submeta{display:flex;flex-wrap:wrap;gap:8px 18px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ofm_subwindows{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:14px}
.ofm_subwindow{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:12px}
.ofm_subwindow strong{font-size:13px;font-variant-numeric:tabular-nums}
.ofm_subwindow progress{appearance:none;width:100%;height:5px;border:0;border-radius:2px;background:var(--dsw-alias-border-l1);accent-color:var(--dsw-alias-state-business-primary)}
.ofm_subwindow progress::-webkit-progress-bar{background:var(--dsw-alias-border-l1);border-radius:2px}
.ofm_subwindow progress::-webkit-progress-value{background:var(--dsw-alias-state-business-primary);border-radius:2px}
.ofm_submodels{display:flex;flex-wrap:wrap;gap:5px;margin:0;padding:0;list-style:none;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ofm_submodels li{max-width:100%;overflow-wrap:anywhere}
.ofm_submodels li+li::before{content:"/";padding-right:5px;color:var(--dsw-alias-label-tertiary)}
.ofm_subcandidates{padding:10px 0;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
/* ══ 骨架屏 ════════════════════════════════════════════════════════════ */
.ofm_skel{position:relative;overflow:hidden;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent);min-height:96px;animation:ofmpulse 1.8s ease-in-out infinite}
.ofm_skel::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(100deg,transparent 30%,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent) 50%,transparent 70%);transform:translateX(-100%);animation:ofm-skel-shine 1.8s ease-in-out infinite}
@keyframes ofm-skel-shine{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
.ofm_skel::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent,rgb(255 255 255 / 8%) 42%,transparent 74%);animation:ofmshine 1.5s ease-in-out infinite}
@keyframes ofmshine{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes ofmpulse{0%,100%{opacity:1}50%{opacity:.55}}
/* ══ 登录引导 ══════════════════════════════════════════════════════════ */
.ofm_loginbody{display:flex;flex-direction:column;gap:14px}
.ofm_loginstep{display:flex;gap:11px;align-items:flex-start;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.ofm_loginstep b{flex:none;width:21px;height:21px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:650;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);color:var(--dsw-alias-state-business-primary)}
.ofm_scanline{animation:ofmscan 2.2s ease-in-out infinite}
@keyframes ofmscan{0%,100%{opacity:.35}50%{opacity:.85}}
/* ══ 数据看板 KPI ══════════════════════════════════════════════════════ */
.ofm_kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.ofm_kpi{display:flex;flex-direction:column;gap:6px;padding:15px 17px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 1px 2px rgb(0 0 0 / 5%);transition:transform .22s cubic-bezier(.32,.72,0,1),box-shadow .24s ease,border-color .2s ease}
.ofm_kpi:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 8%),0 16px 36px rgb(0 0 0 / 13%)}
.ofm_kpilabel{font-size:11px;font-weight:560;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.ofm_kpivalue{font-size:25px;font-weight:760;letter-spacing:-.7px;line-height:1.15;font-variant-numeric:tabular-nums;background:linear-gradient(120deg,var(--dsw-alias-label-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-label-primary)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.ofm_kpi:hover .ofm_kpivalue{transform:translateY(-1px);transition:transform .3s cubic-bezier(.34,1.56,.64,1)}
.ofm_kpivalue{transition:transform .3s cubic-bezier(.34,1.56,.64,1);display:inline-block}
.ofm_kpisub{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ofm_kpi.warn .ofm_kpivalue{-webkit-text-fill-color:var(--dsw-alias-state-warning-primary,#f0a441);background:none}
.ofm_logfailed td{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 5%,transparent)}
/* ══ 真实图标与积分展示 ════════════════════════════════════════════════ */
.ofm_navmark img,.ofm_chanlogo img{width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block}
.ofm_chanlogo{padding:0;overflow:hidden}
.ofm_credittotal b{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}
.ofm_creditbadge{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:600;padding:2px 9px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 9%,transparent);color:var(--dsw-alias-state-warning-primary,#f0a441);white-space:nowrap}
.ofm_creditbadge.strong{max-width:100%;white-space:normal;overflow-wrap:anywhere;color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}
/* ══ 账号池状态 ════════════════════════════════════════════════════════ */
.ofm_pooltop{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.ofm_poolbadge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);font-size:12.5px;font-weight:650;white-space:nowrap}
.ofm_pooldot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.ofm_poolbadge.ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent)}
.ofm_poolbadge.ok .ofm_pooldot{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}
.ofm_poolbadge.busy{color:var(--dsw-alias-state-warning-primary,#f0a441);border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 40%,transparent)}
.ofm_poolbadge.busy .ofm_pooldot{background:var(--dsw-alias-state-warning-primary,#f0a441);animation:ofmpulse 1.4s ease-in-out infinite}
.ofm_poolbadge.over{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.ofm_poolbadge.over .ofm_pooldot{background:var(--dsw-alias-state-error-primary);animation:ofmpulse .8s ease-in-out infinite}
.ofm_poolstats{display:flex;gap:22px;flex-wrap:wrap}
.ofm_poolstats .ofm_stat b{font-size:19px}
.ofm_poolstats .ofm_stat.hot b{color:var(--dsw-alias-state-error-primary)}
.ofm_poolmeta{display:flex;gap:8px 18px;align-items:baseline;flex-wrap:wrap;justify-content:space-between}
@media (max-width:760px){.ofm_tank.xl{width:100%;max-width:340px}.ofm_tab{flex:1 1 auto;text-align:center}}
/* ══ 动效降级：用户系统开启"减少动态效果"时全部收敛 ═══════════════════ */
/* —— 交互锚点增强：激活态 / 状态色 / 加载态（additive，不改既有规则） —— */
/* tab：激活项在滑块底衬之上再补一道品牌下划线，选中更明确 */
.ofm_tab[aria-selected="true"]{color:var(--dsw-alias-label-primary)}
.ofm_tab[aria-selected="true"]::after{content:"";position:absolute;left:12px;right:12px;bottom:3px;height:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary);opacity:.85;transition:opacity .18s cubic-bezier(.32,.72,0,1)}
/* 渠道卡：随接入状态着色顶部 hairline 与外发光（已接入=品牌色、关闭=灰、待接入=琥珀弱化） */
.ofm_chan[data-state="on"]::before{background:linear-gradient(90deg,var(--chan-accent,var(--dsw-alias-state-business-primary)),color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 30%,transparent));opacity:1}
.ofm_chan[data-state="on"]{border-color:color-mix(in srgb,var(--chan-accent,var(--dsw-alias-state-business-primary)) 34%,var(--dsw-alias-border-l2))}
.ofm_chan[data-state="idle"]::before{background:linear-gradient(90deg,var(--dsw-alias-state-warning-primary,#f0a441),transparent);opacity:.6}
.ofm_chan[data-state="off"]::before{background:linear-gradient(90deg,var(--dsw-alias-label-tertiary),transparent);opacity:.5}
/* 按钮：异步进行中显示内联 spinner（aria-busy 锚点，文字仍保留占位避免布局跳动） */
.ofm_btn[aria-busy="true"]{position:relative;color:transparent !important;pointer-events:none}
.ofm_btn[aria-busy="true"]::after{content:"";position:absolute;left:50%;top:50%;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;border-radius:50%;border:2px solid color-mix(in srgb,currentColor 30%,var(--dsw-alias-label-secondary));border-top-color:var(--dsw-alias-label-primary);animation:ofm-btn-spin .7s linear infinite}
@keyframes ofm-btn-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.ofm_root *,.ofm_root *::before,.ofm_root *::after{animation-duration:.01ms !important;animation-iteration-count:1 !important;transition-duration:.01ms !important}}
/* ═══ 精密仪器精修层（世界观：原厂仪器手感）：颜色听宿主，质感在阻尼。曲线 --ease-instrument 冲得快落得稳，--ease-settle 极轻过冲。退场比进场快。 ═══ */
.ofm_glass{transition:border-color .22s var(--ease-instrument),box-shadow .26s var(--ease-instrument),transform .22s var(--ease-instrument),background .22s var(--ease-instrument)}
.ofm_glass:hover{border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 92%,var(--dsw-alias-state-business-primary));box-shadow:0 1px 2px rgb(0 0 0 / 5%),0 10px 28px -14px color-mix(in srgb,var(--dsw-alias-state-business-primary) 18%,transparent)}
.ofm_kpi{transition:border-color .22s var(--ease-instrument),transform .22s var(--ease-instrument),box-shadow .26s var(--ease-instrument)}
.ofm_kpi:hover{transform:translateY(-1px)}
.ofm_kpivalue{transition:transform .3s var(--ease-settle),color .2s var(--ease-instrument);display:inline-block}
.ofm_kpi:hover .ofm_kpivalue{transform:translateY(-1px) scale(1.015);color:var(--dsw-alias-label-primary)}
.ofm_table tbody tr{transition:background .14s var(--ease-instrument)}
.ofm_seg button,.ofm_chip{transition:background .2s var(--ease-instrument),color .2s var(--ease-instrument),border-color .2s var(--ease-instrument),box-shadow .22s var(--ease-settle)}
.ofm_prog i{transition:width .5s var(--ease-instrument)}
.ofm_minibtn{transition:transform .14s var(--ease-instrument),border-color .18s var(--ease-instrument),color .18s var(--ease-instrument),background .18s var(--ease-instrument)}
.ofm_minibtn:active:not(:disabled){transform:scale(.98);transition-duration:.09s}
.ofm_root input,.ofm_root select,.ofm_root textarea{transition:border-color .18s var(--ease-instrument),box-shadow .2s var(--ease-instrument),background .18s var(--ease-instrument)}
@media (prefers-reduced-motion:reduce){.ofm_glass,.ofm_kpi,.ofm_kpivalue,.ofm_minibtn,.ofm_prog i{transition:none!important}.ofm_kpi:hover,.ofm_kpi:hover .ofm_kpivalue{transform:none}}

/* ==== V5 INSTRUMENT START ==== */
/* 精密仪器·样板间覆盖层：1px细边+内高光，无外投影；颜色全部听宿主 var(--dsw-alias-*)。
   夜(暗)高光更刃、纹理更显；昼(亮)高光收敛、纹理近乎哑。reduced-motion 去位移留状态。 */

/* ── ① 面板卡片 .ofm_panel / .ofm_card ─────────────────────────── */
/* 双基底：拉丝细纹(repeating-linear-gradient)垫底，实体色覆盖在上，从边缘隐约透出拉丝感 */
.ofm_root .ofm_panel{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%), inset 0 -14px 28px -18px rgb(0 0 0 / 16%) !important;
  transition: border-color .22s var(--ease-instrument), box-shadow .26s var(--ease-instrument), transform .22s var(--ease-instrument) !important;
}
.ofm_root .ofm_card{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-3) 84%, transparent) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%), inset 0 -12px 24px -16px rgb(0 0 0 / 14%) !important;
  transition: transform .22s var(--ease-instrument), box-shadow .26s var(--ease-instrument), border-color .2s var(--ease-instrument) !important;
}
/* hover：kinetic tension —— 位移压浅(-1px)，去掉外投影，靠边色提亮+高光增强传递"浮起" */
.ofm_root .ofm_card:hover{
  transform: translateY(-1px) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 58%, var(--dsw-alias-border-l2)) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 11%), inset 0 -12px 24px -16px rgb(0 0 0 / 10%) !important;
}

/* ── ② 按钮 .ofm_btn ─────────────────────────── */
/* kinetic tension：外壳 active 陷落(scale .985)，内部 ::after 扫光条反向滑过形成"外陷内顶" */
.ofm_root .ofm_btn{
  position: relative !important;
  overflow: hidden !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%) !important;
  transition: transform .16s var(--ease-settle), border-color .2s var(--ease-instrument), background .2s var(--ease-instrument), box-shadow .2s var(--ease-instrument), opacity .16s var(--ease-instrument) !important;
}
.ofm_root .ofm_btn::after{
  content: "" !important;
  position: absolute !important;
  top: 0 !important; bottom: 0 !important;
  left: -60% !important; width: 42% !important;
  background: linear-gradient(100deg, transparent, rgb(255 255 255 / 14%), transparent) !important;
  transform: skewX(-18deg) !important;
  transition: left .5s var(--ease-instrument) !important;
  pointer-events: none !important;
}
/* hover：扫光滑过（exit slower than press）；去掉原外投影，仅留顶部高光 */
.ofm_root .ofm_btn:hover:not(:disabled){
  transform: translateY(-1px) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 10%) !important;
}
.ofm_root .ofm_btn:hover:not(:disabled)::after{
  left: 118% !important;
}
/* active：快速陷落(.09s) + 内阴影加深=物理按压；松开靠 --ease-settle 回弹 */
.ofm_root .ofm_btn:active:not(:disabled){
  transform: scale(.985) !important;
  transition-duration: .09s !important;
  box-shadow: inset 0 2px 5px rgb(0 0 0 / 14%), inset 0 1px 0 rgb(255 255 255 / 3%) !important;
}
/* primary 按钮保留主色渐变，仅把外投影换成更克制的内高光+轻凹槽 */
.ofm_root .ofm_btn.primary{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 22%), inset 0 -10px 18px -12px rgb(0 0 0 / 24%) !important;
}
.ofm_root .ofm_btn.primary:hover:not(:disabled){
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 26%), inset 0 -10px 18px -12px rgb(0 0 0 / 18%) !important;
}

/* ── ③ 表格行 hover .ofm_table tbody tr ─────────────────────────── */
/* 行首 2px 主色竖条用 transform:scaleY 展开(不触发布局)；exit(.12s) 比 entrance(.16s) 快 */
.ofm_root .ofm_table tbody tr{
  transition: background .16s var(--ease-instrument) !important;
}
.ofm_root .ofm_table tbody tr td:first-child{
  position: relative !important;
}
.ofm_root .ofm_table tbody tr td:first-child::before{
  content: "" !important;
  position: absolute !important;
  left: 0 !important; top: 6px !important; bottom: 6px !important;
  width: 2px !important; border-radius: 2px !important;
  background: var(--dsw-alias-state-business-primary) !important;
  transform: scaleY(0) !important;
  transform-origin: center !important;
  opacity: 0 !important;
  transition: transform .16s var(--ease-instrument), opacity .12s var(--ease-instrument) !important;
  pointer-events: none !important;
}
.ofm_root .ofm_table tbody tr:hover td:first-child::before{
  transform: scaleY(1) !important;
  opacity: 1 !important;
}
/* 数字列表针走格感：tabular-nums + pl5-tick 机械顿挫(steps) */
.ofm_root .ofm_table td{
  font-variant-numeric: tabular-nums !important;
}
/* 表针走格：离散百分比快照模拟 steps 顿挫——同值连帧=停格，瞬间跳格=机械感；@keyframes 里用不了 steps() 函数，用帧堆出来 */
@keyframes pl5-tick{
  0%,24%{ transform: translateY(0); }
  25%,54%{ transform: translateY(-1.5px); }
  55%,79%{ transform: translateY(-.75px); }
  80%,100%{ transform: translateY(0); }
}

/* ── 昼(not-dark)收敛：高光更哑、拉丝更隐、回弹更小 ─────────────── */
@media not (prefers-color-scheme: dark){
  .ofm_root .ofm_panel,
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, transparent) !important;
  }
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-3) 88%, transparent) !important;
  }
  .ofm_root .ofm_panel{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 45%), inset 0 -14px 28px -18px rgb(0 0 0 / 7%) !important;
  }
  .ofm_root .ofm_card{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 50%), inset 0 -12px 24px -16px rgb(0 0 0 / 6%) !important;
  }
  .ofm_root .ofm_card:hover{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 60%), inset 0 -12px 24px -16px rgb(0 0 0 / 5%) !important;
  }
  .ofm_root .ofm_btn{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 50%) !important;
  }
  .ofm_root .ofm_btn:hover:not(:disabled){
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 62%) !important;
  }
}

/* ── reduced-motion 降级：去位移/回弹/扫光/顿挫，保留颜色与不透明度反馈 ── */
@media (prefers-reduced-motion: reduce){
  /* 统一过渡降级：所有交互件只留颜色/不透明度反馈，去位移 */
  .ofm_root .ofm_card,
  .ofm_root .ofm_panel,
  .ofm_root .ofm_btn,
  .ofm_root .ofm_table tbody tr,
  .ofm_root .ofm_table tbody tr td:first-child::before,
  .ofm_root .ofm_switch i,
  .ofm_root .ofm_switch i::after,
  .ofm_root .ofm_seg button,
  .ofm_root .ofm_stat,
  .ofm_root .ofm_kvc,
  .ofm_root .ofm_input,
  .ofm_root .ofm_starbtn,
  .ofm_root .ofm_chanlogo{
    transition: border-color .12s ease, background .12s ease, box-shadow .12s ease, opacity .12s ease, color .12s ease !important;
  }
  /* 去位移/回弹/陷落 */
  .ofm_root .ofm_card:hover,
  .ofm_root .ofm_btn:hover:not(:disabled),
  .ofm_root .ofm_btn:active:not(:disabled),
  .ofm_root .ofm_stat:hover,
  .ofm_root .ofm_kvc:hover,
  .ofm_root .ofm_seg button:active:not([aria-pressed="true"]),
  .ofm_root .ofm_starbtn:active,
  .ofm_root .ofm_chan:hover .ofm_chanlogo{
    transform: none !important;
  }
  /* 开关捏扁还原 */
  .ofm_root .ofm_switch:active i::after{
    width: 14px !important;
  }
  /* 扫光条砍掉 */
  .ofm_root .ofm_btn::after,
  .ofm_root .ofm_starbtn::after{
    content: none !important;
  }
  /* 呼吸灯停跳，但保留颜色状态 */
  .ofm_root .ofm_dot.ok{
    animation: none !important;
    opacity: 1 !important;
  }
  /* 表针走格动画停走，但保留数字本身 */
  .ofm_root .ofm_kpi:hover .ofm_kpivalue,
  .ofm_root .ofm_stat:hover b{
    animation: none !important;
  }
}

/* ── ④ 输入框 .ofm_input：仪器凹槽手感 ─────────────────────────── */
/* 常态凹槽(inset 顶高光+底内阴影)；focus 时凹槽不动，只换边色+外发光，像仪器被点亮 */
.ofm_root .ofm_input{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%), inset 0 2px 6px -2px rgb(0 0 0 / 10%) !important;
  transition: border-color .18s var(--ease-instrument), box-shadow .2s var(--ease-instrument), background .18s var(--ease-instrument) !important;
}
.ofm_root .ofm_input:hover{
  border-color: color-mix(in srgb, var(--dsw-alias-border-l2) 55%, var(--dsw-alias-state-business-primary)) !important;
}
.ofm_root .ofm_input:focus{
  border-color: var(--dsw-alias-state-business-primary) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%), inset 0 2px 6px -2px rgb(0 0 0 / 8%), 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-business-primary) 16%, transparent) !important;
}

/* ── ⑤ 开关 .ofm_switch：spring 滑块阻尼 ─────────────────────────── */
/* 滑块用 --ease-settle 带回弹；按下时滑块变宽=被"捏扁"，松开回弹归位 */
.ofm_root .ofm_switch i{
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 10%), inset 0 -1px 0 rgb(255 255 255 / 4%) !important;
  transition: background .22s var(--ease-instrument), border-color .22s var(--ease-instrument), box-shadow .22s var(--ease-instrument) !important;
}
.ofm_root .ofm_switch i::after{
  background: var(--dsw-alias-label-primary) !important;
  box-shadow: 0 1px 3px rgb(0 0 0 / 28%), inset 0 1px 0 rgb(255 255 255 / 20%) !important;
  transition: transform .28s var(--ease-settle), background .2s var(--ease-instrument), width .14s var(--ease-instrument) !important;
}
.ofm_root .ofm_switch[aria-checked="true"] i{
  box-shadow: inset 0 1px 3px rgb(0 0 0 / 14%), inset 0 -1px 0 rgb(255 255 255 / 8%) !important;
}
.ofm_root .ofm_switch[aria-checked="true"] i::after{
  background: var(--dsw-alias-label-on-accent, #fff) !important;
}
.ofm_root .ofm_switch:active i::after{
  width: 17px !important;
}

/* ── ⑥ 徽章/药丸/标签 .ofm_badge/.ofm_pill/.ofm_tag/.ofm_chantag/.ofm_chip ── */
/* 统一加顶部发丝高光；状态色只用 color-mix 调透明度，不换色相 */
.ofm_root .ofm_pill,
.ofm_root .ofm_tag,
.ofm_root .ofm_chip,
.ofm_root .ofm_chantag{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 5%) !important;
  transition: border-color .2s var(--ease-instrument), color .2s var(--ease-instrument), background .2s var(--ease-instrument), transform .18s var(--ease-settle) !important;
}
.ofm_root .ofm_badge{
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 6%) !important;
  transition: border-color .2s var(--ease-instrument), color .2s var(--ease-instrument), background .2s var(--ease-instrument) !important;
}
/* 状态点呼吸灯保留，但改成 pl5- 前缀、机械顿挫更明显的两拍节奏 */
@keyframes pl5-dot-breathe{
  0%,100%{ opacity:1; }
  50%{ opacity:.45; }
}
.ofm_root .ofm_dot.ok{
  animation: pl5-dot-breathe 2.4s cubic-bezier(.4,0,.6,1) infinite !important;
}
/* 分段控件选中块：加顶部高光，按下时微微陷落 */
.ofm_root .ofm_seg button[aria-pressed="true"]{
  box-shadow: 0 1px 3px rgb(0 0 0 / 10%), inset 0 1px 0 rgb(255 255 255 / 8%) !important;
  transition: color .18s var(--ease-instrument), background .18s var(--ease-instrument), box-shadow .2s var(--ease-settle) !important;
}
.ofm_root .ofm_seg button:active:not([aria-pressed="true"]){
  transform: scale(.97) !important;
}

/* ── ⑦ 原生件接管：滚动条 / selection / caret / 聚焦环 ─────────────── */
/* 滚动条：仪器滑轨——thumb 加顶部高光与底部凹槽，hover 时轻微增亮 */
.ofm_root ::-webkit-scrollbar-thumb{
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 30%, transparent) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%), inset 0 -1px 0 rgb(0 0 0 / 10%) !important;
  transition: background .2s var(--ease-instrument) !important;
}
.ofm_root ::-webkit-scrollbar-thumb:hover{
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary) 48%, transparent) !important;
}
/* 文本选择：主色薄涂，昼模式再淡一点避免刺眼 */
.ofm_root ::selection{
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 20%, transparent) !important;
}
/* 光标：跟随主色 */
.ofm_root input, .ofm_root textarea{
  caret-color: var(--dsw-alias-state-business-primary) !important;
}
/* 聚焦环：仪器刻度环——细环+外晕，用 --ease-instrument 淡入 */
.ofm_root :focus-visible{
  outline: 2px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 72%, transparent) !important;
  outline-offset: 2px !important;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent) !important;
  transition: box-shadow .18s var(--ease-instrument), outline-color .18s var(--ease-instrument) !important;
}

/* ── ⑧【师傅批改①】拉丝纹理增强：金属感要真的能摸到 ─────────────── */
/* 夜模式 3% → 4.5%，昼模式 1.5% → 2.8%，纹理间隔收紧让拉丝更密 */
.ofm_root .ofm_panel{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-2) 86%, transparent) !important;
}
.ofm_root .ofm_card{
  background:
    repeating-linear-gradient(115deg, rgb(255 255 255 / 4.5%) 0 1px, transparent 1px 2.5px) padding-box,
    color-mix(in srgb, var(--dsw-alias-bg-layer-3) 84%, transparent) !important;
}
@media not (prefers-color-scheme: dark){
  .ofm_root .ofm_panel,
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-2) 90%, transparent) !important;
  }
  .ofm_root .ofm_card{
    background:
      repeating-linear-gradient(115deg, rgb(255 255 255 / 4%) 0 1px, transparent 1px 2.5px) padding-box,
      color-mix(in srgb, var(--dsw-alias-bg-layer-3) 88%, transparent) !important;
  }
}

/* ── ⑧【师傅批改②】昼模式高光压暗：45-62% → 30-38%，更克制 ─────────── */
@media not (prefers-color-scheme: dark){
  .ofm_root .ofm_panel{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 34%), inset 0 -14px 28px -18px rgb(0 0 0 / 6%) !important;
  }
  .ofm_root .ofm_card{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 38%), inset 0 -12px 24px -16px rgb(0 0 0 / 5%) !important;
  }
  .ofm_root .ofm_card:hover{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 42%), inset 0 -12px 24px -16px rgb(0 0 0 / 4%) !important;
  }
  .ofm_root .ofm_btn{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 36%) !important;
  }
  .ofm_root .ofm_btn:hover:not(:disabled){
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 44%) !important;
  }
  .ofm_root .ofm_pill,
  .ofm_root .ofm_tag,
  .ofm_root .ofm_chip,
  .ofm_root .ofm_chantag,
  .ofm_root .ofm_badge{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 30%) !important;
  }
  .ofm_root .ofm_input{
    box-shadow: inset 0 1px 0 rgb(255 255 255 / 34%), inset 0 2px 6px -2px rgb(0 0 0 / 6%) !important;
  }
}

/* ── ⑧【师傅批改③】表格竖条语言统一：所有表格行 hover 都带主色竖条 ── */
/* .ofm_newsbody table 是内容型表格，保持朴素；仅给数据表 .ofm_table 统一竖条。
   同时把 .ofm_kvc / .ofm_stat 等"类表格"卡片也纳入 hover 微提亮，保持语言一致 */
.ofm_root .ofm_stat,
.ofm_root .ofm_kvc{
  transition: border-color .2s var(--ease-instrument), box-shadow .22s var(--ease-instrument), transform .2s var(--ease-settle) !important;
}
.ofm_root .ofm_stat:hover,
.ofm_root .ofm_kvc:hover{
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 38%, var(--dsw-alias-border-l1)) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%) !important;
  transform: translateY(-1px) !important;
}

/* ── ⑩【返工·收编租界】星按钮/导航标/渠道标 全部听宿主变量 ─────────────── */
/* L1130 .ofm_starbtn:hover 混 #3ECFA0、L1181 .ofm_navmark 混 #3ECFA0 —— 统一改混 label-primary，零品牌色 */
.ofm_root .ofm_starbtn{
  transition: transform .16s var(--ease-settle), box-shadow .2s var(--ease-instrument), color .2s var(--ease-instrument), background .2s var(--ease-instrument) !important;
}
.ofm_root .ofm_starbtn:hover{
  background: linear-gradient(140deg, var(--dsw-alias-state-business-primary), color-mix(in srgb, var(--dsw-alias-state-business-primary) 76%, var(--dsw-alias-label-primary))) !important;
  color: var(--dsw-alias-label-on-accent, #fff) !important;
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-business-primary) 10%, transparent), 0 6px 16px color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent) !important;
}
.ofm_root .ofm_starbtn:active{
  transform: scale(.97) !important;
}
/* 扫光条改走 --ease-instrument，与 .ofm_btn 同语言 */
.ofm_root .ofm_starbtn::after{
  transition: left .5s var(--ease-instrument) !important;
}
/* 导航标：去掉 #3ECFA0 混色，改混 label-primary；外投影换成内高光+轻凹槽 */
.ofm_root .ofm_navmark{
  background: linear-gradient(145deg, var(--dsw-alias-state-business-primary), color-mix(in srgb, var(--dsw-alias-state-business-primary) 58%, var(--dsw-alias-label-primary))) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 26%), inset 0 -6px 12px -8px rgb(0 0 0 / 20%) !important;
}
.ofm_root .ofm_navmark svg{
  fill: var(--dsw-alias-label-on-accent, #fff) !important;
}
/* 渠道标：--chan-accent 兜底本来就是宿主变量，收编写死的 #fff / #101828，外投影换内高光 */
.ofm_root .ofm_chanlogo{
  color: var(--dsw-alias-label-on-accent, #fff) !important;
  background: linear-gradient(150deg, var(--chan-accent, var(--dsw-alias-state-business-primary)), color-mix(in srgb, var(--chan-accent, var(--dsw-alias-state-business-primary)) 52%, var(--dsw-alias-bg-layer-3))) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 24%), inset 0 -8px 14px -10px rgb(0 0 0 / 22%) !important;
  transition: transform .3s var(--ease-settle) !important;
}
.ofm_root .ofm_chan:hover .ofm_chanlogo{
  transform: scale(1.05) rotate(-2deg) !important;
}

/* ── ⑩【返工·收编 SEASON 落地件】色板/选中 chip/渠道卡顶条 ─────────────── */
/* SEASON 数组在 JS(L1663) 里、靠内联 style 注入，CSS 改不了值；
   收编它落地的元素，让质感听宿主：色板加高光、chip 选中不再花、渠道卡顶条收敛 */
.ofm_root .ofm_swatch{
  border-radius: 3px !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 30%), inset 0 -1px 0 rgb(0 0 0 / 16%) !important;
}
/* chip 选中态：JS 注入彩色背景，这里压回宿主语言——主色薄涂+主色边，去掉杂色 */
.ofm_root .ofm_chip[aria-pressed="true"]{
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent) !important;
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 55%, transparent) !important;
  color: var(--dsw-alias-state-business-primary) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 8%) !important;
}
/* 渠道卡顶条(::before 用 --chan-accent)：收敛高度与发光，听宿主凹槽语言 */
.ofm_root .ofm_chan::before{
  height: 2px !important;
  box-shadow: 0 1px 0 rgb(255 255 255 / 6%) !important;
}
.ofm_root .ofm_chan[data-state="on"]{
  border-color: color-mix(in srgb, var(--chan-accent, var(--dsw-alias-state-business-primary)) 30%, var(--dsw-alias-border-l2)) !important;
  box-shadow: inset 0 1px 0 rgb(255 255 255 / 7%) !important;
}

/* ── ⑩【返工·接上 pl5-tick】KPI/统计数字获得表针走格感 ─────────────── */
/* 挂到 KPI 大数字与统计卡数字：hover 时数字以机械顿挫走一格，模拟仪表指针跳动 */
.ofm_root .ofm_kpivalue,
.ofm_root .ofm_stat b{
  display: inline-block !important;
}
.ofm_root .ofm_kpi:hover .ofm_kpivalue,
.ofm_root .ofm_stat:hover b{
  animation: pl5-tick .34s var(--ease-instrument) 1 !important;
}
/* ==== V5 INSTRUMENT END ==== */
/* ── 聚合渠道 / 省 Token / 路由：新页面的表面 ─────────────────────────────
   动效一律走 150–250ms 的短过渡，不弹跳；reduced-motion 下由文件末尾的
   媒体查询整体关掉。ofm_rise 用 backwards 而不是 both：动画结束后元素回到
   样式表里的 transform，卡片的 hover 抬升才不会被动画的终态钉死。 */
.ofm_rise{animation:ofmrisein .22s cubic-bezier(.22,.61,.36,1) backwards}
@keyframes ofmrisein{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ofm_duo{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(272px,100%),1fr));gap:12px;align-items:start}
.ofm_duo>*{min-width:0}
.ofm_picklist{display:grid;grid-template-columns:repeat(auto-fill,minmax(228px,1fr));gap:8px;max-height:330px;overflow:auto;padding:2px}
.ofm_pickrow{display:flex;flex-direction:column;gap:5px;align-items:stretch;text-align:left;font:inherit;padding:9px 11px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);color:var(--dsw-alias-label-primary);cursor:pointer;transition:border-color .16s ease,background .16s ease,transform .16s ease}
.ofm_pickrow:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);transform:translateY(-1px)}
.ofm_pickrow[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.ofm_pickrow:disabled{opacity:.55;cursor:default}
.ofm_pickhead{display:flex;align-items:center;gap:7px;min-width:0}
.ofm_pickhead b{font-size:12.5px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_pickmeta{display:flex;gap:7px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary);min-width:0}
.ofm_picknote{font-size:10.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.ofm_meter{height:9px;border-radius:99px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);overflow:hidden}
.ofm_meter i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,transparent),var(--dsw-alias-state-business-primary));transition:width .55s cubic-bezier(.22,.61,.36,1)}
.ofm_member{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 82%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 58%,transparent);font-size:11.5px;transition:border-color .16s ease,background .16s ease}
.ofm_member .ofm_id{flex:1;min-width:0}
.ofm_snippet{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.6;padding:9px 11px;border-radius:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:pre;overflow:auto;max-height:230px}
@media (max-width:600px){.ofm_duo{grid-template-columns:1fr}.ofm_picklist{grid-template-columns:1fr}.ofm_member{flex-wrap:wrap}}
@media (prefers-reduced-motion:reduce){.ofm_rise,.ofm_page{animation:none}.ofm_pickrow,.ofm_member,.ofm_meter i,.ofm_card,.ofm_kpi,.ofm_chan{transition:none}.ofm_root .ofm_card:hover,.ofm_pickrow:hover:not(:disabled){transform:none}}

/* ── 推荐项目页：两张「去点 Star」的卡片 ─────────────────────────────────
   这一页只有一件事要促成——点开仓库、点下 Star。所以卡片比常规模型卡大一档，
   入场逐张错峰（--i 由调用方给），悬停抬升；主 CTA 是渐变星按钮，带一圈呼吸
   光环与悬停扫光；数字用 count-up 落地。全部只动 transform/opacity/颜色。
   动效降级：文件末尾的 reduced-motion 块统一关掉位移与动画。 */
.ofm_recogrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(360px,100%),1fr));gap:14px;align-items:stretch}
.ofm_recocard{position:relative;display:flex;flex-direction:column;gap:12px;padding:18px;border-radius:18px;border:1px solid var(--dsw-alias-border-l2);background:linear-gradient(168deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 86%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-2) 80%,transparent));box-shadow:inset 0 1px 0 rgb(255 255 255 / 7%),0 2px 8px rgb(0 0 0 / 5%),0 14px 34px color-mix(in srgb,var(--dsw-alias-state-business-primary) 6%,transparent);overflow:hidden;animation:ofm-reco-in .5s var(--ease-instrument) backwards;animation-delay:calc(var(--i,0)*90ms);transition:transform .24s var(--ease-instrument),box-shadow .28s ease,border-color .2s ease}
.ofm_recocard::before{content:"";position:absolute;inset:-45% 45% 50% -35%;pointer-events:none;opacity:0;background:radial-gradient(58% 58% at 32% 32%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent),transparent 72%);transition:opacity .4s ease}
.ofm_recocard:hover::before{opacity:1}
.ofm_recocard:hover{transform:translateY(-3px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 10%),0 18px 44px color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent)}
@keyframes ofm-reco-in{from{opacity:0;transform:translateY(16px) scale(.985)}to{opacity:1;transform:none}}
.ofm_recotop{display:flex;align-items:center;gap:11px;min-width:0}
.ofm_recomark{display:flex;align-items:center;justify-content:center;width:42px;height:42px;flex:none;border-radius:13px;color:var(--dsw-alias-label-on-accent,#fff);background:linear-gradient(145deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-label-primary)));box-shadow:inset 0 1px 0 rgb(255 255 255 / 28%),0 4px 12px color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent);transition:transform .3s var(--ease-settle)}
.ofm_recomark svg{width:22px;height:22px;fill:currentColor}
.ofm_recocard:hover .ofm_recomark{transform:rotate(-4deg) scale(1.06)}
.ofm_recoid{display:flex;flex-direction:column;gap:2px;min-width:0}
.ofm_reconame{font-size:15px;font-weight:700;letter-spacing:-.2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_recorepo{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ofm_recobadge{margin-left:auto;flex:none;font-size:10.5px;font-weight:650;padding:3px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent);color:var(--dsw-alias-state-business-primary);white-space:nowrap}
.ofm_recotagline{margin:0;font-size:13.5px;font-weight:650;line-height:1.5;letter-spacing:-.1px}
.ofm_recobody{margin:0;flex:1;font-size:12px;line-height:1.75;color:var(--dsw-alias-label-secondary)}
.ofm_recochips{display:flex;gap:6px;flex-wrap:wrap}
.ofm_recochip{font-size:10.5px;padding:3px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 66%,transparent);color:var(--dsw-alias-label-secondary);transition:border-color .16s ease,color .16s ease,transform .16s ease}
.ofm_recochip:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,var(--dsw-alias-border-l1));color:var(--dsw-alias-label-primary);transform:translateY(-1px)}
.ofm_recofoot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:auto;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1)}
.ofm_recofacts{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ofm_recofact{display:flex;align-items:baseline;gap:5px}
.ofm_recofact b{font-size:13.5px;font-weight:700;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.ofm_recoacts{display:flex;gap:8px;align-items:center;margin-left:auto}
.ofm_recogo{display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 58%,transparent);color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;text-decoration:none;white-space:nowrap;transition:border-color .16s ease,color .16s ease,transform .16s ease,background .16s ease}
.ofm_recogo:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 50%,var(--dsw-alias-border-l2));color:var(--dsw-alias-label-primary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent);transform:translateY(-1px)}
.ofm_recogo svg{width:12px;height:12px;fill:currentColor;opacity:.7;transition:transform .2s var(--ease-instrument)}
.ofm_recogo:hover svg{transform:translateX(2px)}
.ofm_recostar{position:relative;display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:999px;overflow:hidden;font-size:13px;font-weight:700;letter-spacing:.1px;text-decoration:none;white-space:nowrap;color:var(--dsw-alias-label-on-accent,#fff);background:linear-gradient(135deg,var(--dsw-alias-state-business-primary),color-mix(in srgb,var(--dsw-alias-state-business-primary) 58%,var(--dsw-alias-label-primary)));box-shadow:inset 0 1px 0 rgb(255 255 255 / 26%),0 6px 18px color-mix(in srgb,var(--dsw-alias-state-business-primary) 28%,transparent);transition:transform .18s var(--ease-settle),box-shadow .24s var(--ease-instrument),filter .2s ease}
.ofm_recostar:hover{transform:translateY(-2px) scale(1.02);filter:saturate(1.06);box-shadow:inset 0 1px 0 rgb(255 255 255 / 32%),0 12px 28px color-mix(in srgb,var(--dsw-alias-state-business-primary) 34%,transparent)}
.ofm_recostar:active{transform:scale(.97)}
.ofm_recostar svg{width:16px;height:16px;fill:currentColor;transition:transform .5s var(--ease-settle)}
.ofm_recostar:hover svg{transform:rotate(72deg) scale(1.15)}
.ofm_recostar::after{content:"";position:absolute;top:0;bottom:0;width:36%;left:-45%;pointer-events:none;background:linear-gradient(100deg,transparent,rgb(255 255 255 / 38%),transparent);transform:skewX(-18deg);transition:left .6s var(--ease-instrument)}
.ofm_recostar:hover::after{left:115%}
.ofm_recostarring{position:absolute;inset:0;border-radius:inherit;pointer-events:none;border:1px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 62%,transparent);animation:ofm-reco-ring 2.8s var(--ease-instrument) infinite}
@keyframes ofm-reco-ring{0%{opacity:.6;transform:scale(1)}70%,100%{opacity:0;transform:scale(1.22)}}
.ofm_recoglow{position:absolute;inset:-50% -12% auto;height:175%;z-index:0;pointer-events:none;background:radial-gradient(42% 52% at 24% 62%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent),transparent 70%),radial-gradient(38% 46% at 78% 38%,color-mix(in srgb,var(--dsw-alias-state-success-primary) 11%,transparent),transparent 72%);filter:blur(10px);animation:ofm-reco-aurora 18s ease-in-out infinite alternate}
@keyframes ofm-reco-aurora{from{transform:translate3d(-3%,1%,0) scale(1)}to{transform:translate3d(3%,-2%,0) scale(1.08)}}
.ofm_reconote{margin:0;font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
@media (max-width:600px){.ofm_recogrid{grid-template-columns:1fr}.ofm_recoacts{width:100%;margin-left:0}}
@media (prefers-reduced-motion:reduce){.ofm_recocard,.ofm_recostar,.ofm_recogo,.ofm_recochip,.ofm_recomark{animation:none;transition:border-color .12s ease,background .12s ease,box-shadow .12s ease,opacity .12s ease,color .12s ease}.ofm_recocard:hover,.ofm_recostar:hover,.ofm_recostar:active,.ofm_recogo:hover,.ofm_recochip:hover,.ofm_recocard:hover .ofm_recomark{transform:none}.ofm_recostar::after,.ofm_recostarring,.ofm_recoglow{display:none}}

/* 装饰特效默认关闭；鱼缸独立保留。布局用的 transform 不受影响。 */
.ofm_navtools{grid-column:2;grid-row:1;display:flex;align-items:center;justify-self:end;gap:12px;flex-wrap:wrap}
.ofm_root[data-ofm-effects="off"]::before{content:none}
.ofm_root[data-ofm-effects="off"],
.ofm_root[data-ofm-effects="off"] :not(.ofm_tank):not(.ofm_tank *){
 backdrop-filter:none!important;-webkit-backdrop-filter:none!important;filter:none!important;
 animation:none!important;transition:none!important;will-change:auto!important;
}
.ofm_root[data-ofm-effects="off"] :not(.ofm_tank):not(.ofm_tank *)::before,
.ofm_root[data-ofm-effects="off"] :not(.ofm_tank):not(.ofm_tank *)::after{
 animation:none!important;transition:none!important;filter:none!important;
}
.ofm_root[data-ofm-effects="off"] :is(.ofm_nav,.ofm_panel,.ofm_hero,.ofm_glass){background:var(--dsw-alias-bg-layer-2)!important}
.ofm_root[data-ofm-effects="off"] :is(.ofm_recoglow,.ofm_recostarring){display:none!important}
.ofm_root[data-ofm-effects="off"] :not(.ofm_tank):not(.ofm_tank *):is(:hover,:active){transform:none!important}
.ofm_root[data-ofm-effects="off"] :is(.ofm_btn,.ofm_starbtn)::after{content:none!important}
.ofm_tank[data-ofm-motion="off"] *{animation-play-state:paused!important}
.ofm_root[data-ofm-active="false"] *,
.ofm_root[data-ofm-active="false"] *::before,
.ofm_root[data-ofm-active="false"] *::after{animation-play-state:paused!important}
@media(prefers-reduced-motion:reduce){
 .ofm_root *,.ofm_root *::before,.ofm_root *::after{animation:none!important;transition:none!important}
}

/* Preserve the upstream horizontal navigation within narrow settings panes. */
.ofm_root.ofm_shell{width:100%;min-width:0;letter-spacing:0}
.ofm_shell .ofm_navbrand{min-width:0;white-space:normal;letter-spacing:0}
.ofm_shell .ofm_tabs{min-width:0}
.ofm_shell .ofm_tab{letter-spacing:0}
.ofm_workspace{min-width:0;max-width:100%;overflow-wrap:anywhere}
.ofm_workspace>.ofm_page{min-width:0;width:100%}
.ofm_modelworkspace{min-width:0;gap:12px}
.ofm_workspacetabs{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ofm_workspacetab{position:relative;font:inherit;font-size:12px;font-weight:600;letter-spacing:0;cursor:pointer;padding:8px 14px;border:1px solid transparent;border-radius:8px;color:var(--dsw-alias-label-secondary);background:transparent;transition:color .18s ease,background-color .18s ease,border-color .18s ease}
.ofm_workspacetab::after{content:"";position:absolute;left:14px;right:14px;bottom:-9px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-state-business-primary);transform:scaleX(0);transform-origin:center;transition:transform .24s cubic-bezier(.3,.7,.3,1)}
.ofm_workspacetab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.ofm_workspacetab[aria-selected="true"]{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}
.ofm_workspacetab[aria-selected="true"]::after{transform:scaleX(1)}
.ofm_workspacetab:focus-visible,.ofm_tab:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.ofm_workspaceview{min-width:0;animation:ofm_workspaceview_in .28s ease}
.ofm_workspaceview[hidden]{display:none}
@keyframes ofm_workspaceview_in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.ofm_enginebar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;min-height:32px;margin-bottom:0}
.ofm_enginebar h2{display:flex;align-items:center;gap:9px;margin:0;font-size:18px;font-weight:650}
.ofm_enginebar h2::before{content:"";width:9px;height:9px;border-radius:3px;flex:none;background:linear-gradient(135deg,var(--dsw-alias-state-business-primary),var(--dsw-alias-state-success-primary))}
.ofm_engineworkspace{gap:8px}
.ofm_enginetools{display:flex;align-items:center;gap:4px;flex:none}
.ofm_engineicon{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;transition:color .16s ease,background-color .16s ease,border-color .16s ease,transform .12s ease,box-shadow .16s ease}
.ofm_engineicon:hover{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);transform:translateY(-1px)}
.ofm_engineicon:active{transform:translateY(0) scale(.96)}
.ofm_engineicon:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.ofm_engineicon svg{display:block;width:16px;height:16px;transition:transform .3s ease}
.ofm_engineicon:hover svg{transform:rotate(12deg)}
.ofm_engineframe{display:block;width:100%;height:clamp(420px,calc(100dvh - 340px),900px);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color-scheme:normal;animation:ofm_engineframe_in .4s ease}
@keyframes ofm_engineframe_in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ofm_engineempty{display:flex;flex-direction:column;align-items:flex-start;gap:14px;padding:34px 26px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;animation:ofm_workspaceview_in .3s ease}
.ofm_enginestarting{display:inline-flex;align-items:center;gap:9px}
.ofm_enginestarting::before{content:"";width:13px;height:13px;border-radius:50%;flex:none;border:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 32%,transparent);border-top-color:var(--dsw-alias-state-business-primary);animation:ofm_engine_spin .9s linear infinite}
@keyframes ofm_engine_spin{to{transform:rotate(360deg)}}
.ofm_engineoverlay{position:fixed!important;inset:0;z-index:1900!important;display:flex!important;flex-direction:column;box-sizing:border-box;width:100%!important;max-width:none!important;min-height:0;padding:12px 16px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);gap:10px;animation:ofm_engineoverlay_in .26s cubic-bezier(.2,.9,.3,1)}
@keyframes ofm_engineoverlay_in{from{opacity:0;transform:scale(.985)}to{opacity:1;transform:none}}
.ofm_engineoverlay .ofm_enginebar{flex:none}
.ofm_engineoverlay .ofm_engineframe{height:100%;min-height:0;flex:1}
.ofm_directory>*{animation:ofmrisein .3s ease backwards}
.ofm_directory>*:nth-child(2){animation-delay:.03s}
.ofm_directory>*:nth-child(3){animation-delay:.06s}
.ofm_directory>*:nth-child(4){animation-delay:.09s}
.ofm_directory>*:nth-child(5){animation-delay:.12s}
.ofm_directory>*:nth-child(6){animation-delay:.15s}
.ofm_directory>*:nth-child(n+7){animation-delay:.18s}
.ofm_directory .ofm_chan.compact,.ofm_directory .ofm_provider{transition:border-color .18s ease,box-shadow .18s ease,transform .18s ease}
.ofm_directory .ofm_chan.compact:hover,.ofm_directory .ofm_provider:hover{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,var(--dsw-alias-border-l2));box-shadow:0 4px 16px rgb(0 0 0 / 7%);transform:translateY(-1px)}
.ofm_subaccount{animation:ofmrisein .3s ease backwards}
.ofm_subaccount:nth-child(2){animation-delay:.04s}
.ofm_subaccount:nth-child(3){animation-delay:.08s}
.ofm_subaccount:nth-child(n+4){animation-delay:.12s}
.ofm_subwindow progress{transition:opacity .3s ease}
.ofm_shell .ofm_grid{grid-template-columns:repeat(auto-fill,minmax(min(252px,100%),1fr))}
.ofm_shell :is(input,textarea,select){max-width:100%}
@media(max-width:420px){
 .ofm_shell .ofm_nav{gap:8px;padding:8px}
 .ofm_shell .ofm_navtools{gap:8px}
 .ofm_shell .ofm_navtools .ofm_switch span{display:none}
 .ofm_shell .ofm_navtools .ofm_starbtn{font-size:0;padding:6px;gap:0}
}
`

    // ── helpers ───────────────────────────────────────────────────────────────
    // 用页面 base 解析，而不是 origin-absolute 的「/api/...」：DSH 挂在反向代理
    // 子路径下（https://<host>/<prefix>/）时，前导斜杠会把 <prefix> 丢掉，请求
    // 直接打到站点根被前置网关 404，设置面板报「无法连接插件后端」（#54）。
    // 相对路径随页面 base 走，根路径部署下与原值完全一致。解析不了（无 document
    // 的宿主、非常规 base）就退回根路径原值——行为不比修复前差。
    const API = (() => {
      try { return new URL('api/our-free-model', document.baseURI).pathname } catch { return '/api/our-free-model' }
    })()
    const SEASON = ['#4C8DFF', '#3ECFA0', '#F2A65A', '#E36AA6', '#8B7BF0', '#39B8C4', '#D9743E', '#7BB24A']

    async function api(path, options) {
      // 8 秒超时兜底：后端路由未注册/挂起时 fetch 不再永久挂起——此前全部 api 调用
      // （onboarding /announcement、设置页 /announcements /update/status、面板 /summary /stats
      // /forward/key 等）无任何超时，一个不响应端点即可阻塞 settings.onboarding 协调流程
      // 并长期占用同源连接池。超时按 AbortError 抛给调用方，走各自 .catch 降级路径。
      // 慢路由按需放宽（options.timeout，毫秒）：/bench 要等一整段真实生成（本车道
      // 首帧动辄数十秒），/update/apply 要下载+校验+安装整包，/refresh /reprobe 要
      // 跑完一整轮探测——8 秒兜底套在它们身上只会“前端报失败、后端继续烧”，
      // 测速按钮因此几乎必失败而配额照付。
      const { timeout = 8000, ...fetchOptions } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...fetchOptions, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } finally {
        clearTimeout(timer)
      }
    }

    const post = (path, body, timeout) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      ...body === undefined ? {} : { body: JSON.stringify(body) },
      ...timeout === undefined ? {} : { timeout },
    })

    function useAsync(loader, deps) {
      const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
      const run = useCallback(() => {
        let alive = true
        setState(current => ({ ...current, status: 'loading' }))
        loader().then(data => { if (alive) setState({ status: 'ready', data, error: '' }) })
          .catch(error => { if (alive) setState({ status: 'error', data: undefined, error: String(error?.message ?? error) }) })
        return () => { alive = false }
      }, deps)
      useEffect(() => run(), [run])
      return { ...state, reload: run }
    }

    function kilo(value) {
      const n = Math.round(Number(value) || 0)
      if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
      if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K`
      return String(n)
    }

    function ago(ts, locale) {
      if (!ts) return '—'
      const seconds = Math.max(1, Math.round((Date.now() - ts) / 1000))
      const zh = String(locale ?? '').toLowerCase().startsWith('zh')
      if (seconds < 60) return zh ? `${seconds} 秒前` : `${seconds}s ago`
      const minutes = Math.round(seconds / 60)
      if (minutes < 60) return zh ? `${minutes} 分钟前` : `${minutes}m ago`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return zh ? `${hours} 小时前` : `${hours}h ago`
      return zh ? `${Math.round(hours / 24)} 天前` : `${Math.round(hours / 24)}d ago`
    }

    function copy(text, done) {
      const finish = ok => done(ok)
      if (navigator?.clipboard?.writeText !== undefined) {
        navigator.clipboard.writeText(text).then(() => finish(true), () => finish(legacy(text)))
        return
      }
      finish(legacy(text))
    }
    function legacy(text) {
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch { return false }
    }

    // ── announcement HTML: strict allowlist, no innerHTML sink ───────────────
    // The feed is authored by the repository owner, but rendering is a trust
    // boundary of its own: the feed URL can be pointed anywhere, and a
    // compromised repository must never become script execution. Nothing here
    // hands a string to the HTML engine — the tokenizer walks the text, drops
    // everything off the allowlist, and builds a virtual tree that both React
    // and plain DOM can materialize. The same parser is exercised headlessly
    // by scripts/sanitize-test.mjs.
    const ALLOWED_TAGS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul'])
    /** Everything these elements contain is dropped, closing tag included. */
    const DROP_CONTENT_TAGS = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'textarea', 'title', 'svg', 'math', 'form', 'input', 'button', 'select', 'option', 'video', 'audio', 'canvas', 'link', 'meta', 'base'])
    const VOID_TAGS = new Set(['br', 'hr', 'img'])
    const MAX_HTML_NODES = 4000
    const ALLOWED_STYLE_PROPS = new Set(['color', 'background-color', 'text-align', 'font-weight', 'font-style', 'text-decoration'])
    const STYLE_CAMEL = { 'background-color': 'backgroundColor', 'text-align': 'textAlign', 'font-weight': 'fontWeight', 'font-style': 'fontStyle', 'text-decoration': 'textDecoration', color: 'color' }

    /** http(s), mailto and in-page fragments only; images additionally accept inline PNG/JPEG/GIF/WebP. */
    function safeUrl(raw, isImage) {
      const value = String(raw ?? '').trim()
      if (value === '' || value.length > 2000) return undefined
      const lower = value.toLowerCase()
      if (/^https?:\/\//.test(lower)) return value
      if (lower.startsWith('mailto:') && /^[^@\s]+@[^@\s]+$/.test(value.slice(7))) return value
      if (lower.startsWith('#')) return value
      if (isImage && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) return value
      return undefined
    }

    function sanitizeStyle(raw) {
      const out = {}
      for (const decl of String(raw ?? '').split(';')) {
        const idx = decl.indexOf(':')
        if (idx === -1) continue
        const prop = decl.slice(0, idx).trim().toLowerCase()
        const value = decl.slice(idx + 1).trim()
        if (!ALLOWED_STYLE_PROPS.has(prop) || value === '' || value.length > 120) continue
        if (/url\(|expression|javascript:|@|<|>/.test(value.toLowerCase())) continue
        out[STYLE_CAMEL[prop]] = value
      }
      return out
    }

    function sanitizeAttrs(tag, attrText) {
      const props = {}
      const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
      let match
      while ((match = attrRe.exec(attrText ?? '')) !== null) {
        const key = match[1].toLowerCase()
        const value = match[3] ?? match[4] ?? match[5] ?? ''
        if (key === 'style') {
          const style = sanitizeStyle(value)
          if (Object.keys(style).length > 0) props.style = style
          continue
        }
        if (tag === 'a' && key === 'href') {
          const url = safeUrl(value)
          if (url !== undefined) {
            props.href = url
            props.target = '_blank'
            props.rel = 'noopener noreferrer'
          }
          continue
        }
        if (tag === 'img' && key === 'src') {
          const url = safeUrl(value, true)
          if (url !== undefined) props.src = url
          continue
        }
        if ((tag === 'img' || tag === 'a') && key === 'title') { props.title = value.slice(0, 300); continue }
        if (tag === 'img' && key === 'alt') { props.alt = value.slice(0, 300); continue }
        if ((key === 'width' || key === 'height') && /^\d{1,4}$/.test(value)) { props[key] = Number(value); continue }
      }
      return props
    }

    /**
     * Tokenize announcement HTML into a virtual tree of
     * `{type:'el', tag, props, children}` and `{type:'text', text}` nodes.
     * Disallowed elements are unwrapped (their children survive); the content
     * of raw-text elements such as `<script>` is dropped entirely.
     */
    function parseSafeHtml(html) {
      if (typeof html !== 'string' || html.trim() === '') return []
      const root = { type: 'root', children: [] }
      const stack = [root]
      const top = () => stack[stack.length - 1]
      let nodes = 0
      let skipUntil = null
      const tokenRe = /<!--[\s\S]*?-->|<\/\s*([a-zA-Z][a-zA-Z0-9-]*)\s*>|<\s*([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+)/g
      let match
      while ((match = tokenRe.exec(html)) !== null) {
        if (nodes >= MAX_HTML_NODES) break
        if (match[0].startsWith('<!--')) continue
        if (match[4] !== undefined) {
          if (skipUntil === null) {
            const text = match[4]
            if (text.trim() !== '' || (top().children.length > 0 && typeof top().children[top().children.length - 1] !== 'string')) {
              top().children.push(text)
            }
          }
          continue
        }
        const name = (match[1] ?? match[2] ?? '').toLowerCase()
        if (name === '') continue
        if (match[1] !== undefined) {
          // closing tag
          if (skipUntil !== null) {
            if (name === skipUntil) skipUntil = null
            continue
          }
          if (!ALLOWED_TAGS.has(name)) continue
          let depth = stack.length - 1
          while (depth > 0 && stack[depth].tag !== name) depth -= 1
          if (depth === 0) continue
          while (stack.length - 1 > depth) {
            const dropped = stack.pop()
            top().children.push(...dropped.children)
          }
          const frame = stack.pop()
          top().children.push({ type: 'el', tag: frame.tag, props: frame.props, children: frame.children })
          nodes += 1
          continue
        }
        // opening tag
        if (skipUntil !== null) continue
        if (DROP_CONTENT_TAGS.has(name)) { skipUntil = name; continue }
        if (!ALLOWED_TAGS.has(name)) continue
        const props = sanitizeAttrs(name, match[3])
        if (name === 'img' && props.src === undefined) continue
        if (VOID_TAGS.has(name)) {
          top().children.push({ type: 'el', tag: name, props, children: [] })
          nodes += 1
          continue
        }
        stack.push({ tag: name, props, children: [] })
      }
      while (stack.length > 1) {
        const frame = stack.pop()
        top().children.push(...frame.children)
      }
      return root.children
    }

    /** Materialize the virtual tree as React elements (keys are positional). */
    function htmlToReact(nodes) {
      return nodes.map((node, index) => typeof node === 'string'
        ? node
        : h(node.tag, { key: index, ...node.props }, ...htmlToReact(node.children ?? [])))
    }

    /** Materialize the virtual tree as DOM nodes (for toasts and modals). */
    function htmlToDom(nodes) {
      return nodes.map(node => {
        if (typeof node === 'string') return document.createTextNode(node)
        const el = document.createElement(node.tag)
        for (const [key, value] of Object.entries(node.props ?? {})) {
          if (key === 'style') { Object.assign(el.style, value); continue }
          el.setAttribute(key, String(value))
        }
        for (const child of htmlToDom(node.children ?? [])) el.appendChild(child)
        return el
      })
    }

    // ── toasts: a vanilla-DOM host so pushes surface on every page ───────────
    // Slot content only exists where the shell mounts it; a toast that lived
    // inside the settings section would be invisible everywhere else. This
    // host attaches to document.body, outside the app root, and needs no
    // react-dom — the body renders through the same allowlist parser.
    function toastHost() {
      let host = document.querySelector('.ofm_toasts')
      if (host === null) {
        host = document.createElement('div')
        host.className = 'ofm_toasts'
        document.body.appendChild(host)
      }
      return host
    }

    function showToast({ title, body, html, tone, actions = [], holdMs = 10000 }) {
      try {
        const host = toastHost()
        const card = document.createElement('div')
        card.className = 'ofm_toast' + (tone === undefined ? '' : ` ${tone}`)
        const head = document.createElement('div')
        head.className = 'ofm_toasttitle'
        head.appendChild(document.createTextNode(title ?? ''))
        const close = document.createElement('button')
        close.type = 'button'
        close.className = 'ofm_toastclose'
        // No locale lookup in here on purpose: showToast also runs from the
        // push subscription before any `t` binding is in scope, and a throw
        // inside this try/catch would silently swallow the whole toast.
        close.setAttribute('aria-label', 'close')
        close.title = '✕'
        close.textContent = '✕'
        close.addEventListener('click', () => card.remove())
        head.appendChild(close)
        card.appendChild(head)
        if (body !== undefined && body !== '') {
          const area = document.createElement('div')
          area.className = 'ofm_toastbody'
          area.textContent = String(body)
          card.appendChild(area)
        } else if (html !== undefined) {
          const area = document.createElement('div')
          area.className = 'ofm_toastbody'
          for (const node of htmlToDom(parseSafeHtml(html))) area.appendChild(node)
          card.appendChild(area)
        }
        if (actions.length > 0) {
          const row = document.createElement('div')
          row.className = 'ofm_toastactions'
          for (const action of actions) {
            const btn = document.createElement('button')
            btn.type = 'button'
            btn.className = 'ofm_btn'
            btn.textContent = action.label
            btn.addEventListener('click', () => { card.remove(); action.onClick?.() })
            row.appendChild(btn)
          }
          card.appendChild(row)
        }
        host.appendChild(card)
        while (host.children.length > 4) host.firstElementChild?.remove()
        if (holdMs > 0) {
          const timer = setTimeout(() => card.remove(), holdMs)
          timer.unref?.()
        }
        return card
      } catch { /* a toast must never break its caller */ }
      return undefined
    }

    /** Modal surface for `urgent` announcements; dismiss runs the ack callback. */
    function showUrgentModal({ title, html, confirmLabel, onClose }) {
      try {
        document.querySelector('.ofm_scrim[data-ofm-urgent]')?.remove()
        const scrim = document.createElement('div')
        scrim.className = 'ofm_scrim'
        scrim.setAttribute('data-ofm-urgent', 'true')
        const modal = document.createElement('div')
        modal.className = 'ofm_modal'
        modal.setAttribute('role', 'alertdialog')
        modal.setAttribute('aria-modal', 'true')
        const head = document.createElement('div')
        head.className = 'ofm_modalhead'
        head.textContent = title ?? ''
        const body = document.createElement('div')
        body.className = 'ofm_modalbody'
        for (const node of htmlToDom(parseSafeHtml(html ?? ''))) body.appendChild(node)
        const foot = document.createElement('div')
        foot.className = 'ofm_modalfoot'
        const ok = document.createElement('button')
        ok.type = 'button'
        ok.className = 'ofm_btn primary'
        ok.textContent = confirmLabel ?? 'OK'
        ok.addEventListener('click', () => { scrim.remove(); onClose?.() })
        foot.appendChild(ok)
        modal.appendChild(head)
        modal.appendChild(body)
        modal.appendChild(foot)
        scrim.appendChild(modal)
        document.body.appendChild(scrim)
      } catch { /* a modal must never break its caller */ }
    }

    /** OS-level notification, only when the user both opted in and granted. */
    function osNotify(title, body) {
      try {
        if (typeof Notification !== 'function' || Notification.permission !== 'granted') return
        new Notification(title, { body: String(body ?? '').slice(0, 200) })
      } catch { /* the in-app toast still fires */ }
    }

    const Switch = (props) => h('button', {
      type: 'button',
      className: 'ofm_switch',
      role: 'switch',
      'aria-label': props.label,
      'aria-checked': props.checked ? 'true' : 'false',
      // Several call sites already pass `disabled` (the gateway switch does, while
      // its RPC is in flight) and it was silently dropped, so a switch stayed
      // clickable through a write it could not survive. Passing it through is what
      // those call sites meant.
      disabled: props.disabled === true,
      onClick: props.onChange,
    }, h('i'), props.label === undefined ? null : h('span', null, props.label))

    const Pill = (props) => h('span', { className: `ofm_pill${props.strong ? ' strong' : ''}` },
      props.tone === undefined ? null : h('span', { className: `ofm_dot ${props.tone}` }),
      props.children)

    const Button = props => h('button', {
      type: 'button',
      className: 'ofm_btn' + (props.kind === undefined ? '' : ' ' + props.kind),
      disabled: props.disabled,
      onClick: props.onClick,
      title: props.title,
      'aria-label': props['aria-label'],
    }, props.children)

    function Section(props) {
      return h('section', { className: 'ofm_sec' },
        h('div', { className: 'ofm_sechead' },
          h('span', { className: 'ofm_sec_title' }, props.title),
          props.hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, props.hint)),
        props.children)
    }

    function Panel(props) {
      return h('div', { className: 'ofm_panel' },
        props.title === undefined ? null : h('div', { className: 'ofm_paneltitle' }, props.title, props.hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, props.hint)),
        props.children)
    }

    // ── charts (hand-drawn SVG; the shell ships no plotting primitive) ────────
    function Heatmap(props) {
      const { days, t } = props
      const cells = useMemo(() => buildHeatCells(days), [days])
      const peak = cells.reduce((max, cell) => Math.max(max, cell.total), 0)
      if (cells.length === 0) return h('p', { className: 'ofm_note' }, t('heat.empty'))
      const level = value => value === 0 ? '' : peak === 0 ? '' : value / peak > 0.66 ? 'l4' : value / peak > 0.4 ? 'l3' : value / peak > 0.16 ? 'l2' : 'l1'
      return h(Fragment, null,
        h('div', { className: 'ofm_heat', role: 'img', 'aria-label': t('heat.title') },
          cells.map((cell, index) => h('div', {
            key: `${cell.day}-${index}`,
            className: 'ofm_cell ' + level(cell.total),
            title: `${cell.day} · ${cell.total.toLocaleString()} tokens${cell.models.length ? ` · ${cell.models.join(', ')}` : ''}`,
          }))),
        h('div', { className: 'ofm_scale' }, t('heat.legend'),
          ['l1', 'l2', 'l3', 'l4'].map(cls => h('span', { key: cls, className: `ofm_cell ${cls}` })),
          t('heat.legendMore')))
    }

    /** Column-major local-calendar weeks, from Sunday through today (17 weeks by default). */
    function buildHeatCells(days, span = 119) {
      if (days.length === 0) return []
      const byDay = new Map(days.map(row => [row.day, row]))
      const end = new Date()
      // Noon avoids midnight DST transitions shifting subsequent dates to 01:00.
      end.setHours(12, 0, 0, 0)
      const cells = []
      const start = new Date(end)
      start.setDate(start.getDate() - end.getDay() - (Math.ceil(span / 7) - 1) * 7)
      for (let cursor = new Date(start); cursor <= end; cursor.setDate(cursor.getDate() + 1)) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
        const row = byDay.get(key)
        cells.push({ day: key, total: row?.total ?? 0, models: (row?.models ?? []).filter(m => m.output > 0).map(m => m.model) })
      }
      return cells
    }

    function TrendChart(props) {
      const { series, metric, mode } = props
      const width = 900
      const height = 168
      const pad = { top: 12, right: 8, bottom: 18, left: 40 }
      const rows = series.length === 0 ? [{ day: '', total: 0 }] : series
      const valueOf = row => mode === 'requests'
        ? row.models.reduce((sum, m) => sum + m.calls, 0)
        : metric === 'total' ? row.total : (row.models.find(m => m.model === metric)?.output ?? 0)
      const points = rows.map((row, index) => ({ x: rows.length === 1 ? width / 2 : pad.left + (index / (rows.length - 1)) * (width - pad.left - pad.right), y: 0, value: valueOf(row), day: row.day }))
      const peak = Math.max(1, ...points.map(p => p.value))
      for (const point of points) point.y = pad.top + (1 - point.value / peak) * (height - pad.top - pad.bottom)
      const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
      const area = `${line} L${points[points.length - 1].x.toFixed(1)},${height - pad.bottom} L${points[0].x.toFixed(1)},${height - pad.bottom} Z`
      const color = metric === 'total' ? 'var(--dsw-alias-state-business-primary)' : (props.color ?? 'var(--dsw-alias-state-business-primary)')
      const ticks = [0, 0.5, 1].map(frac => ({ y: pad.top + frac * (height - pad.top - pad.bottom), label: kilo(peak * (1 - frac)) }))
      return h('svg', { className: 'ofm_svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', role: 'img' },
        h('defs', null, h('linearGradient', { id: 'ofmFill', x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { offset: '0%', 'stop-color': color, 'stopOpacity': '0.32' }),
          h('stop', { offset: '100%', 'stop-color': color, 'stopOpacity': '0.02' }))),
        ticks.map(tick => h('g', { key: tick.y },
          h('line', { x1: pad.left, x2: width - pad.right, y1: tick.y, y2: tick.y, stroke: 'var(--dsw-alias-border-l1)', strokeWidth: 1, strokeDasharray: tick.label === '0' ? undefined : '3 4' }),
          h('text', { x: pad.left - 6, y: tick.y + 3.5, textAnchor: 'end', fontSize: 9.5, fill: 'var(--dsw-alias-label-tertiary)' }, tick.label))),
        h('path', { d: area, fill: 'url(#ofmFill)' }),
        h('path', { d: line, fill: 'none', stroke: color, strokeWidth: 1.9, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' }),
        rows.length > 1 ? [rows[0], rows[Math.floor(rows.length / 2)], rows[rows.length - 1]].map((row, i) => h('text', {
          key: `x${i}`,
          x: points[Math.min(points.length - 1, Math.round((i === 0 ? 0 : i === 1 ? (rows.length - 1) / 2 : rows.length - 1)))].x,
          y: height - 4, textAnchor: i === 0 ? 'start' : i === 2 ? 'end' : 'middle', fontSize: 9.5, fill: 'var(--dsw-alias-label-tertiary)',
        }, row.day.slice(5))) : null)
    }

    function Sparkline(props) {
      const values = props.values
      if (values.length < 2) return h('span', { className: 'ofm_note' }, props.t('speed.none'))
      const width = 150
      const height = 30
      const peak = Math.max(...values, 1)
      const floor = Math.min(...values, 0)
      const span = Math.max(1e-6, peak - floor)
      const line = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${(index / (values.length - 1) * width).toFixed(1)},${(height - ((value - floor) / span) * (height - 4) - 2).toFixed(1)}`).join(' ')
      return h('svg', { className: 'ofm_svg', viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none', style: { height } },
        h('path', { d: line, fill: 'none', stroke: props.color ?? 'var(--dsw-alias-state-business-primary)', strokeWidth: 1.6, strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' }))
    }

    // ── model roster ──────────────────────────────────────────────────────────
    function ModelCard(props) {
      const { model: m, t, onBench, bench, locked, eacLogin, onVisibility, busy } = props
      const listed = m.availabilitySource === 'listing'
      const manual = m.availabilitySource === 'manual'
      const stateKey = `state.${m.availability}`
      const dim = !listed && m.availability !== 'available'
      const rung = (m.budgets ?? []).find(row => row.isDefault === true)
      // A model that declares its own thinking levels shows them beside the
      // ceiling tag, so the card names what the composer's Effort menu offers.
      // Each id is looked up with a literal call so the dictionary lint can see
      // the key, and an id with no translation falls back to the id itself.
      const levelName = id => id === 'disabled' || id === 'none' ? t('effort.off')
        : id === 'minimal' ? t('effort.minimal')
          : id === 'low' ? t('effort.low')
            : id === 'medium' ? t('effort.medium')
              : id === 'high' ? t('effort.high')
                : id === 'xhigh' ? t('effort.xhigh')
                  : id === 'max' ? t('effort.max') : id
      const levels = Array.isArray(m.efforts) && m.efforts.length > 0
        ? m.efforts.map(levelName).join(' / ')
        : undefined
      return h('article', { className: 'ofm_card' + (dim ? ' dim' : '') + (m.pinned === true ? ' pinned' : '') },
        h('div', { className: 'ofm_cardhead' },
          m.channel === 'eac' ? h('span', { className: 'ofm_chantag', title: t('tag.eacChannel') }, 'EAC') : null,
          m.channel === 'eac' && locked === true ? h('span', { className: 'ofm_chantag', title: t('eac.lockedTitle') }, '🔒') : null,
          m.channel === 'kilo' ? h('span', { className: 'ofm_chantag', title: t('tag.kiloChannel') }, 'Kilo') : null,
          h('span', { className: 'ofm_cardname', title: m.name }, m.name),
          m.isNew === true ? h('span', { className: 'ofm_newtag', title: t('tag.newTitle') }, t('tag.new')) : null,
          m.hot === true ? h('span', { className: 'ofm_hottag', title: t('tag.hotTitle') }, t('tag.hot')) : null,
          h('span', { className: 'ofm_badge ' + (listed ? 'unknown' : m.availability), title: listed ? t('hint.listed') : undefined }, listed ? t('state.listed') : t(stateKey))),
        h('div', { className: 'ofm_id', title: m.id }, m.label ?? m.id),
        h('div', { className: 'ofm_tags' },
          m.hiddenByUser === true ? h('span', { className: 'ofm_tag' }, t('visibility.hidden')) : null,
          m.fast === true ? h('span', { className: 'ofm_tag fast', title: t('tag.fastTitle') }, t('tag.fast')) : null,
          h('span', { className: 'ofm_tag' }, m.vision ? t('tag.vision') : t('tag.text')),
          m.reasoning ? h('span', { className: 'ofm_tag' }, m.canDisableThinking === false ? t('tag.thinkingShared') : t('tag.thinking')) : null,
          h('span', { className: 'ofm_tag' }, `${t('tag.context')} ${kilo(m.contextWindow)}`),
          h('span', { className: 'ofm_tag' }, `${t('tag.output')} ${kilo(m.maxOutput)}`),
          rung === undefined ? null
            : h('span', { className: 'ofm_tag', title: t('tag.rungTitle').replace('{ladder}', m.budgets.map(row => `${row.name} ${kilo(row.tokens)}`).join(' · ')) },
              `${t('tag.rung')} ${kilo(rung.tokens)}`),
          levels === undefined ? null
            : h('span', { className: 'ofm_tag', title: t('tag.levelsTitle') }, `${t('tag.levels')} ${levels}`)),
        m.channel === 'eac' && locked === true
          ? h(Fragment, null,
            h('p', { className: 'ofm_note' }, t('eac.lockedNote')),
            eacLogin === undefined ? null : h('div', { className: 'ofm_row' },
              h(Button, { kind: 'primary', disabled: eacLogin.busy || eacLogin.pending !== null, onClick: eacLogin.login },
                eacLogin.busy ? t('eac.starting') : t('eac.login'))))
          : null,
        listed ? h('p', { className: 'ofm_note' }, t('hint.listed'))
          : manual && m.availability !== 'available' ? h('p', { className: 'ofm_note' }, m.detail || t(stateKey))
          : m.availability === 'region-blocked' ? h('p', { className: 'ofm_note' }, t('hint.region'))
          : m.availability === 'unknown' ? h('p', { className: 'ofm_note' }, t('hint.unknown'))
            : m.availability === 'unavailable' ? h('p', { className: 'ofm_note', title: m.detail ?? '' }, t('hint.hidden'))
              : h('div', { className: 'ofm_metrics' },
                m.ttftMs === undefined || m.ttftMs === 0 ? null : h('span', null, t('tag.latency'), ' ', h('b', null, Math.round(m.ttftMs)), ' ms'),
                h('span', null, manual ? t('pref.measuredAt') : t('pref.probedAt'), ' ', h('b', null, ago(m.probedAt, t.locale)))),
        m.canDisableThinking === false ? h('p', { className: 'ofm_note' }, t('hint.sharedBudget')) : null,
        onVisibility === undefined ? null : h('div', { className: 'ofm_sec' },
          h(Switch, { checked: m.hiddenByUser !== true, label: t('visibility.showModel'),
            disabled: busy || m.hiddenByGroup === true, onChange: () => onVisibility(m) }),
          m.hiddenByGroup === true ? h('p', { className: 'ofm_note' }, t('visibility.groupHidden')) : null),
        onBench === undefined ? null : h('div', { className: 'ofm_row' },
          h(Button, { disabled: bench?.running === true, onClick: () => onBench(m) }, bench?.running === true ? t('bench.running') : t('bench.run')),
          bench?.result === undefined ? null : h('span', { className: 'ofm_note' }, bench.result)))
    }

    function isFreePoolModel(model) {
      return !model.channel || model.channel === 'anonymous' || model.channel === 'kilo'
    }

    function freePoolView(data) {
      const rows = (data.catalog ?? []).filter(isFreePoolModel)
      const counts = { available: 0, 'region-blocked': 0, unavailable: 0, throttled: 0, unknown: 0 }
      for (const model of rows) {
        const state = model.availabilitySource === 'listing' ? 'unknown' : model.availability
        counts[Object.hasOwn(counts, state) ? state : 'unknown']++
      }
      // 选择器可能保留暂时限流的模型；这些已知受阻模型不应抬高水位。
      const blocked = new Set(['throttled', 'unavailable', 'region-blocked'])
      const selectable = data.settings?.enabled === false ? 0 : rows.filter(model => {
        const state = model.availabilitySource === 'listing' ? 'unknown' : model.availability
        return !blocked.has(state) && !model.hiddenByUser && !model.hiddenByGroup &&
          (model.route === 'our-free-model' ||
            (model.route === 'our-free-model-region' && data.settings?.exposeRegionModels !== false))
      }).length
      return { rows, counts, total: rows.length, selectable,
        anonymous: rows.filter(model => model.channel !== 'kilo').length,
        kilo: rows.filter(model => model.channel === 'kilo').length }
    }

    function Roster(props) {
      const { summary, t, onBench, benches = {}, auth, eacLogin, only, onApply, busy } = props
      // 免费页与水位采用相同范围：匿名免费模型和 Kilo；其他付费来源留在各自页面。
      const roster = only === undefined ? summary.catalog
        : only === 'eac' ? summary.catalog.filter(m => m.channel === 'eac')
          : summary.catalog.filter(isFreePoolModel)
      // Featured rows lead their group: the pinned flag rides the catalog row, so
      // the order is the same on the EAC page and in the onboarding roster, and a
      // row that is not featured keeps its upstream order.
      const lead = list => [...list].sort((a, b) => (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0))
      const available = lead(roster.filter(m => m.route === 'our-free-model'))
      const limited = lead(roster.filter(m => m.route === 'our-free-model-region'))
      const unlisted = lead(roster.filter(m => m.route !== 'our-free-model' && m.route !== 'our-free-model-region'))
      const toggleModel = onApply === undefined ? undefined : model => {
        const ids = summary.settings.hiddenModelIds ?? []
        return onApply({ hiddenModelIds: ids.includes(model.id) ? ids.filter(id => id !== model.id) : [...ids, model.id] })
      }
      // 只有拿到过明确判定（网关答过 /eac/status）且未授权时才上锁：状态未知
      // 不该显示一把凭空的锁，网关不可达时本地记录仍算已授权。
      const locked = auth !== undefined && auth.available === true && auth.authorized !== true
      const group = (title, list, hint) => list.length === 0 ? null
        : h('div', { className: 'ofm_sec', style: { gap: 8 } },
          h('div', { className: 'ofm_row' }, h('span', { className: 'ofm_sec_title', style: { fontSize: 12.5 } }, title),
            hint === undefined ? null : h('span', { className: 'ofm_sec_hint' }, hint)),
          h('div', { className: 'ofm_grid' }, list.map(m => h(ModelCard, {
            key: m.id, model: m, t, onBench, locked: m.channel === 'eac' && locked, eacLogin,
            onVisibility: toggleModel, busy,
            bench: { running: benches[m.id]?.running === true, ...benches[m.id]?.result === undefined ? {} : { result: benches[m.id].result } },
          }))))
      // The lane closed at the gate is the one "no EAC models" case the page can
      // explain without a log (issue #60): on a host the kernel gave no profile,
      // the group never renders and nothing else on the page names the reason.
      const laneNote = summary.laneAvailable === false && !summary.catalog.some(m => m.channel === 'eac')
        ? h('p', { className: 'ofm_note' }, t('roster.noLane')) : null
      return h(Fragment, null,
        laneNote,
        onApply === undefined ? null : h('div', { className: 'ofm_sec' },
          h('p', { className: 'ofm_note' }, t('visibility.hint')),
          h(Switch, { checked: summary.settings.hideFreeModels === true, disabled: busy,
            label: t('pref.hideFreeModels'), onChange: () => onApply({ hideFreeModels: summary.settings.hideFreeModels !== true }) }),
          h(Switch, { checked: summary.settings.hideEacModels === true, disabled: busy,
            label: t('pref.hideEacModels'), onChange: () => onApply({ hideEacModels: summary.settings.hideEacModels !== true }) })),
        group(t('roster.selectable'), available),
        group(t('state.region-blocked'), limited, t('hint.region')),
        group(t('visibility.unlisted'), unlisted))
    }

    // ── dashboard ─────────────────────────────────────────────────────────────
    // ── pool panel (co-paid lane capacity & live pressure) ────────────────────
    // Numbers come from the gateway through the plugin backend (/pool), which
    // is the only place the sealed gateway URL exists. All of them are real:
    // capacity is the operator's actual provisioning rule (stars × 1.5, or a
    // configured count), and the load verdict — 畅通 / 繁忙 / 过载 — is computed
    // by the gateway process itself from its in-flight streams and event-loop
    // saturation, so the panel and the server can never disagree about the
    // color. The panel renders nothing at all when the host has no lane or the
    // gateway is dark — a gauge that lies would be worse than no gauge.
    const POOL_REPO_URL = 'https://github.com/Ebony-Vinyl/dsh-our-free-model'
    const FISH_PATH = 'M1 7c2.5-3.5 7-5 11-3.2L18.5 1v12L12 10.2C8 12 3.5 10.5 1 7zm16.4 0l5.1-3.4v6.8L17.4 7zM8.4 5.6a1 1 0 11-2 0 1 1 0 012 0z'

    /**
     * The aquarium itself: water level, waves, bubbles, three fish and a glass
     * frame. It is deliberately a *pure* visual — every page that shows one
     * decides what the level means (free lane: share of models reachable;
     * EAC lane: the co-paid pool's 24h pressure), because a tank whose meaning
     * changes with the caller is the only way to put the same object at the top
     * of two pages without either one lying about its numbers.
     */
    function Tank(props) {
      const { pct, level = 'ok', size, label } = props
      const filled = Number(pct) > 0
      const tankRef = useRef(null)
      const [visible, setVisible] = useState(true)
      useEffect(() => {
        if (!filled || typeof IntersectionObserver !== 'function' || !tankRef.current) return undefined
        const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)))
        observer.observe(tankRef.current)
        return () => observer.disconnect()
      }, [filled])
      const fish = ['f1', 'f2', 'f3'].map(name => h('i', { className: `ofm_fish ${name}`, key: name },
        h('svg', { viewBox: '0 0 24 14' }, h('path', { d: FISH_PATH }))))
      const bubbles = ['b1', 'b2', 'b3', 'b4', 'b5'].map(name => h('i', { className: `ofm_bubble ${name}`, key: name }))
      if (pct === null || pct === undefined) return null
      return h('div', {
        className: `ofm_tank ${level}${size === 'xl' ? ' xl' : ''}`,
        ref: tankRef,
        'data-ofm-motion': filled && visible ? 'on' : 'off',
        role: 'img',
        'aria-label': label ?? `${pct}%`,
        style: { '--lvl': `${Math.max(0, Math.min(100, pct))}%` },
      },
        h('div', { className: 'ofm_tankwater' },
          h('div', { className: 'ofm_tankdeep' }, ...bubbles, ...fish),
          h('i', { className: 'ofm_wave w1' }),
          h('i', { className: 'ofm_wave w2' })),
        h('i', { className: 'ofm_tankrays' }),
        h('i', { className: 'ofm_tankshine' }),
        h('div', { className: 'ofm_tankglass' }))
    }

    /**
     * The co-paid pool snapshot, shared by the EAC page's tank and its detail
     * panel. One hook so the page and the panel never disagree: both read the
     * same 30-second poll. `pool === undefined` means "still loading", `null`
     * means "the host has no lane or the gateway is dark" — the caller decides
     * whether that is a muted line or nothing at all.
     */
    function usePool() {
      const [pool, setPool] = useState(undefined)
      const [poolError, setPoolError] = useState('')
      useEffect(() => {
        let alive = true
        // The gateway can be slow under exactly the load this panel reports;
        // the 8s api() default would abort while the backend is still waiting.
        const load = () => api('/pool', { timeout: 25_000 })
          .then(data => {
            if (!alive) return
            setPool(data?.pool != null ? data : null)
            setPoolError('')
          })
          .catch(error => {
            if (!alive) return
            setPool(null)
            // The backend tags the failure with a fixed reason code; map it to
            // readable text instead of hiding the panel in silence.
            const code = /\(([^)]+)\)\s*$/.exec(String(error?.message ?? ''))?.[1] ?? ''
            setPoolError(code)
          })
        load()
        const timer = setInterval(load, 30_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      return { pool, poolError }
    }

    /** The pool's load verdict and the numbers behind it, from one snapshot. */
    function poolReading(pool) {
      const active = Number.isFinite(pool.active24h) ? pool.active24h : null
      const capacityKnown = Number.isFinite(pool.pool) && pool.pool > 0
      // Two readings, on purpose: the tank cannot hold more than full, but the
      // page must not round a pool running at 147% of its provisioned capacity
      // down to "100%" — that reads as "exactly at capacity", which is a
      // different, calmer sentence than what the gateway is saying.
      const rawPct = capacityKnown && active !== null ? Math.round(100 * active / pool.pool) : null
      const pct = rawPct === null ? null : Math.max(0, Math.min(100, rawPct))
      // A gateway build that predates the level verdict answers without one.
      // The plugin then applies the same default thresholds locally, so an
      // upgraded panel never reads a calm color off an unupgraded server —
      // and once the gateway does send its verdict, that one wins.
      const level = pool.level === 'over' || (pool.level === undefined && pool.inflight >= 80) ? 'over'
        : pool.level === 'busy' || (pool.level === undefined && pool.inflight >= 30) ? 'busy' : 'ok'
      return { active, capacityKnown, pct, rawPct, level }
    }

    /** The GitHub star every call to action on this page carries. */
    const STAR_GLYPH = 'M8 .25a.75.75 0 01.673.418l1.882 3.815 4.21.612a.75.75 0 01.416 1.279l-3.046 2.97.719 4.192a.75.75 0 01-1.088.791L8 12.347l-3.766 1.98a.75.75 0 01-1.088-.79l.72-4.194L.818 6.374a.75.75 0 01.416-1.28l4.21-.611L7.327.668A.75.75 0 018 .25z'

    /** The repository every page's star button points at, opened in a new tab. */
    function StarButton(props) {
      const { t, repo = POOL_REPO_URL } = props
      const label = t('star.cta')
      return h('a', {
        className: 'ofm_starbtn',
        href: `https://github.com/${repo.replace(/^https?:\/\/github\.com\//, '')}`,
        target: '_blank',
        rel: 'noreferrer noopener',
        title: `${t('star.title')} · ${repo}`,
      }, h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('path', { d: STAR_GLYPH })),
        label)
    }
    /** Where the pool's capacity number comes from, in one sentence. */
    function capacityText(pool, t) {
      if (pool.poolSource === 'formula') return t('pool.formula').replace('{stars}', String(pool.stars ?? '—'))
      if (pool.poolSource === 'configured') return t('pool.configured')
      return t('pool.capacityUnknown')
    }

    // ── EAC 渠道授权（GitHub 登录 + Star） ────────────────────────────────────
    // 闸门在服务器：网关拒绝没有用户令牌的对话，而这个面板是取得令牌的唯一入口。
    // 三种状态如实呈现——未登录 / 已登录但未 star / 已授权——并且登录全程无需
    // 复制粘贴：后端把授权页交给系统浏览器，前端轮询网关领取令牌。令牌本身从不
    // 到达浏览器，这里只显示登录名与判定结果。
    //
    // 登录流（发起、轮询、busy/notice）住在 SettingsPage 级的 hook 里：页头的
    // 未授权按钮、上锁模型卡的「去授权」和这个面板必须共享同一个进行中的会话，
    // 各挂一份轮询会互相抢令牌的领取权。
    const EAC_LOGIN_TTL = 10 * 60_000
    const EAC_LOGIN_KEY = `ofm.eac.pending:${API}`
    function rememberEacLogin(pending) {
      try {
        if (pending === null) sessionStorage.removeItem(EAC_LOGIN_KEY)
        else sessionStorage.setItem(EAC_LOGIN_KEY, JSON.stringify(pending))
      } catch { /* restricted browser storage: this mounted page can still log in */ }
    }
    function restoreEacLogin() {
      try {
        const value = JSON.parse(sessionStorage.getItem(EAC_LOGIN_KEY))
        if (value !== null && /^[A-Za-z0-9_-]{16,64}$/.test(value.link)
          && typeof value.url === 'string' && /^https?:\/\//.test(value.url)
          && Number.isFinite(value.startedAt) && value.startedAt <= Date.now()
          && Date.now() - value.startedAt < EAC_LOGIN_TTL) return value
      } catch { /* absent or malformed */ }
      rememberEacLogin(null)
      return null
    }
    function useEacLogin({ t, summary, onAuth }) {
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [pending, setPending] = useState(restoreEacLogin)
      const [copied, setCopied] = useState(false)
      const starting = useRef(false)
      const cancelling = useRef(false)
      const attempt = useRef(0)
      const pendingRef = useRef(pending)
      pendingRef.current = pending
      const updatePending = value => {
        pendingRef.current = value
        rememberEacLogin(value)
        setPending(value)
      }
      const refresh = useCallback(() => {
        api('/eac/status', { timeout: 20_000 }).then(onAuth).catch(() => onAuth({ available: true, authorized: false, login: '', unverified: true }))
      }, [onAuth])
      const latest = useRef(summary)
      latest.current = summary
      const latestT = useRef(t)
      latestT.current = t

      // Schedule only after completion: slow gateway responses must not create
      // overlapping collectors. The link survives settings-page remounts.
      useEffect(() => {
        if (pending === null) return undefined
        let alive = true
        let timer
        const poll = async () => {
          const t = latestT.current
          if (!alive || cancelling.current) return
          if (Date.now() - pending.startedAt >= EAC_LOGIN_TTL) {
            updatePending(null); setNotice(t('eac.expired')); return
          }
          try {
            const result = await api(`/eac/login/poll?link=${encodeURIComponent(pending.link)}`, { timeout: 22_000 })
            if (!alive || cancelling.current || pendingRef.current?.link !== pending.link) return
            if (result.status === 'ok') {
              updatePending(null)
              setNotice(t('eac.done').replace('{login}', result.login ?? ''))
              refresh(); latest.current?.reload?.()
              return
            }
            if (result.status === 'expired') {
              updatePending(null); setNotice(t('eac.sessionExpired')); return
            }
            if (result.status === 'unstarred') setNotice(t('eac.needStar').replace('{login}', result.login ?? ''))
            else setNotice('')
          } catch (error) {
            if (!alive || cancelling.current || pendingRef.current?.link !== pending.link) return
            const reason = String(error?.message ?? '')
            if (reason === 'cancelled') { updatePending(null); setNotice(''); return }
            // Never render response HTML, URL or credentials as diagnostics.
            const safe = /^gateway-http-\d{3}$/.test(reason) ? `HTTP ${reason.slice(-3)}`
              : ['unreachable', 'malformed', 'not-writable', 'cancelled', 'no-lane', 'bad-link', 'timeout'].includes(reason) ? reason : 'unreachable'
            setNotice(reason === 'not-writable' ? t('eac.saveFailed') : t('eac.pollFailed').replace('{reason}', safe))
          }
          if (alive && pendingRef.current?.link === pending.link) timer = setTimeout(poll, 2500)
        }
        timer = setTimeout(poll, 2500)
        return () => { alive = false; clearTimeout(timer) }
      }, [pending, refresh])

      const cancel = async () => {
        const currentPending = pendingRef.current
        if (currentPending === null || cancelling.current) return
        cancelling.current = true
        attempt.current++; setBusy(true)
        try {
          const result = await post(`/eac/login/cancel?link=${encodeURIComponent(currentPending.link)}`)
          if (result.ok !== true && result.status !== 'ok') throw new Error('cancellation unconfirmed')
          updatePending(null)
          if (result.status === 'ok') {
            setNotice(latestT.current('eac.done').replace('{login}', result.login ?? ''))
            refresh(); latest.current?.reload?.()
          } else setNotice('')
        } catch {
          const t = latestT.current
          setNotice(t('eac.cancelFailed'))
          // A failed cancellation must retain the link and restart the serial
          // loop. The Host may already have saved it or accepted cancellation.
          updatePending({ ...currentPending })
        } finally { cancelling.current = false; setBusy(false) }
      }
      const login = async () => {
        if (starting.current || cancelling.current || pendingRef.current !== null) return
        starting.current = true
        const current = ++attempt.current
        setBusy(true); setNotice('')
        try {
          const started = await post('/eac/login/start', undefined, 30_000)
          if (current !== attempt.current) return
          if (started?.error !== undefined) { setNotice(t('eac.startFailed').replace('{reason}', started.error)); return }
          updatePending({ link: started.link, url: started.url, startedAt: Date.now() })
          if (started.opened !== true) setNotice(t('eac.openManually'))
        } catch (error) {
          if (current === attempt.current) setNotice(t('eac.startFailed').replace('{reason}', 'unreachable'))
        } finally { starting.current = false; setBusy(false) }
      }
      const logout = async () => {
        attempt.current++; updatePending(null); setBusy(true)
        try {
          await post('/eac/logout')
          refresh(); latest.current?.reload?.()
        } catch { setNotice(t('eac.startFailed').replace('{reason}', 'unreachable')) } finally { setBusy(false) }
      }
      return { busy, notice, pending, copied, setCopied, refresh, login, logout, cancel }
    }

    function EacAuth(props) {
      const { t, auth, eacLogin } = props
      const { busy, notice, pending, copied, setCopied, refresh, login, logout, cancel } = eacLogin

      if (auth === undefined) return h('p', { className: 'ofm_note' }, t('loading'))
      if (auth.available !== true) return h('p', { className: 'ofm_note' }, t('eac.noLane'))
      const repo = auth.repo !== undefined && auth.repo !== '' ? auth.repo : 'Ebony-Vinyl/dsh-our-free-model'
      return h(Fragment, null,
        h('div', { className: 'ofm_row' },
          auth.authorized === true
            ? h(Pill, { strong: true, tone: 'ok' }, t('eac.pillOk'))
            : h(Pill, { strong: true, tone: 'warn' }, t('eac.pillLocked')),
          auth.required === true ? h(Pill, { tone: 'err' }, t('eac.pillRequired')) : h(Pill, null, auth.required === false ? t('eac.pillCompat') : t('eac.pillUnknown')),
          auth.unverified === true ? h(Pill, { tone: 'warn' }, t('eac.pillUnverified')) : null),
        h('p', { className: 'ofm_note' }, t('eac.intro').replace('{repo}', repo)),
        auth.authorized === true
          ? h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, t('eac.loggedIn').replace('{login}', auth.login !== '' && auth.login !== undefined ? auth.login : '—').replace('{when}', ago(auth.lastCheck, t.locale))),
            h(Button, { disabled: busy, onClick: refresh }, t('eac.recheck')),
            h(Button, { disabled: busy, onClick: logout }, t('eac.logout')))
          : h('div', { className: 'ofm_row' },
            h(Button, { kind: 'primary', disabled: busy || pending !== null, onClick: login }, busy ? t('eac.starting') : t('eac.login')),
            h(StarButton, { t, repo })),
        pending !== null
          ? h('div', { className: 'ofm_callout' },
            h('div', null,
              h('div', null, t('eac.waiting')),
              h(Button, { kind: 'ghost', disabled: busy, onClick: cancel }, t('eac.cancel')),
              h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 } },
                h('a', { href: pending.url, target: '_blank', rel: 'noreferrer noopener', className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 0, overflowWrap: 'anywhere' } }, pending.url),
                h(Button, { kind: 'ghost', onClick: () => copy(pending.url, ok => { if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1600) } }) }, copied ? t('eac.copied') : t('eac.copy')))))
          : null,
        notice !== '' ? h('p', { className: 'ofm_note' }, notice) : null)
    }

    function Dashboard(props) {
      const { stats, t } = props
      const days = useMemo(() => [...stats.days].sort((a, b) => a.day.localeCompare(b.day)), [stats.days])
      const recent = [...(stats.samples ?? [])].slice(-40)
      // 「最近一回合」跟着一个轻量轮询走（#26）：看板其余部分仍是页面加载时的
      // 快照，这一行单独刷新，让「刚发完一条消息」的用户不用整页重载就能看到
      // 这一回合的 token 去向。聊天窗属于宿主内核，插件无法在对话流里注入，
      // 这是插件表面能做到的最接近实时的位置。
      const [fresh, setFresh] = useState(null)
      useEffect(() => {
        let alive = true
        const timer = setInterval(() => api('/stats').then(data => { if (alive) setFresh(data) }).catch(() => {}), 60_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      // The host already dropped the windows it could not measure and took out of
      // the numerator the tokens it never streamed. Averaging per-call rates
      // instead let one 1 ms window publish 63 000 tok/s and carry the whole card
      // to 2 493.
      const streamed = recent.filter(sample => sample.decodeMs > 0 && sample.tps !== null)
      const streamMs = streamed.reduce((sum, sample) => sum + sample.decodeMs, 0)
      const weightedTps = streamMs > 0
        ? streamed.reduce((sum, sample) => sum + (sample.decodeTokens ?? 0), 0) / (streamMs / 1000)
        : null
      const latencies = recent.filter(sample => sample.ttftMs !== null && sample.ttftMs !== undefined)
      const models = stats.models ?? []
      const [mode, setMode] = useState('tokens')
      const [metric, setMetric] = useState('total')

      const cumulative = useMemo(() => {
        let tokenRun = 0
        let requestRun = 0
        return days.map(row => {
          tokenRun += row.total
          requestRun += row.models.reduce((sum, m) => sum + m.calls, 0)
          return { ...row, total: mode === 'requests' ? requestRun : tokenRun }
        })
      }, [days, mode])

      const active = metric === 'total' ? undefined : models.find(m => m.model === metric)
      const color = metric === 'total'
        ? 'var(--dsw-alias-state-business-primary)'
        : SEASON[Math.max(0, models.findIndex(m => m.model === metric)) % SEASON.length]

      const headline = h('div', { className: 'ofm_stats' },
        stat(kilo(stats.grand.input + stats.grand.output), t('curve.tokens')),
        stat(kilo(stats.grand.output), t('stat.output')),
        stat(kilo(stats.grand.reasoning), t('stat.reasoning')),
        stat(String(stats.requests ?? 0), t('speed.calls')),
        stat(String(stats.requestFailures ?? stats.grand.failed ?? 0), t('speed.failed')),
        stat(String(stats.turns ?? stats.grand.turns ?? 0), t('speed.turns')),
        stat(String(stats.failedTurns ?? stats.grand.failedTurns ?? 0), t('speed.turnFailed')),
        stat(String(stats.recoveredTurns ?? stats.grand.recoveredTurns ?? 0), t('speed.recovered')))

      const heatmap = h(Panel, { title: t('heat.title') }, h(Heatmap, { days, t }))

      const legend = h('div', { className: 'ofm_chips' },
        chip(t('curve.total'), metric === 'total', SEASON[0], () => setMetric('total')),
        models.map((m, index) => chip(m.name, metric === m.model, SEASON[index % SEASON.length], () => setMetric(m.model))))

      const curve = h(Panel, { title: t('curve.title') },
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_seg' },
            segButton(t('curve.tokens'), mode === 'tokens', () => setMode('tokens')),
            segButton(t('curve.requests'), mode === 'requests', () => setMode('requests'))),
          legend),
        h(TrendChart, { series: cumulative, mode, metric, color }),
        active === undefined ? null : h('p', { className: 'ofm_note' },
          active.name, ' · ', String(active.calls), ' ', t('speed.calls'),
          active.tps === null || active.tps === undefined ? null : ' · ',
          active.tps === null || active.tps === undefined ? null : `${active.tps} ${t('unit.tokPerSec')}`))

      // 最近一回合（#26）：取最新一条调用样本，输入/输出 token、首帧、速度，
      // 失败的调用也如实标出。数据源优先用轮询到的新快照，退回页面加载时的。
      const lastSample = (fresh?.samples ?? stats.samples ?? []).slice(-1)[0] ?? null
      const nameOfModel = id => models.find(m => m.model === id)?.name ?? id
      const agoOf = at => {
        const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
        if (seconds < 60) return t('last.justNow')
        if (seconds < 3600) return t('last.minAgo').replace('{n}', String(Math.floor(seconds / 60)))
        if (seconds < 86400) return t('last.hourAgo').replace('{n}', String(Math.floor(seconds / 3600)))
        return t('last.dayAgo').replace('{n}', String(Math.floor(seconds / 86400)))
      }
      const originOf = value => ({ chat: t('last.originChat'), harness: t('last.originHarness'), forward: t('last.originForward'), bench: t('last.originBench') })[value] ?? String(value ?? '')
      const lastTurnStrip = lastSample === null ? null : h('div',
        { className: 'ofm_row', style: { flexWrap: 'wrap', gap: 14, alignItems: 'baseline', paddingBottom: 10, marginBottom: 12, borderBottom: '1px solid var(--dsw-alias-border-l1)' } },
        h('b', { style: { fontSize: 13 } }, t('last.title')),
        h('b', { style: { fontSize: 13 } }, nameOfModel(lastSample.model)),
        h('span', { className: 'ofm_note' },
          `${originOf(lastSample.origin)} · ${t('last.input')} ${kilo(lastSample.input)} · ${t('col.output')} ${kilo(lastSample.output)} tok`
          + (lastSample.ttftMs != null ? ` · ${t('speed.ttft')} ${Math.round(lastSample.ttftMs)} ${t('unit.ms')}` : '')
          + (lastSample.tps != null ? ` · ${t('speed.tps')} ${Math.round(lastSample.tps)} ${t('unit.tokPerSec')}` : '')
          + (lastSample.ok === false ? ` · ${t('speed.failed')}` : '')),
        h('span', { className: 'ofm_note', style: { marginLeft: 'auto' } }, agoOf(lastSample.at)))

      const speed = h(Panel, { title: t('speed.title'), hint: recent.length + ' ' + t('speed.calls') },
        recent.length === 0
          ? h('p', { className: 'ofm_note' }, t('speed.none'))
          : h(Fragment, null,
            lastTurnStrip,
            h('div', { className: 'ofm_row', style: { gap: 24 } },
              sparkCell(t('speed.tps'), streamed.map(s => s.tps), SEASON[0], value => Math.round(value) + ' ' + t('unit.tokPerSec'), t, weightedTps),
              sparkCell(t('speed.ttft'), latencies.map(s => s.ttftMs), SEASON[2], value => Math.round(value) + ' ' + t('unit.ms'), t),
              sparkCell(t('stat.output'), recent.map(s => s.output), SEASON[1], value => kilo(value) + ' tok', t)),
            h('p', { className: 'ofm_note' }, t('speed.note')
              .replace('{n}', String(streamed.length))
              .replace('{total}', String(recent.length)))))

      const table = models.length === 0 ? null : h(Panel, { title: t('speed.model') },
        h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
          h('thead', null, h('tr', null,
            h('th', null, t('speed.model')),
            num(t('speed.calls')), num(t('speed.turns')), num(t('speed.recovered')),
            num(t('speed.tps')), num(t('speed.ttft')), num(t('col.reason')),
            num(t('col.output')), num(t('speed.failed')), num(t('speed.turnFailed')))),
          h('tbody', null, [...models].sort((a, b) => b.output - a.output).map(m => h('tr', { key: m.model },
            h('td', { title: m.model }, m.name),
            numTd(m.calls),
            numTd(m.turns),
            numTd(m.recoveredTurns === 0 ? '—' : m.recoveredTurns),
            numTd(m.tps),
            numTd(m.avgTtftMs === null || m.avgTtftMs === undefined ? null : Math.round(m.avgTtftMs)),
            numTd(kilo(m.reasoning)),
            numTd(kilo(m.output)),
            numTd(m.failed === 0 ? '—' : m.failed),
            numTd(m.failedTurns === 0 ? '—' : m.failedTurns)))))))

      const historyNote = stats.logicalEstimated || stats.requestFailuresEstimated
        ? h('p', { className: 'ofm_note' }, t('speed.estimated'))
        : null
      return h(Fragment, null, headline, h('p', { className: 'ofm_note' }, t('speed.scope')), historyNote,
        h('div', { className: 'ofm_two' }, heatmap, curve), speed, table)
    }

    const sparkCell = (label, values, color, format, t, summary) => {
      const shown = summary !== undefined ? summary : values.length < 2 ? null : avg(values)
      return h('div', { className: 'ofm_sec', style: { gap: 2 } },
        h('span', { className: 'ofm_note' }, label),
        h(Sparkline, { values, color, t }),
        h('b', { style: { fontSize: 15 } }, shown === null ? '—' : format(shown)))
    }

    const stat = (value, label) => h('div', { className: 'ofm_stat' }, h('b', null, value), h('span', null, label))
    const num = label => h('th', { className: 'ofm_num' }, label)
    const numTd = value => h('td', { className: 'ofm_num' }, value === null || value === undefined ? '—' : value)
    const avg = list => list.length === 0 ? 0 : list.reduce((a, b) => a + b, 0) / list.length
    const segButton = (label, on, onClick) => h('button', { type: 'button', 'aria-pressed': on ? 'true' : 'false', onClick }, label)
    const chip = (label, on, color, onClick) => h('button', { type: 'button', className: 'ofm_chip', 'aria-pressed': on ? 'true' : 'false', onClick, style: on ? { color } : undefined },
      h('span', { className: 'ofm_swatch', style: { background: color } }), label)

    // ── forward listener ──────────────────────────────────────────────────────
    function Forward(props) {
      const { settings, t, onApply, busy } = props
      const [draft, setDraft] = useState(settings.forward)
      useEffect(() => setDraft(settings.forward), [settings.forward?.enabled, settings.forward?.host, settings.forward?.port, settings.forward?.lan?.enabled, settings.forward?.lan?.port, settings.forward?.lan?.running])
      const [key, setKey] = useState('')
      const [shown, setShown] = useState(false)
      const [copied, setCopied] = useState('')
      useEffect(() => {
        if (draft?.running !== true) return
        let alive = true
        api('/forward/key').then(payload => { if (alive) setKey(payload.key ?? '') }).catch(() => {})
        return () => { alive = false }
      }, [draft?.running])
      const port = draft?.actualPort ?? draft?.port ?? 0
      const base = `http://${draft?.host || '127.0.0.1'}:${port}/v1`
      const doCopy = (label, value) => copy(value, ok => {
        if (!ok) return
        setCopied(label)
        setTimeout(() => setCopied(''), 1600)
      })
      const curl = `curl ${base}/chat/completions \\\n  -H "authorization: Bearer ${shown && key !== '' ? key : '<API KEY>'}" \\\n  -H "content-type: application/json" \\\n  -d '{"model":"<model id>","messages":[{"role":"user","content":"hi"}]}'`

      // The relay is a door of its own: its own key, its own liveness, and an
      // address that only exists while it is listening.
      const lan = draft?.lan
      const [lanKey, setLanKey] = useState('')
      const [lanShown, setLanShown] = useState(false)
      useEffect(() => {
        if (lan?.running !== true) return
        let alive = true
        api('/forward/lan/key').then(payload => { if (alive) setLanKey(payload.key ?? '') }).catch(() => {})
        return () => { alive = false }
      }, [lan?.running])
      const lanPort = lan?.actualPort ?? lan?.port ?? 0
      // Which address a peer should dial is a property of this machine's
      // interfaces, and they move under the panel: a laptop that changed networks,
      // woke from sleep, or brought a VPN up holds a different set than it did a
      // minute ago — and the stale one is exactly the one the user copies to the
      // other machine. So while the relay is on this polls the addresses
      // themselves, at the same 15 s cadence the outlet's node reading uses,
      // instead of trusting the snapshot that shipped with the settings.
      const lanLive = useAsync(() => api('/forward/lan/addresses'), [lan?.running])
      const reloadLanAddresses = lanLive.reload
      useEffect(() => {
        if (lan?.running !== true) return undefined
        const timer = setInterval(() => reloadLanAddresses(), 15_000)
        return () => clearInterval(timer)
      }, [lan?.running, reloadLanAddresses])
      const lanHosts = lanLive.data?.addresses ?? lan?.addresses ?? []
      const lanHost = lanHosts[0] ?? ''
      const lanUrl = lanHost === '' ? t('forward.lanNoAddress') : `http://${lanHost}:${lanPort}/v1`
      const lanToggle = current => ({ ...current, lan: { ...(current?.lan ?? {}), enabled: !(current?.lan?.enabled === true) } })

      return h(Panel, null,
        h('div', { className: 'ofm_row' },
          h(Switch, { checked: draft?.enabled === true, label: t('forward.enabled'), onChange: () => setDraft(current => ({ ...current, enabled: !(current?.enabled === true) })) }),
          h('span', { className: 'ofm_pill' }, h('span', { className: `ofm_dot ${draft?.running === true ? 'ok' : draft?.error ? 'err' : ''}` }), draft?.running === true ? t('forward.running') : t('forward.stopped'))),
        h('div', { className: 'ofm_row' },
          field(t('forward.host'), h('input', { className: 'ofm_input', style: { maxWidth: 150 }, value: draft?.host ?? '127.0.0.1', onChange: e => setDraft(c => ({ ...c, host: e.target.value })) })),
          field(t('forward.port'), h('input', { className: 'ofm_input', style: { maxWidth: 110 }, inputMode: 'numeric', value: draft?.port ?? '', onChange: e => setDraft(c => ({ ...c, port: Number(e.target.value.replace(/\D/g, '')) || 0 })) })),
          h(Button, { kind: 'primary', disabled: busy || draft?.enabled === undefined, onClick: () => onApply({ forward: { enabled: draft.enabled === true, host: draft.host, port: draft.port } }) }, t('forward.apply'))),
        draft?.error ? h('div', { className: 'ofm_callout ofm_error' }, t('forward.error').replace('{message}', draft.error)) : null,
        draft?.notice ? h('div', { className: 'ofm_callout' }, t('forward.notice').replace('{message}', draft.notice)) : null,
        draft?.running === true ? h(Fragment, null,
          h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, t('forward.baseUrl')),
            h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200 } }, base),
            h(Button, { kind: 'ghost', onClick: () => doCopy('base', base) }, copied === 'base' ? t('forward.copied') : t('forward.copy'))),
          h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, t('forward.key')),
            h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, letterSpacing: shown ? 0 : 1 } }, key === '' ? '…' : shown ? key : '•'.repeat(24)),
            h(Button, { kind: 'ghost', onClick: () => setShown(value => !value) }, shown ? t('forward.hide') : t('forward.show')),
            h(Button, { kind: 'ghost', onClick: () => doCopy('key', key) }, copied === 'key' ? t('forward.copied') : t('forward.copy')),
            h(Button, { kind: 'ghost', title: t('forward.rotateWarn'), onClick: async () => { const payload = await post('/forward/rotate'); setKey(payload.key ?? ''); setShown(true) } }, t('forward.rotate'))),
          h('div', { className: 'ofm_sec', style: { gap: 4 } }, h('span', { className: 'ofm_note' }, t('forward.example')),
            h('pre', { className: 'ofm_mono' }, curl),
            h('div', null, h(Button, { kind: 'ghost', onClick: () => doCopy('curl', curl) }, copied === 'curl' ? t('forward.copied') : t('forward.copy'))))) : null,
        h('div', { className: 'ofm_sec', style: { gap: 6, marginTop: 12 } },
          h('div', { className: 'ofm_note' }, t('forward.lanTitle')),
          h('div', { className: 'ofm_row' },
            h(Switch, { checked: lan?.enabled === true, label: t('forward.lanEnabled'), onChange: () => setDraft(lanToggle) }),
            h('span', { className: 'ofm_pill' }, h('span', { className: `ofm_dot ${lan?.running === true ? 'ok' : lan?.error ? 'err' : ''}` }), lan?.running === true ? t('forward.lanRunning') : t('forward.lanStopped'))),
          h('div', { className: 'ofm_row' },
            field(t('forward.lanPort'), h('input', { className: 'ofm_input', style: { maxWidth: 110 }, inputMode: 'numeric', value: lan?.port ?? 0, onChange: e => setDraft(c => ({ ...c, lan: { ...(c?.lan ?? {}), port: Number(e.target.value.replace(/\D/g, '')) || 0 } })) })),
            h('span', { className: 'ofm_note' }, t('forward.lanAuto')),
            h(Button, { kind: 'primary', disabled: busy, onClick: () => onApply({ forward: { enabled: draft?.enabled === true, host: draft?.host, port: draft?.port, lan: { enabled: lan?.enabled === true, port: lan?.port ?? 0 } } }) }, t('forward.lanApply'))),
          h('div', { className: 'ofm_callout' }, t('forward.lanWarn')),
          h('div', { className: 'ofm_note' }, t('forward.lanHint')),
          lan?.error ? h('div', { className: 'ofm_callout ofm_error' }, t('forward.lanError').replace('{message}', lan.error)) : null,
          lan?.running === true ? h(Fragment, null,
            h('div', { className: 'ofm_row' },
              h('span', { className: 'ofm_note' }, t('forward.lanUrl')),
              h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200 } }, lanUrl),
              h(Button, { kind: 'ghost', onClick: () => doCopy('lanUrl', lanUrl) }, copied === 'lanUrl' ? t('forward.copied') : t('forward.copy'))),
            lanHosts.length > 1 ? h('div', { className: 'ofm_note' }, t('forward.lanAlso').replace('{list}', lanHosts.slice(1).join('    '))) : null,
            h('div', { className: 'ofm_row' },
              h('span', { className: 'ofm_note' }, t('forward.lanKey')),
              h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, letterSpacing: lanShown ? 0 : 1 } }, lanKey === '' ? '…' : lanShown ? lanKey : '•'.repeat(24)),
              h(Button, { kind: 'ghost', onClick: () => setLanShown(value => !value) }, lanShown ? t('forward.hide') : t('forward.show')),
              h(Button, { kind: 'ghost', onClick: () => doCopy('lanKey', lanKey) }, copied === 'lanKey' ? t('forward.copied') : t('forward.copy')),
              h(Button, { kind: 'ghost', title: t('forward.lanRotateWarn'), onClick: async () => { const payload = await post('/forward/lan/rotate'); setLanKey(payload.key ?? ''); setLanShown(true) } }, t('forward.rotate')))) : null))
    }

    // ── egress outlet ─────────────────────────────────────────────────────────
    // Two ways out: a Clash subscription load-balanced by a spawned mihomo, or
    // one hand-written http/https/socks5 URL. Until this is on AND started,
    // egressFetch sends every request direct — nothing here is load-bearing for
    // plain use. The address is a credential, so it never rides along in the
    // settings payload: this panel shows the masked host and pulls the value
    // itself (`/egress/url`) only when the owner asks to see or copy it.
    function Egress(props) {
      const { settings, t, onApply, busy } = props
      const [draft, setDraft] = useState(settings.egress ?? {})
      useEffect(() => setDraft(settings.egress ?? {}), [settings.egress?.enabled, settings.egress?.mode, settings.egress?.urlLabel, settings.egress?.hasUrl, settings.egress?.active, settings.egress?.error])
      const [urlShown, setUrlShown] = useState(false)
      const [urlValue, setUrlValue] = useState('')
      const [copied, setCopied] = useState('')
      const readUrl = () => api('/egress/url').then(payload => String(payload?.url ?? '')).catch(() => '')
      // Which node url-test is carrying traffic on, and what the last gateway
      // round trip cost. mihomo re-ranks on its own schedule, so while the outlet
      // is on this polls instead of trusting the snapshot that shipped with the
      // settings. `/outlet` reads the controller, so it is only worth calling
      // when an outlet is actually running.
      const live = useAsync(() => api('/outlet'), [settings.egress?.enabled, settings.egress?.active])
      const reloadOutlet = live.reload
      const running = settings.egress?.active === true
      useEffect(() => {
        if (!running) return undefined
        const timer = setInterval(() => reloadOutlet(), 15_000)
        return () => clearInterval(timer)
      }, [running, reloadOutlet])
      const status = running && live.data ? live.data : draft
      const node = typeof status?.node === 'string' ? status.node : ''
      const nodeDelayMs = Number(status?.nodeDelayMs ?? 0)
      const latencyMs = Number(status?.latencyMs ?? 0)
      const subscription = draft?.mode !== 'client'
      const statusLine = text => h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200 } }, text)
      // The stored address is never in the payload this panel was rendered
      // from, so "see it" and "copy it" both cost one on-demand fetch, and the
      // masked form is all this page holds the rest of the time.
      const revealUrl = async () => {
        if (urlShown) { setUrlShown(false); return }
        setUrlValue(await readUrl())
        setUrlShown(true)
      }
      const copyUrl = async () => {
        const value = await readUrl()
        if (value === '') return
        copy(value, ok => {
          if (!ok) return
          setCopied('egressUrl')
          setTimeout(() => setCopied(''), 1600)
        })
      }
      const urlMask = draft?.hasUrl === true ? `${draft?.urlLabel ?? ''}/…` : t('egress.urlNone')
      const apply = () => {
        const patch = { enabled: draft?.enabled === true, mode: subscription ? 'subscription' : 'client', mihomoPath: String(draft?.mihomoPath ?? '') }
        // Empty means "keep the stored address": this panel never received it,
        // so it has nothing to send back, and an empty string would read as
        // "clear it" on the receiving end.
        if (String(draft?.url ?? '') !== '') patch.url = String(draft.url)
        onApply({ egress: patch })
      }
      return h(Panel, null,
        h('div', { className: 'ofm_row' },
          h(Switch, { checked: draft?.enabled === true, label: t('egress.enabled'), onChange: () => setDraft(c => ({ ...c, enabled: !(c?.enabled === true) })) }),
          h('span', { className: 'ofm_pill' }, h('span', { className: `ofm_dot ${draft?.active === true ? 'ok' : draft?.error ? 'err' : ''}` }), draft?.active === true ? t('egress.active') : t('egress.inactive'))),
        h('div', { className: 'ofm_row' },
          h(Switch, { checked: subscription, label: t('egress.modeSubscription'), onChange: () => setDraft(c => ({ ...c, mode: subscription ? 'client' : 'subscription' })) })),
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('egress.url')),
          h('code', { className: 'ofm_mono', style: { padding: '4px 8px', flex: 1, minWidth: 200, letterSpacing: urlShown ? 0 : 1 } },
            urlShown ? (urlValue === '' ? t('egress.urlNone') : urlValue) : urlMask),
          h(Button, { kind: 'ghost', onClick: revealUrl }, urlShown ? t('forward.hide') : t('forward.show')),
          h(Button, { kind: 'ghost', onClick: copyUrl }, copied === 'egressUrl' ? t('forward.copied') : t('forward.copy')),
          // Deleting the address is still a thing the owner may want, and the
          // panel cannot express it by sending back a field it never held — so
          // it says so outright, and the outlet goes down with the credential.
          h(Button, { kind: 'ghost', title: t('egress.urlClearWarn'), disabled: draft?.hasUrl !== true || busy, onClick: () => {
            setUrlShown(false)
            setUrlValue('')
            onApply({ egress: { enabled: false, mode: subscription ? 'subscription' : 'client', mihomoPath: String(draft?.mihomoPath ?? ''), url: '' } })
          } }, t('egress.urlClear'))),
        h('div', { className: 'ofm_row' },
          field(t('egress.urlNew'), h('input', { className: 'ofm_input', style: { flex: 1, minWidth: 260 }, value: draft?.url ?? '', placeholder: t('egress.urlPlaceholder'), onChange: e => setDraft(c => ({ ...c, url: e.target.value })) })),
          h(Button, { kind: 'primary', disabled: busy, onClick: apply }, t('egress.apply'))),
        subscription ? h('div', { className: 'ofm_row' },
          field(t('egress.mihomoPath'), h('input', { className: 'ofm_input', style: { flex: 1, minWidth: 260 }, value: draft?.mihomoPath ?? '', placeholder: 'auto', onChange: e => setDraft(c => ({ ...c, mihomoPath: e.target.value })) })),
          h('span', { className: 'ofm_note' }, t('egress.mihomoHint'))) : null,
        draft?.error ? h('div', { className: 'ofm_callout ofm_error' }, t('egress.error').replace('{message}', draft.error)) : null,
        h('div', { className: 'ofm_note' }, t('egress.direct')),
        running ? h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('egress.outlet')),
          statusLine(`${draft.outlet ?? ''} · ${draft.mode ?? ''}`)) : null,
        running ? h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('egress.node')),
          statusLine(node === '' ? t('egress.measuring') : nodeDelayMs > 0 ? `${node} · ${nodeDelayMs}ms` : node)) : null,
        running ? h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('egress.latency')),
          statusLine(latencyMs > 0 ? `${(latencyMs / 1000).toFixed(2)}s` : t('egress.measuring'))) : null)
    }

    const field = (label, control) => h('label', { className: 'ofm_field' }, h('span', null, label), control)

    // ── preferences ───────────────────────────────────────────────────────────
    function Preferences(props) {
      const { summary, t, onApply, busy } = props
      const settings = summary.settings
      const [draft, setDraft] = useState(settings)
      useEffect(() => setDraft(settings), [summary])
      return h(Panel, null,
        h('div', { className: 'ofm_row', style: { gap: 20 } },
          h(Switch, { checked: settings.enabled !== false, label: t('pref.enabled'), onChange: () => onApply({ enabled: !(settings.enabled !== false) }) }),
          h(Switch, { checked: settings.exposeRegionModels !== false, label: t('pref.exposeRegion'), onChange: () => onApply({ exposeRegionModels: !(settings.exposeRegionModels !== false) }) })),
        h('div', { className: 'ofm_row', style: { gap: 20 } },
          h(Switch, { checked: settings.hideFreeModels === true, disabled: busy, label: t('pref.hideFreeModels'), onChange: () => onApply({ hideFreeModels: settings.hideFreeModels !== true }) }),
          h(Switch, { checked: settings.hideEacModels === true, disabled: busy, label: t('pref.hideEacModels'), onChange: () => onApply({ hideEacModels: settings.hideEacModels !== true }) })),
        h('div', { className: 'ofm_row' },
          field(t('pref.interval'), h('input', { className: 'ofm_input', style: { maxWidth: 100 }, value: draft?.probeIntervalMinutes ?? 15, onChange: e => setDraft(c => ({ ...c, probeIntervalMinutes: Number(e.target.value.replace(/\D/g, '')) || 0 })) })),
          field(t('pref.maxTokens'), h('input', { className: 'ofm_input', style: { maxWidth: 120 }, value: draft?.defaultMaxTokens ?? 32768, onChange: e => setDraft(c => ({ ...c, defaultMaxTokens: Number(e.target.value.replace(/\D/g, '')) || 0 })) })),
          h(Button, { kind: 'primary', disabled: busy, onClick: () => onApply({ probeIntervalMinutes: draft.probeIntervalMinutes, defaultMaxTokens: draft.defaultMaxTokens }) }, t('forward.apply'))),
        h('div', { className: 'ofm_row', style: { gap: 8 } },
          h('span', { className: 'ofm_pill' }, `${t('pref.egress')}: ${summary.egress?.ip ?? '—'}${summary.egress?.country ? ` (${summary.egress.country})` : ''}`),
          h('span', { className: 'ofm_pill' }, `${t('pref.probedAt')}: ${ago(summary.probedAt, t.locale)}`)))
    }

    // ── announcement center ──────────────────────────────────────────────────
    const LEVEL_KEY = { info: 'level.info', update: 'level.update', warn: 'level.warn', urgent: 'level.urgent' }

    function NewsPanel(props) {
      const { t } = props
      const news = useAsync(() => api('/announcements'), [])
      const [busy, setBusy] = useState(false)
      const [osError, setOsError] = useState('')
      // Collapsed by default: the header row carries the status, and the body
      // opens only while there is something unread to read.
      const [open, setOpen] = useState(false)
      const items = news.data?.items ?? []
      const unread = news.data?.unread ?? 0
      useEffect(() => {
        if (unread > 0) setOpen(true)
      }, [unread])
      // Live refresh: the push subscription broadcasts to window on arrival.
      useEffect(() => {
        const handler = () => news.reload()
        window.addEventListener('ofm:announcements', handler)
        return () => window.removeEventListener('ofm:announcements', handler)
      }, [news.reload])
      const notifyOs = news.data?.notifyOs === true
      const ack = async payload => {
        setBusy(true)
        try { await post('/announcements/ack', payload); news.reload() } finally { setBusy(false) }
      }
      const refresh = async () => {
        setBusy(true)
        try { await post('/announcements/refresh', undefined, 60_000); news.reload() } finally { setBusy(false) }
      }
      const enableOs = async () => {
        setOsError('')
        if (typeof Notification === 'undefined') { setOsError(t('news.osDenied')); return }
        let permission = 'default'
        try { permission = await Notification.requestPermission() } catch { permission = Notification.permission }
        if (permission !== 'granted') { setOsError(t('news.osDenied')); return }
        try { await post('/settings', { notifyOs: true }) } catch { /* server state lags; permission is the gate */ }
        news.reload()
      }
      return h(Panel, null,
        h('div', { className: 'ofm_row' },
          unread > 0 ? h('span', { className: 'ofm_pill strong' }, t('news.unread').replace('{n}', String(unread))) : null,
          news.data?.error ? h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot warn' }), t('news.fetchFailed')) : null,
          h('span', { className: 'ofm_pill' }, `${t('news.lastFetch')}: ${ago(news.data?.fetchedAt, t.locale)}`),
          h('span', { className: 'spacer', style: { marginLeft: 'auto' } }),
          h(Button, { kind: 'ghost', onClick: () => setOpen(value => !value) }, open ? t('news.collapse') : t('news.expand')),
          h(Button, { disabled: busy || news.status !== 'ready', onClick: refresh }, busy ? t('news.refreshing') : t('news.refresh'))),
        open ? h(Fragment, null,
          h('div', { className: 'ofm_row' },
            notifyOs
              ? h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot ok' }), t('news.osOn'))
              : h(Button, { onClick: enableOs }, t('news.osEnable')),
            osError !== '' ? h('span', { className: 'ofm_note' }, osError)
              : notifyOs ? null : h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot' }), t('news.osOff')),
            unread > 0 ? h('span', { style: { marginLeft: 'auto' } }, h(Button, { kind: 'ghost', disabled: busy, onClick: () => ack({ all: true }) }, t('news.allRead'))) : null),
          news.status === 'loading' && news.data === undefined ? h('p', { className: 'ofm_note' }, t('loading')) : null,
          news.status === 'error' ? h('p', { className: 'ofm_note' }, news.error) : null,
          news.status === 'ready' && items.length === 0 ? h('p', { className: 'ofm_note' }, t('news.empty'), ' ', h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, t('news.emptyHint'))) : null,
          h('div', { className: 'ofm_news' }, items.map(item => h(NewsItem, {
            key: item.id, item, t, locale: t.locale, busy,
            onAck: () => ack({ id: item.id }),
          })))) : null)
    }

    function NewsItem(props) {
      const { item, t, locale, busy, onAck } = props
      const body = useMemo(() => parseSafeHtml(item.html ?? ''), [item.html])
      const acknowledged = item.acked === true
      return h('article', { className: 'ofm_newsitem' + (acknowledged ? '' : ' unread') },
        acknowledged ? null : h('span', { className: 'ofm_newsdot', 'aria-hidden': 'true' }),
        h('div', { className: 'ofm_newshead' },
          h('span', { className: 'ofm_level ' + item.level }, t(LEVEL_KEY[item.level] ?? 'level.info')),
          h('span', { className: 'ofm_newstitle' }, item.title),
          acknowledged ? null : h(Button, { kind: 'ghost', disabled: busy, onClick: onAck }, t('news.markRead'))),
        h('div', { className: 'ofm_newsmeta' },
          h('span', null, item.createdAt > 0 ? new Date(item.createdAt).toLocaleDateString() : ''),
          h('span', null, ago(item.createdAt, locale)),
          item.pinned === true ? h('span', null, '📌') : null),
        h('div', { className: 'ofm_newsbody' }, ...htmlToReact(body)),
        item.link?.url ? h('div', null, h('a', { href: item.link.url, target: '_blank', rel: 'noopener noreferrer' }, item.link.label || t('news.link'))) : null)
    }

    // ── in-app upgrade ───────────────────────────────────────────────────────
    function syncUpgradeOwner(control, data) {
      const managed = data?.managed === true
      if (control.current.managed !== managed) {
        control.current.managed = managed
        control.current.generation += 1
        control.current.phase = ''
      }
    }
    // Status requests may overlap (SSE, an action, or a remount). Only the newest
    // mounted request may publish an installation owner or an error.
    function useUpgradeStatus(control) {
      const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
      const sequence = useRef(0)
      const mounted = useRef(true)
      const reload = useCallback(async () => {
        const request = ++sequence.current
        control.current.ready = false
        setState(current => ({ ...current, status: 'loading', error: '' }))
        try {
          const data = await api('/update/status')
          if (!mounted.current || request !== sequence.current) return
          syncUpgradeOwner(control, data)
          control.current.data = data
          control.current.ready = true
          setState({ status: 'ready', data, error: '' })
          return data
        } catch (error) {
          if (!mounted.current || request !== sequence.current) return
          setState(current => ({ ...current, status: 'error', error: String(error?.message ?? error) }))
        }
      }, [])
      useEffect(() => {
        mounted.current = true
        void reload()
        return () => { mounted.current = false; sequence.current += 1; control.current.generation += 1 }
      }, [reload])
      return { ...state, reload }
    }
    function UpgradePanel(props) {
      const { t, settings, onApply, busy } = props
      const control = useRef({ managed: false, generation: 0, phase: '', ready: false })
      const status = useUpgradeStatus(control)
      const [phase, setPhase] = useState('')
      const [message, setMessage] = useState('')
      const [error, setError] = useState('')
      const data = status.data
      const managed = data?.managed === true
      syncUpgradeOwner(control, data)
      control.current.data = data
      control.current.ready = status.status === 'ready'
      useEffect(() => {
        setPhase(''); setMessage(''); setError('')
      }, [managed])
      useEffect(() => {
        const handler = event => {
          control.current.generation += 1
          control.current.phase = ''
          const version = event.detail?.version ?? ''
          setPhase(''); setError('')
          setMessage(control.current.managed || version === '' ? '' : event.detail?.restartRequired === true
           ? t('upgrade.restart').replace('{version}', version) : t('upgrade.done').replace('{version}', version))
          void status.reload()
        }
        window.addEventListener('ofm:upgraded', handler)
        return () => window.removeEventListener('ofm:upgraded', handler)
      }, [status.reload, t])
      const begin = next => {
        const snapshot = control.current.data
        if (control.current.managed || !control.current.ready || control.current.phase !== '' || snapshot?.applying === true) return null
        if (next !== 'checking' && snapshot?.recoveryRequired === true) return null
        if (next === 'applying' && snapshot?.available !== true) return null
        control.current.phase = next
        const token = ++control.current.generation
        setPhase(next); setError(''); setMessage('')
        return token
      }
      const current = token => token === control.current.generation && !control.current.managed
      const finish = token => {
        if (!current(token)) return false
        control.current.phase = ''; setPhase('')
        return true
      }
      const check = async () => {
        const token = begin('checking')
        if (token === null) return
        try {
          await post('/update/check', undefined, 60_000)
          if (finish(token)) void status.reload()
        } catch (err) {
          if (!finish(token)) return
          await status.reload()
          if (current(token)) setError(String(err?.message ?? err))
        }
      }
      const applyUpgrade = async () => {
        const token = begin('applying')
        if (token === null) return
        setMessage(t('upgrade.phase.download'))
        try {
          const result = await post('/update/apply', {}, 600_000)
          // The response releases controls even when hot reload closes SSE.
          if (!finish(token)) return
          setMessage(result?.version === undefined ? t('upgrade.phase.install') : result.restartRequired === true
            ? t('upgrade.restart').replace('{version}', result.version) : t('upgrade.doneRefresh').replace('{version}', result.version))
          void status.reload()
        } catch (err) {
          if (!finish(token)) return
          setMessage('')
          await status.reload()
          if (current(token)) setError(String(err?.message ?? err))
        }
      }
      const reload = async () => {
        const token = begin('reloading')
        if (token === null) return
        setMessage(t('upgrade.phase.reload'))
        try { await post('/reload') } catch (err) {
          if (!current(token)) return
          setMessage('')
          await status.reload()
          if (current(token)) setError(String(err?.message ?? err))
        } finally { finish(token) }
      }
      const notes = useMemo(() => parseSafeHtml(data?.notes ?? ''), [data?.notes])
      const upToDate = !managed && status.status === 'ready' && data !== undefined && data.latest !== '' && data.available === false
        && data.applying !== true && data.recoveryRequired !== true && data.versionMismatch !== true
      return h(Panel, null,
        h('div', { className: 'ofm_upgradecards' },
          h('span', { className: 'ofm_pill strong' }, `${t('upgrade.current')}: ${data?.current || '…'}`),
          data?.installedVersion !== undefined ? h('span', { className: 'ofm_pill' }, `${t('upgrade.installed')}: ${data.installedVersion || '…'}`) : null,
          data?.latest !== undefined && data.latest !== '' ? h('span', { className: 'ofm_pill' }, `${t('upgrade.latest')}: ${data.latest}`) : null,
          !managed && data?.available === true ? h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot warn' }), t('upgrade.available').replace('{version}', data.latest)) : null,
          upToDate ? h('span', { className: 'ofm_pill' }, h('span', { className: 'ofm_dot ok' }), t('upgrade.upToDate')) : null,
          h('span', { className: 'ofm_pill' }, `${t('upgrade.checkedAt')}: ${data?.checkedAt ? ago(data.checkedAt, t.locale) : t('upgrade.never')}`)),
        data?.hotReloadAvailable === false || data?.restartRequired === true ? h('div', { className: 'ofm_callout', role: 'status' }, t('upgrade.restartHint')) : null,
         h('div', { className: 'ofm_row' },
          h(Button, { disabled: managed || phase !== '' || status.status !== 'ready' || data?.applying === true, onClick: check }, !managed && phase === 'checking' ? t('upgrade.checking') : t('upgrade.check')),
          data?.available === true ? h(Button, { kind: 'primary', disabled: managed || status.status !== 'ready' || phase !== '' || data.applying === true || data.recoveryRequired === true, onClick: applyUpgrade }, !managed && phase === 'applying' ? t('upgrade.applying') : t('upgrade.apply')) : null,
          h('a', {
            className: 'ofm_btn ofm_starlink',
            href: 'https://github.com/Ebony-Vinyl/dsh-our-free-model',
            target: '_blank',
            rel: 'noopener noreferrer',
          }, h('span', { 'aria-hidden': 'true' }, '\u2606'), t('upgrade.star'))),
        managed ? h('div', { className: 'ofm_callout', role: 'status' }, t('upgrade.managed')) : null,
        status.status === 'error' ? h('div', { className: 'ofm_callout ofm_error' }, t('loadFailed'), ' ', status.error) : null,
        !managed && phase === 'applying' ? h('div', { className: 'ofm_prog', role: 'progressbar', 'aria-label': t('upgrade.applying') }, h('i')) : null,
        !managed && data?.recoveryRequired === true ? h('div', { className: 'ofm_callout ofm_error' },
          h('div', null, t('upgrade.recovery'),
            data.recoveryBackup ? h('p', { className: 'ofm_note' }, `${t('upgrade.backup')}: ${data.recoveryBackup}`) : null)) : null,
        !managed && data?.versionMismatch === true ? h('div', { className: 'ofm_callout' }, t('upgrade.mismatch')) : null,
        !managed && message !== '' ? h('p', { className: 'ofm_note' }, message) : null,
        !managed && (error || data?.error) ? h('div', { className: 'ofm_callout ofm_error' }, t('upgrade.failed').replace('{message}', error || data.error)) : null,
        notes.length > 0 ? h('div', { className: 'ofm_sec', style: { gap: 4 } },
          h('span', { className: 'ofm_note' }, t('upgrade.notes')),
          h('div', { className: 'ofm_upnotes ofm_newsbody' }, ...htmlToReact(notes))) : null,
        data?.lastApplied !== undefined ? h('p', { className: 'ofm_note' },
          `${t('upgrade.history')}: ${data.lastApplied.ok === true ? '✓' : '✗'} `,
          t('upgrade.from').replace('{from}', data.lastApplied.from ?? '?'),
          ` → ${data.lastApplied.to ?? '?'} · ${ago(data.lastApplied.at, t.locale)}`,
          data.lastApplied.ok === false && data.lastApplied.error ? ` — ${data.lastApplied.error}` : '') : null,
        !managed ? h('p', { className: 'ofm_note' }, (settings.updateCheckHours ?? 0) > 0 ? t('upgrade.auto').replace('{n}', String(settings.updateCheckHours)) : t('upgrade.autoOff')) : null,
        h('div', { className: 'ofm_row' },
          h(Button, { disabled: managed || data?.hotReloadAvailable === false || data?.restartRequired === true || status.status !== 'ready' || phase !== '' || data?.applying === true || data?.recoveryRequired === true, onClick: reload }, phase === 'reloading' && !managed ? t('reload.reloading') : t('reload.now')),
          h(Switch, { checked: !managed && data?.autoReloadWatch === true, disabled: managed || data?.hotReloadAvailable === false || status.status !== 'ready' || phase !== '' || busy, label: t('reload.auto'), onChange: () => { if (!control.current.managed && control.current.ready && control.current.data?.hotReloadAvailable !== false && control.current.phase === '' && !busy) onApply({ autoReloadWatch: !(control.current.data?.autoReloadWatch === true) }) } }),
          managed ? null : h('span', { className: 'ofm_note' }, t('reload.done').replace('{n}', String(settings.reloadCount ?? 0)))))
    }

    function UpgradePage(props) {
      const { t, settings, onApply, busy } = props
      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('section.upgrade'), sub: t('section.upgradeHint') }),
        h(UpgradePanel, { t, settings, onApply, busy }))
    }

    // ── 推荐项目页 ────────────────────────────────────────────────────────────
    // 这一页只有一个任务：让人点开仓库、点下 Star。所以文案是「说清它解决什么
    // 问题」，动作是「一眼能看到的星按钮」，数字是宿主 /picks 取回的真实 Star /
    // Fork / 最近提交——拿不到就整块不显示，绝不用占位数字凑版面（这块页面的
    // 全部说服力都在数字是真的）。每张卡片的文案按语言直写 t('字面量')，字典
    // 保持可 grep；各仓库的地址与「第二个动作」在这里各写一份。
    const RECO_LINKS = {
      desktop: { repo: 'https://github.com/Ebony-Vinyl/EAC-Desktop', extra: 'https://github.com/Ebony-Vinyl/EAC-Desktop/releases' },
      pack: { repo: 'https://github.com/Ebony-Vinyl/EAC-Pack', extra: 'https://github.com/Ebony-Vinyl/EAC-Pack#git-安装' },
      designWorld: { repo: 'https://github.com/Ebony-Vinyl/EAC-design-world', extra: 'https://github.com/Ebony-Vinyl/EAC-design-world#安装' },
    }
    const RECO_DESKTOP_MARK = 'M1.4 3.1h13.2a.7.7 0 01.7.7v6a.7.7 0 01-.7.7H1.4a.7.7 0 01-.7-.7v-6a.7.7 0 01.7-.7zM5.6 12h4.8v1.4H5.6z'
    const RECO_PACK_MARK = 'M8 1.2l6.3 3.2L8 7.6 1.7 4.4 8 1.2zM12.9 7.3l1.4.7L8 11.2 1.7 8l1.4-.7L8 9.8l4.9-2.5zM12.9 10.6l1.4.7L8 14.5 1.7 11.3l1.4-.7L8 13.1l4.9-2.5z'
    const RECO_DESIGN_MARK = 'M2.6 1.6h7.1l3.7 3.7v7.1a2 2 0 01-2 2H2.6a2 2 0 01-2-2V3.6a2 2 0 012-2zm.9 1.9v7.6h9V6.1h-2.5a1 1 0 01-1-1V3.5H3.5zm8.7 2.1h.6v-1.4l-.6-.6v2zM4.2 7.1h7.6a.7.7 0 010 1.4H4.2a.7.7 0 010-1.4zm0 3h5.2a.7.7 0 010 1.4H4.2a.7.7 0 010-1.4z'
    const RECO_EXT_MARK = 'M3.75 2A1.75 1.75 0 002 3.75v8.5C2 13.216 2.784 14 3.75 14h8.5A1.75 1.75 0 0014 12.25v-4.5a.75.75 0 00-1.5 0v4.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h4.5a.75.75 0 000-1.5h-4.5zM9.5 2a.75.75 0 000 1.5h2.19L7.22 7.97a.75.75 0 101.06 1.06l4.47-4.47v2.19a.75.75 0 001.5 0v-4a.75.75 0 00-.75-.75h-4z'

    /** 2,034 — a star count is read, not computed, so it keeps its separators. */
    const grouped = value => String(Math.max(0, Math.round(Number(value) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

    /**
     * 0 → n in about a second, once per arrival.
     *
     * The page's whole argument is that these numbers are real and moving, and a
     * number that counts up reads as a live reading rather than a printed one.
     * Reduced motion skips straight to the value — the number is the point, the
     * motion is not.
     */
    function useCountUp(target, effects = false) {
      const [value, setValue] = useState(target ?? null)
      useEffect(() => {
        if (typeof target !== 'number') return
        const reduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          && window.matchMedia('(prefers-reduced-motion: reduce)').matches
        if (reduced || !effects) { setValue(target); return }
        const started = Date.now()
        let raf = 0
        const tick = () => {
          const progress = Math.min(1, (Date.now() - started) / 900)
          setValue(Math.round(target * (1 - Math.pow(1 - progress, 3))))
          if (progress < 1) raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
      }, [target, effects])
      return value
    }

    function RecoCard(props) {
      const { t, index, stat, mark, name, repo, badge, tagline, body, chips, repoUrl, extraUrl, extraLabel } = props
      const stars = stat !== null && typeof stat.stars === 'number' ? stat.stars : null
      const shown = useCountUp(stars, props.effects)
      const forks = stat !== null && typeof stat.forks === 'number' ? stat.forks : null
      const pushedAt = stat !== null && typeof stat.pushedAt === 'number' ? stat.pushedAt : null
      const stale = stat !== null && stat.stale === true
      // One fork is one fork; the label is the only place the page can tell.
      const forkLabel = forks === 1 ? t('picks.fork') : t('picks.forks')
      return h('article', { className: 'ofm_recocard', style: { '--i': String(index) } },
        h('div', { className: 'ofm_recotop' },
          h('span', { className: 'ofm_recomark', 'aria-hidden': 'true' }, h('svg', { viewBox: '0 0 16 16' }, h('path', { d: mark }))),
          h('div', { className: 'ofm_recoid' },
            h('span', { className: 'ofm_reconame' }, name),
            h('span', { className: 'ofm_recorepo' }, repo)),
          h('span', { className: 'ofm_recobadge' }, badge)),
        h('p', { className: 'ofm_recotagline' }, tagline),
        h('p', { className: 'ofm_recobody' }, body),
        h('div', { className: 'ofm_recochips' }, chips.map(chip => h('span', { key: chip, className: 'ofm_recochip' }, chip))),
        h('div', { className: 'ofm_recofoot' },
          h('div', { className: 'ofm_recofacts' },
            stars === null ? null : h('span', { className: 'ofm_recofact' },
              h('b', null, grouped(shown ?? stars)),
              h('span', null, t('picks.stars')),
              stale ? h('span', { className: 'ofm_reconote' }, t('picks.stale')) : null),
            forks === null ? null : h('span', { className: 'ofm_recofact' }, h('b', null, grouped(forks)), h('span', null, forkLabel)),
            pushedAt === null ? null : h('span', { className: 'ofm_recofact' }, h('b', null, ago(pushedAt, t.locale)), h('span', null, t('picks.updated')))),
          h('div', { className: 'ofm_recoacts' },
            h('a', { className: 'ofm_recogo', href: extraUrl, target: '_blank', rel: 'noreferrer noopener' },
              extraLabel,
              h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, h('path', { d: RECO_EXT_MARK }))),
            h('a', {
              className: 'ofm_recostar', href: repoUrl, target: '_blank', rel: 'noreferrer noopener',
              title: `${t('picks.starHint')} · ${repo}`,
            },
              h('span', { className: 'ofm_recostarring', 'aria-hidden': 'true' }),
              h('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true' }, h('path', { d: STAR_GLYPH })),
              t('picks.star')))))
    }

    function PicksPage(props) {
      const { t } = props
      const picks = useAsync(() => api('/picks'), [])
      const repos = picks.data?.repos ?? []
      const statOf = id => repos.find(row => row.id === id) ?? null
      // A cold read gives the host four seconds to reach GitHub, so a slow first
      // answer can land after the page is already on screen. One delayed re-read
      // fills the numbers in; the flag makes sure it is one, not a poll.
      const [retried, setRetried] = useState(false)
      const numbers = repos.some(row => typeof row.stars === 'number')
      useEffect(() => {
        if (retried || numbers || picks.status !== 'ready') return undefined
        const timer = setTimeout(() => { setRetried(true); picks.reload() }, 6000)
        return () => clearTimeout(timer)
      }, [retried, numbers, picks.status, picks.reload])
      // The project count and star total cover the same successfully read rows.
      const counted = repos.filter(row => Number.isFinite(row.stars))
      const total = counted.reduce((sum, row) => sum + row.stars, 0)
      return h('div', { className: 'ofm_page' },
        h('header', { className: 'ofm_hero ofm_glass' },
          h('span', { className: 'ofm_recoglow', 'aria-hidden': 'true' }),
          h('div', { className: 'ofm_pagehead' },
            h('div', { className: 'ofm_pagetitle' },
              h('h2', null, t('picks.title')),
              h('p', { className: 'ofm_pagesub' }, t('picks.sub'))),
            h('div', { className: 'ofm_pills' },
              total > 0 ? h(Pill, { strong: true }, t('picks.totalStars').replace('{n}', grouped(total)).replace('{c}', grouped(counted.length))) : null,
              h(StarButton, { t })))),
        h('div', { className: 'ofm_recogrid' },
          h(RecoCard, {
            t, effects: props.effects, index: 0, stat: statOf('eac-desktop'), mark: RECO_DESKTOP_MARK,
            name: 'EAC-Desktop', repo: 'Ebony-Vinyl/EAC-Desktop',
            badge: t('picks.desktop.badge'),
            tagline: t('picks.desktop.tagline'),
            body: t('picks.desktop.body'),
            chips: [t('picks.desktop.tag1'), t('picks.desktop.tag2'), t('picks.desktop.tag3'), t('picks.desktop.tag4')],
            repoUrl: RECO_LINKS.desktop.repo, extraUrl: RECO_LINKS.desktop.extra, extraLabel: t('picks.getDesktop'),
          }),
          h(RecoCard, {
            t, effects: props.effects, index: 1, stat: statOf('eac-pack'), mark: RECO_PACK_MARK,
            name: 'EAC-Pack', repo: 'Ebony-Vinyl/EAC-Pack',
            badge: t('picks.pack.badge'),
            tagline: t('picks.pack.tagline'),
            body: t('picks.pack.body'),
            chips: [t('picks.pack.tag1'), t('picks.pack.tag2'), t('picks.pack.tag3'), t('picks.pack.tag4')],
            repoUrl: RECO_LINKS.pack.repo, extraUrl: RECO_LINKS.pack.extra, extraLabel: t('picks.getPack'),
          }),
          h(RecoCard, {
            t, effects: props.effects, index: 2, stat: statOf('eac-design-world'), mark: RECO_DESIGN_MARK,
            name: 'EAC-design-world', repo: 'Ebony-Vinyl/EAC-design-world',
            badge: t('picks.design.badge'),
            tagline: t('picks.design.tagline'),
            body: t('picks.design.body'),
            chips: [t('picks.design.tag1'), t('picks.design.tag2'), t('picks.design.tag3'), t('picks.design.tag4')],
            repoUrl: RECO_LINKS.designWorld.repo, extraUrl: RECO_LINKS.designWorld.extra, extraLabel: t('picks.getDesign'),
          })),
        picks.status === 'error' ? h('p', { className: 'ofm_reconote' }, t('picks.liveFailed')) : null,
        h('p', { className: 'ofm_reconote' }, t('picks.foot')))
    }

    // ── EAC router ────────────────────────────────────────────────────────
    // Real channel logos carried over from the upstream Channel Pack client (see
    // vendor/channel-pack/NOTICE.md) — the same artwork users know from those
    // products, embedded so no network fetch is involved. Channels without an
    // entry fall back to their two-letter tile.
    const CHANNEL_ICONS = {
      'qodercn': 'data:image/png;base64,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',
      'qoder': 'data:image/png;base64,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',
      'cline': 'data:image/png;base64,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',
      'raccoon': 'data:image/png;base64,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',
      'zcode': 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAgklEQVR42u3XsRGAIAyF4UxgYe0g7j+FpZtgRwN36stLAhruqP+v4ICIdNaybsViy92yCj+CeMW7CO94gwgFRMUrIgFTAPbzgPe/Aa5nAInTAGicAtDE1QBtXAVgxGEAeuIpAFYYArDj81xEoQDLd+A1ID8k3wTkXDDEaDbEcBo1nl/XXoK4yMqvMgAAAABJRU5ErkJggg==',
    }

    /** The plugin's own brand mark (user-supplied artwork, 128px JPEG). */
    const BRAND_ICON = 'data:image/jpeg;base64,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'

    /**
     * The current account channels enabled by OFM. Identity is static (it is
     * the product, not a reading), so the grid renders instantly and only the
     * *state* comes from the pack over RPC. `accent` drives each card's stripe
     * and logo tile; `login` picks the flow the card offers.
     */
    const CHANNEL_PROVIDERS = [
      { id: 'lobsterai', name: 'LobsterAI', org: '有道', accent: '#FF6A00', note: '龙虾 · 每日签到积分', login: 'browser' },
      { id: 'qoder', name: 'Qoder', org: '阿里系', accent: '#615CED', note: '每日 100 Credits，加密推理端点', login: 'browser' },
      { id: 'qodercn', name: 'Qoder 中国版', org: '阿里系', accent: '#7A6CF0', note: '中国版端点与模型池', login: 'browser' },
      { id: 'trae', name: 'TRAE', org: '字节', accent: '#00BFA6', note: '手机号登录', login: 'browser' },
      { id: 'cline', name: 'Cline', org: 'Cline', accent: '#5B5BD6', note: 'Cline 账号免费额度', login: 'browser' },
      { id: 'loomy', name: 'Loomy', org: '讯飞', accent: '#2F6BFF', note: '微信扫码，或短信验证码备用', login: 'browser+sms' },
      { id: 'raccoon', name: 'Raccoon', org: '商汤', accent: '#00A6A6', note: '手机号登录', login: 'browser' },
      { id: 'minimax', name: 'MiniMax Code', org: 'MiniMax', accent: '#E4007F', note: '设备码 + PKCE，每日签到', login: 'browser' },
      { id: 'zcode', name: 'ZCode', org: '智谱', accent: '#3B6EF6', note: '浏览器登录（需本机可开浏览器）', login: 'browser' },
      { id: 'gemini', name: 'Gemini', org: 'Google Code Assist', accent: '#4285F4', note: '本地回调 OAuth 免费线', login: 'browser' },
    ]

    /** 与现有 RPC 的能力对应：余额、每日领取及独立签到状态分别判断。 */
    const CHANNEL_CREDITS = {
      lobsterai: { claim: true },
      qoder: { claim: true },
      qodercn: { claim: true },
      trae: { claim: true },
      cline: { unit: 'dollars' },
      loomy: { claim: true },
      raccoon: {},
      minimax: { claim: true, status: true },
      zcode: { claim: true, unit: 'tokens' },
      gemini: { unit: 'quota', quota: true },
    }

    /**
     * The host RPC the pack registered at `/api/channel-pack`.
     *
     * The pack's own browser half used the shell's connection service; this page
     * does the same instead of proxying through our JSON API, so channel traffic
     * keeps the connection's admission and the credential store stays the only
     * place a token exists. `connection` is read opportunistically: a shell that
     * does not offer it still renders the free and EAC pages, with this one
     * explaining itself instead of breaking.
     */
    function sameChannelTransport(left, right) {
      return left === right || (left !== null && right !== null
        && typeof left === 'object' && typeof right === 'object'
        && left.connection === right.connection && left.call === right.call)
    }

    function channelTransport(rpc) {
      return typeof rpc?.transport === 'function' ? rpc.transport() : rpc
    }

    function useChannelRpc(ctx) {
      const ctxRef = useRef(ctx)
      ctxRef.current = ctx
      const readTransport = useCallback(() => {
        const current = ctxRef.current
        let connection
        try { connection = current?.connection } catch { /* service not provided yet */ }
        if (connection === undefined || connection === null) {
          try { connection = current?.get?.('connection') } catch { /* service not provided yet */ }
        }
        try {
          const call = connection?.rpc?.call
          return typeof call === 'function' ? { connection, call } : null
        } catch { return null }
      }, [])
      const [transport, setTransport] = useState(readTransport)
      useEffect(() => {
        let alive = true
        const check = () => {
          if (!alive) return
          const next = readTransport()
          setTransport(previous => sameChannelTransport(previous, next) ? previous : next)
        }
        check()
        const timer = setInterval(check, 500)
        return () => { alive = false; clearInterval(timer) }
      }, [readTransport])
      // Context wrappers do not invalidate readers; actual transport replacement does.
      const rpc = useCallback(async (method, payload, timeoutMs = 60_000) => {
        const latest = readTransport()
        if (latest === null) throw new Error('no-connection')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        try {
          const result = await latest.call.call(latest.connection.rpc, '/api', 'channel-pack', { method, payload }, controller.signal)
          if (result?.ok === true) return result.value
          if (result?.ok === false) throw new Error(result.error?.message ?? result.error?.code ?? 'rpc-failed')
          return result
        } finally { clearTimeout(timer) }
      }, [readTransport, transport])
      rpc.transport = readTransport
      return { available: transport !== null, rpc }
    }

    const ZCODE_PROVIDER_KEY = 'ofm:zcode:login-provider'
    function closeLoginPopup(popup) {
      try { if (popup && !popup.closed) popup.close() } catch { /* best effort */ }
    }

    /** Human text for a millisecond timestamp, or the long-lived marker. */
    function expiryText(entry, t) {
      if (!Number.isFinite(entry?.expiresAt) || entry.expiresAt <= 0) return t('chan.expires.never')
      return ago(entry.expiresAt, t.locale)
    }

    function ChannelCard(props) {
      const { channel, status, rpc, t, onError, onChanged, compact = false, pending = false } = props
      const [open, setOpen] = useState(null)
      const [accounts, setAccounts] = useState(undefined)
      const [models, setModels] = useState(undefined)
      const [credits, setCredits] = useState(undefined)
      // 实时积分：每个账号的剩余余额（credits.balances），卡片汇总 + 账号行
      // 逐条展示；随账号列表与领积分动作刷新，另有一个慢轮询兜底。
      const [balances, setBalances] = useState(undefined)
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState('')
      const [login, setLogin] = useState(null)
      const modelBatchPending = useRef(false)
      const [balanceError, setBalanceError] = useState('')
      const [balanceLoading, setBalanceLoading] = useState(false)
      const balancePending = useRef(null)
      const balanceGeneration = useRef(0)
      const claimPending = useRef(false)
      const creditCapability = CHANNEL_CREDITS[channel.id]
      const [zcodeProvider, setZcodeProvider] = useState(() => {
        try { return window.localStorage?.getItem(ZCODE_PROVIDER_KEY) === 'zai' ? 'zai' : 'bigmodel' } catch { return 'bigmodel' }
      })
      const loginAttempt = useRef(null)
      const chooseZcodeProvider = value => {
        if (value !== 'bigmodel' && value !== 'zai') return
        setZcodeProvider(value)
        try { window.localStorage?.setItem(ZCODE_PROVIDER_KEY, value) } catch { /* preference still applies this session */ }
      }
      const balanceLabel = creditCapability?.unit === 'tokens' ? t('chan.credits.tokens')
        : creditCapability?.unit === 'dollars' ? t('chan.credits.dollars')
          : creditCapability?.quota ? t('chan.credits.quota') : t('chan.credits.left')

      const accountsCount = status?.accounts?.total ?? 0
      const enabledCount = status?.accounts?.enabled ?? 0
      const modelsTotal = status?.models?.total ?? 0
      const modelsOff = status?.models?.disabled ?? 0
      const connected = status?.closed !== true && enabledCount > 0
      const chanState = status?.closed === true ? 'off' : connected ? 'on' : 'idle'
      const stateText = pending ? t('chan.state.loading') : status?.closed === true ? t('chan.state.closed') : connected ? t('chan.state.on') : t('chan.state.off')

      const loadAccounts = useCallback(async () => {
        try {
          const value = await rpc('account.list', { provider: channel.id })
          setAccounts(value?.accounts ?? [])
        } catch (error) { setAccounts([]); onError(channel, error) }
      }, [rpc, channel.id, onError])
      const loadModels = useCallback(async () => {
        try {
          const value = await rpc('model.list', { provider: channel.id })
          setModels(value?.models ?? [])
        } catch (error) { setModels([]); onError(channel, error) }
      }, [rpc, channel.id, onError])
      const loadCredits = useCallback(async () => {
        if (!CHANNEL_CREDITS[channel.id]?.status) return
        try {
          const value = await rpc('credits.status', { provider: channel.id })
          setCredits(value?.accounts ?? [])
        } catch { setCredits([]) }
      }, [rpc, channel.id])
      const loadBalances = useCallback((afterWrite = false) => {
        if (!CHANNEL_CREDITS[channel.id] || !rpc) return Promise.resolve()
        const pending = balancePending.current
        if (!afterWrite && pending?.provider === channel.id && pending.rpc === rpc) return pending.promise
        const generation = ++balanceGeneration.current
        const request = { provider: channel.id, rpc }
        balancePending.current = request
        setBalanceLoading(true); setBalanceError('')
        request.promise = (async () => {
          try {
            const value = await rpc('credits.balances', { provider: channel.id, ...afterWrite ? { force: true } : {} }, 90_000)
            if (generation === balanceGeneration.current) setBalances(value?.accounts ?? [])
          } catch (error) {
            if (generation === balanceGeneration.current) {
              setBalances([])
              setBalanceError(String(error?.message ?? error))
            }
          } finally {
            if (generation === balanceGeneration.current) setBalanceLoading(false)
            if (balancePending.current === request) balancePending.current = null
          }
        })()
        return request.promise
      }, [rpc, channel.id])
      useEffect(() => {
        setBalances(undefined); setBalanceError('')
        void loadBalances()
        return () => { balanceGeneration.current++; balancePending.current = null }
      }, [loadBalances])
      // A slow heartbeat keeps the numbers honest while the page sits open:
      // balances move whenever a model is used elsewhere, and a stale credit
      // count reads as "I have more quota than I do".
      useEffect(() => {
        if (!CHANNEL_CREDITS[channel.id]) return undefined
        const timer = setInterval(() => { void loadBalances() }, 90_000)
        return () => clearInterval(timer)
      }, [channel.id, loadBalances])
      const balanceOf = accountId => {
        const row = (balances ?? []).find(entry => entry.accountId === accountId)
        return row?.balance === null || row?.balance === undefined ? null : row.balance
      }
      const balancesTotal = (balances ?? []).reduce((sum, row) => sum + (Number.isFinite(row.balance?.total) ? row.balance.total : 0), 0)
      const balancesKnown = (balances ?? []).some(row => Number.isFinite(row.balance?.total))
      const balanceFailures = (balances ?? []).filter(row => row.error || !Number.isFinite(row.balance?.total)).length

      // Refetch what is on screen whenever the pack reports a change for this
      // channel: an account added in another tab, a completed background login,
      // a claim that moved the numbers.
      useEffect(() => {
        const onEvent = () => {
          if (open === 'accounts') { void loadAccounts(); void loadCredits() }
          if (open === 'models') void loadModels()
          void loadBalances()
        }
        window.addEventListener('ofm:channels', onEvent)
        return () => window.removeEventListener('ofm:channels', onEvent)
      }, [open, loadAccounts, loadModels, loadCredits, loadBalances])

      const toggle = async fold => {
        if (open === fold) { setOpen(null); return }
        setOpen(fold)
        if (fold === 'accounts') { setAccounts(undefined); await loadAccounts(); void loadCredits(); void loadBalances() }
        if (fold === 'models') { setModels(undefined); await loadModels() }
      }

      // The pack's login is two-phase: `account.create` returns the URL to open
      // *immediately* (a popup opened after a 30-second await is blocked), then
      // the browser flow finishes in the background and `login.poll` sees the
      // credential appear. The placeholder account is real from the first
      // moment, so the card can poll against it.
      useEffect(() => {
        if (loginAttempt.current?.cancelled) {
          loginAttempt.current = null
          setBusy(value => value === 'add' ? '' : value)
        }
        return () => {
          const attempt = loginAttempt.current
          if (attempt) { attempt.cancelled = true; closeLoginPopup(attempt.popup) }
        }
      }, [channel.id])
      useEffect(() => {
        const attempt = loginAttempt.current
        if (!attempt || sameChannelTransport(attempt.transport, channelTransport(rpc))) return
        attempt.cancelled = true
        closeLoginPopup(attempt.popup)
        loginAttempt.current = null
        setBusy(value => value === 'add' ? '' : value)
      }, [rpc])
      const startLogin = async () => {
        if (loginAttempt.current && !loginAttempt.current.cancelled) return
        const attempt = { popup: null, cancelled: false, transport: channelTransport(rpc) }
        const current = () => !attempt.cancelled && sameChannelTransport(attempt.transport, channelTransport(rpc))
        loginAttempt.current = attempt
        setBusy('add'); setNotice('')
        // Reserve inside the click; a delayed RPC would lose transient activation.
        try {
          attempt.popup = window.open('about:blank', '_blank')
          if (attempt.popup) attempt.popup.opener = null
        } catch { closeLoginPopup(attempt.popup); attempt.popup = null }
        try {
          const value = await rpc('account.create', {
            provider: channel.id,
            ...channel.id === 'zcode' ? { zcodeProvider } : {},
          }, 90_000)
          if (!current()) { attempt.cancelled = true; closeLoginPopup(attempt.popup); return }
          const accountId = value?.accountId
          const url = value?.loginUrl
          if (typeof accountId !== 'string' || accountId === '') throw new Error('bad-answer')
          if (typeof url === 'string' && url !== '') {
            const target = new URL(url)
            if (url.length > 2048 || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('bad-login-url')
            let opened = false
            try {
              if (attempt.popup && !attempt.popup.closed) {
                attempt.popup.location.replace(url)
                opened = true
                attempt.popup = null
              }
            } catch { /* the host can open it instead */ }
            closeLoginPopup(attempt.popup); attempt.popup = null
            if (!opened) {
              try { opened = (await post('/open-external', { url }, 15_000))?.opened === true } catch { /* manual link remains available */ }
            }
            if (!current()) { attempt.cancelled = true; return }
            if (!opened) {
              try { window.open(url, '_blank', 'noopener') } catch { /* the modal offers the link too */ }
            }
          } else { closeLoginPopup(attempt.popup); attempt.popup = null }
          setLogin({ accountId, url: typeof url === 'string' ? url : '', startedAt: Date.now() })
          setOpen('accounts')
        } catch (error) {
          closeLoginPopup(attempt.popup)
          if (current()) onError(channel, error)
        } finally {
          if (loginAttempt.current === attempt && !attempt.cancelled) {
            loginAttempt.current = null
            setBusy('')
          }
        }
      }

      // Poll the placeholder until its credential lands. Ten minutes matches the
      // window the pack keeps a pending login link alive for.
      useEffect(() => {
        if (login === null) return undefined
        let alive = true
        const timer = setInterval(async () => {
          if (Date.now() - login.startedAt > 10 * 60_000) {
            if (alive) { setLogin(null); setNotice(t('chan.login.expired')) }
            return
          }
          try {
            const value = await rpc('login.poll', { accountId: login.accountId, provider: channel.id })
            if (!alive) return
            if (value?.done === true) {
              setLogin(null)
              if (value.success === false) {
                setNotice(t('chan.login.failed').replace('{reason}', value.error ?? '未知原因'))
              } else {
                setNotice(t('chan.login.done').replace('{login}', value.login ?? ''))
                onChanged()
                void loadAccounts()
                void loadCredits()
                void loadBalances(true)
              }
            } else if (typeof value?.error === 'string' && value.error !== '') {
              setLogin(null)
              setNotice(t('chan.login.failed').replace('{reason}', value.error))
            }
          } catch { /* the link may still complete; keep polling */ }
        }, 3000)
        return () => { alive = false; clearInterval(timer) }
      }, [login, rpc, channel.id, t, onChanged, loadAccounts, loadCredits, loadBalances])

      const accountAction = async (key, accountId, fn) => {
        setBusy(key); setNotice('')
        try { await fn() } catch (error) { onError(channel, error) } finally { setBusy('') }
      }

      const setAllModels = async disabled => {
        if (busy !== '' || modelBatchPending.current || !rpc || !models?.length) return
        modelBatchPending.current = true
        try {
          await accountAction(disabled ? 'models:hide' : 'models:show', '', async () => {
            await rpc('model.setAllDisabled', { provider: channel.id, disabled })
            await loadModels()
            onChanged()
          })
        } finally { modelBatchPending.current = false }
      }

      const removeAccount = async accountId => {
        const entry = (accounts ?? []).find(row => row.id === accountId)
        if (typeof window !== 'undefined' && typeof window.confirm === 'function'
          && !window.confirm(t('chan.confirm.delete').replace('{name}', entry?.nickname ?? accountId))) return
        await accountAction('del:' + accountId, accountId, async () => {
          await rpc('account.delete', { accountId })
          onChanged(); await loadAccounts(); void loadBalances(true)
        })
      }

      const claim = async () => {
        if (!creditCapability?.claim || busy !== '' || claimPending.current) return
        claimPending.current = true
        setBusy('claim'); setNotice('')
        try {
          const value = await rpc('credits.claimAll', { provider: channel.id }, 180_000)
          const summary = value?.summary ?? value
          const claimed = Number(summary?.claimed ?? 0)
          const credit = Number(summary?.totalCredit ?? 0)
          const failed = (value?.results ?? []).filter(row => row.outcome?.kind === 'failed')
          const successText = t('chan.claim.result').replace('{count}', String(claimed)).replace('{credit}', String(credit))
          const failureText = t('chan.claim.failed').replace('{reason}', failed.map(row => row.outcome.message).join('；'))
          setNotice(failed.length > 0 ? claimed > 0 ? `${successText}；${failureText}` : failureText
            : claimed > 0 ? successText : t('chan.claim.none'))
          void loadCredits(); void loadBalances(true)
        } catch (error) { onError(channel, error) } finally { claimPending.current = false; setBusy('') }
      }

      const creditFor = accountId => (credits ?? []).find(row => row.accountId === accountId)?.status ?? null
      const [expanded, setExpanded] = useState(false)

      const card = h('article', {
        className: `ofm_chan ${compact ? 'compact' : 'ofm_glass'}${status?.closed === true ? ' off' : ''}`,
        'data-state': chanState,
        'data-channel': channel.id,
        style: { '--chan-accent': channel.accent },
      },
        h('div', { className: 'ofm_chanhead' },
          h('span', { className: 'ofm_chanlogo', 'aria-hidden': 'true' },
            CHANNEL_ICONS[channel.id] !== undefined
              ? h('img', { src: CHANNEL_ICONS[channel.id], alt: '' })
              : channel.name.slice(0, 2).toUpperCase()),
          h('span', { className: 'ofm_chanid' },
            h('b', null, channel.name),
            h('span', null, channel.org)),
          h('span', { className: 'ofm_chanstate' },
            h('span', { className: `ofm_dot ${connected ? 'ok' : status?.closed === true ? 'err' : ''}` }),
            stateText)),
        h('p', { className: 'ofm_note' }, channel.note),
        h('div', { className: 'ofm_chanmeta' },
          h('span', null, `${t('chan.meta.accounts')} `, h('b', null, `${enabledCount}/${accountsCount}`)),
          h('span', null, `${t('chan.meta.models')} `, h('b', null, modelsTotal === 0 ? '—' : `${modelsTotal - modelsOff}/${modelsTotal}`)),
          creditCapability ? h('span', { className: 'ofm_credittotal' },
            `${balanceLabel} `,
            h('b', null, balanceLoading ? '…' : balancesKnown
              ? creditCapability.quota ? t('chan.credits.loaded').replace('{count}', String((balances ?? []).filter(row => Number.isFinite(row.balance?.total)).length)) : kilo(balancesTotal)
              : balances === undefined ? '…' : '—')) : null),
        compact ? h('div', { className: 'ofm_directoryactions' },
          h('span', { className: 'ofm_id' }, channel.id),
          h('button', {
            type: 'button', className: `ofm_btn ${accountsCount > 0 || expanded ? 'ghost' : 'primary'}`,
            disabled: !rpc || busy !== '', 'aria-expanded': expanded,
            'aria-controls': `ofm-channel-${channel.id}`,
            onClick: () => {
              if (expanded) { setExpanded(false); return }
              setExpanded(true)
              if (accountsCount > 0) { if (open !== 'accounts') void toggle('accounts') }
              else void startLogin()
            },
          }, expanded ? t('chan.collapse') : accountsCount > 0 ? t('chan.manage') : t('chan.connect'))) : null,
        !compact || expanded ? h('div', {
          className: compact ? 'ofm_directorydetail' : undefined, id: `ofm-channel-${channel.id}`,
        },
        h('div', { className: 'ofm_chanacts' },
          channel.id === 'zcode' ? h('div', { className: 'ofm_seg', role: 'group', 'aria-label': t('chan.zcode.provider') },
            h('button', {
              type: 'button', disabled: busy !== '' || !rpc,
              'aria-pressed': zcodeProvider === 'bigmodel',
              onClick: () => chooseZcodeProvider('bigmodel'),
            }, t('chan.zcode.bigmodel')),
            h('button', {
              type: 'button', disabled: busy !== '' || !rpc,
              'aria-pressed': zcodeProvider === 'zai',
              onClick: () => chooseZcodeProvider('zai'),
            }, t('chan.zcode.zai'))) : null,
          h('button', { type: 'button', className: 'ofm_btn', disabled: busy !== '' || !rpc, 'aria-busy': busy === 'add' ? 'true' : undefined, onClick: startLogin }, busy === 'add' ? '…' : t('chan.act.add')),
          accountsCount > 0 ? h('button', {
            type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || !rpc, 'aria-busy': busy === 'refreshAll' ? 'true' : undefined,
            onClick: () => accountAction('refreshAll', '', async () => {
              for (const row of accounts ?? await rpc('account.list', { provider: channel.id }).then(v => v?.accounts ?? [])) {
                try { await rpc('account.refresh', { accountId: row.id }, 90_000) } catch (error) { onError(channel, error) }
              }
              onChanged(); await loadAccounts(); void loadBalances(true)
            }),
          }, busy === 'refreshAll' ? '…' : t('chan.act.refresh')) : null,
          creditCapability ? h('button', {
            type: 'button', className: 'ofm_btn ghost', disabled: balanceLoading || busy !== '' || !rpc,
            'aria-busy': balanceLoading ? 'true' : undefined, onClick: () => void loadBalances(true),
          }, balanceLoading ? t('chan.credits.loading') : t('chan.credits.refresh')) : null,
          creditCapability?.claim ? h('button', {
            type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || !rpc, 'aria-busy': busy === 'claim' ? 'true' : undefined,
            onClick: claim,
          }, busy === 'claim' ? '…' : t('chan.act.claim')) : null,
          h('button', { type: 'button', className: 'ofm_foldtoggle', disabled: !rpc, 'data-open': open === 'accounts' ? 'true' : 'false', onClick: () => void toggle('accounts') },
            h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M3 1.5l6 4.5-6 4.5z' })),
            t('chan.fold.accounts'), accounts === undefined ? null : ` (${accounts.length})`),
          h('button', { type: 'button', className: 'ofm_foldtoggle', disabled: !rpc, 'data-open': open === 'models' ? 'true' : 'false', onClick: () => void toggle('models') },
            h('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' }, h('path', { d: 'M3 1.5l6 4.5-6 4.5z' })),
            t('chan.fold.models'), models === undefined ? null : ` (${models.length})`)),
        notice !== '' ? h('p', { className: 'ofm_note' }, notice) : null,
        balanceError !== '' ? h('p', { className: 'ofm_balanceerror', role: 'alert' },
          t('chan.credits.failed').replace('{reason}', balanceError))
          : balanceFailures > 0 ? h('p', { className: 'ofm_balanceerror', role: 'status' },
            t('chan.credits.partial').replace('{count}', String(balanceFailures))) : null,
        open === 'accounts' ? h('div', { className: 'ofm_chanfold' },
          accounts === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 44 } })
            : accounts.length === 0 ? h('p', { className: 'ofm_note' }, t('chan.noAccount'))
              : h('div', { className: 'ofm_acctlist' }, accounts.map(row => {
                const credit = creditFor(row.id)
                const pending = row.refreshable !== true && !Number.isFinite(row.expiresAt)
                return h('div', { className: 'ofm_acct' + (pending ? ' pending' : ''), key: row.id },
                  h('span', { className: 'ofm_acctname', title: row.nickname ?? row.id }, row.nickname ?? row.id),
                  h('span', { className: 'ofm_acctmeta' }, row.enabled === false ? t('chan.disabled') : t('chan.enabled'), ' · ', expiryText(row, t)),
                  credit?.todayCheckedIn === true && Number.isFinite(credit.todayCredit) ? h('span', { className: 'ofm_creditbadge' },
                    t('chan.credit.today').replace('{credit}', String(credit.todayCredit))) : null,
                  (() => {
                    const balance = balanceOf(row.id)
                    if (!creditCapability) return null
                    if (balanceLoading) return h('span', { className: 'ofm_note' }, t('chan.credits.loading'))
                    const result = (balances ?? []).find(entry => entry.accountId === row.id)
                    if (balance === null || !Number.isFinite(balance.total)) return h('span', { className: 'ofm_balanceerror' },
                      balanceError ? t('chan.credits.failed').replace('{reason}', balanceError)
                        : result?.error || t('chan.credits.unavailable'))
                    const reading = creditCapability.quota
                      ? (balance.packages ?? []).map(pkg => `${pkg.name} ${pkg.remaining}%`).join(' · ') || '—'
                      : kilo(balance.total)
                    return h('span', { className: 'ofm_creditbadge strong', title: balanceLabel },
                      `${balanceLabel} ${reading}`)
                  })(),
                  h('span', { className: 'ofm_acctacts' },
                    h('button', {
                      type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                      onClick: () => accountAction('test:' + row.id, row.id, async () => {
                        const value = await rpc('account.test', { accountId: row.id }, 90_000)
                        setNotice(value?.ok === false
                          ? t('chan.test.failed').replace('{reason}', value?.error ?? '')
                          : t('chan.test.ok').replace('{ms}', String(value?.ms ?? value?.latencyMs ?? '—')))
                      }),
                    }, t('chan.act.test')),
                    h('button', {
                      type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                      onClick: () => accountAction('refresh:' + row.id, row.id, async () => {
                        await rpc('account.refresh', { accountId: row.id }, 90_000)
                        onChanged(); await loadAccounts(); void loadBalances(true)
                      }),
                    }, t('chan.act.refresh')),
                    h('button', {
                      type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                      onClick: () => accountAction('toggle:' + row.id, row.id, async () => {
                        await rpc('account.update', { accountId: row.id, patch: { enabled: row.enabled === false } })
                        onChanged(); await loadAccounts()
                      }),
                    }, row.enabled === false ? t('chan.act.enable') : t('chan.act.disable')),
                    h('button', {
                      type: 'button', className: 'ofm_minibtn danger', disabled: busy !== '' || !rpc,
                      onClick: () => void removeAccount(row.id),
                    }, t('chan.act.delete'))))
              }))) : null,
        open === 'models' ? h('div', { className: 'ofm_chanfold' },
          models === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 44 } })
            : models.length === 0 ? h('p', { className: 'ofm_note' }, '—')
              : h(Fragment, null,
                h('div', { className: 'ofm_row' },
                  h('span', { className: 'ofm_note' }, t('chan.model.enabledCount')
                    .replace('{enabled}', String(models.filter(model => model.disabled !== true).length))
                    .replace('{total}', String(models.length))),
                  h('button', {
                    type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || !rpc,
                    title: t('chan.model.allScope'), 'aria-busy': busy === 'models:show' ? 'true' : undefined,
                    onClick: () => void setAllModels(false),
                  }, t('chan.model.enableAll')),
                  h('button', {
                    type: 'button', className: 'ofm_btn ghost', disabled: busy !== '' || !rpc,
                    title: t('chan.model.allScope'), 'aria-busy': busy === 'models:hide' ? 'true' : undefined,
                    onClick: () => void setAllModels(true),
                  }, t('chan.model.disableAll'))),
                h('div', { className: 'ofm_modellist' }, models.map(model => h('div', {
                className: 'ofm_modelrow' + (model.disabled === true ? ' off' : ''),
                key: model.id,
              },
                h('span', { className: 'ofm_id', title: model.id }, model.name ?? model.id),
                model.isFree === true ? h('span', { className: 'ofm_tagpill free' }, t('chan.model.free')) : null,
                model.dead === true ? h('span', { className: 'ofm_tagpill dead' }, t('chan.model.dead')) : null,
                model.disabled === true ? h('span', { className: 'ofm_tagpill' }, t('chan.model.hidden')) : null,
                h('button', {
                  type: 'button', className: 'ofm_minibtn', disabled: busy !== '' || !rpc,
                  onClick: () => accountAction('model:' + model.id, '', async () => {
                    if (model.dead === true) await rpc('model.clearDead', { provider: channel.id, modelId: model.id })
                    else await rpc('model.setDisabled', { provider: channel.id, modelId: model.id, disabled: model.disabled !== true })
                    await loadModels(); onChanged()
                  }),
                }, model.dead === true ? t('chan.model.restore') : model.disabled === true ? t('chan.model.on') : t('chan.model.off'))))))) : null) : null)

      const modal = login === null ? null : h('div', { className: 'ofm_scrim' },
        h('div', { className: 'ofm_modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('chan.login.title').replace('{name}', channel.name) },
          h('div', { className: 'ofm_modalhead' }, t('chan.login.title').replace('{name}', channel.name)),
          h('div', { className: 'ofm_modalbody ofm_loginbody' },
            h('div', { className: 'ofm_loginstep' }, h('b', null, '1'), h('span', null, t('chan.login.step1'))),
            h('div', { className: 'ofm_loginstep' }, h('b', null, '2'), h('span', null, t('chan.login.step2'))),
            login.url === '' ? null : h('code', { className: 'ofm_mono', style: { wordBreak: 'break-all', whiteSpace: 'pre-wrap' } }, login.url),
            h('p', { className: 'ofm_note ofm_scanline' }, t('chan.login.waiting'))),
          h('div', { className: 'ofm_modalfoot' },
            login.url === '' ? null : h('a', { className: 'ofm_btn primary', href: login.url, target: '_blank', rel: 'noreferrer noopener' }, t('chan.login.open')),
            h('button', { type: 'button', className: 'ofm_btn ghost', onClick: () => setLogin(null) }, t('chan.login.cancel')))))

      return h(Fragment, null, card, modal)
    }

    function ChannelsPage(props) {
      const { t, ctx, summary } = props
      const { available, rpc } = useChannelRpc(ctx)
      const [query, setQuery] = useState('')
      const [filter, setFilter] = useState('')
      // The pack runs a daily auto check-in engine across the credit channels;
      // this page is where it is switched and watched (usage.autoCheckin).
      const [auto, setAuto] = useState(undefined)
      const loadAuto = useCallback(async () => {
        if (!available) return
        try { const value = await rpc('usage.autoCheckin', {}, 30_000); setAuto(value?.autoCheckin ?? null) } catch { setAuto(null) }
      }, [available, rpc])
      useEffect(() => { void loadAuto() }, [loadAuto])
      const toggleAuto = async () => {
        try { const value = await rpc('usage.autoCheckin', { enabled: auto?.enabled !== true }, 60_000); setAuto(value?.autoCheckin ?? null) } catch { /* the status refresh tells */ }
      }
      const [statuses, setStatuses] = useState(undefined)
      const [error, setError] = useState('')
      const pack = summary?.channels ?? { state: 'pending', error: '' }
      // The pack is what answers this page's RPC, so *the RPC answering* is the
      // readiness signal — the summary's `channels` bit can be a step behind:
      // it is read when the page mounts, while the pack's dynamic import may
      // still be in flight, and a page that trusted it would show an empty grid
      // for as long as that stale read lasted. The summary state is then only
      // the failure *reason* when the probes never come back.
      const [ready, setReady] = useState(pack.state === 'ready')

      const statusGeneration = useRef(0)
      const statusRetry = useRef(null)
      const statusRequest = useRef(0)
      const statusApplied = useRef(0)
      const loadStatus = useCallback(async (attempt = 0, generation = statusGeneration.current) => {
        if (attempt === 0) { clearTimeout(statusRetry.current); statusRetry.current = null }
        if (!available) return
        const request = ++statusRequest.current
        const transport = channelTransport(rpc)
        const current = () => generation === statusGeneration.current && request >= statusApplied.current
          && sameChannelTransport(transport, channelTransport(rpc))
        try {
          const value = await rpc('provider.status', { providers: CHANNEL_PROVIDERS.map(row => row.id) })
          if (!current()) return
          statusApplied.current = request
          setStatuses(value?.statuses ?? {})
          setReady(true)
          setError('')
        } catch (err) {
          if (!current()) return
          // The pack imports asynchronously on a cold start; retry a bounded
          // few times before believing the failure and surfacing the reason.
          if (attempt < 4) {
            clearTimeout(statusRetry.current)
            statusRetry.current = setTimeout(() => { if (current()) void loadStatus(attempt + 1, generation) }, 4000)
            return
          }
          setError(String(err?.message ?? err))
        }
      }, [available, rpc])

      useEffect(() => {
        void loadStatus()
        return () => { statusGeneration.current++; clearTimeout(statusRetry.current); statusRetry.current = null }
      }, [loadStatus])
      // A second poll loop, slow: the pack pushes nothing for accounts changed
      // in another window, and a stale count on this page is the kind of quiet
      // wrongness that reads as a bug. Local actions refresh immediately.
      useEffect(() => {
        if (!available) return undefined
        const timer = setInterval(() => { void loadStatus() }, 45_000)
        return () => clearInterval(timer)
      }, [available, loadStatus])

      const onChanged = useCallback(() => {
        void loadStatus()
        try { window.dispatchEvent(new CustomEvent('ofm:channels')) } catch { /* no window */ }
      }, [loadStatus])

      const onError = useCallback((channel, err) => {
        const reason = String(err?.message ?? err)
        showToast({ title: t('chan.error').replace('{reason}', reason).slice(0, 120), body: channel.name, tone: 'warn' })
      }, [t])

      const stateOf = channel => !available ? 'disconnected' : statuses?.[channel.id]?.closed === true ? 'closed'
        : (statuses?.[channel.id]?.accounts?.enabled ?? 0) > 0 ? 'connected' : 'disconnected'
      const connected = CHANNEL_PROVIDERS.filter(row => stateOf(row) === 'connected').length
      const needle = query.trim().toLowerCase()
      const rows = CHANNEL_PROVIDERS.filter(channel =>
        (filter === '' || (statuses !== undefined || !available) && stateOf(channel) === filter)
        && (needle === '' || `${channel.id} ${channel.name} ${channel.org}`.toLowerCase().includes(needle)))
      const failed = !ready && pack.state === 'failed'

      return h('div', { className: 'ofm_page' },
        h('header', { className: 'ofm_directoryhero' },
          h('div', { className: 'ofm_pagehead' },
            h('div', { className: 'ofm_pagetitle' },
              h('h2', null, t('chan.title')),
              h('p', { className: 'ofm_pagesub' }, t('chan.sub'))),
            h('div', { className: 'ofm_pills' },
              h(Pill, { strong: true, tone: ready ? 'ok' : failed ? 'err' : 'warn' },
                ready ? `${connected}/${CHANNEL_PROVIDERS.length} ${t('chan.state.on')}` : t('chan.state.off')),
              h(Pill, null, `${t('chan.meta.accounts')} ${statuses === undefined ? '—' : CHANNEL_PROVIDERS.reduce((sum, row) => sum + (statuses[row.id]?.accounts?.enabled ?? 0), 0)}`))),
          auto == null ? null : h('div', { className: 'ofm_row' },
            h(Switch, { checked: auto.enabled === true, label: t('chan.auto.title'), onChange: () => void toggleAuto() }),
            h(Pill, { tone: auto.running === true ? 'warn' : auto.ranToday === true ? 'ok' : '' },
              auto.running === true ? t('chan.auto.running') : auto.ranToday === true ? t('chan.auto.ran') : t('chan.auto.off')),
            typeof auto.lastResult === 'string' && auto.lastResult !== '' ? h('span', { className: 'ofm_note', title: auto.lastResult }, t('chan.auto.last').replace('{result}', auto.lastResult.length > 60 ? `${auto.lastResult.slice(0, 60)}…` : auto.lastResult)) : null)),
        failed ? h('div', { className: 'ofm_callout ofm_error' },
          h('div', null, t('chan.pack.failed').replace('{reason}', pack.error ?? ''), h('div', { className: 'ofm_note' }, t('chan.pack.hint')))) : null,
        !available ? h('div', { className: 'ofm_callout' }, h('div', null, t('chan.rpc.unavailable'))) : null,
        h('div', { className: 'ofm_directorytools' },
          h('label', null, t('chan.search'),
            h('input', {
              className: 'ofm_input', type: 'search', value: query, placeholder: t('chan.search'),
              onChange: event => setQuery(event.target.value),
            })),
          h('label', null, t('chan.filterStatus'),
            h('select', { className: 'ofm_input', 'aria-label': t('chan.filterStatus'), value: filter, onChange: event => setFilter(event.target.value) },
              h('option', { value: '' }, t('chan.filterAll')),
              h('option', { value: 'connected' }, t('chan.state.on')),
              h('option', { value: 'disconnected' }, t('chan.state.off')),
              h('option', { value: 'closed' }, t('chan.state.closed'))))),
        h('div', { className: 'ofm_directorycount', role: 'status' },
          t('chan.showing').replace('{shown}', String(rows.length)).replace('{total}', String(CHANNEL_PROVIDERS.length))),
        rows.length === 0 ? h('p', { className: 'ofm_note' }, t('chan.filterEmpty')) : null,
        h('div', { className: 'ofm_directory' }, rows.map(channel => h(ChannelCard, {
          key: channel.id,
          channel,
          status: available ? statuses?.[channel.id] : undefined,
          rpc: available && ready ? rpc : null,
          compact: true,
          pending: available && statuses === undefined && !failed && error === '',
          t,
          onError,
          onChanged,
        }))),
        error !== '' && !failed ? h('p', { className: 'ofm_note' }, `${t('chan.error').replace('{reason}', error)}`) : null)
    }

    // ── 数据看板 / 运行日志 / 网关设置 ────────────────────────────────────────
    // The absorbed pack keeps a per-request token ledger (channel → provider →
    // account → model trees, plus a ring of individual requests). These three
    // pages are its reading surface, modelled on the standalone gateway
    // consoles users already know: KPI cards, an account pivot, a model
    // performance table, a paginated request log and the gateway's switches.
    const LEDGER_EMPTY = () => ({ requests: 0, reportedRequests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, errors: 0 })

    /** Weighted merge of tree rows: averages are re-weighted by request count
     *  so a cross-day or cross-account merge never pretends a heavy day and a
     *  light day average to their mean. */
    function mergeLedgerRows(rows) {
      const out = LEDGER_EMPTY()
      let ttftSum = 0; let ttftN = 0; let tpsSum = 0; let tpsN = 0
      for (const row of rows) {
        out.requests += row.requests ?? 0
        out.reportedRequests += row.reportedRequests ?? 0
        out.inputTokens += row.inputTokens ?? 0
        out.outputTokens += row.outputTokens ?? 0
        out.cacheReadTokens += row.cacheReadTokens ?? 0
        out.cacheWriteTokens += row.cacheWriteTokens ?? 0
        out.reasoningTokens += row.reasoningTokens ?? 0
        out.errors += row.errors ?? 0
        if (Number.isFinite(row.avgTtftMs) && (row.requests ?? 0) > 0) { ttftSum += row.avgTtftMs * row.requests; ttftN += row.requests }
        if (Number.isFinite(row.avgTps) && (row.requests ?? 0) > 0) { tpsSum += row.avgTps * row.requests; tpsN += row.requests }
      }
      out.avgTtftMs = ttftN > 0 ? Math.round(ttftSum / ttftN) : null
      out.avgTps = tpsN > 0 ? Math.round((tpsSum / tpsN) * 10) / 10 : null
      return out
    }

    /** Flatten the channel→provider→account tree into account rows. */
    function ledgerAccountRows(channels) {
      const rows = []
      for (const ch of channels ?? []) {
        for (const provider of ch.providers ?? []) {
          for (const account of provider.accounts ?? []) {
            rows.push({ channel: ch.channel, provider: provider.provider, accountId: account.accountId, ...mergeLedgerRows([account.totals ?? {}]), models: account.models ?? [] })
          }
        }
      }
      return rows
    }

    /** Aggregate the same tree into per-model rows (across accounts). */
    function ledgerModelRows(channels) {
      const map = new Map()
      for (const ch of channels ?? []) {
        for (const provider of ch.providers ?? []) {
          for (const account of provider.accounts ?? []) {
            for (const model of account.models ?? []) {
              const key = model.model
              const row = map.get(key) ?? { model: key, providers: new Set(), rows: [] }
              row.providers.add(provider.provider)
              row.rows.push(model)
              map.set(key, row)
            }
          }
        }
      }
      return [...map.values()].map(row => ({ model: row.model, providers: [...row.providers], ...mergeLedgerRows(row.rows) }))
    }

    /** Flatten history days into one merged tree (the 全部历史 view). */
    function mergedHistoryChannels(days) {
      const map = new Map()
      for (const day of days ?? []) {
        for (const ch of day.channels ?? []) {
          const slot = map.get(ch.channel) ?? { channel: ch.channel, providers: [] }
          for (const provider of ch.providers ?? []) {
            let pslot = slot.providers.find(row => row.provider === provider.provider)
            if (pslot === undefined) { pslot = { provider: provider.provider, accounts: [] }; slot.providers.push(pslot) }
            for (const account of provider.accounts ?? []) {
              let aslot = pslot.accounts.find(row => row.accountId === account.accountId)
              if (aslot === undefined) { aslot = { accountId: account.accountId, models: [] }; pslot.accounts.push(aslot) }
              aslot.models.push(...(account.models ?? []))
            }
          }
          map.set(ch.channel, slot)
        }
      }
      // Re-aggregate the piled-up model lists into proper totals per account.
      for (const ch of map.values()) {
        for (const provider of ch.providers) {
          for (const account of provider.accounts) {
            const byModel = new Map()
            for (const model of account.models) {
              const row = byModel.get(model.model) ?? { model: model.model, rows: [] }
              row.rows.push(model); byModel.set(model.model, row)
            }
            account.models = [...byModel.values()].map(row => ({ model: row.model, ...mergeLedgerRows(row.rows) }))
            account.totals = mergeLedgerRows(account.models)
          }
        }
      }
      return [...map.values()]
    }

    function todayKey() {
      const now = new Date()
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    }

    const fmtInt = value => Number.isFinite(value) ? value.toLocaleString() : '—'
    const fmtPct = (part, whole) => whole > 0 ? `${Math.round(100 * part / whole)}%` : '—'
    const fmtMs = value => Number.isFinite(value) && value > 0 ? `${value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`}` : '—'
    const fmtTps = value => Number.isFinite(value) && value > 0 ? `${value.toFixed(1)} tok/s` : '—'

    function useLedger(props) {
      const { available, rpc } = useChannelRpc(props.ctx)
      const [state, setState] = useState({ status: 'loading', history: [], snapshot: null, error: '' })
      const load = useCallback(async () => {
        if (!available) { setState(current => ({ ...current, status: 'unavailable', error: 'no-connection' })); return }
        try {
          const [ledger, history] = await Promise.all([
            rpc('usage.tokenLedger', { limit: 400 }, 60_000),
            rpc('usage.tokenLedgerHistory', { sinceDays: 90 }, 60_000),
          ])
          setState({ status: 'ready', snapshot: ledger?.snapshot ?? null, history: history?.history ?? [], totals: history?.totals ?? null, error: '' })
        } catch (error) { setState(current => ({ ...current, status: 'error', error: String(error?.message ?? error) })) }
      }, [available, rpc])
      useEffect(() => { void load() }, [load])
      return { ...state, reload: load }
    }

    /** KPI cards: one reading per card, exactly like the gateway consoles. */
    function KpiCard(props) {
      const { label, value, sub, tone } = props
      return h('div', { className: `ofm_kpi ofm_glass${tone ? ` ${tone}` : ''}` },
        h('span', { className: 'ofm_kpilabel' }, label),
        h('b', { className: 'ofm_kpivalue' }, value),
        sub === undefined ? null : h('span', { className: 'ofm_kpisub' }, sub))
    }

    function LedgerPage(props) {
      const { t, ctx } = props
      const ledger = useLedger(props)
      const [scope, setScope] = useState('today')
      const loaded = ledger.status === 'ready'
      // 今日 = the pack's live snapshot (its in-memory day tree); 全部 = the
      // persisted day aggregation, merged back into one tree. The grand
      // cumulative number always reads the history total — even on 今日 —
      // because "累计" that resets at midnight is a lie.
      const channels = scope === 'today'
        ? (ledger.snapshot?.channels ?? [])
        : mergedHistoryChannels(ledger.history)
      const totals = scope === 'today'
        ? mergeLedgerRows([ledger.snapshot?.totals ?? {}])
        : mergeLedgerRows((ledger.history ?? []).map(day => day.totals ?? {}))
      const cumulative = ledger.totals ?? ledger.snapshot?.totals ?? {}
      const accounts = ledgerAccountRows(channels)
      const models = ledgerModelRows(channels).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens))
      // The pack's ring is already newest-first (`token-ledger.ts`: "最近明细
      // （最新在前）", built with `unshift`), so it is used as served. Reversing it
      // here put the oldest request at the top of the table — and, behind the log
      // page's pagination, the request the user just made on the last page.
      const entries = ledger.snapshot?.entries ?? []
      const tokenTotal = totals.inputTokens + totals.outputTokens
      const cacheBase = totals.inputTokens + totals.cacheReadTokens

      if (ledger.status === 'unavailable') {
        return h('div', { className: 'ofm_page' },
          h(PageHero, { title: t('dash.title'), sub: t('dash.sub') }),
          h('div', { className: 'ofm_callout' }, h('div', null, t('chan.rpc.unavailable'))))
      }
      return h('div', { className: 'ofm_page' },
        h(PageHero, { t, titleKey: 'dash.title', subKey: 'dash.sub' },
          h('div', { className: 'ofm_seg', role: 'tablist' },
            ['today', 'all'].map(key => h('button', {
              key, type: 'button', 'aria-pressed': scope === key ? 'true' : 'false',
              onClick: () => setScope(key),
            }, key === 'today' ? t('dash.today') : t('dash.all')))),
          h(Button, { onClick: () => void ledger.reload() }, t('dash.refresh'))),
        !loaded ? h('div', { className: 'ofm_chanwrap' }, [0, 1, 2].map(i => h('div', { className: 'ofm_skel', key: i, style: { minHeight: 120 } }))) : null,
        loaded ? h('div', { className: 'ofm_kpis' },
          h(KpiCard, { label: scope === 'today' ? t('dash.kpiToday') : t('dash.kpiScopeAll'), value: fmtInt(tokenTotal), sub: `${t('dash.input')} ${fmtInt(totals.inputTokens)} · ${t('dash.output')} ${fmtInt(totals.outputTokens)} · ${t('dash.reasoning')} ${fmtInt(totals.reasoningTokens)}` }),
          h(KpiCard, { label: t('dash.kpiCumulative'), value: fmtInt((cumulative.inputTokens ?? 0) + (cumulative.outputTokens ?? 0)), sub: `${t('dash.input')} ${fmtInt(cumulative.inputTokens)} · ${t('dash.output')} ${fmtInt(cumulative.outputTokens)} · ${t('dash.reasoning')} ${fmtInt(cumulative.reasoningTokens)}` }),
          h(KpiCard, { label: t('dash.kpiSpeed'), value: fmtTps(totals.avgTps), sub: `${t('dash.ttft')} ${fmtMs(totals.avgTtftMs)}` }),
          h(KpiCard, { label: t('dash.kpiCache'), value: fmtPct(totals.cacheReadTokens, cacheBase), sub: `${t('dash.cacheTokens')} ${fmtInt(totals.cacheReadTokens)}` }),
          h(KpiCard, { label: t('dash.kpiRequests'), value: fmtInt(totals.requests), sub: `${t('dash.successRate')} ${fmtPct(totals.requests - totals.errors, totals.requests)} · ${t('dash.failed')} ${fmtInt(totals.errors)}`, tone: totals.errors > 0 ? 'warn' : '' })) : null,
        loaded ? h(Section, { title: t('dash.recentTitle'), hint: t('dash.recentHint') },
          entries.length === 0 ? h('p', { className: 'ofm_note' }, t('dash.empty'))
            : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
                h('thead', null, h('tr', null,
                h('th', { key: 'time' }, t('log.time')),
                h('th', { key: 'chan' }, t('chan.titleSingle')),
                h('th', { key: 'model' }, t('log.model')),
                h('th', { key: 'account' }, t('log.account')),
                h('th', { key: 'via' }, t('log.via')),
                h('th', { key: 'result' }, t('log.result')),
                h('th', { key: 'duration' }, t('log.duration')),
                h('th', { key: 'ttft' }, t('log.ttft')),
                h('th', { key: 'speed' }, t('log.speed')),
                h('th', { key: 'input' }, t('log.input')),
                h('th', { key: 'output' }, t('log.output')),
                h('th', { key: 'reasoning' }, t('log.reasoning')),
                h('th', { key: 'cache' }, t('log.cache')),
                h('th', { key: 'total' }, t('log.total')))),
              h('tbody', null, entries.slice(0, 12).map((entry, index) => h('tr', { key: index },
                h('td', null, new Date(entry.ts).toLocaleString()),
                h('td', null, entry.provider),
                h('td', null, entry.model),
                h('td', null, entry.accountId || '—'),
                h('td', null, entry.channel === 'gateway' ? t('log.viaGateway') : t('log.viaDirect')),
                h('td', null, entry.error ? h('span', { className: 'ofm_badge unavailable', title: entry.error }, t('log.failed')) : h('span', { className: 'ofm_badge available' }, t('log.ok'))),
                h('td', { className: 'ofm_num' }, fmtMs(entry.durationMs)),
                h('td', { className: 'ofm_num' }, fmtMs(entry.ttftMs)),
                h('td', { className: 'ofm_num' }, fmtTps(entry.tps)),
                h('td', { className: 'ofm_num' }, fmtInt(entry.inputTokens)),
                h('td', { className: 'ofm_num' }, fmtInt(entry.outputTokens)),
                h('td', { className: 'ofm_num' }, Number.isFinite(entry.reasoningTokens) ? fmtInt(entry.reasoningTokens) : '—'),
                h('td', { className: 'ofm_num' }, Number.isFinite(entry.cacheReadTokens) ? fmtInt(entry.cacheReadTokens) : '—'),
                h('td', { className: 'ofm_num' }, h('b', null, fmtInt(entry.inputTokens + entry.outputTokens))))))))) : null,
        loaded ? h(Section, { title: t('dash.accountsTitle'), hint: t('dash.accountsHint') },
          accounts.length === 0 ? h('p', { className: 'ofm_note' }, t('dash.empty'))
            : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
              h('thead', null, h('tr', null,
                h('th', { key: 'account' }, t('log.account')),
                h('th', { key: 'chan' }, t('chan.titleSingle')),
                h('th', { key: 'requests' }, t('log.requests')),
                h('th', { key: 'total' }, t('log.total')),
                h('th', { key: 'input' }, t('log.input')),
                h('th', { key: 'output' }, t('log.output')),
                h('th', { key: 'reasoning' }, t('log.reasoning')),
                h('th', { key: 'cache' }, t('log.cache')),
                h('th', { key: 'mix' }, t('log.modelMix')))),
              h('tbody', null, accounts.sort((a, b) => b.requests - a.requests).map((row, index) => h('tr', { key: index },
                h('td', null, h('b', null, row.accountId || t('log.unattributed'))),
                h('td', null, row.provider),
                h('td', { className: 'ofm_num' }, fmtInt(row.requests)),
                h('td', { className: 'ofm_num' }, fmtInt(row.inputTokens + row.outputTokens)),
                h('td', { className: 'ofm_num' }, fmtInt(row.inputTokens)),
                h('td', { className: 'ofm_num' }, fmtInt(row.outputTokens)),
                h('td', { className: 'ofm_num' }, fmtInt(row.reasoningTokens)),
                h('td', { className: 'ofm_num' }, fmtInt(row.cacheReadTokens)),
                h('td', null, (row.models ?? []).slice().sort((a, b) => ((b.inputTokens ?? 0) + (b.outputTokens ?? 0)) - ((a.inputTokens ?? 0) + (a.outputTokens ?? 0))).slice(0, 2).map(model => `${model.model} · ${fmtInt((model.inputTokens ?? 0) + (model.outputTokens ?? 0))}`).join('，') || '—'))))))) : null,
        loaded ? h(Section, { title: t('dash.modelsTitle'), hint: t('dash.modelsHint') },
          models.length === 0 ? h('p', { className: 'ofm_note' }, t('dash.empty'))
            : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
              h('thead', null, h('tr', null,
                h('th', { key: 'model' }, t('log.model')),
                h('th', { key: 'chan' }, t('chan.titleSingle')),
                h('th', { key: 'requests' }, t('log.requests')),
                h('th', { key: 'failed' }, t('log.failed')),
                h('th', { key: 'total' }, t('log.total')),
                h('th', { key: 'slash' }, t('log.inputSlash')),
                h('th', { key: 'ttft' }, t('log.ttft')),
                h('th', { key: 'speed' }, t('log.speed')),
                h('th', { key: 'hit' }, t('log.cacheHit')),
                h('th', { key: 'share' }, t('log.share')))),
              h('tbody', null, models.map(row => h('tr', { key: row.model },
                h('td', null, h('b', null, row.model)),
                h('td', null, row.providers.join('，')),
                h('td', { className: 'ofm_num' }, fmtInt(row.requests)),
                h('td', { className: 'ofm_num' }, row.errors > 0 ? h('span', { className: 'ofm_badge unavailable' }, fmtInt(row.errors)) : fmtInt(0)),
                h('td', { className: 'ofm_num' }, fmtInt(row.inputTokens + row.outputTokens)),
                h('td', { className: 'ofm_num' }, `${fmtInt(row.inputTokens)} / ${fmtInt(row.outputTokens)} / ${fmtInt(row.reasoningTokens)}`),
                h('td', { className: 'ofm_num' }, fmtMs(row.avgTtftMs)),
                h('td', { className: 'ofm_num' }, fmtTps(row.avgTps)),
                h('td', { className: 'ofm_num' }, fmtPct(row.cacheReadTokens, row.inputTokens + row.cacheReadTokens)),
                h('td', { className: 'ofm_num' }, `${fmtPct(row.inputTokens + row.outputTokens, tokenTotal)}`))))))) : null)
    }

    /** The log page: the same request ring, at full width and full detail. */
    function LogsPage(props) {
      const { t, ctx } = props
      const ledger = useLedger(props)
      const [pageSize, setPageSize] = useState(20)
      const [auto, setAuto] = useState(false)
      const reload = ledger.reload
      useEffect(() => {
        if (auto !== true) return undefined
        const timer = setInterval(() => { void reload() }, 10_000)
        return () => clearInterval(timer)
      }, [auto, reload])
      // Newest first, as the pack serves it — see the note in LedgerPage.
      const entries = ledger.snapshot?.entries ?? []
      const pages = Math.max(1, Math.ceil(entries.length / pageSize))
      const [page, setPage] = useState(1)
      const safePage = Math.min(page, pages)
      const rows = entries.slice((safePage - 1) * pageSize, safePage * pageSize)
      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('logs.title'), sub: t('logs.sub') },
          h('div', { className: 'ofm_seg' }, [10, 20, 50, 100].map(size => h('button', {
            key: size, type: 'button', 'aria-pressed': pageSize === size ? 'true' : 'false',
            onClick: () => { setPageSize(size); setPage(1) },
          }, String(size)))),
          h(Switch, { checked: auto, label: t('logs.auto'), onChange: () => setAuto(value => !value) }),
          h(Button, { onClick: () => void reload() }, t('dash.refresh'))),
        ledger.status === 'unavailable' ? h('div', { className: 'ofm_callout' }, h('div', null, t('chan.rpc.unavailable'))) : null,
        ledger.status === 'loading' ? h('div', { className: 'ofm_skel', style: { minHeight: 200 } }) : null,
        ledger.status === 'ready' ? h(Section, {
          title: t('logs.title'),
          hint: t('logs.count').replace('{shown}', String(rows.length)).replace('{total}', String(entries.length)),
        },
          entries.length === 0 ? h('p', { className: 'ofm_note' }, t('logs.empty'))
            : h('div', { className: 'ofm_tablewrap' }, h('table', { className: 'ofm_table' },
              h('thead', null, h('tr', null,
                h('th', { key: 'time' }, t('log.time')),
                h('th', { key: 'chan' }, t('chan.titleSingle')),
                h('th', { key: 'model' }, t('log.model')),
                h('th', { key: 'account' }, t('log.account')),
                h('th', { key: 'via' }, t('log.via')),
                h('th', { key: 'result' }, t('log.result')),
                h('th', { key: 'duration' }, t('log.duration')),
                h('th', { key: 'ttft' }, t('log.ttft')),
                h('th', { key: 'speed' }, t('log.speed')),
                h('th', { key: 'input' }, t('log.input')),
                h('th', { key: 'output' }, t('log.output')),
                h('th', { key: 'reasoning' }, t('log.reasoning')),
                h('th', { key: 'cache' }, t('log.cache')),
                h('th', { key: 'total' }, t('log.total')))),
              h('tbody', null, rows.map((entry, index) => h('tr', { key: index, className: entry.error ? 'ofm_logfailed' : '' },
                h('td', null, new Date(entry.ts).toLocaleString()),
                h('td', null, entry.provider),
                h('td', null, entry.model),
                h('td', null, entry.accountId || '—'),
                h('td', null, entry.channel === 'gateway' ? t('log.viaGateway') : t('log.viaDirect')),
                h('td', null, entry.error ? h('span', { className: 'ofm_badge unavailable', title: entry.error }, t('log.failed')) : h('span', { className: 'ofm_badge available' }, t('log.ok'))),
                h('td', { className: 'ofm_num' }, fmtMs(entry.durationMs)),
                h('td', { className: 'ofm_num' }, fmtMs(entry.ttftMs)),
                h('td', { className: 'ofm_num' }, fmtTps(entry.tps)),
                h('td', { className: 'ofm_num' }, fmtInt(entry.inputTokens)),
                h('td', { className: 'ofm_num' }, fmtInt(entry.outputTokens)),
                h('td', { className: 'ofm_num' }, Number.isFinite(entry.reasoningTokens) ? fmtInt(entry.reasoningTokens) : '—'),
                h('td', { className: 'ofm_num' }, Number.isFinite(entry.cacheReadTokens) ? fmtInt(entry.cacheReadTokens) : '—'),
                h('td', { className: 'ofm_num' }, h('b', null, fmtInt(entry.inputTokens + entry.outputTokens)))))))),
          pages > 1 ? h('div', { className: 'ofm_row' },
            h(Button, { kind: 'ghost', disabled: safePage <= 1, onClick: () => setPage(value => Math.max(1, value - 1)) }, '‹'),
            h('span', { className: 'ofm_note' }, t('logs.page').replace('{page}', String(safePage)).replace('{pages}', String(pages))),
            h(Button, { kind: 'ghost', disabled: safePage >= pages, onClick: () => setPage(value => Math.min(pages, value + 1)) }, '›')) : null,
          h('p', { className: 'ofm_note' }, t('logs.windowNote'))) : null)
    }

    /** The gateway page: the pack's OpenAI endpoint plus this plugin's relay. */
    function GatewayPage(props) {
      const { t, ctx } = props
      const { available, rpc } = useChannelRpc(ctx)
      const [status, setStatus] = useState(undefined)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [keyShown, setKeyShown] = useState(false)
      const [relay, setRelay] = useState(undefined)
      const [relayKey, setRelayKey] = useState('')
      const [relayBusy, setRelayBusy] = useState(false)
      // 免费车道转发端口的接入配方。它和上面这块网关是两条独立监听：这里的地址与
      // 密钥由宿主按实际绑定的端口生成，端口没开就只给一句说明而不是一堆会骗人的
      // 配方（未启用时 /clients 回的是占位端口与占位 Key）。
      const clients = usePanel(() => api('/clients'), [])

      const loadGateway = useCallback(async () => {
        if (!available) return
        try { setStatus(await rpc('gateway.getEnabled', {}, 30_000)) } catch (error) { setNotice(String(error?.message ?? error)) }
      }, [available, rpc])
      const loadRelay = useCallback(async () => {
        try { setRelay(await api('/chan-gateway')) } catch { setRelay(null) }
      }, [])
      useEffect(() => { void loadGateway(); void loadRelay() }, [loadGateway, loadRelay])

      const toggleGateway = async enabled => {
        setBusy(true); setNotice('')
        try { setStatus(await rpc('gateway.setEnabled', { enabled }, 60_000)) } catch (error) { setNotice(String(error?.message ?? error)) } finally { setBusy(false) }
      }
      const applyRelay = async patch => {
        setRelayBusy(true); setNotice('')
        try { setRelay(await post('/chan-gateway/apply', patch)) } catch (error) { setNotice(String(error?.message ?? error)) } finally { setRelayBusy(false) }
      }
      const showRelayKey = async () => {
        try { setRelayKey((await api('/chan-gateway/key')).key ?? '') } catch { setRelayKey('') }
      }

      // The RPC returns structured values, not strings: `address` is
      // { host, port } and `apiKey` is { value, fromEnv, path } — rendering
      // either directly hands React an object, which is a crash (#31), not a
      // wrong sentence.
      const address = status?.address ?? null
      const gatewayUrl = address !== null && typeof address === 'object'
        ? `http://${address.host}:${address.port}/v1`
        : ''
      const apiKeyInfo = typeof status?.apiKey === 'object' && status?.apiKey !== null ? status.apiKey : null
      const apiKeyValue = apiKeyInfo?.value ?? ''
      const models = status?.models ?? []
      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('gw.title'), sub: t('gw.sub') },
          h(Button, { onClick: () => { void loadGateway(); void loadRelay() } }, t('dash.refresh'))),
        notice !== '' ? h('div', { className: 'ofm_callout ofm_error' }, h('div', null, notice)) : null,
        h(Section, { title: t('gw.gatewayTitle'), hint: t('gw.gatewayHint') },
          status === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 96 } })
            : h('div', { className: 'ofm_panel' },
              h('div', { className: 'ofm_row' },
                h(Pill, { strong: true, tone: status.running === true ? 'ok' : 'warn' }, status.running === true ? t('gw.running') : t('gw.stopped')),
                status.blockedByEnv === true ? h(Pill, { tone: 'err' }, t('gw.envBlocked')) : null,
                h(Switch, { checked: status.enabled === true, label: t('gw.switch'), onChange: () => void toggleGateway(status.enabled !== true), disabled: busy })),
              h('div', { className: 'ofm_row' },
                h('span', { className: 'ofm_note' }, t('gw.endpoint')),
                gatewayUrl === '' ? h('span', { className: 'ofm_note' }, '—')
                  : h(Fragment, null, h('code', { className: 'ofm_mono' }, gatewayUrl), h(Button, { kind: 'ghost', onClick: () => copy(gatewayUrl, () => {}) }, t('eac.copy')))),
              h('div', { className: 'ofm_row' },
                h('span', { className: 'ofm_note' }, t('gw.key')),
                apiKeyValue === '' ? h('span', { className: 'ofm_note' }, t('gw.keyNone'))
                  : h(Fragment, null,
                    h('code', { className: 'ofm_mono' }, keyShown ? apiKeyValue : '••••••••••••••••'),
                    h(Button, { kind: 'ghost', onClick: () => setKeyShown(value => !value) }, keyShown ? t('gw.hide') : t('gw.show')),
                    h(Button, { kind: 'ghost', onClick: () => copy(apiKeyValue, () => {}) }, t('eac.copy'))),
                h('span', { className: 'ofm_note' }, apiKeyInfo === null ? t('gw.keyNoneHint') : t('gw.keyNote'))),
              h('div', { className: 'ofm_row' },
                h('span', { className: 'ofm_note' }, `${t('gw.models')} ${models.length}`),
                h('span', { className: 'ofm_note' }, t('gw.portNote'))))),
        h(Section, { title: t('gw.relayTitle'), hint: t('gw.relayHint') },
          relay === undefined ? h('div', { className: 'ofm_skel', style: { minHeight: 96 } })
            : h('div', { className: 'ofm_panel' },
              h('div', { className: 'ofm_row' },
                h(Pill, { strong: true, tone: relay.relay?.running === true ? 'ok' : 'warn' }, relay.relay?.running === true ? t('gw.running') : t('gw.stopped')),
                h(Switch, {
                  checked: relay.relay?.enabled === true, label: t('gw.relaySwitch'), disabled: relayBusy,
                  onChange: () => void applyRelay({ enabled: relay.relay?.enabled !== true }),
                })),
              relay.relay?.error ? h('div', { className: 'ofm_callout ofm_error' }, h('div', null, relay.relay.error)) : null,
              h('div', { className: 'ofm_row' },
                h('div', { className: 'ofm_field' }, h('span', null, t('gw.relayBind')),
                  h('select', {
                    className: 'ofm_input', value: relay.relay?.host ?? '127.0.0.1',
                    onChange: event => void applyRelay({ host: event.target.value }),
                  },
                  h('option', { value: '127.0.0.1' }, t('gw.bindLocal')),
                  h('option', { value: '0.0.0.0' }, t('gw.bindLan')))),
                h('div', { className: 'ofm_field' }, h('span', null, t('gw.relayPort')),
                  h('input', {
                    className: 'ofm_input', type: 'number', min: 0, max: 65535, style: { width: 120 },
                    defaultValue: relay.relay?.port ?? 18326,
                    onBlur: event => { const port = Number(event.target.value); if (Number.isInteger(port) && port >= 0 && port <= 65535 && port !== (relay.relay?.port ?? 0)) void applyRelay({ port }) },
                  }))),
              relay.relay?.running === true ? h('div', { className: 'ofm_row' },
                h('span', { className: 'ofm_note' }, t('gw.relayUrl')),
                h('code', { className: 'ofm_mono' }, `http://${relay.relay.host === '0.0.0.0' || relay.relay.host === '::' ? '<lan-ip>' : relay.relay.host}:${relay.relay.port}/v1`),
                h(Button, { kind: 'ghost', onClick: () => copy(`http://${relay.relay.host}:${relay.relay.port}/v1`, () => {}) }, t('eac.copy'))) : null,
              h('div', { className: 'ofm_row' },
                h('span', { className: 'ofm_note' }, t('gw.relayKey')),
                h('code', { className: 'ofm_mono' }, relayKey === '' ? '••••••••••••••••' : relayKey),
                h(Button, { kind: 'ghost', onClick: () => void showRelayKey() }, t('gw.show')),
                relayKey === '' ? null : h(Button, { kind: 'ghost', onClick: () => copy(relayKey, () => {}) }, t('eac.copy')),
                h(Button, {
                  kind: 'ghost', disabled: relayBusy,
                  onClick: async () => { try { setRelayKey((await post('/chan-gateway/rotate')).key ?? '') } catch (error) { setNotice(String(error?.message ?? error)) } },
                }, t('gw.rotate'))),
              h('p', { className: 'ofm_note' }, t('gw.relayNote')),
              h('p', { className: 'ofm_note' }, t('gw.freeLaneNote')))),
        h(Section, { title: t('gw.clientsTitle'), hint: t('gw.clientsHint') },
          clients.status === 'loading' ? h('div', { className: 'ofm_skel', style: { minHeight: 96 } })
            : clients.status === 'error'
              ? h(PanelError, { t, title: t('gw.clientsTitle'), message: clients.error, onRetry: clients.reload })
              // The recipes are generated from the port that actually bound, so a
              // listener that is off has nothing honest to print: the route answers
              // with a placeholder port and a placeholder key, and a pasted
              // placeholder is a client that silently fails to connect.
              : clients.data?.running !== true
                ? h('div', { className: 'ofm_callout ofm_rise' },
                  h('div', null, h('b', null, t('gw.clientsOff')), h('div', null, t('gw.clientsOffHint'))))
                : h('div', { className: 'ofm_panel ofm_rise' },
                  h('div', { className: 'ofm_row' },
                    h('span', { className: 'ofm_note' }, t('forward.baseUrl')),
                    h('code', { className: 'ofm_mono' }, clients.data.baseUrl),
                    h(CopyButton, { t, text: clients.data.baseUrl }),
                    h('span', { className: 'ofm_note' }, t('gw.clientsModels').replace('{n}', String((clients.data.models ?? []).length)))),
                  clients.data.lanUrl === '' ? null
                    : h('div', { className: 'ofm_row' },
                      h('span', { className: 'ofm_note' }, t('forward.lanUrl')),
                      h('code', { className: 'ofm_mono' }, clients.data.lanUrl),
                      h(CopyButton, { t, text: clients.data.lanUrl })),
                  h('div', { className: 'ofm_duo' }, (clients.data.snippets ?? []).map((snippet, index) => h('div', {
                    key: snippet.id, className: 'ofm_card ofm_rise',
                    style: { animationDelay: `${Math.min(index, 8) * 22}ms` },
                  },
                  h('div', { className: 'ofm_cardhead' },
                    h('span', { className: 'ofm_cardname' }, snippet.name),
                    h('span', { className: 'ofm_tag' }, snippet.language)),
                  h('pre', { className: 'ofm_snippet' }, snippet.body),
                  h('div', { className: 'ofm_row' }, h(CopyButton, { t, text: snippet.body }))))))))
    }

    /** Shared page hero for the three gateway-console pages. The caller
     *  renders the copy: literal t() calls stay visible to the copy lint. */
    function PageHero(props) {
      const { title, sub, children } = props
      return h('header', { className: 'ofm_hero ofm_glass' },
        h('div', { className: 'ofm_pagehead' },
          h('div', { className: 'ofm_pagetitle' },
            h('h2', null, title),
            h('p', { className: 'ofm_pagesub' }, sub)),
          children))
    }

    // ── 聚合渠道 / 省 Token / 路由 ─────────────────────────────────────────────
    /**
     * One panel fetch per page, plus the merge for what a write answers with.
     *
     * `useAsync` above re-reads the whole payload after a write. These three
     * pages must not do that: every control's POST already answers with the state
     * the host stored, and a re-read would either double the round trips or open a
     * window where a switch shows what was *clicked* rather than what was saved.
     * So the payload lives here and the caller merges the POST answer in through
     * `patch`. The shimmer is for the first answer only — a reload after a write
     * keeps the current panel on screen instead of collapsing it back.
     */
    function usePanel(loader, deps) {
      const [state, setState] = useState({ status: 'loading', data: undefined, error: '' })
      const run = useCallback(() => {
        let alive = true
        setState(current => ({ status: current.data === undefined ? 'loading' : 'ready', data: current.data, error: '' }))
        loader()
          .then(data => { if (alive) setState({ status: 'ready', data, error: '' }) })
          .catch(error => {
            if (!alive) return
            setState(current => current.data === undefined
              ? { status: 'error', data: undefined, error: String(error?.message ?? error) }
              : { status: 'ready', data: current.data, error: String(error?.message ?? error) })
          })
        return () => { alive = false }
      }, deps)
      useEffect(() => run(), [run])
      const patch = useCallback(update => setState(current => current.data === undefined
        ? current
        : { ...current, data: typeof update === 'function' ? update(current.data) : { ...current.data, ...update } }), [])
      return { ...state, reload: run, patch }
    }

    /** First-fetch placeholder: three shimmering cards, not one grey line. */
    function PanelSkeleton() {
      return h('div', { className: 'ofm_grid', 'aria-hidden': 'true' },
        h('div', { className: 'ofm_skel' }), h('div', { className: 'ofm_skel' }), h('div', { className: 'ofm_skel' }))
    }

    /**
     * A load failure that names what failed and offers the retry.
     *
     * The older pages render nothing at all when a route refuses, which reads as
     * "this plugin has no such feature". Each of the three new pages passes its
     * own title, because "cannot read the provider registry" and "cannot read the
     * chain settings" are different sentences to act on.
     */
    function PanelError(props) {
      const { t, title, message, onRetry } = props
      return h('div', { className: 'ofm_callout ofm_error ofm_rise' },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('b', null, title),
          h('div', null, message)),
        h(Button, { kind: 'ghost', onClick: onRetry }, t('retry')))
    }

    /** Copy-to-clipboard that answers the click, so a copy is never silent. */
    function CopyButton(props) {
      const { t, text } = props
      const [done, setDone] = useState(false)
      useEffect(() => {
        if (!done) return
        const timer = setTimeout(() => setDone(false), 1400)
        return () => clearTimeout(timer)
      }, [done])
      return h(Button, {
        kind: 'ghost',
        onClick: () => copy(text, ok => { if (ok) setDone(true) }),
      }, done ? t('eac.copied') : t('eac.copy'))
    }

    /** A switch with its one-line explanation underneath. */
    function ToggleRow(props) {
      const { label, hint, checked, disabled, onChange } = props
      return h('div', { className: 'ofm_field' },
        h(Switch, { checked, label, disabled, onChange }),
        hint === undefined ? null : h('span', null, hint))
    }

    // Labels for the ids the host serves. Literal t() calls inside an object
    // literal rather than a key table, because a key the copy lint cannot see is
    // a key it reports as unused (the same shape the pool-reason table uses).
    const AGG_CATEGORY = t => ({
      apikey: t('agg.category.apikey'),
      free: t('agg.category.free'),
      'free-tier': t('agg.category.freeTier'),
      local: t('agg.category.local'),
      oauth: t('agg.category.oauth'),
    })
    const AGG_AUTH = t => ({
      apiKey: t('agg.auth.apiKey'),
      none: t('agg.auth.none'),
      oauth: t('agg.auth.oauth'),
      adc: t('agg.auth.adc'),
    })
    const SAVER_LEVEL = t => ({
      off: t('saver.level.off'),
      lite: t('saver.level.lite'),
      full: t('saver.level.full'),
      ultra: t('saver.level.ultra'),
      'wenyan-lite': t('saver.level.wenyanLite'),
      wenyan: t('saver.level.wenyan'),
      'wenyan-ultra': t('saver.level.wenyanUltra'),
    })
    const LANE_LABEL = t => ({
      free: t('routing.channel.free'),
      eac: t('routing.channel.eac'),
      kilo: t('routing.channel.kilo'),
      aggregate: t('routing.channel.aggregate'),
      combo: t('routing.channel.combo'),
    })

    /**
     * Auth kinds this lane cannot drive.
     *
     * `oauth` needs an interactive login and `adc` a cloud-side credential, so
     * the aggregate lane skips them when it builds the catalog. Offering one in
     * the picker would be offering a provider whose key field can never work, so
     * they are shown and marked instead of hidden — "this exists and this lane
     * will not call it" is the honest sentence.
     */
    const AGG_UNUSABLE = new Set(['oauth', 'adc'])

    /** `a, b` / `a\nb` -> `['a','b']`, the shape POST /providers stores. */
    const parseModelIds = value => String(value ?? '').split(/[\n,]+/).map(part => part.trim()).filter(part => part !== '')

    /** How many catalog rows one provider contributes right now, read from
     *  /summary: "configured" must never imply "in the model picker". */
    const contributedBy = (catalog, providerId) => (catalog ?? [])
      .filter(row => row.channel === 'aggregate' && row.providerId === providerId).length

    const miniBtn = (label, onClick, options = {}) => h('button', {
      type: 'button',
      className: 'ofm_minibtn' + (options.danger === true ? ' danger' : ''),
      disabled: options.disabled === true,
      title: options.title,
      onClick,
    }, label)

    /**
     * The add-provider picker: the whole registry, filtered.
     *
     * Every row carries what the decision needs — category, wire format, auth
     * kind, how many models ship with it, where to get a key and the free-tier
     * note — because "which of these 76 is worth a key" is the actual question.
     * Rows are capped; the counts say how many matched.
     */
    function ProviderPicker(props) {
      const { t, registry, onPick } = props
      const [query, setQuery] = useState('')
      const [category, setCategory] = useState('')
      const [format, setFormat] = useState('')
      const [auth, setAuth] = useState('')
      const categories = AGG_CATEGORY(t)
      const auths = AGG_AUTH(t)
      const needle = query.trim().toLowerCase()
      const matched = registry.filter(row => {
        if (category !== '' && row.category !== category) return false
        if (format !== '' && row.format !== format) return false
        if (auth !== '' && row.authKind !== auth) return false
        if (needle === '') return true
        return `${row.id} ${row.name}`.toLowerCase().includes(needle)
      })
      const shown = matched.slice(0, 48)
      const formats = [...new Set(registry.map(row => row.format))].sort()
      return h('div', { className: 'ofm_panel ofm_rise' },
        h('div', { className: 'ofm_paneltitle' }, t('agg.addTitle'),
          h('span', { className: 'ofm_sec_hint' }, t('agg.showing').replace('{shown}', String(shown.length)).replace('{total}', String(matched.length)))),
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_field', style: { flex: '1 1 180px' } },
            h('span', null, t('agg.search')),
            h('input', { className: 'ofm_input', value: query, placeholder: t('agg.search'), onChange: event => setQuery(event.target.value) })),
          h('div', { className: 'ofm_field' }, h('span', null, t('agg.filterCategory')),
            h('select', { className: 'ofm_input', value: category, onChange: event => setCategory(event.target.value) },
              h('option', { value: '' }, t('agg.filterAll')),
              Object.keys(categories).map(id => h('option', { key: id, value: id }, categories[id])))),
          h('div', { className: 'ofm_field' }, h('span', null, t('agg.filterFormat')),
            h('select', { className: 'ofm_input', value: format, onChange: event => setFormat(event.target.value) },
              h('option', { value: '' }, t('agg.filterAll')),
              formats.map(id => h('option', { key: id, value: id }, id)))),
          h('div', { className: 'ofm_field' }, h('span', null, t('agg.filterAuth')),
            h('select', { className: 'ofm_input', value: auth, onChange: event => setAuth(event.target.value) },
              h('option', { value: '' }, t('agg.filterAll')),
              Object.keys(auths).map(id => h('option', { key: id, value: id }, auths[id]))))),
        h('p', { className: 'ofm_note' }, t('agg.addHint')),
        shown.length === 0
          ? h('p', { className: 'ofm_note' }, t('agg.noMatch'))
          : h('div', { className: 'ofm_picklist' }, shown.map((row, index) => {
            const blocked = AGG_UNUSABLE.has(row.authKind)
            return h('div', {
              key: row.id, className: 'ofm_pickrow ofm_rise',
              style: { animationDelay: `${Math.min(index, 12) * 18}ms` },
            },
            h('span', { className: 'ofm_pickhead' },
              h('b', { title: row.name }, row.name),
              blocked ? h('span', { className: 'ofm_tagpill dead' }, t('agg.notUsable')) : null),
            h('span', { className: 'ofm_pickmeta' },
              h('span', { className: 'ofm_tag' }, categories[row.category] ?? row.category),
              h('span', { className: 'ofm_tag' }, row.format),
              h('span', { className: 'ofm_tag' }, auths[row.authKind] ?? row.authKind),
              h('span', null, t('agg.modelCount').replace('{n}', String(row.modelCount)))),
            blocked
              ? h('span', { className: 'ofm_picknote' }, t('agg.notUsableWhy').replace('{kind}', auths[row.authKind] ?? row.authKind))
              : h('span', { className: 'ofm_row' },
                row.credentialUrl === '' ? null
                  : h('a', { className: 'ofm_starlink', href: row.credentialUrl, target: '_blank', rel: 'noreferrer' }, t('agg.credential')),
                miniBtn(t('agg.select'), () => onPick(row))),
            row.notes === '' ? null : h('span', { className: 'ofm_picknote' }, row.notes))
          })))
    }

    /**
     * One provider's editor, shared by "configure" and "add".
     *
     * The key box starts empty on purpose and an empty box means *keep*: the host
     * distinguishes an absent field from an empty string, and conflating them is
     * what silently kept a key the user believed they had deleted. Deleting one
     * is therefore its own button, and it says what it does.
     */
    function ProviderEditor(props) {
      const { t, provider, state, contributions, onSaved, onRemoved, onChanged, showContributions = true } = props
      const fresh = state === undefined
      const [enabled, setEnabled] = useState(state?.enabled !== false)
      const [baseUrl, setBaseUrl] = useState(state?.baseUrl ?? '')
      const [key, setKey] = useState('')
      const [models, setModels] = useState((state?.models ?? []).join(', '))
      const [verdict, setVerdict] = useState(state?.lastTest ?? null)
      const [found, setFound] = useState(null)
      const [confirm, setConfirm] = useState(false)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')

      const run = async (kind, action) => {
        setBusy(kind)
        setError('')
        try { await action() } catch (failure) { setError(String(failure?.message ?? failure)) } finally { setBusy('') }
      }
      const save = () => run('save', async () => {
        const body = { providerId: provider.id, enabled, baseUrl, models: parseModelIds(models) }
        if (key !== '') body.apiKey = key
        const answer = await post('/providers', body)
        setKey('')
        onSaved(answer.aggregate, provider, fresh)
      })
      const clearKey = () => run('clear', async () => {
        const answer = await post('/providers', { providerId: provider.id, apiKey: '' })
        setKey('')
        onSaved(answer.aggregate, provider, false)
      })
      const test = () => run('test', async () => {
        // A listing probe, not a generation: the host verifies the key by asking
        // for the model list, so this costs no tokens. `status: 0` with ok:false
        // is its own verdict — "cannot be verified without spending a
        // generation" — and reads as a warning, not as a rejected key.
        const answer = await post('/providers/test', { providerId: provider.id }, 60_000)
        setVerdict({ at: Date.now(), ok: answer.ok === true, status: Number(answer.status) || 0, message: String(answer.message ?? '') })
      })
      const discover = () => run('discover', async () => {
        const answer = await post('/providers/discover', { providerId: provider.id }, 60_000)
        setFound(Array.isArray(answer.models) ? answer.models : null)
        // The host persisted the ids and rebuilt the catalog; re-read both views
        // so the contribution counts and the key fingerprint stay true.
        onChanged?.()
      })

      return h('div', { className: 'ofm_rise', style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'ofm_pickmeta' },
          h('span', { className: 'ofm_tag' }, AGG_CATEGORY(t)[provider.category] ?? provider.category),
          h('span', { className: 'ofm_tag' }, provider.format),
          h('span', { className: 'ofm_tag' }, AGG_AUTH(t)[provider.authKind] ?? provider.authKind),
          // The card prints this one line above the editor, so it is suppressed
          // there; the add-provider flow renders the editor alone and keeps it.
          showContributions === false ? null : h('span', null, t('agg.contributes').replace('{n}', String(contributions)))),
        h('div', { className: 'ofm_duo' },
          ToggleRow({
            label: t('agg.enabled'), checked: enabled, disabled: busy !== '',
            onChange: () => { if (busy === '') setEnabled(value => !value) },
          }),
          field(t('agg.key'),
            h('input', {
              className: 'ofm_input', type: 'password', value: key, placeholder: t('agg.keyPlaceholder'),
              autoComplete: 'off', disabled: busy !== '',
              onChange: event => setKey(event.target.value),
            })),
          field(t('agg.baseUrl'),
            h('input', {
              className: 'ofm_input', value: baseUrl, placeholder: provider.baseUrl, disabled: busy !== '',
              onChange: event => setBaseUrl(event.target.value),
            })),
          field(t('agg.models'),
            h('textarea', {
              className: 'ofm_input', rows: 2, value: models, placeholder: t('agg.modelsPlaceholder'),
              disabled: busy !== '',
              onChange: event => setModels(event.target.value),
            }))),
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('agg.keyKeep')),
          state?.hasKey === true ? h('span', { className: 'ofm_note' }, t('agg.hasKey').replace('{hint}', state.keyHint)) : h('span', { className: 'ofm_note' }, t('agg.noKey')),
          state?.hasKey === true ? miniBtn(t('agg.keyClear'), clearKey, { danger: true, disabled: busy !== '', title: t('agg.keyClearWarn') }) : null),
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('agg.baseUrlHint')),
          provider.baseUrl === '' ? null : h('span', { className: 'ofm_note' }, t('agg.baseUrlDefault').replace('{url}', provider.baseUrl)),
          provider.baseUrlOverrideEnv === '' ? null : h('span', { className: 'ofm_note' }, t('agg.baseUrlEnv').replace('{env}', provider.baseUrlOverrideEnv))),
        h('p', { className: 'ofm_note' }, t('agg.modelsHint')),
        h('div', { className: 'ofm_row' },
          h(Button, { kind: 'primary', disabled: busy !== '', onClick: save }, busy === 'save' ? t('agg.saving') : fresh ? t('agg.add') : t('agg.save')),
          miniBtn(t('agg.test'), test, { disabled: busy !== '' }),
          miniBtn(t('agg.discover'), discover, { disabled: busy !== '' }),
          h('span', { className: 'spacer', style: { marginLeft: 'auto' } }),
          fresh ? null : (confirm
            ? h(Fragment, null,
              miniBtn(t('agg.removeConfirm'), () => run('remove', async () => {
                const answer = await post('/providers/remove', { providerId: provider.id })
                onRemoved(answer.aggregate, provider)
              }), { danger: true, disabled: busy !== '' }),
              miniBtn(t('agg.cancel'), () => setConfirm(false), { disabled: busy !== '' }))
            : miniBtn(t('agg.remove'), () => setConfirm(true), { danger: true, disabled: busy !== '' }))),
        confirm ? h('p', { className: 'ofm_note' }, t('agg.removeWarn')) : null,
        h('div', { className: 'ofm_row' },
          verdict === null ? h('span', { className: 'ofm_note' }, t('agg.neverTested'))
            : h(Fragment, null,
              h(Pill, { tone: verdict.ok === true ? 'ok' : verdict.status === 0 ? 'warn' : 'err' },
                verdict.ok === true ? t('agg.testOk') : verdict.status === 0 ? t('agg.testUnverified') : t('agg.testFailed')),
              h('span', { className: 'ofm_note' }, t('agg.testAt').replace('{when}', ago(verdict.at, t.locale)))),
          busy === 'test' ? h('span', { className: 'ofm_note' }, t('agg.testing')) : null,
          busy === 'discover' ? h('span', { className: 'ofm_note' }, t('agg.discovering')) : null),
        verdict !== null && verdict.ok !== true && verdict.status === 0
          ? h('p', { className: 'ofm_note' }, t('agg.testUnverifiedWhy')) : null,
        verdict !== null && verdict.message !== '' ? h('p', { className: 'ofm_note' }, verdict.message) : null,
        found === null
          ? null
          : h('div', { className: 'ofm_row' },
            h('span', { className: 'ofm_note' }, found.length === 0 ? t('agg.discoveredNone') : t('agg.discovered').replace('{n}', String(found.length))),
            found.length === 0 ? null : miniBtn(t('agg.discoveredUse'), () => setModels(found.join(', ')))),
        error === '' ? null : h('div', { className: 'ofm_callout ofm_error' },
          h('div', null, h('b', null, t('agg.failed')), h('div', null, error))))
    }

    /** Registry identity stays visible even after its saved configuration is removed. */
    function ProviderCard(props) {
      const { t, provider, state, contributions, onSaved, onRemoved, onChanged } = props
      const [expanded, setExpanded] = useState(false)
      const fresh = state === undefined
      const blocked = AGG_UNUSABLE.has(provider.authKind)
      return h('article', { className: 'ofm_provider', 'data-provider': provider.id },
        h('div', { className: 'ofm_cardhead' },
          h('span', { className: 'ofm_cardname', title: provider.name }, provider.name),
          h('span', { className: 'ofm_tagpill' },
            fresh ? t('agg.unconfigured') : state.enabled === false ? t('agg.disabled') : t('agg.configured'))),
        h('div', { className: 'ofm_id' }, provider.id),
        h('div', { className: 'ofm_pickmeta' },
          h('span', { className: 'ofm_tag' }, AGG_CATEGORY(t)[provider.category] ?? provider.category),
          h('span', { className: 'ofm_tag' }, provider.format),
          h('span', null, t('agg.modelCount').replace('{n}', String(provider.modelCount)))),
        fresh ? null : h('div', { className: 'ofm_metrics' },
          h('span', null, contributions > 0 ? t('agg.contributes').replace('{n}', String(contributions)) : t('agg.contributesNone')),
          h('span', null, state.hasKey === true ? t('agg.hasKey').replace('{hint}', state.keyHint) : t('agg.noKey'))),
        blocked ? h('p', { className: 'ofm_note' },
          t('agg.notUsableWhy').replace('{kind}', AGG_AUTH(t)[provider.authKind] ?? provider.authKind)) : null,
        h('div', { className: 'ofm_directoryactions' },
          provider.credentialUrl === '' ? h('span') : h('a', {
            className: 'ofm_starlink', href: provider.credentialUrl, target: '_blank', rel: 'noreferrer noopener',
          }, t('agg.credential')),
          h('button', {
            type: 'button', className: `ofm_btn ${fresh && !expanded ? 'primary' : 'ghost'}`,
            disabled: blocked && fresh, 'aria-expanded': expanded, 'aria-controls': `ofm-provider-${provider.id}`,
            onClick: () => setExpanded(value => !value),
          }, expanded ? t('chan.collapse') : fresh ? t('agg.connect') : t('agg.manage'))),
        expanded ? h('div', { className: 'ofm_directorydetail', id: `ofm-provider-${provider.id}` },
          h(ProviderEditor, {
            key: fresh ? 'new' : 'saved', t, provider, state, contributions, onSaved, onChanged,
            onRemoved: (aggregate, removed) => { setExpanded(false); onRemoved(aggregate, removed) },
            showContributions: false,
          })) : null)
    }

    /**
     * 聚合渠道: the registry, the configured providers and their editors.
     *
     * The catalog is read from the summary the shell already holds, so the
     * "contributes N models" line is the picker's own view rather than a second
     * derivation — and every write asks the shell to re-read it, because saving a
     * provider changes what the model picker offers.
     */
    function AggregatePage(props) {
      const { t, summary } = props
      const panel = usePanel(() => api('/providers'), [])
      const [adding, setAdding] = useState(false)
      const [draft, setDraft] = useState(null)
      const [query, setQuery] = useState('')
      const [category, setCategory] = useState('')
      const [filter, setFilter] = useState('')
      const catalog = summary?.data?.catalog ?? []
      const registry = panel.data?.registry ?? []
      const configured = panel.data?.configured?.providers ?? {}
      const categories = AGG_CATEGORY(t)

      const afterWrite = (aggregate, provider, isNew) => {
        if (aggregate !== undefined && aggregate !== null) panel.patch({ configured: aggregate })
        if (isNew) { setAdding(false); setDraft(null) }
        summary?.reload?.()
        showToast({ title: t('agg.saved'), body: t('agg.savedBody').replace('{name}', provider.name), holdMs: 3600 })
      }
      const afterRemove = (aggregate, provider) => {
        if (aggregate !== undefined && aggregate !== null) panel.patch({ configured: aggregate })
        if (draft?.id === provider.id) setDraft(null)
        summary?.reload?.()
        showToast({ title: t('agg.saved'), body: t('agg.removedBody').replace('{name}', provider.name), holdMs: 3600 })
      }
      const afterDiscover = () => { panel.reload(); summary?.reload?.() }

      const needle = query.trim().toLowerCase()
      const configuredCount = registry.filter(provider => configured[provider.id] !== undefined).length
      const rows = registry
        .map(provider => ({ id: provider.id, provider, state: configured[provider.id] }))
        .filter(row => category === '' || row.provider.category === category)
        .filter(row => filter === '' || (filter === 'unconfigured' ? row.state === undefined
          : filter === 'disabled' ? row.state?.enabled === false : row.state !== undefined))
        .filter(row => needle === '' || `${row.id} ${row.provider.name}`.toLowerCase().includes(needle))

      return h('div', { className: 'ofm_page' },
        h('header', { className: 'ofm_directoryhero' },
          h('div', { className: 'ofm_pagehead' },
            h('div', { className: 'ofm_pagetitle' }, h('h2', null, t('agg.title')), h('p', { className: 'ofm_pagesub' }, t('agg.sub'))),
          h('div', { className: 'ofm_pills' },
            h(Pill, null, t('agg.registryCount').replace('{n}', String(registry.length))),
            h(Pill, { strong: true }, t('agg.configuredCount').replace('{n}', String(configuredCount))))),
          h(Button, {
            kind: adding ? 'ghost' : 'primary',
            onClick: () => { setAdding(value => !value); setDraft(null) },
          }, adding ? t('agg.cancel') : t('agg.addProvider'))),
        panel.status === 'loading' ? h(PanelSkeleton) : null,
        panel.status === 'error'
          ? h(PanelError, { t, title: t('agg.loadFailed'), message: panel.error, onRetry: panel.reload })
          : null,
        panel.status === 'ready'
          ? h(Fragment, null,
            draft !== null
              ? h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_paneltitle' }, draft.name, h('span', { className: 'ofm_sec_hint' }, draft.id)),
                h(ProviderEditor, {
                  key: draft.id, t, provider: draft, state: configured[draft.id], contributions: contributedBy(catalog, draft.id),
                  onSaved: afterWrite, onRemoved: afterRemove, onChanged: afterDiscover,
                }))
              : adding
                ? h(ProviderPicker, { t, registry, onPick: setDraft })
                : null,
            h(Section, { title: t('agg.configuredTitle'), hint: t('agg.configuredHint') },
              h('div', { className: 'ofm_directorytools' },
                h('label', null, t('agg.search'),
                  h('input', { className: 'ofm_input', type: 'search', value: query, placeholder: t('agg.search'), onChange: event => setQuery(event.target.value) })),
                h('label', null, t('agg.filterCategory'),
                  h('select', { className: 'ofm_input', 'aria-label': t('agg.filterCategory'), value: category, onChange: event => setCategory(event.target.value) },
                    h('option', { value: '' }, t('agg.filterAll')),
                    Object.keys(categories).map(id => h('option', { key: id, value: id }, categories[id])))),
                h('label', null, t('chan.filterStatus'),
                  h('select', { className: 'ofm_input', 'aria-label': t('chan.filterStatus'), value: filter, onChange: event => setFilter(event.target.value) },
                    h('option', { value: '' }, t('agg.filterAll')),
                    h('option', { value: 'configured' }, t('agg.configured')),
                    h('option', { value: 'unconfigured' }, t('agg.unconfigured')),
                    h('option', { value: 'disabled' }, t('agg.disabled'))))),
              h('div', { className: 'ofm_directorycount', role: 'status' },
                t('agg.showing').replace('{shown}', String(rows.length)).replace('{total}', String(registry.length))),
              registry.length === 0
                ? h('div', { className: 'ofm_panel' },
                  h('div', { className: 'ofm_paneltitle' }, t('agg.empty')),
                  h('p', { className: 'ofm_note' }, t('agg.emptyHint')))
                : rows.length === 0
                  ? h('p', { className: 'ofm_note' }, t('agg.filterEmpty'))
                  : h('div', { className: 'ofm_directory' }, rows.map(row => h(ProviderCard, {
                    key: row.id, t, provider: row.provider, state: row.state,
                    contributions: contributedBy(catalog, row.id),
                    onSaved: afterWrite, onRemoved: afterRemove, onChanged: afterDiscover,
                  })))))
          : null)
    }

    const SUBSCRIPTION_PROVIDERS = {
      codex: 'Codex / ChatGPT', claude: 'Claude', gemini: 'Gemini', api: 'API',
    }

    function SubscriptionImport(props) {
      const { t, localProvider, busy, onImport, onCancel } = props
      const [provider, setProvider] = useState(localProvider ?? 'codex')
      const [label, setLabel] = useState('')
      const [modelText, setModelText] = useState('')
      const [mode, setMode] = useState('paste')
      const [json, setJson] = useState('')
      const [apiKey, setApiKey] = useState('')
      const [baseUrl, setBaseUrl] = useState('')
      const [format, setFormat] = useState('openai-chat')
      const [error, setError] = useState('')
      const [reading, setReading] = useState(false)
      const fileRef = useRef(null)
      const readEpoch = useRef(0)
      useEffect(() => () => { readEpoch.current++ }, [])
      const clearCredentials = () => {
        readEpoch.current++
        setJson(''); setApiKey(''); setError(''); setReading(false)
        if (fileRef.current) fileRef.current.value = ''
      }
      const readFile = async event => {
        const file = event.target.files?.[0]
        const epoch = ++readEpoch.current
        setError(''); setJson(''); setReading(false)
        if (!file) return
        if (file.size > 1024 * 1024) { setError(t('sub.fileTooLarge')); return }
        setReading(true)
        try {
          const contents = await file.text()
          if (epoch === readEpoch.current) setJson(contents)
        } catch {
          if (epoch === readEpoch.current) setError(t('sub.fileFailed'))
        } finally {
          if (epoch === readEpoch.current) setReading(false)
        }
      }
      const submit = async event => {
        event.preventDefault()
        if (busy || reading) return
        setError('')
        const models = [...new Set(parseModelIds(modelText))]
        if (models.length === 0 || models.length > 200 || models.some(id =>
          id.length > 240 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(id) || id.startsWith('subscription:'))) {
          setError(t('sub.invalidModels')); return
        }
        const body = { provider, models, ...(label.trim() ? { label: label.trim() } : {}) }
        if (!localProvider && provider === 'api') {
          if (!apiKey.trim()) { setError(t('sub.keyRequired')); return }
          let endpoint
          try { endpoint = new URL(baseUrl) } catch { setError(t('sub.invalidEndpoint')); return }
          if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
            setError(t('sub.invalidEndpoint')); return
          }
          body.credentials = { apiKey: apiKey.trim() }
          body.baseUrl = endpoint.href.replace(/\/$/, '')
          body.format = format
        } else if (!localProvider) {
          let credentials
          try { credentials = JSON.parse(json.replace(/^\uFEFF/, '')) } catch { setError(t('sub.invalidJson')); return }
          if (credentials === null || typeof credentials !== 'object' || Array.isArray(credentials)) {
            setError(t('sub.invalidJson')); return
          }
          body.credentials = credentials
        }
        if (await onImport(localProvider ? 'import-local' : 'import', body)) {
          clearCredentials()
          onCancel()
        }
      }
      const disabled = busy || reading
      return h('form', { className: 'ofm_subform', onSubmit: submit, 'aria-label': t('sub.add'), 'aria-busy': disabled },
        h('div', { className: 'ofm_duo' },
          h('label', null, t('sub.provider'),
            h('select', {
              className: 'ofm_input', 'aria-label': t('sub.provider'), value: provider, disabled: disabled || !!localProvider,
              onChange: event => { clearCredentials(); setProvider(event.target.value) },
            }, Object.entries(SUBSCRIPTION_PROVIDERS).map(([id, name]) => h('option', { key: id, value: id }, name)))),
          h('label', null, t('sub.label'),
            h('input', { className: 'ofm_input', value: label, maxLength: 120, disabled,
              onChange: event => setLabel(event.target.value), autoComplete: 'off' }))),
        h('label', null, t('sub.models'),
          h('textarea', { className: 'ofm_input', value: modelText, rows: 3, disabled, spellCheck: false,
            onChange: event => setModelText(event.target.value) })),
        localProvider ? null : provider === 'api'
          ? h(Fragment, null,
            h('div', { className: 'ofm_duo' },
              h('label', null, t('sub.baseUrl'),
                h('input', { className: 'ofm_input', value: baseUrl, disabled, inputMode: 'url', autoComplete: 'off',
                  onChange: event => setBaseUrl(event.target.value) })),
              h('label', null, t('sub.format'),
                h('select', { className: 'ofm_input', 'aria-label': t('sub.format'), value: format, disabled, onChange: event => setFormat(event.target.value) },
                  ['openai-chat', 'openai-responses', 'anthropic-messages'].map(id => h('option', { key: id, value: id }, id))))),
            h('label', null, t('sub.key'),
              h('input', { className: 'ofm_input', type: 'password', value: apiKey, disabled, autoComplete: 'new-password',
                spellCheck: false, onChange: event => setApiKey(event.target.value) })))
          : h(Fragment, null,
            h('div', { className: 'ofm_seg', role: 'group', 'aria-label': t('sub.credentials') },
              h('button', { type: 'button', disabled, 'aria-pressed': mode === 'paste',
                onClick: () => { clearCredentials(); setMode('paste') } }, t('sub.paste')),
              h('button', { type: 'button', disabled, 'aria-pressed': mode === 'file',
                onClick: () => { clearCredentials(); setMode('file') } }, t('sub.upload'))),
            mode === 'paste'
              ? h('label', null, t('sub.credentials'),
                h('textarea', { className: 'ofm_input', value: json, rows: 5, disabled, autoComplete: 'off', spellCheck: false,
                  onChange: event => setJson(event.target.value) }))
              : h('label', null, t('sub.file'),
                h('input', { className: 'ofm_input', ref: fileRef, type: 'file', accept: '.json,application/json',
                  disabled: busy, onChange: readFile }))),
        error ? h('div', { className: 'ofm_callout ofm_error', role: 'alert' }, error) : null,
        h('div', { className: 'ofm_row' },
          h('button', { type: 'submit', className: 'ofm_btn primary', disabled }, disabled ? t('sub.working') : t('sub.import')),
          h(Button, { kind: 'ghost', disabled: busy, onClick: () => { clearCredentials(); onCancel() } }, t('sub.cancel'))))
    }

    function SubscriptionWindow({ t, window, fallback }) {
      const numeric = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100
      const used = numeric(window?.usedPercent) ? window.usedPercent : null
      const remaining = numeric(window?.remainingPercent) ? window.remainingPercent : null
      const id = window?.id ?? window?.name ?? ''
      const label = fallback ?? (window?.kind === 'five_hour' || id === 'five_hour' ? t('sub.fiveHour')
        : window?.kind === 'weekly' || id === 'weekly' || id.startsWith('seven_day')
          ? t('sub.weekly') + (id.startsWith('seven_day_') ? ` · ${id.slice(10)}` : '')
          : window?.model ?? window?.name ?? id)
      const reset = typeof window?.resetsAt === 'string' ? Date.parse(window.resetsAt) : NaN
      return h('div', { className: 'ofm_subwindow' },
        h('span', null, label),
        h('strong', null, used !== null ? t('sub.used').replace('{n}', String(Math.round(used * 10) / 10))
          : remaining !== null ? t('sub.remaining').replace('{n}', String(Math.round(remaining * 10) / 10)) : t('sub.unknown')),
        used === null && remaining === null ? null : h('progress', {
          max: 100, value: used ?? 100 - remaining, 'aria-label': label,
        }),
        Number.isFinite(reset) ? h('span', { className: 'ofm_note' }, `${t('sub.resets')} `,
          h('time', { dateTime: window.resetsAt }, new Date(reset).toLocaleString(t.locale === 'zh' ? 'zh-CN' : 'en-US'))) : null)
    }

    function SubscriptionAccount({ t, account, busy, mutate }) {
      const [confirm, setConfirm] = useState(false)
      const quota = account.quota ?? {}
      const windows = Array.isArray(quota.windows) ? quota.windows : []
      const fiveHour = quota.fiveHour ?? windows.find(row => row.kind === 'five_hour' || row.id === 'five_hour' || row.name === 'five_hour')
      const weekly = quota.weekly ?? windows.find(row => row.id === 'seven_day' || row.id === 'weekly'
        || row.name === 'seven_day' || row.name === 'weekly')
      const sameWindow = (row, other) => other && (row === other || (row.id ?? row.name) === (other.id ?? other.name))
      const extra = windows.filter(row => row !== fiveHour && row !== weekly
        && !sameWindow(row, fiveHour) && !sameWindow(row, weekly))
      const checked = typeof quota.checkedAt === 'string' ? Date.parse(quota.checkedAt) : NaN
      const modelIds = (Array.isArray(account.models) ? account.models : []).map(model => typeof model === 'string' ? model : model.id)
      return h('article', { className: 'ofm_subaccount', 'data-subscription': account.id },
        h('div', { className: 'ofm_directoryactions' },
          h('div', null,
            h('h3', null, account.label ?? SUBSCRIPTION_PROVIDERS[account.provider]),
            h('span', { className: 'ofm_note' }, SUBSCRIPTION_PROVIDERS[account.provider] ?? account.provider)),
          h(Switch, { checked: account.enabled !== false, label: t('sub.enabled'), disabled: !!busy,
            onChange: () => mutate('enabled', { id: account.id, enabled: account.enabled === false }) })),
        h('div', { className: 'ofm_submeta' },
          h('span', null, `${t('sub.plan')}: ${quota.plan ?? t('sub.unknown')}`),
          h('span', null, `${t('sub.balance')}: `, quota.balance?.unlimited === true ? t('sub.unlimited')
            : typeof quota.balance?.amount === 'number' && Number.isFinite(quota.balance.amount)
              ? `${quota.balance.amount} ${quota.balance.unit === 'credits' ? t('sub.credits') : quota.balance.unit ?? ''}`
              : t('sub.unknown')),
          Number.isFinite(checked) ? h('span', null, `${t('sub.checked')}: `,
            h('time', { dateTime: quota.checkedAt }, new Date(checked).toLocaleString(t.locale === 'zh' ? 'zh-CN' : 'en-US'))) : null),
        quota.status === 'error' ? h('div', { className: 'ofm_callout ofm_error', role: 'alert' },
          h('b', null, t('sub.quotaFailed')), quota.error?.message ? h('span', null, quota.error.message) : null) : null,
        h('div', { className: 'ofm_subwindows' },
          h(SubscriptionWindow, { t, window: fiveHour, fallback: t('sub.fiveHour') }),
          h(SubscriptionWindow, { t, window: weekly, fallback: t('sub.weekly') }),
          extra.map((window, index) => h(SubscriptionWindow, { key: window.id ?? index, t, window }))),
        modelIds.length ? h('ul', { className: 'ofm_submodels', 'aria-label': t('sub.models') },
          modelIds.map(id => h('li', { key: id }, id))) : h('span', { className: 'ofm_note' }, t('sub.noModels')),
        h('div', { className: 'ofm_row' },
          h(Button, { disabled: !!busy, onClick: () => mutate('quota', { id: account.id }) },
            busy === `quota:${account.id}` ? t('sub.working') : t('sub.refreshQuota')),
          h(Button, { kind: 'ghost', disabled: !!busy, onClick: () => setConfirm(value => !value) }, confirm ? t('sub.cancel') : t('sub.remove'))),
        confirm ? h('div', { className: 'ofm_row' },
          h('span', null, t('sub.removeQuestion')),
          h(Button, { disabled: !!busy, onClick: () => mutate('remove', { id: account.id }) }, t('sub.confirmRemove'))) : null)
    }

    function SubscriptionsPage({ t, summary }) {
      const panel = usePanel(() => api('/subscriptions'), [])
      const [editor, setEditor] = useState(null)
      const [candidates, setCandidates] = useState(null)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const pending = useRef(false)
      const mutate = async (action, body) => {
        if (pending.current) return false
        pending.current = true
        setBusy(`${action}:${body.id ?? ''}`); setError('')
        try {
          const result = await post(`/subscriptions/${action}`, body, action === 'quota' ? 120_000 : 15_000)
          if (!Array.isArray(result.accounts)) throw new Error()
          panel.patch({ accounts: result.accounts })
          if (action !== 'quota') summary?.reload?.()
          return true
        } catch {
          // Never render a parse or transport error that might quote an import.
          setError(t('sub.operationFailed'))
          return false
        } finally { pending.current = false; setBusy('') }
      }
      const discover = async () => {
        if (pending.current) return
        pending.current = true
        setBusy('discover'); setError('')
        try {
          const result = await api('/subscriptions/discover', { timeout: 15_000 })
          const rows = result.accounts ?? result.candidates
          if (!Array.isArray(rows)) throw new Error()
          setCandidates(rows.filter(row => ['codex', 'claude', 'gemini'].includes(row.provider))
            .map(row => ({ id: row.id, provider: row.provider })))
        } catch { setError(t('sub.operationFailed')) }
        finally { pending.current = false; setBusy('') }
      }
      const accounts = panel.data?.accounts ?? []
      return h('div', { className: 'ofm_page ofm_subscriptions' },
        h('header', { className: 'ofm_directoryhero' },
          h('div', { className: 'ofm_pagehead' },
            h('div', { className: 'ofm_pagetitle' }, h('h2', null, t('sub.title'))),
            h(Pill, null, t('sub.accounts').replace('{n}', String(accounts.length)))),
          h('div', { className: 'ofm_row' },
            h(Button, { kind: 'primary', disabled: !!busy || panel.status !== 'ready',
              onClick: () => { setEditor({}); setError('') } }, t('sub.add')),
            h(Button, { disabled: !!busy || panel.status !== 'ready', onClick: discover },
              busy === 'discover' ? t('sub.working') : t('sub.discover')))),
        panel.status === 'loading' ? h(PanelSkeleton) : null,
        panel.error ? h(PanelError, { t, title: t('sub.loadFailed'), message: t('sub.operationFailed'), onRetry: panel.reload }) : null,
        error ? h('div', { className: 'ofm_callout ofm_error', role: 'alert' }, error) : null,
        editor ? h(SubscriptionImport, {
          key: editor.provider ?? 'manual', t, localProvider: editor.provider, busy: !!busy,
          onImport: mutate, onCancel: () => setEditor(null),
        }) : null,
        candidates !== null ? h('section', { className: 'ofm_subcandidates', 'aria-label': t('sub.candidates') },
          h('b', null, t('sub.candidates')),
          candidates.length === 0 ? h('span', { className: 'ofm_note' }, t('sub.noCandidates'))
            : candidates.map(row => h('div', { key: row.id, className: 'ofm_directoryactions' },
              h('span', null, SUBSCRIPTION_PROVIDERS[row.provider]),
              h(Button, { disabled: !!busy, onClick: () => { setEditor({ provider: row.provider }); setError('') } }, t('sub.review'))))) : null,
        panel.status === 'ready' ? accounts.length
          ? accounts.map(account => h(SubscriptionAccount, { key: account.id, t, account, busy, mutate }))
          : h('p', { className: 'ofm_note' }, t('sub.empty')) : null)
    }

    /** The segmented level picker the two prompt savers share. */
    function LevelPicker(props) {
      const { t, levels, value, disabled, onChange } = props
      const labels = SAVER_LEVEL(t)
      return h('div', { className: 'ofm_seg', role: 'group' },
        levels.map(level => h('button', {
          key: level, type: 'button', disabled, 'aria-pressed': level === value ? 'true' : 'false',
          onClick: () => { if (!disabled && level !== value) onChange(level) },
        }, labels[level] ?? level)))
    }

    /** The savings bar: it grows into place once the first measurement lands, so
     *  the number reads as a measurement rather than as decoration. */
    function SavingsMeter(props) {
      const { t, percent } = props
      const [live, setLive] = useState(0)
      useEffect(() => {
        const timer = setTimeout(() => setLive(Math.max(0, Math.min(100, percent))), 60)
        return () => clearTimeout(timer)
      }, [percent])
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('saver.percent')),
          h('b', { className: 'ofm_kpivalue', style: { fontSize: 20 } }, `${percent}%`)),
        h('div', {
          className: 'ofm_meter', role: 'progressbar',
          'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': t('saver.percent'),
        }, h('i', { style: { width: `${live}%` } })))
    }

    /**
     * 省 Token: the three savers and what they have actually saved.
     *
     * Every control posts and then renders the host's own answer; nothing here
     * shows a switch state the settings file does not have. The dashboard reads
     * the measurement the host keeps, and says so explicitly when there is none —
     * an empty meter is not a claim that nothing was saved, it is the absence of a
     * measurement.
     */
    function SaverPage(props) {
      const { t } = props
      const panel = usePanel(() => Promise.all([api('/token-saver'), api('/local-optimize')])
        .then(([saver, local]) => ({ saver, local })), [])
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const saver = panel.data?.saver
      const local = panel.data?.local
      const savings = saver?.savings ?? null

      const write = async (kind, action) => {
        setBusy(kind)
        setError('')
        try { await action() } catch (failure) {
          // The route refuses an unknown level with a 400 and a sentence naming
          // the legal ones; showing it is more useful than swallowing it.
          setError(String(failure?.message ?? failure))
          showToast({ title: t('saver.failed'), body: String(failure?.message ?? failure), tone: 'warn', holdMs: 6000 })
        } finally { setBusy('') }
      }
      const saveSaver = patch => write('saver', async () => {
        const answer = await post('/token-saver', patch)
        // The POST answer carries the stored switches; the measurement is the
        // host's own tally and is only served by the GET, so it is kept as-is.
        panel.patch(current => ({ ...current, saver: { ...answer.tokenSaver, savings: current.saver?.savings } }))
        showToast({ title: t('saver.saved'), body: t('saver.savedBody'), holdMs: 3200 })
      })
      const saveLocal = patch => write('local', async () => {
        const answer = await post('/local-optimize', patch)
        panel.patch(current => ({ ...current, local: answer.localOptimize }))
        showToast({ title: t('saver.saved'), body: t('saver.savedBody'), holdMs: 3200 })
      })

      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('saver.title'), sub: t('saver.sub') },
          h('div', { className: 'ofm_pills' },
            h(Pill, { strong: true, tone: saver?.enabled === false ? 'warn' : 'ok' },
              saver?.enabled === false ? t('agg.disabled') : t('agg.enabled')))),
        panel.status === 'loading' ? h(PanelSkeleton) : null,
        panel.status === 'error'
          ? h(PanelError, { t, title: t('saver.loadFailed'), message: panel.error, onRetry: panel.reload })
          : null,
        error === '' ? null : h('div', { className: 'ofm_callout ofm_error ofm_rise' }, h('div', null, error)),
        panel.status === 'ready'
          ? h(Fragment, null,
            // The master switch governs all three savers, so it stands on its own
            // above them: inside the prompt-shaping section it read as that
            // section's switch, which is the one thing it is not.
            h('div', { className: 'ofm_panel ofm_rise' },
              h('div', { className: 'ofm_row' },
                h(Switch, {
                  checked: saver.enabled !== false, label: t('saver.master'), disabled: busy !== '',
                  onChange: () => { if (busy === '') saveSaver({ enabled: saver.enabled === false }) },
                }),
                h('span', { className: 'ofm_note' }, t('saver.masterHint')))),
            h(Section, { title: t('saver.dashTitle'), hint: t('saver.dashHint') },
              savings === null
                ? h('p', { className: 'ofm_note' }, t('saver.noData'))
                : h('div', { className: 'ofm_panel ofm_rise' },
                  h('div', { className: 'ofm_stats' },
                    stat(`${fmtInt(savings.bytesBefore)} B`, t('saver.bytesBefore')),
                    stat(`${fmtInt(savings.bytesAfter)} B`, t('saver.bytesAfter')),
                    stat(`${fmtInt(savings.saved)} B`, t('saver.bytesSaved')),
                    stat(String(savings.blocks), t('saver.blocks')),
                    stat(String(savings.calls), t('saver.calls')),
                    stat(String(savings.promptCalls), t('saver.promptCalls'))),
                  savings.bytesBefore > 0
                    ? h(SavingsMeter, { t, percent: savings.percent })
                    : h('p', { className: 'ofm_note' }, t('saver.noData')),
                  savings.summary === undefined || savings.summary === ''
                    ? null
                    : h('p', { className: 'ofm_note' }, `${t('saver.report')} · ${savings.summary}`))),
            h(Section, { title: t('saver.promptTitle'), hint: t('saver.promptHint') },
              h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_duo' },
                  h('div', { className: 'ofm_field' },
                    h('span', null, t('saver.caveman')),
                    h(LevelPicker, {
                      t, levels: saver.cavemanLevels ?? [], value: saver.prompts?.caveman, disabled: busy !== '',
                      onChange: level => saveSaver({ prompts: { caveman: level } }),
                    }),
                    h('span', null, t('saver.cavemanWhat'))),
                  h('div', { className: 'ofm_field' },
                    h('span', null, t('saver.ponytail')),
                    h(LevelPicker, {
                      t, levels: saver.ponytailLevels ?? [], value: saver.prompts?.ponytail, disabled: busy !== '',
                      onChange: level => saveSaver({ prompts: { ponytail: level } }),
                    }),
                    h('span', null, t('saver.ponytailWhat')))),
                h('p', { className: 'ofm_note' }, t('saver.voiceWarn')))),
            h(Section, { title: t('saver.rtk'), hint: t('saver.rtkWhat') },
              h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_row' },
                  h(Switch, {
                    checked: saver.rtk === true, label: t('saver.rtk'), disabled: busy !== '',
                    onChange: () => { if (busy === '') saveSaver({ rtk: saver.rtk !== true }) },
                  })),
                h('p', { className: 'ofm_note' }, t('saver.rtkSafety')))),
            h(Section, { title: t('saver.localTitle'), hint: t('saver.localHint') },
              h('div', { className: 'ofm_panel ofm_rise' },
                h('div', { className: 'ofm_row' },
                  h(Switch, {
                    checked: local.enabled !== false, label: t('saver.local.enabled'), disabled: busy !== '',
                    onChange: () => { if (busy === '') saveLocal({ enabled: local.enabled === false }) },
                  })),
                h('div', { className: 'ofm_duo' },
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.quota !== false, label: t('saver.local.quota'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ quota: local.quota === false }) },
                    }),
                    h('span', null, t('saver.local.quotaHint'))),
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.prefix !== false, label: t('saver.local.prefix'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ prefix: local.prefix === false }) },
                    }),
                    h('span', null, t('saver.local.prefixHint'))),
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.title !== false, label: t('saver.local.title'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ title: local.title === false }) },
                    }),
                    h('span', null, t('saver.local.titleHint'))),
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.suggestion !== false, label: t('saver.local.suggestion'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ suggestion: local.suggestion === false }) },
                    }),
                    h('span', null, t('saver.local.suggestionHint'))),
                  h('div', { className: 'ofm_field' },
                    h(Switch, {
                      checked: local.filepath !== false, label: t('saver.local.filepath'), disabled: busy !== '',
                      onChange: () => { if (busy === '') saveLocal({ filepath: local.filepath === false }) },
                    }),
                    h('span', null, t('saver.local.filepathHint')))))))
          : null)
    }

    /** The chain editor's member picker: searchable, and it shows the lane and
     *  the vision flag, because those are what decide a chain's order. */
    function ModelPicker(props) {
      const { t, models, chosen, onPick } = props
      const [query, setQuery] = useState('')
      const lanes = LANE_LABEL(t)
      const needle = query.trim().toLowerCase()
      const rows = models
        .filter(row => needle === '' || `${row.id} ${row.name}`.toLowerCase().includes(needle))
        .slice(0, 60)
      return h('div', { className: 'ofm_panel' },
        h('div', { className: 'ofm_paneltitle' }, t('routing.pickModel')),
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_field', style: { flex: '1 1 200px' } },
            h('span', null, t('routing.pickModel')),
            h('input', { className: 'ofm_input', value: query, placeholder: t('routing.searchModel'), onChange: event => setQuery(event.target.value) }))),
        rows.length === 0
          ? h('p', { className: 'ofm_note' }, t('routing.noModel'))
          : h('div', { className: 'ofm_picklist' }, rows.map(row => h('button', {
            key: row.id, type: 'button', className: 'ofm_pickrow',
            'aria-pressed': chosen.includes(row.id) ? 'true' : 'false',
            onClick: () => onPick(row.id),
          },
          h('span', { className: 'ofm_pickhead' }, h('b', { title: row.name }, row.name ?? row.id)),
          h('span', { className: 'ofm_pickmeta' },
            h('span', { className: 'ofm_id' }, row.id),
            h('span', { className: 'ofm_tag' }, lanes[row.channel] ?? row.channel),
            row.contextWindow > 0 ? h('span', { className: 'ofm_tag' }, `${t('tag.context')} ${kilo(row.contextWindow)}`) : null,
            row.maxOutput > 0 ? h('span', { className: 'ofm_tag' }, `${t('tag.output')} ${kilo(row.maxOutput)}`) : null,
            row.vision === true ? h('span', { className: 'ofm_tag' }, t('tag.vision')) : null)))))
    }

    function ChainCapacity({ capacity, t }) {
      if (!capacity) return null
      return h('div', { className: 'ofm_tags', 'aria-label': t('routing.capacity') },
        h('span', { className: 'ofm_note' }, t('routing.capacity')),
        h('span', { className: 'ofm_tag' }, `${t('tag.context')} ${kilo(capacity.contextWindow)}`),
        h('span', { className: 'ofm_tag' }, `${t('tag.output')} ${kilo(capacity.maxOutput)}`),
        h('span', { className: 'ofm_tag' }, capacity.vision ? t('tag.vision') : t('tag.text')))
    }

    /**
     * The chain editor.
     *
     * The member list is ordered and the order is the chain, so it is edited in
     * place (add / remove / move) rather than through a free-text field: a typo in
     * a text field is a link that silently never resolves, and the host has no way
     * to tell "you meant this model" from "this model is gone".
     */
    const strategyLabels = t => ({
      fallback: t('routing.strategy.fallback'),
      'round-robin': t('routing.strategy.roundRobin'),
      smart: t('routing.strategy.smart'),
      usage: t('routing.strategy.usage'),
      pace: t('routing.strategy.pace'),
    })
    function ChainEditor(props) {
      const { t, chain, models, onSave, onCancel } = props
      const [name, setName] = useState(chain.name ?? '')
      const [strategy, setStrategy] = useState(['fallback', 'round-robin', 'smart', 'usage', 'pace'].includes(chain.strategy) ? chain.strategy : 'fallback')
      const [stickyLimit, setStickyLimit] = useState(String(chain.stickyLimit ?? 1))
      const [enabled, setEnabled] = useState(chain.enabled !== false)
      const [members, setMembers] = useState(Array.isArray(chain.models) ? chain.models : [])
      const [picking, setPicking] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const byId = new Map(models.map(row => [row.id, row]))
      const lanes = LANE_LABEL(t)
      const preview = useAsync(() => members.length
        ? post('/combos/preview', { models: members })
        : Promise.resolve({ capacity: null }), [members, models])

      const move = (index, delta) => setMembers(current => {
        const next = [...current]
        const target = index + delta
        if (target < 0 || target >= next.length) return current
        const [row] = next.splice(index, 1)
        next.splice(target, 0, row)
        return next
      })
      const submit = async () => {
        setBusy(true)
        setError('')
        try {
          const limit = Number(stickyLimit)
          await onSave({
            ...chain.id === undefined ? {} : { id: chain.id },
            name,
            models: members,
            strategy,
            stickyLimit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1,
            enabled,
          })
        } catch (failure) { setError(String(failure?.message ?? failure)) } finally { setBusy(false) }
      }

      return h('div', { className: 'ofm_panel ofm_rise' },
        h('div', { className: 'ofm_row' },
          h('div', { className: 'ofm_field', style: { flex: '1 1 180px' } },
            h('span', null, t('routing.name')),
            h('input', {
              className: 'ofm_input', value: name, placeholder: t('routing.namePlaceholder'), disabled: busy,
              onChange: event => setName(event.target.value),
            })),
          h('div', { className: 'ofm_field' },
            h('span', null, t('routing.strategy')),
            h('select', {
              className: 'ofm_input', value: strategy, disabled: busy,
              onChange: event => { if (!busy) setStrategy(event.target.value) },
            }, Object.entries(strategyLabels(t))
              .map(([value, label]) => h('option', { key: value, value }, label)))),
          strategy === 'round-robin'
            ? h('div', { className: 'ofm_field' },
              h('span', null, t('routing.stickyLimit')),
              h('input', {
                className: 'ofm_input', type: 'number', min: 1, max: 100, style: { width: 96 },
                value: stickyLimit, disabled: busy,
                onChange: event => setStickyLimit(event.target.value),
              }))
            : null,
          h(Switch, {
            checked: enabled, label: t('routing.enabled'), disabled: busy,
            onChange: () => { if (!busy) setEnabled(value => !value) },
          })),
        strategy === 'round-robin' ? h('p', { className: 'ofm_note' }, t('routing.stickyHint')) : null,
        h('div', { className: 'ofm_paneltitle' }, t('routing.members'),
          h('span', { className: 'ofm_sec_hint' }, t('routing.memberCount').replace('{n}', String(members.length)))),
        members.length === 0
          ? h('p', { className: 'ofm_note' }, t('routing.memberEmpty'))
          : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } }, members.map((id, index) => {
            const row = byId.get(id)
            return h('div', { key: `${id}#${index}`, className: 'ofm_member' },
              h('span', { className: 'ofm_id', title: id }, row?.name ?? id),
              h('span', { className: 'ofm_tag' }, lanes[row?.channel] ?? ''),
              row?.contextWindow > 0 ? h('span', { className: 'ofm_tag' }, `${t('tag.context')} ${kilo(row.contextWindow)}`) : null,
              miniBtn('↑', () => move(index, -1), { disabled: busy || index === 0, title: t('routing.moveUp') }),
              miniBtn('↓', () => move(index, 1), { disabled: busy || index === members.length - 1, title: t('routing.moveDown') }),
              miniBtn(t('routing.removeMember'), () => setMembers(current => current.filter((_, at) => at !== index)), { danger: true, disabled: busy }))
          })),
        preview.status === 'error'
          ? h('p', { className: 'ofm_note' }, t('routing.capacityUnavailable'))
          : preview.status === 'loading' && members.length ? h('p', { className: 'ofm_note' }, t('loading'))
            : h(ChainCapacity, { capacity: preview.data?.capacity, t }),
        h('div', { className: 'ofm_row' },
          h(Button, { kind: 'ghost', disabled: busy, onClick: () => setPicking(value => !value) }, picking ? t('routing.cancel') : t('routing.addMember'))),
        picking ? h(ModelPicker, { t, models, chosen: members, onPick: id => setMembers(current => [...current, id]) }) : null,
        h('div', { className: 'ofm_row' },
          h(Button, { kind: 'primary', disabled: busy || name.trim() === '' || members.length === 0, onClick: submit }, t('routing.save')),
          h(Button, { kind: 'ghost', disabled: busy, onClick: onCancel }, t('routing.cancel'))),
        error === '' ? null : h('div', { className: 'ofm_callout ofm_error' },
          h('div', null, h('b', null, t('routing.failed')), h('div', null, error))))
    }

    /**
     * One stored chain.
     *
     * A chain that resolves to nothing right now is *not* an error state: the host
     * keeps such a chain on purpose, because a link that reaches an EAC model is
     * still correct on a day that lane is closed, and rewriting the user's chain
     * for them is worse than showing it as unavailable. So the card names the
     * members that are not in the roster and says the chain is kept as written —
     * which is the difference between "your chain is fine" and "your chain is
     * broken", and the user is the only one who can tell which one it is.
     */
    function ChainCard(props) {
      const { t, chain, resolved, missing, lookup, onEdit, onDelete, confirming, index, capacity } = props
      const lanes = LANE_LABEL(t)
      const usable = chain.enabled !== false && resolved.length > 0
      return h('div', { className: 'ofm_card ofm_rise', style: { animationDelay: `${Math.min(index, 8) * 22}ms` } },
        h('div', { className: 'ofm_cardhead' },
          h('span', { className: 'ofm_cardname', title: chain.name }, chain.name),
          h(Pill, { tone: usable ? 'ok' : 'warn' }, usable ? t('routing.usable') : t('routing.notUsable'))),
        h('div', { className: 'ofm_metrics' },
          h('span', null, chain.id),
          h('span', null, strategyLabels(t)[chain.strategy] ?? strategyLabels(t).fallback),
          h('span', null, t('routing.memberCount').replace('{n}', String((chain.models ?? []).length)))),
        h(ChainCapacity, { capacity, t }),
        h('div', { className: 'ofm_row' },
          h('span', { className: 'ofm_note' }, t('routing.resolved')),
          resolved.length === 0
            ? h('span', { className: 'ofm_note' }, '—')
            : resolved.map(id => h('span', { key: id, className: 'ofm_tag' }, `${lookup.get(id)?.name ?? id} · ${lanes[lookup.get(id)?.channel] ?? ''}`))),
        missing.length === 0
          ? null
          : h(Fragment, null,
            h('p', { className: 'ofm_note' }, t('routing.missing').replace('{ids}', missing.join(', '))),
            h('p', { className: 'ofm_note' }, t('routing.notUsableWhy'))),
        h('div', { className: 'ofm_row' },
          miniBtn(t('routing.edit'), onEdit),
          onDelete === undefined ? null : miniBtn(confirming === true ? t('routing.deleteConfirm') : t('routing.delete'), onDelete, { danger: true })))
    }

    /**
     * 路由: the stored fallback chains and their editor.
     *
     * The resolution shown per chain is derived from the model list this page
     * already holds — the same intersection the host uses to build the virtual
     * catalog row — so it survives a reload, and the `usable` array a save answers
     * with is preferred when it is there.
     */
    function RoutingPage(props) {
      const { t } = props
      const panel = usePanel(() => api('/combos'), [])
      const [editing, setEditing] = useState(null)
      const [confirm, setConfirm] = useState('')
      const chains = panel.data?.combos ?? []
      const models = panel.data?.models ?? []
      const lookup = useMemo(() => new Map(models.map(row => [row.id, row])), [models])

      const resolvedOf = chain => {
        const answered = (panel.data?.usable ?? []).find(row => row.id === chain.id)
        if (answered !== undefined) return answered.models
        return (chain.models ?? []).filter(id => lookup.has(id))
      }
      const missingOf = chain => (chain.models ?? []).filter(id => !lookup.has(id))
      const save = async row => {
        // The whole list is written back, because that is the route's shape: it
        // normalizes and replaces. An edit keeps its id, so a rename never changes
        // the model id a client may already be pinned to.
        const known = chains.some(chain => chain.id === row.id)
        const rows = known ? chains.map(chain => chain.id === row.id ? row : chain) : [...chains, row]
        const answer = await post('/combos', { combos: rows })
        panel.patch({ combos: answer.combos, usable: answer.usable })
        panel.reload()
        setEditing(null)
        showToast({ title: t('routing.saved'), body: t('routing.savedBody'), holdMs: 3200 })
      }
      const remove = async id => {
        const answer = await post('/combos', { combos: chains.filter(chain => chain.id !== id) })
        panel.patch({ combos: answer.combos, usable: answer.usable })
        panel.reload()
        setConfirm('')
        showToast({ title: t('routing.saved'), body: t('routing.savedBody'), holdMs: 3200 })
      }
      // A fresh chain is the same editor with an empty draft: the fields, the
      // member list and the validation are identical, only the id is absent.
      const blank = { name: '', models: [], strategy: 'fallback', stickyLimit: 1, enabled: true }

      return h('div', { className: 'ofm_page' },
        h(PageHero, { title: t('routing.title'), sub: t('routing.sub') },
          h('div', { className: 'ofm_pills' },
            h(Pill, null, t('routing.chains') + ' ' + String(chains.length)))),
        panel.status === 'loading' ? h(PanelSkeleton) : null,
        panel.status === 'error'
          ? h(PanelError, { t, title: t('routing.loadFailed'), message: panel.error, onRetry: panel.reload })
          : null,
        panel.status === 'ready'
          ? h(Section, { title: t('routing.chains'), hint: t('routing.chainsHint') },
            // The editor renders full width above the list rather than inside a
            // grid cell: a chain's member list and its picker need the room, and a
            // form squeezed into a 252 px column is a form nobody can order.
            editing !== null
              ? h(ChainEditor, {
                t, models, chain: editing.chain,
                onSave: save, onCancel: () => setEditing(null),
              })
              : chains.length === 0
                ? h('div', { className: 'ofm_panel' },
                  h('div', { className: 'ofm_paneltitle' }, t('routing.empty')),
                  h('p', { className: 'ofm_note' }, t('routing.emptyHint')),
                  h('div', { className: 'ofm_row' },
                    h(Button, { kind: 'primary', onClick: () => setEditing({ chain: blank }) }, t('routing.newChain'))))
                : h('div', { className: 'ofm_row' },
                  h(Button, { kind: 'primary', onClick: () => setEditing({ chain: blank }) }, t('routing.newChain'))),
            chains.length === 0 ? null : h('div', { className: 'ofm_grid' }, chains.map((chain, index) => h(ChainCard, {
              key: chain.id, t, index, chain, lookup,
              resolved: resolvedOf(chain), missing: missingOf(chain),
              capacity: (panel.data?.usable ?? []).find(row => row.id === chain.id),
              confirming: confirm === chain.id,
              onEdit: () => setEditing({ chain }),
              onDelete: () => { if (confirm === chain.id) void remove(chain.id); else setConfirm(chain.id) },
            }))),
            confirm === '' ? null : h('p', { className: 'ofm_note' }, t('routing.deleteWarn')))
          : null)
    }

    // ── settings page ─────────────────────────────────────────────────────────
    function SettingsPage(props) {
      const tagged = props.locale === undefined ? props.t : Object.assign(x => props.t(x), { locale: props.locale })
      const t = tagged
      const [busy, setBusy] = useState(false)
      const [benches, setBenches] = useState({})
      const summary = useAsync(() => api('/summary'), [])
      const stats = useAsync(() => api('/stats'), [])
      // GitHub 授权状态由这一层持有：模型卡的锁标记与 EAC 面板必须看到同一个
      // 判定，登录 / 退出后两边同时更新；60 秒轮询兜住别处（另一台机器）的变动。
      const [eacAuth, setEacAuth] = useState(undefined)
      useEffect(() => {
        let alive = true
        const load = () => api('/eac/status', { timeout: 20_000 })
          .then(data => { if (alive) setEacAuth(data) })
          .catch(() => { if (alive) setEacAuth({ available: false, authorized: false, login: '' }) })
        load()
        const timer = setInterval(load, 60_000)
        return () => { alive = false; clearInterval(timer) }
      }, [])
      // 登录流只有这一份：EAC 面板、页头的未授权按钮、上锁模型卡的「去授权」
      // 共享同一个进行中的会话（同一轮询、同一条提示），见 useEacLogin。
      const eacLogin = useEacLogin({ t, summary, onAuth: setEacAuth })

      const apply = async patch => {
        setBusy(true)
        try {
          await post('/settings', patch)
          summary.reload(); stats.reload()
        } catch (error) {
          // The route can refuse a patch — a routable forward bind, for one — and a
          // rejection nobody shows is a button that appears to do nothing.
          showToast({ title: t('settings.failed'), body: String(error?.message ?? error), tone: 'warn' })
        } finally { setBusy(false) }
      }
      const bench = async model => {
        setBenches(current => ({ ...current, [model.id]: { running: true } }))
        try {
          // 默认档（balanced）而不是 deep：测速要回答的是“这个模型日常多快”，
          // 默认档就是日常档；deep 每次最多烧 32K 输出 token，且经常把固定
          // bench 会话自己打到 429。
          // The backend owns the 300s total budget; leave 30s for its final response.
          const result = await post('/bench', { model: model.id }, 330_000)
          setBenches(current => ({ ...current, [model.id]: { running: false, result: t('bench.result').replace('{ttft}', result.ttftMs).replace('{tps}', result.tokensPerSecond ?? '—').replace('{reasoning}', result.reasoningTokens ?? '—') + (result.persisted === false ? ' · ' + t('bench.notSaved') : '') } }))
          summary.reload()
        } catch (error) {
          setBenches(current => ({ ...current, [model.id]: { running: false, result: String(error?.message ?? error) } }))
          summary.reload()
        }
      }

      if (summary.status === 'loading' && summary.data === undefined) return h('div', { className: 'ofm_root' }, h('p', { className: 'ofm_note' }, t('loading')))
      if (summary.status === 'error') {
        return h('div', { className: 'ofm_root' },
          h('div', { className: 'ofm_callout ofm_error' }, h('div', null, h('b', null, t('loadFailed')), h('div', null, summary.error))),
          h('div', null, h(Button, { onClick: () => summary.reload() }, t('retry'))))
      }
      const data = summary.data
      // 匿名免费与 Kilo 共用状态统计；清单条目不会被当成实测成功。
      const counts = freePoolView(data).counts
      return h(Shell, {
        t: tagged, data, counts, summary, stats, eacAuth, setEacAuth, eacLogin,
        busy, setBusy, apply, bench, benches, ctx: props.ctx,
      })
    }

    // ── the three-page shell ──────────────────────────────────────────────────
    // The settings section used to be one long scroll. It is now three pages
    // behind one glass navigation bar, because the three lanes answer three
    // different questions and mixing them pushed the model roster — the thing
    // people actually open this page for — below the fold:
    //   免费模型       the no-account lane (this plugin's own gateway),
    //   EAC 模型       the desktop co-paid lane behind GitHub auth,
    //   EAC router     the current enabled account channels and their logins.
    // The active page lives in localStorage so a reload — or the hot reload the
    // upgrader triggers — comes back to the page the user was reading.
    const EFFECTS_KEY = 'ofm.visualEffects'
    const TAB_KEY = 'ofm.tab'
    const TABS = ['free', 'eac', 'channels', 'aggregate', 'workspace', 'saver', 'routing', 'ledger', 'logs', 'gateway', 'upgrade', 'picks']
    const WORKSPACE_CSS = `
      .who{min-width:0}
      .who .name,.nm .n,.lib-path{white-space:normal!important;overflow-wrap:anywhere;overflow:visible!important;text-overflow:clip!important}
      .lib-path{height:auto!important;max-width:100%;text-align:left}
      .sheet .grid{grid-template-columns:repeat(auto-fill,minmax(min(220px,100%),1fr))!important}
      .sheet .tile{height:auto;min-height:34px;padding-top:6px;padding-bottom:6px}
      .sheet .kind,.row-head{flex-wrap:wrap}
      .row-head .label{min-width:0;white-space:normal;overflow-wrap:anywhere}
      input,select,textarea{min-width:0;max-width:100%;box-sizing:border-box}
      @media(max-width:440px){
        .row{flex-wrap:wrap;align-items:flex-start}
        button.text{white-space:normal;overflow-wrap:anywhere;max-width:100%}
        #view-sessions .who{flex:1 1 140px}
      }
    `

    function WorkspaceIcon({ name }) {
      const paths = {
        expand: ['M8 3H5a2 2 0 0 0-2 2v3', 'M16 3h3a2 2 0 0 1 2 2v3', 'M21 16v3a2 2 0 0 1-2 2h-3', 'M8 21H5a2 2 0 0 1-2-2v-3'],
        close: ['M18 6 6 18', 'm6 6 12 12'],
        refresh: ['M3 12a9 9 0 0 1 15.36-6.36L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-15.36 6.36L3 16', 'M8 16H3v5'],
        settings: ['M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z'],
      }
      return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
        (paths[name] ?? []).map((d, i) => h('path', { key: i, d })),
        name === 'settings' ? h('circle', { cx: 12, cy: 12, r: 3 }) : null)
    }

    function ModelWorkspace({ t, summary }) {
      const [state, setState] = useState('starting')
      const [error, setError] = useState('')
      const [generation, setGeneration] = useState(0)
      const frame = useRef(null)
      const anchor = useRef(null)
      const closeButton = useRef(null)
      const [expanded, setExpanded] = useState(false)
      const [portal, setPortal] = useState(null)
      const syncTheme = () => {
        const root = anchor.current?.closest('.ofm_root') ?? document.documentElement
        const style = window.getComputedStyle(root)
        const variables = {}
        for (const token of ['label-primary', 'label-secondary', 'label-tertiary', 'label-on-accent', 'bg-layer-1', 'bg-layer-2',
          'bg-layer-3', 'border-l1', 'border-l2', 'state-business-primary', 'state-success-primary', 'state-error-primary', 'state-warning-primary']) {
          const name = `--dsw-alias-${token}`
          const value = style.getPropertyValue(name).trim()
          if (value) variables[name] = value
        }
        const themed = root.closest('[data-theme]')
          ?? document.querySelector('[data-theme]')
        const colorScheme = themed?.getAttribute('data-theme')
          ?? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        frame.current?.contentWindow?.postMessage({
          type: 'ofm:engine-theme', variables, fontFamily: style.fontFamily,
          colorScheme: colorScheme === 'dark' ? 'dark' : 'light', externalControls: true,
        }, window.location.origin)
      }
      useEffect(() => {
        if (state !== 'ready') return
        const observer = new MutationObserver(syncTheme)
        const root = anchor.current?.closest('.ofm_root') ?? document.documentElement
        for (let node = root; node; node = node.parentElement) {
          observer.observe(node, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
        }
        const media = window.matchMedia?.('(prefers-color-scheme: dark)')
        media?.addEventListener?.('change', syncTheme)
        return () => { observer.disconnect(); media?.removeEventListener?.('change', syncTheme) }
      }, [state, expanded])
      useEffect(() => {
        if (!expanded) { setPortal(null); return }
        const host = document.createElement('div')
        host.setAttribute('data-ofm-workspace-root', 'true')
        document.body.appendChild(host)
        const root = anchor.current?.closest('.ofm_shell')
        const wasInert = root?.inert
        const focused = document.activeElement
        if (root) root.inert = true
        setPortal(host)
        const escape = event => {
          if (event.key === 'Escape') setExpanded(false)
        }
        const focus = event => {
          if (!host.contains(event.target)) closeButton.current?.focus()
        }
        window.addEventListener('keydown', escape)
        document.addEventListener('focusin', focus)
        return () => {
          window.removeEventListener('keydown', escape)
          document.removeEventListener('focusin', focus)
          if (root) root.inert = wasInert
          host.remove()
          if (focused?.isConnected) focused.focus?.()
        }
      }, [expanded])
      useEffect(() => { if (portal) closeButton.current?.focus() }, [portal])
      useEffect(() => {
        const changed = event => {
          if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow
            || event.data?.type !== 'ofm:engine-changed') return
          void post('/engine/refresh', {}, 30_000).then(() => summary?.reload?.()).catch(() => {})
        }
        window.addEventListener('message', changed)
        return () => window.removeEventListener('message', changed)
      }, [summary?.reload])
      useEffect(() => {
        let alive = true
        setState('starting'); setError('')
        post('/engine/start', {}, 120_000).then(() => {
          if (alive) { setState('ready'); summary?.reload?.() }
        }).catch(() => {
          if (alive) { setState('error'); setError(t('engine.failed')) }
        })
        return () => { alive = false }
      }, [generation])
      const refresh = async () => {
        try { await post('/engine/refresh', {}, 30_000); summary?.reload?.() }
        catch { setError(t('engine.failed')) }
      }
      const engineAction = action => frame.current?.contentWindow?.postMessage({
        type: 'ofm:engine-action', action,
      }, window.location.origin)
      const toolbar = h('header', { className: 'ofm_enginebar' },
          h('h2', null, t('engine.title')),
          h('div', { className: 'ofm_enginetools', role: 'group', 'aria-label': t('engine.title') },
            h('button', { ref: closeButton, type: 'button', className: 'ofm_engineicon',
              title: expanded ? t('engine.close') : t('engine.expand'),
              'aria-label': expanded ? t('engine.close') : t('engine.expand'),
              onClick: () => setExpanded(value => !value) }, h(WorkspaceIcon, { name: expanded ? 'close' : 'expand' })),
            state === 'ready' ? h('button', { type: 'button', className: 'ofm_engineicon',
              title: t('engine.refresh'), 'aria-label': t('engine.refresh'),
              onClick: () => { engineAction('refresh'); void refresh() } }, h(WorkspaceIcon, { name: 'refresh' })) : null,
            state === 'ready' ? h('button', { type: 'button', className: 'ofm_engineicon',
              title: t('engine.settings'), 'aria-label': t('engine.settings'),
              onClick: () => engineAction('settings') }, h(WorkspaceIcon, { name: 'settings' })) : null))
      const content = h(Fragment, null,
        toolbar,
        error ? h('div', { className: 'ofm_callout ofm_error', role: 'alert' }, error) : null,
        state === 'ready'
          ? h('iframe', { ref: frame, className: 'ofm_engineframe', src: `${API}/engine/ui/?mode=window&view=providers`, title: t('engine.title'),
            allow: 'clipboard-write', referrerPolicy: 'same-origin', onLoad: event => {
              syncTheme()
              const doc = event.currentTarget.contentDocument
              if (!doc || doc.getElementById('ofm-workspace-layout')) return
              const style = doc.createElement('style')
              style.id = 'ofm-workspace-layout'
              style.textContent = WORKSPACE_CSS
              doc.head.appendChild(style)
            } })
          : h('div', { className: 'ofm_engineempty' },
            h('span', { className: state === 'starting' ? 'ofm_note ofm_enginestarting' : 'ofm_note', role: 'status' },
              state === 'starting' ? t('engine.starting') : t('engine.failed')),
            state === 'error' ? h(Button, { kind: 'primary', onClick: () => setGeneration(value => value + 1) }, t('engine.start')) : null))
      return h('div', { className: 'ofm_page ofm_engineworkspace', ref: anchor },
        expanded ? portal ? ReactDOM.createPortal(
          h('div', { className: 'ofm_root ofm_engineoverlay', role: 'dialog', 'aria-modal': 'true',
            'aria-label': t('engine.title'), 'data-ofm-effects': 'off' }, content), portal) : null : content)
    }

    function WorkspacePage({ t, summary, section, onSelect }) {
      const [visited, setVisited] = useState(() => new Set([section]))
      useEffect(() => {
        try { window.localStorage?.setItem('ofm.workspace.section', section) } catch { /* 当前页面仍可切换 */ }
      }, [section])
      const sections = [['tools', t('engine.tools')], ['accounts', t('sub.title')]]
      const select = next => { onSelect(next); setVisited(previous => new Set([...previous, next])) }
      return h('div', { className: 'ofm_page ofm_modelworkspace' },
        h('div', { className: 'ofm_workspacetabs', role: 'tablist', 'aria-label': t('engine.title'),
          onKeyDown: event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 'tools' : event.key === 'End' ? 'accounts'
              : section === 'tools' ? 'accounts' : 'tools'
            select(next)
            event.currentTarget.querySelector(`#ofm-workspace-tab-${next}`)?.focus()
          } },
          sections.map(([id, label]) => h('button', { key: id, type: 'button',
            className: 'ofm_workspacetab', role: 'tab', id: `ofm-workspace-tab-${id}`,
            'aria-controls': `ofm-workspace-view-${id}`, 'aria-selected': section === id ? 'true' : 'false',
            tabIndex: section === id ? 0 : -1, onClick: () => select(id) }, label))),
        sections.filter(([id]) => visited.has(id)).map(([id]) => h('div', {
          key: id, className: 'ofm_workspaceview', hidden: section !== id, role: 'tabpanel',
          id: `ofm-workspace-view-${id}`, 'aria-labelledby': `ofm-workspace-tab-${id}`,
        }, id === 'tools' ? h(ModelWorkspace, { t, summary }) : h(SubscriptionsPage, { t, summary }))))
    }

    function Shell(props) {
      const { t, data, counts, summary, stats, eacAuth, setEacAuth, eacLogin, busy, setBusy, apply, bench, benches, ctx } = props
      const [tab, setTab] = useState(() => {
        try {
          const saved = window.localStorage?.getItem(TAB_KEY)
          return saved === 'subscriptions' ? 'workspace' : TABS.includes(saved) ? saved : 'free'
        } catch { return 'free' }
      })
      const [workspaceSection, setWorkspaceSection] = useState(() => {
        try { return window.localStorage?.getItem(TAB_KEY) === 'subscriptions' ? 'accounts'
          : window.localStorage?.getItem('ofm.workspace.section') === 'accounts' ? 'accounts' : 'tools' }
        catch { return 'tools' }
      })
      const [effects, setEffects] = useState(() => {
        try { return window.localStorage?.getItem(EFFECTS_KEY) === 'on' } catch { return false }
      })
      const toggleEffects = () => setEffects(current => {
        const next = !current
        try { window.localStorage?.setItem(EFFECTS_KEY, next ? 'on' : 'off') } catch { /* 当前页面仍可切换 */ }
        return next
      })
      /* The disclaimer is not a gate on the lanes: it reads once on the first
         settings visit and is reopenable afterwards. `undefined` means the answer
         has not arrived yet, which is neither "show it" nor "hide it". */
      const [disclaimer, setDisclaimer] = useState(undefined)
      const [disclaimerOpen, setDisclaimerOpen] = useState(false)
      useEffect(() => {
        let alive = true
        api('/disclaimer')
          .then(payload => { if (alive) setDisclaimer(payload) })
          .catch(() => { if (alive) setDisclaimer({ acknowledged: true }) })
        return () => { alive = false }
      }, [])
      useEffect(() => {
        if (disclaimer === undefined) return
        if (disclaimer.acknowledged !== true) setDisclaimerOpen(true)
      }, [disclaimer])
      const shellRef = useRef(null)
      const [active, setActive] = useState(true)
      useEffect(() => {
        let inViewport = true
        const update = () => setActive(inViewport && document.hidden !== true)
        update()
        document.addEventListener?.('visibilitychange', update)
        const observer = typeof IntersectionObserver === 'function' && shellRef.current
          ? new IntersectionObserver(entries => { inViewport = entries.some(entry => entry.isIntersecting); update() }) : null
        if (observer) observer.observe(shellRef.current)
        return () => { document.removeEventListener?.('visibilitychange', update); observer?.disconnect() }
      }, [])
      const tabRefs = useRef({})
      const [glider, setGlider] = useState({ left: 0, top: 0, width: 0, height: 0 })
      const [catalogBusy, setCatalogBusy] = useState(false)
      const catalogPending = useRef(false)
      useEffect(() => {
        try { window.localStorage?.setItem(TAB_KEY, tab) } catch { /* storage unavailable */ }
        const measure = () => {
          const node = tabRefs.current[tab]
          if (node) setGlider({ left: node.offsetLeft, top: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight })
        }
        measure()
        const node = tabRefs.current[tab]
        const observer = typeof ResizeObserver === 'function' && node?.parentElement ? new ResizeObserver(measure) : null
        if (observer) observer.observe(node.parentElement)
        window.addEventListener('resize', measure)
        return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
      }, [tab, t.locale])

      const runCatalog = async path => {
        if (catalogPending.current) return
        catalogPending.current = true
        setCatalogBusy(true)
        try {
          await post(path, undefined, 600_000)
          summary.reload(); stats.reload()
        } catch (error) {
          showToast({ title: t('settings.failed'), body: String(error?.message ?? error), tone: 'warn' })
        } finally {
          catalogPending.current = false
          setCatalogBusy(false)
        }
      }
      const refresh = () => runCatalog('/refresh')
      const reprobe = () => runCatalog('/reprobe')

      const tabs = [
        ['free', t('nav.tab.free'), freePoolView(data).total],
        ['eac', t('nav.tab.eac'), data.catalog.filter(m => m.channel === 'eac').length],
        ['channels', t('nav.tab.channels'), CHANNEL_PROVIDERS.length],
        ['aggregate', t('nav.tab.aggregate'), data.catalog.filter(m => m.channel === 'aggregate').length],
        ['workspace', t('nav.tab.workspace'), data.catalog.filter(m => m.channel === 'subscription').length],
        ['saver', t('nav.tab.saver'), null],
        ['routing', t('nav.tab.routing'), data.catalog.filter(m => m.channel === 'combo').length],
        ['ledger', t('nav.tab.ledger'), null],
        ['logs', t('nav.tab.logs'), null],
        ['gateway', t('nav.tab.gateway'), null],
        ['upgrade', t('nav.tab.upgrade'), null],
        ['picks', t('nav.tab.picks'), null],
      ]
      const nav = h('nav', { className: 'ofm_nav' },
        h('span', { className: 'ofm_navbrand' },
          h('span', { className: 'ofm_navmark', 'aria-hidden': 'true' },
            h('img', { src: BRAND_ICON, alt: '' })),
          t('title')),
        h('div', { className: 'ofm_tabs', role: 'tablist', 'aria-label': t('title'), onKeyDown: event => {
          const steps = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }
          if (!Object.hasOwn(steps, event.key) && event.key !== 'Home' && event.key !== 'End') return
          event.preventDefault()
          const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
            : (tabs.findIndex(([id]) => id === tab) + steps[event.key] + tabs.length) % tabs.length
          setTab(tabs[index][0])
          event.currentTarget.querySelectorAll('[role="tab"]')[index]?.focus()
        } },
          h('span', { className: 'ofm_tabglider', 'aria-hidden': 'true',
            style: { transform: `translate(${glider.left}px, ${glider.top}px)`, width: `${glider.width}px`, height: `${glider.height}px` } }),
          tabs.map(([id, label, num]) => h('button', {
            key: id, type: 'button', role: 'tab', 'aria-selected': tab === id ? 'true' : 'false', className: 'ofm_tab', 'data-on': tab === id ? 'true' : 'false',
            tabIndex: tab === id ? 0 : -1,
            ref: node => { tabRefs.current[id] = node },
            id: `ofm-tab-${id}`, 'aria-controls': 'ofm-workspace',
            onClick: () => setTab(id),
          }, label, num === null ? null : h('span', { className: 'ofm_tabnum' }, String(num))))),
        h('div', { className: 'ofm_navtools', title: t('effects.hint') },
          h(Switch, { checked: effects, label: t('effects.enabled'), onChange: toggleEffects }),
          h(StarButton, { t })))

      const page = tab === 'workspace'
        ? h(WorkspacePage, { t, summary, section: workspaceSection, onSelect: setWorkspaceSection })        : tab === 'channels'
        ? h(ChannelsPage, { t, ctx, summary })
        : tab === 'aggregate'
          ? h(AggregatePage, { t, summary })
          : tab === 'saver'
            ? h(SaverPage, { t })
            : tab === 'routing'
              ? h(RoutingPage, { t })
              : tab === 'ledger'
                ? h(LedgerPage, { t, ctx })
                : tab === 'logs'
                  ? h(LogsPage, { t, ctx })
                  : tab === 'gateway'
                    ? h(GatewayPage, { t, ctx })
                    : tab === 'upgrade'
                      ? h(UpgradePage, { t, settings: data.settings, onApply: apply, busy })
                    : tab === 'picks'
                      ? h(PicksPage, { t, effects })
                    : tab === 'eac'
                      ? h(EacPage, { t, data, counts, summary, stats, eacAuth, setEacAuth, eacLogin, busy, catalogBusy, apply, bench, benches, refresh, reprobe })
                      : h(FreePage, { t, data, counts, summary, stats, eacAuth, eacLogin, busy, catalogBusy, apply, bench, benches, refresh, reprobe })

      return h('div', { className: 'ofm_root ofm_shell', ref: shellRef, 'data-ofm-effects': effects ? 'on' : 'off', 'data-ofm-active': active ? 'true' : 'false' },
        nav,
        h('div', { className: 'ofm_workspace', id: 'ofm-workspace', role: 'tabpanel', 'aria-labelledby': `ofm-tab-${tab}` }, page),
        h('footer', { className: 'ofm_shellfoot' },
          h('button', {
            type: 'button', className: 'ofm_linkbtn',
            onClick: () => setDisclaimerOpen(true),
          }, t('disclaimer.reopen'))),
        disclaimerOpen && disclaimer !== undefined
          ? h(Disclaimer, { t, copy: disclaimer, onClose: () => setDisclaimerOpen(false) })
          : null)
    }

    function SponsorBanner({ t }) {
      return h('aside', { className: 'ofm_sponsor_banner', 'aria-label': t('sponsor.bannerTitle') },
        h('div', { className: 'ofm_sponsor_logo', 'aria-hidden': 'true' },
          h('img', { src: SPONSOR_LOGO, alt: '', width: 56, height: 56, style: { display: 'block', objectFit: 'contain', borderRadius: 'inherit' } })),
        h('div', { className: 'ofm_sponsor_bannerbody' },
          h('span', { className: 'ofm_sponsor_kicker' }, t('sponsor.bannerTag')),
          h('h3', null, t('sponsor.bannerTitle')),
          h('p', null, t('sponsor.bannerDescription'))),
        h('a', { className: 'ofm_sponsor_cta', href: SPONSOR_CARD_URL, target: '_blank', rel: 'noopener noreferrer' },
          h('span', null, t('sponsor.bannerCta')), h('span', { 'aria-hidden': 'true' }, '↗')))
    }

    function FreePage(props) {
      const { t, data, counts, summary, stats, eacAuth, eacLogin, busy, catalogBusy, apply, bench, benches, refresh, reprobe } = props
      const { total, selectable, anonymous, kilo: kiloCount } = freePoolView(data)
      const ok = counts.available ?? 0
      const pct = total > 0 ? Math.max(0, Math.min(100, Math.round(100 * selectable / total))) : null
      const ratio = total > 0 ? selectable / total : 0
      // 颜色跟随可选比例；实际探测结果仍由下方五格状态独立显示。
      const level = ratio >= 0.6 ? 'ok' : ratio >= 0.3 ? 'busy' : 'over'
      return h('div', { className: 'ofm_page' },
        h(SponsorBanner, { t }),
        h('header', { className: 'ofm_hero ofm_glass' },
          h('div', { className: 'ofm_pagehead' },
            h('div', { className: 'ofm_pagetitle' },
              h('h2', null, t('free.title')),
              h('p', { className: 'ofm_pagesub' }, t('free.sub'))),
            h('div', { className: 'ofm_pills' },
              h(Pill, { strong: true, tone: data.settings.enabled !== false ? 'ok' : 'err' }, data.settings.enabled !== false ? t('pref.enabled') : 'off'),
              h(Pill, null, `${t('pref.egress')} ${data.egress?.country ?? data.egress?.ip ?? '—'}`),
              h(Pill, null, `${t('pref.probedAt')} ${ago(data.probedAt, t.locale)}`))),
          h('div', { className: 'ofm_tankrow' },
            h(Tank, { pct, level, size: 'xl', label: `${t('free.tankLabel')} ${pct ?? '—'}%` }),
            h('div', { className: 'ofm_tankside' },
              h('div', { className: 'ofm_pooltop' },
                h('span', { className: `ofm_poolbadge ${level}` },
                  h('span', { className: 'ofm_pooldot' }),
                  `${t('free.tankLabel')} ${pct ?? '—'}%`),
                h(StarButton, { t })),
              h('div', { className: 'ofm_poolstats', title: t('free.statHint').replace('{total}', String(total)) },
                h('div', { className: 'ofm_stat' }, h('b', null, String(ok)), h('span', null, t('state.available'))),
                h('div', { className: `ofm_stat${(counts['region-blocked'] ?? 0) > 0 ? ' hot' : ''}` },
                  h('b', null, String(counts['region-blocked'] ?? 0)), h('span', null, t('state.region-blocked'))),
                h('div', { className: 'ofm_stat' }, h('b', null, String(counts.unavailable ?? 0)), h('span', null, t('state.unavailable'))),
                h('div', { className: `ofm_stat${(counts.throttled ?? 0) > 0 ? ' hot' : ''}` },
                  h('b', null, String(counts.throttled ?? 0)), h('span', null, t('state.throttled'))),
                h('div', { className: 'ofm_stat' }, h('b', null, String(counts.unknown ?? 0)), h('span', null, t('state.unknown')))),
              h('div', { className: 'ofm_poolmeta' },
                h('span', { className: 'ofm_note' }, total > 0
                  ? t('free.tankNote').replace('{selectable}', String(selectable)).replace('{total}', String(total))
                  : t('free.tankEmpty')),
                h('span', { className: 'ofm_note' }, t('free.sources').replace('{anonymous}', String(anonymous)).replace('{kilo}', String(kiloCount))),
                h('span', { className: 'ofm_note' }, t('meta.description'))),
              h('div', { className: 'ofm_row' },
                h(Button, { disabled: busy || catalogBusy, onClick: refresh }, catalogBusy || summary.status === 'loading' ? t('probing') : t('refresh')),
                h(Button, { disabled: busy || catalogBusy, onClick: reprobe }, t('reprobe')))))),
        h(Section, { title: t('section.models'), hint: t('section.modelsHint') }, h(Roster, { summary: data, t, onBench: bench, benches, auth: eacAuth, eacLogin, only: 'free', onApply: apply, busy })),
        h(Section, { title: t('section.dash'), hint: t('section.dashHint') },
          stats.status === 'ready' && stats.data !== undefined ? h(Dashboard, { stats: stats.data, summary: data, t })
            : h('p', { className: 'ofm_note' }, t('loading'))),
        h(Section, { title: t('section.forward'), hint: t('section.forwardHint') }, h(Forward, { settings: data.settings, t, onApply: apply, busy })),
        h(Section, { title: t('section.egress'), hint: t('section.egressHint') }, h(Egress, { settings: data.settings, t, onApply: apply, busy })),
        h(Section, { title: t('section.prefs'), hint: t('section.prefsHint') }, h(Preferences, { summary: data, t, onApply: apply, busy })),
        h(Section, { title: t('section.news'), hint: t('section.newsHint') }, h(NewsPanel, { t })))
    }

    function EacPage(props) {
      const { t, data, summary, eacAuth, setEacAuth, eacLogin, busy, catalogBusy, apply, bench, benches, refresh, reprobe } = props
      const { pool, poolError } = usePool()
      const reading = pool === undefined || pool === null ? null : poolReading(pool)
      const levelText = reading === null ? '' : reading.level === 'over' ? t('pool.levelOver') : reading.level === 'busy' ? t('pool.levelBusy') : t('pool.levelOk')
      const eacCount = data.catalog.filter(m => m.channel === 'eac').length
      const reasonText = pool === null
        ? (({ 'no-lane': t('pool.reasonNoLane'), 'gateway-status': t('pool.reasonGateway'), malformed: t('pool.reasonMalformed'), unreachable: t('pool.reasonUnreachable') })[poolError]
          ?? (poolError !== '' ? poolError : t('pool.reasonUnknown')))
        : ''
      return h('div', { className: 'ofm_page' },
        h(SponsorBanner, { t }),
        h('header', { className: 'ofm_hero ofm_glass' },
          h('div', { className: 'ofm_pagehead' },
            h('div', { className: 'ofm_pagetitle' },
              h('h2', null, t('eac.title')),
              h('p', { className: 'ofm_pagesub' }, t('eac.sub'))),
            h('div', { className: 'ofm_pills' },
              h(Pill, { strong: true, tone: eacAuth?.authorized === true ? 'ok' : 'warn' },
                eacAuth?.authorized === true ? t('eac.pillOk') : t('eac.pillLocked')),
              h(Pill, null, `${t('section.models')} ${eacCount}`),
              h(Pill, null, `${t('pref.egress')} ${data.egress?.country ?? data.egress?.ip ?? '—'}`))),
          h('div', { className: 'ofm_tankrow' },
            h(Tank, { pct: reading?.pct ?? null, level: reading?.level ?? 'ok', size: 'xl', label: `${t('eac.tankLabel')} ${reading?.rawPct ?? '—'}%` }),
            h('div', { className: 'ofm_tankside' },
              h('div', { className: 'ofm_pooltop' },
                reading === null
                  ? h('span', { className: 'ofm_poolbadge' }, h('span', { className: 'ofm_pooldot' }),
                    pool === undefined ? t('loading') : t('pool.unavailable').replace('{reason}', reasonText))
                  : h('span', { className: `ofm_poolbadge ${reading.level}` },
                    h('span', { className: 'ofm_pooldot' }),
                    `${levelText} · ${t('pool.live')} ${pool.inflight}`),
                // 未授权时把登录入口放到页头：撞到「没授权」的用户第一眼看到的
                // 位置就该有钥匙，而不是要先找到下方的授权区。
                eacAuth?.available === true && eacAuth?.authorized !== true
                  ? h(Button, { kind: 'primary', disabled: eacLogin.busy || eacLogin.pending !== null, onClick: eacLogin.login },
                    eacLogin.busy ? t('eac.starting') : t('eac.login'))
                  : null,
                h(StarButton, { t })),
              reading === null ? null : h(Fragment, null,
                h('div', { className: 'ofm_poolstats' },
                  h('div', { className: `ofm_stat${reading.level === 'over' ? ' hot' : ''}` },
                    h('b', null, String(pool.inflight)), h('span', null, t('pool.live'))),
                  h('div', { className: 'ofm_stat' },
                    h('b', null, reading.active === null ? '—' : String(reading.active)), h('span', null, t('pool.active'))),
                  h('div', { className: 'ofm_stat' },
                    h('b', null, reading.capacityKnown ? String(pool.pool) : '—'), h('span', null, t('pool.capacity')))),
                h('div', { className: 'ofm_poolmeta' },
                  h('span', { className: 'ofm_note' }, `${t('pool.reach')} ${reading.rawPct ?? '—'}%`),
                  h('span', { className: 'ofm_note' }, capacityText(pool, t)))),
              h('div', { className: 'ofm_row' },
                h(Button, { disabled: busy || catalogBusy, onClick: refresh }, catalogBusy || summary.status === 'loading' ? t('probing') : t('refresh')),
                h(Button, { disabled: busy || catalogBusy, onClick: reprobe }, t('reprobe')))))),
        h(Section, { title: t('section.eac'), hint: t('section.eacHint') }, h(EacAuth, { t, auth: eacAuth, eacLogin })),
        h(Section, { title: t('section.models'), hint: t('section.modelsHint') }, h(Roster, { summary: data, t, onBench: bench, benches, auth: eacAuth, eacLogin, only: 'eac', onApply: apply, busy })),
        h(Section, { title: t('section.news'), hint: t('section.newsHint') }, h(NewsPanel, { t })))
    }

    // ── announcement ──────────────────────────────────────────────────────────
    const PAGES = ['ann.preamble', 'ann.newlane', 'ann.models', 'ann.steps', 'ann.features', 'ann.updates']

    function announcementPortalHost() {
      let host = document.querySelector('[data-ofm-announcement-root]')
      if (host === null) {
        host = document.createElement('div')
        host.setAttribute('data-ofm-announcement-root', 'true')
        document.body.appendChild(host)
      }
      return host
    }

    /**
     * The disclaimer: what this build does not offer, and whose responsibility
     * a third-party channel is.
     *
     * Shown once on the first settings visit (and whenever the copy version
     * moves), then reopenable from the footer link so a user who dismissed it
     * can read it again. It never blocks the model lanes — acknowledging is a
     * settings write, not a gate on inference.
     */
    function Disclaimer(props) {
      const { t, onClose } = props
      const [busy, setBusy] = useState(false)
      const copy = props.copy
      const dismiss = async () => {
        if (busy) return
        setBusy(true)
        try { await post('/disclaimer/ack') } catch { /* ack is best effort */ }
        onClose()
      }
      const host = announcementPortalHost()
      useEffect(() => () => {
        if (host.parentNode !== null) host.parentNode.removeChild(host)
      }, [host])
      return ReactDOM.createPortal(h('div', { className: 'ofm_scrim' },
        h('div', { className: 'ofm_ann ofm_disclaimer', role: 'dialog', 'aria-modal': 'true', 'aria-label': copy.title },
          h('div', { className: 'ofm_annhead' },
            h('h2', { className: 'ofm_anntitle' }, copy.title),
            h('p', { className: 'ofm_annsub' }, copy.subtitle)),
          h('div', { className: 'ofm_annbody' },
            h('p', null, copy.intro),
            copy.sections.map(section => h('section', { key: section.id, className: 'ofm_disclaimersec' },
              h('h3', null, section.heading),
              h('p', null, section.body)))),
          h('div', { className: 'ofm_annfoot' },
            h('span', { className: 'ofm_note' }, t('disclaimer.version').replace('{n}', copy.version)),
            h('span', { className: 'spacer' }),
            h(Button, { kind: 'primary', disabled: busy, onClick: dismiss }, busy ? t('disclaimer.saving') : copy.accept)))), host)
    }

    function Announcement(props) {
      const { t, complete, openSection, page, setPage, summary, acknowledged } = props
      useEffect(() => { if (acknowledged) complete() }, [acknowledged, complete])
      /* Not `#root.inert`, even though the shell does that for its own onboarding
         modals: those portal out of `#root`, while a slot-mounted step stays
         inside it, and inert has no opt-out for descendants. Measured with it on,
         `document.elementFromPoint` over the next-page button returned BODY — the
         dialog could not be clicked at all. The full-viewport scrim already
         swallows every pointer event aimed at the app behind it. */
      if (acknowledged) return null
      const last = page === PAGES.length - 1
      const finish = async () => {
        try { await post(`/announcement/ack?version=${encodeURIComponent(summary?.announcementVersion ?? '')}`) } catch { /* ack is best effort */ }
        complete()
      }
      const host = announcementPortalHost()
      useEffect(() => () => {
        if (host.parentNode !== null) host.parentNode.removeChild(host)
      }, [host])
      return ReactDOM.createPortal(h('div', { className: 'ofm_scrim' },
        h('div', { className: 'ofm_ann', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('title') },
          h('div', { className: 'ofm_annhead' },
            h('h2', { className: 'ofm_anntitle' }, t('title')),
            h('p', { className: 'ofm_annsub' }, t(PAGES[page]))),
          h('div', { className: 'ofm_steps', 'aria-hidden': 'true' },
            PAGES.map((key, index) => h('span', { key, className: 'ofm_step', 'data-on': index <= page ? 'true' : 'false' }))),
          h('div', { className: 'ofm_annbody' }, h(PageBody, { page, t, summary })),
          h('div', { className: 'ofm_annfoot' },
            h('span', { className: 'ofm_note' }, t('ann.page').replace('{n}', page + 1).replace('{total}', PAGES.length)),
            h('span', { className: 'spacer' }),
            page === 0 ? h(Button, { kind: 'ghost', onClick: finish }, t('ann.later')) : h(Button, { kind: 'ghost', onClick: () => setPage(p => Math.max(0, p - 1)) }, '‹'),
            last
              ? h(Button, { kind: 'primary', onClick: async () => { await finish(); openSection?.('our-free-model') } }, t('ann.openSettings'))
              : h(Button, { kind: 'primary', onClick: () => setPage(p => Math.min(PAGES.length - 1, p + 1)) }, '›')))), host)
    }

    const list = (t, keys) => keys.map(key => h('li', { key }, t(key)))

    function PageBody(props) {
      const { page, t, summary } = props
      if (page === 0) return h(Fragment, null,
        h('h3', null, t('ann.preamble')),
        h('p', null, t('ann.pitch')),
        h('ul', null, list(t, ['ann.p1', 'ann.p2', 'ann.p3'])))
      if (page === 1) return h(Fragment, null,
        h('h3', null, t('ann.newlane')),
        h('ul', null, list(t, ['ann.n1', 'ann.n2', 'ann.n3'])))
      if (page === 2) {
        // Advertised models first: this page is the tour a new user reads before
        // they pick anything, and a refused id at the top of it is a bad first
        // impression of a lane that is actually working.
        const rows = (summary?.catalog ?? []).slice().sort((a, b) => (a.route === null ? 1 : 0) - (b.route === null ? 1 : 0))
        if (rows.length === 0) return h('p', null, t('loading'))
        return h(Fragment, null,
          h('h3', null, t('ann.models')),
          h('div', { className: 'ofm_kv' }, rows.slice(0, 8).map(m => h('div', { key: m.id, className: 'ofm_kvc' },
            h('b', null, m.name),
            h('span', null, `${t(`state.${m.availability}`)} · ${m.vision ? t('tag.vision') : t('tag.text')} · ${kilo(m.contextWindow)}`)))),
          rows.some(m => m.availability === 'region-blocked') ? h('p', { className: 'ofm_note' }, t('hint.region')) : null)
      }
      if (page === 3) return h(Fragment, null,
        h('h3', null, t('ann.steps')),
        h('ul', null, list(t, ['ann.s1', 'ann.s2', 'ann.s3', 'ann.s4'])))
      if (page === 4) return h(Fragment, null,
        h('h3', null, t('ann.features')),
        h('ul', null, list(t, ['ann.f1', 'ann.f2', 'ann.f3', 'ann.f4', 'ann.f5'])))
      return h(Fragment, null,
        h('h3', null, t('ann.updates')),
        h('ul', null, list(t, ['ann.u1', 'ann.u2', 'ann.u3', 'ann.u4'])))
    }

    // ── registration ──────────────────────────────────────────────────────────
    // The shell mirrors the active language onto <html lang>, so a render-time
    // read survives a language switch without owning a subscription.
    function localeTag(ctx) {
      try {
        const snapshot = typeof ctx.locale?.getLocale === 'function' ? ctx.locale.getLocale() : ctx.locale?.getSnapshot?.()
        const value = snapshot?.active ?? ctx.locale?.locale
        return typeof value === 'string' ? value : document.documentElement.lang || 'en'
      } catch { return 'en' }
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'our-free-model: dictionaries')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-our-free-model')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'our-free-model: styles')

      // ── push subscription ───────────────────────────────────────────────────
      // One EventSource for the whole app surface: new announcements become
      // toasts (and OS notifications when opted in), urgent ones open a modal,
      // update availability and completed upgrades broadcast onto window so
      // whichever panel is mounted can refresh itself. EventSource reconnects
      // by itself; the hot reload closes every stream server-side, so a swap
      // simply shows up as a fresh `hello` a second later.
      ctx.effect(() => {
        if (typeof EventSource !== 'function') return
        let osEnabled = false
        let disposed = false
        let source
        let retryTimer
        // 重连轮次必须活在 open() 之外：open() 每次重连都会重入，计数器若在里面
        // 会被清零，退避就永远是第一档而不是 30s 翻倍到 5 分钟。
        let retries = 0
        api('/announcements').then(payload => { osEnabled = payload?.notifyOs === true }).catch(() => {})
        const open = () => {
          if (disposed) return
          source = new EventSource(`${API}/events`)
          // 断连保护：服务端不可达时 EventSource 默认无限自动重连（持续占连接池）。
          // 连续失败达到上限先关闭让出连接，但按退避（30s 翻倍、封顶 5 分钟）定时
          // 重新打开——永久关闭让公告/更新/升级推送在宿主重启或休眠后整体静默失效，
          // 只有刷新页面才能恢复；退避重连在恢复连接性的同时保住连接池。
          let errCount = 0
          source.onopen = () => { errCount = 0; retries = 0 }
          source.onerror = () => {
            errCount += 1
            if (errCount < 5) return
            try { source.close() } catch { /* 已关闭 */ }
            if (disposed || retryTimer !== undefined) return
            retryTimer = setTimeout(() => {
              retryTimer = undefined
              open()
            }, Math.min(30_000 * 2 ** retries, 300_000))
            retries += 1
          }
          source.addEventListener('announcements', event => {
            errCount = 0
            let data
            try { data = JSON.parse(event.data) } catch { return }
            for (const item of data.items ?? []) {
              osNotify(t('toast.annTitle'), item.title)
              if (item.level === 'urgent') {
                showUrgentModal({
                  title: `${t('news.urgentTitle')} · ${item.title}`,
                  html: item.html ?? '',
                  confirmLabel: t('news.gotIt'),
                  onClose: () => { void post('/announcements/ack', { id: item.id }).catch(() => {}) },
                })
              } else {
                showToast({ title: t('toast.annTitle'), body: item.title, tone: item.level === 'warn' ? 'warn' : undefined })
              }
            }
            window.dispatchEvent(new CustomEvent('ofm:announcements', { detail: data }))
          })
          source.addEventListener('update', event => {
            let data
            try { data = JSON.parse(event.data) } catch { return }
            osNotify(t('toast.updateTitle'), t('toast.updateBody').replace('{latest}', data.latest ?? '').replace('{current}', data.current ?? ''))
            showToast({
              title: t('toast.updateTitle'),
              body: t('toast.updateBody').replace('{latest}', data.latest ?? '').replace('{current}', data.current ?? ''),
              tone: 'warn', holdMs: 14000,
            })
            window.dispatchEvent(new CustomEvent('ofm:update', { detail: data }))
          })
          source.addEventListener('upgraded', event => {
            let data
            try { data = JSON.parse(event.data) } catch { data = {} }
            window.dispatchEvent(new CustomEvent('ofm:upgraded', { detail: data }))
          })
          source.addEventListener('hello', event => {
            let data
            try { data = JSON.parse(event.data) } catch { data = {} }
            window.dispatchEvent(new CustomEvent('ofm:hello', { detail: data }))
          })
        }
        open()
        return () => {
          disposed = true
          if (retryTimer !== undefined) { clearTimeout(retryTimer); retryTimer = undefined }
          try { source?.close() } catch { /* already closed */ }
        }
      }, 'our-free-model: push subscription')

      // A hot reload or in-app upgrade swaps this bundle while the page stays
      // open. The only durable marker across that swap is localStorage, so the
      // successor announces what happened exactly once.
      ctx.effect(() => {
        void (async () => {
          try {
            const meta = await api('/meta')
            const at = Number(meta?.reloadedAt ?? 0)
            if (at <= 0) return
            let seen = ''
            try { seen = window.localStorage?.getItem('ofm.reloadedAt') ?? '' } catch { /* storage unavailable */ }
            if (String(at) === seen) return
            try { window.localStorage?.setItem('ofm.reloadedAt', String(at)) } catch { /* ignore */ }
            showToast({
              title: meta.version !== '' ? `Our Free Model ${meta.version}` : 'Our Free Model',
              body: t('reload.done').replace('{n}', String(meta.reloadCount ?? 0)),
              actions: [{ label: t('reload.refresh'), onClick: () => { try { window.location.reload() } catch { /* top-level navigation refused */ } } }],
              holdMs: 12000,
            })
          } catch { /* backend absent */ }
        })()
        return () => {}
      }, 'our-free-model: reload notice')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'our-free-model',
        order: 35,
        label: () => t('nav'),
        locale: NS,
      }, props => h(SettingsPage, { ...props, locale: localeTag(ctx), ctx })))

      ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
        name: 'settings.onboarding',
        id: 'our-free-model-announcement',
        order: -50,
        locale: NS,
      }, props => h(AnnouncementGate, { ...props, t: Object.assign(x => t(x), { locale: localeTag(ctx) }) })))
    }
    /**
     * Owns the announcement's readiness.
     *
     * The onboarding coordinator mounts one ordered step at a time and waits for
     * the registrant to either show something or call `complete`. This renders
     * null until the ack state is known — a step that paints a skeleton then
     * removes it is worse than one that waits — and completes immediately when
     * the user already acknowledged the current copy version.
     */
    function AnnouncementGate(props) {
      const { t, complete, openSection, explicit } = props
      const [ack, setAck] = useState(undefined)
      const [summary, setSummary] = useState(undefined)
      const [page, setPage] = useState(0)
      useEffect(() => {
        let alive = true
        api('/announcement')
          .then(payload => { if (alive) setAck(payload) })
          .catch(() => { if (alive) setAck({ acknowledged: true, version: '' }) })
        api('/summary').then(payload => { if (alive) setSummary(payload) }).catch(() => {})
        // 超时兜底：3 秒拿不到 ack（后端挂起/超时/异常）→ 当作已 ack 主动放行——
        // 本组件是 settings.onboarding 协调器最先执行的 step（order:-50），complete 依赖 ack；
        // ack 永远 undefined 会永久卡住 onboarding 流程（连带阻塞后续 step 与主题启动画面）。
        const timer = setTimeout(() => {
          if (alive) setAck(current => current ?? { acknowledged: true, version: '' })
        }, 3000)
        return () => { alive = false; clearTimeout(timer) }
      }, [])
      const acknowledged = ack?.acknowledged === true && explicit !== true
      useEffect(() => {
        if (ack === undefined) return
        if (acknowledged) complete?.()
      }, [ack, acknowledged, complete])
      if (ack === undefined || acknowledged) return null
      return h(Announcement, { t, complete, openSection, page, setPage, summary, acknowledged: false })
    }
    exports.apply = apply
    exports.inject = inject
    exports.name = 'our-free-model'
    // Headless test seams use the same stub React as scripts/client-lint.mjs.
    exports.__test = { parseSafeHtml, safeUrl, sanitizeStyle, htmlToDom, buildHeatCells, Heatmap, ChannelsPage, UpgradePanel, useEacLogin, EacAuth, PicksPage, RecoCard, DICT, useChannelRpc, Shell, SubscriptionsPage, Disclaimer, CSS }
    return module.exports
  },
})
