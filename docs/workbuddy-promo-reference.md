# `/v3/config` 促销与档位真身数据（fixture）

**来源**：本机 WorkBuddy 桌面端自己缓存的产品配置（不是本插件、不是上游仓库的静态兜底表）：

```
C:\Users\zhujieling11\.workbuddy\cache\acc-product-config-v3.json   388 KB，2026-10-09 08:51 拉取
```

抓取方式：`Get-Content <该文件> -Raw | ConvertFrom-Json`，读顶层 `modelPromotions` 与 `modelTiers`
（⚠️ 是**顶层**键，不是 `data.*` —— 早期的 `DshBuddyConfigSnapshot` 假设过 `data.models` 结构，
实测这份配置的模型表在 `models`、活动表在 `modelPromotions`，都在顶层）。

## 为什么这份数据重要

它否掉了本插件对促销结构的**三条隐含假设**，每一条都会导致真实徽标显示不出来：

| 假设 | 真身反例 | 后果 |
|---|---|---|
| 「每个活动都带 `discount`」 | `glm-52-night-discount-daytime-badge-202607`、`ds-discount-daytime-badge-202608`、`hy4-...-daytime-badge-202609` 只有 `badge`，**没有 `discount`** | 这三条被 `parsePromotions` 的 `typeof discount !== 'object' → continue` 整条丢弃 |
| 「同一模型只可能有一条活动」 | `glm-5.2` 与 `hy4-preview` **各有两条**，靠 `priority` 分时段挂标（夜间 100 / 白天 50） | 只留 priority 最高的一条 → 白天那半段没有徽标 |
| 「促销就是折扣」 | `modelTiers`（`订阅优先`）是**另一套**顶层结构，字段完全不同 | 整类标注从未被读取（截图里 GLM-5.3 的「订阅优先」就是它） |

## 数据分层（三条独立来源，必须分开处理）

1. `modelPromotions[]` —— 折扣/免费活动，含双段价格与多段时段。
2. `modelTiers[]` —— 会员档位标注（`订阅优先`），带 `tier` / `requiredUserType` / `trackKey`。
3. `models[]` —— 模型表，`credits` 是原价倍率（如 `deepseek-v4.1-flash` 为 `x0.11`）。

同一模型可以同时命中 1 与 2（`glm-5.3` 既在 `modelTiers` 里、又有自己的 `credits`）。

## `modelPromotions` 全量（7 条，实测）

| id | priority | badge.label | badge.display | displayMode | factor | daily | modelIds |
|---|---|---|---|---|---|---|---|
| `glm-52-night-discount-202607` | 100 | 夜间折扣 | – | strikethrough | 0.5 | `23:00-7:50` | `glm-5.2` |
| `glm-52-night-discount-daytime-badge-202607` | 50 | 夜间折扣 | – | – | – | `7:50-23:00` | `glm-5.2` |
| `hy3-free-trial-202608` | 200 | 限时免费 | **activeOnly** | replace | 0 | （无 daily，只有日期范围） | `hy3`, `hy3-b`, `hy3-c` |
| `hy4-night-discount-badge-202609` | 50 | 夜间免费 | – | – | – | `8:00-23:00` | `hy4-preview`, `hy4-preview-dev` |
| `hy4-night-discount-daytime-badge-202609` | 50 | 夜间免费 | – | strikethrough | 0 | `23:00-23:59` + `0:00-8:00` | `hy4-preview`, `hy4-preview-dev` |
| `ds-discount-daytime-badge-202608` | 50 | 夜间折扣 | – | – | – | `0:00-23:59` | `deepseek-v4-flash-ioa`, `deepseek-v4.1-flash`, `deepseek-v4-pro-ioa`, `deepseek-v4-flash`, `deepseek-v4-pro` |
| `space-bunny-discount-202610` | 100 | 限时折扣（`shortLabel: 折扣`） | – | – | – | （无 daily） | `space-bunny` |

### 值得单独记住的四点

- **有 `badge` 无 `discount`** 的三条（`glm-52...daytime`、`hy4...daytime`、`ds-discount...`）
  只负责「把这个标挂上」，不带价格。丢掉它们 = 白天没有徽标。
- **跨零点被上游拆成两段**：`hy4-preview` 的夜间段写作 `23:00-23:59` + `0:00-8:00`，
  不是一条 `23:00-8:00`。故 `windows` 必须保持数组、逐段判定。
- **标签与文案可能自相矛盾**：`ds-discount-daytime-badge-202608` 的 `badge.label` 是
  「夜间折扣」，但 `hover.textZh` 写的是「周一至周五 09:00–12:00、14:00–18:00 属高峰原价，
  非高峰期积分5折」。上游自己不一致 → 我们**忠实透传**，不自作主张纠正或改写。
- **小时不补零**：`7:50`、`0:00`、`8:00` 混用，`parseHHMM` 必须容忍。

## `modelTiers` 全量（1 条，实测）

```json
{ "id": "tier-standard-2026q3", "enabled": true, "tier": "standard",
  "requiredUserType": "standard", "priority": 20, "trackKey": "model_tier_standard",
  "badge": { "label": "订阅优先" },
  "hover": { "textZh": "资源紧张，旗舰版及高级版会员享优先调度。",
             "action": { "labelZh": "去升级", "labelEn": "Upgrade", "type": "upgrade" } },
  "modelIds": ["glm-5.3", "glm-5.3-flash", "kimi-k2.8-preview"] }
```

与 `modelPromotions` 的差异：没有 `kind`/`discount`/`schedule`，多了 `tier` /
`requiredUserType` / `trackKey`。**不是折扣，是调度优先级**，故状态词与价格都不该出现。

## 各模型的期望展示（用于断言）

| 模型 | 上游命中 | 期望 |
|---|---|---|
| `glm-5.2` @ 23:30 | 夜间折扣（pri 100，0.5x，`23:00-7:50`） | 徽标「夜间折扣」，strikethrough 双段价 |
| `glm-5.2` @ 12:00 | 白天挂标（pri 50，无折扣，`7:50-23:00`） | 徽标「夜间折扣」（**无价格**） |
| `hy4-preview` @ 23:30 | 夜间免费（pri 50，factor 0，两段窗口） | 徽标「夜间免费」，免费 |
| `hy4-preview` @ 12:00 | 白天挂标（无折扣，`8:00-23:00`） | 徽标「夜间免费」（无价格） |
| `hy3` @ 12:00 | 限时免费（pri 200，replace，`activeOnly`） | 徽标「限时免费」，活动期内恒显示 |
| `deepseek-v4.1-flash` @ 12:00 | 白天挂标（无折扣，`0:00-23:59`） | 徽标「夜间折扣」（无价格），tooltip 用 `hover.textZh` |
| `glm-5.3` | 仅 `modelTiers` | 徽标「订阅优先」，**无价格** |
| `space-bunny` | 限时折扣（pri 100，无 daily，日期范围） | 徽标「限时折扣」 |
| `kimi-k2.6`（无任何活动） | – | 无徽标 |

## 复现

数据在 `~/.workbuddy/cache/` 下、会被上游刷新，故**测试不直接读它**：真身结构已固化进
`scripts/promo-buddy-test.mjs` 的 fixture（键名与嵌套逐字对齐本文件）。本文件只作为
「字段为什么长这样」的出处说明，改 fixture 时回这里对照。

---

# TRAE：标签来自**客户端**，不是上游端点

对照物：截图里 TRAE 模型行的 `专属补贴` / `会员 5 折` / `闲时折扣` 三个标签，
在本插件源码里**全部零命中**（搜 `vendor/channel-pack/src/trae*.ts` 找不到
`专属补贴`、`会员`、`闲时`、`member`、`vip`、`exclusive`；只有 `subsidy` 出现在
`trae.ts:709` 的一句注释里）。

## 它们是客户端的 i18n 文案表

本机实测位置：

```
C:\Users\zhujieling11\AppData\Local\Programs\Trae CN\resources\app\node_modules\
  @byted-icube\ai-modules-chat\dist\index.mjs          ← 一套文案（L5001 是整行 i18n）
  @byted-icube\ai-modules-chat\dist\273.ed2ca7ce.mjs    ← 另一套 trae-chat-core.* 文案
```

三种语言并存、键名统一，取值靠**模板变量**填：

| 键 | 中文 | 变量 |
|---|---|---|
| `…activity_discount.subsidy.tag` | `专属补贴` | – |
| `…activity_discount.off_peak.title` | `闲时折扣` | – |
| `…activity_discount.off_peak.hours` | `北京时间空闲时段：{windows}。` | `{windows}` |
| `…discount.member_discount.tag` | `会员{discountFold}折` | `{discountFold}` |
| `…discount.member_discount.tag_tooltip` | `付费会员享额外{discountFold}折\n积分消耗速度：{originalConsumptionRate}x {consumptionRate}x` | 三个 |
| `…activity_discount.subsidy_member.description` | （英）`Current subsidy: {subsidyOff}% off. Members get {memberOff}% off…` | `subsidyOff` / `memberOff` |

**所以**「上游有没有这个端点」这个问题只对一半：**文案骨架没有端点**（`会员{…}折`
硬编码在客户端里），但**变量值**（折扣率、倍率、时段）必然来自服务端——否则
客户端无从知道该填几折。

## 对本插件的含义

1. **`闲时折扣` 的数据我们已经在读**：它就是 `activity_discount` 的 `off_peak` 型，
   `before_consumption_rate` / `consumption_rate` 都已解析。我们只是**自拼**成
   `x0.8→x0.08`，没用上游那四个字——因为那四个字在客户端、不在响应里。
   想贴官方口径，本地按 `discount_type === 'off_peak'` 映射「闲时折扣」即可。
2. **`专属补贴` 同理**：`subsidy` 型（`trae.ts:709` 的注释证实上游有该 type），
   按 `discount_type === 'subsidy'` 映射「专属补贴」。
3. **`会员 5 折` 与上两者不同类**：它是**会员权益**，有独立的
   `free_title` / `free_description` / `free_action: 升级权益`，语义是"升级付费会员
   才有"。这与 workbuddy 的 `modelTiers`（`订阅优先`）同类：**取决于用户身份**，
   不是活动数据。若响应里确实没有该字段，本插件**无法也不该**凭空显示——那会对
   免费用户谎称有折扣。

## 卡在哪、下一步要什么

`discount_type` 目前被丢掉了：`readActivityDiscount` 只判 `!== 'none'`，不保留
type。要按类型套上游中文标签（`off_peak`→闲时折扣、`subsidy`→专属补贴），就得把
这个 type 一路带进 `promo`。**但 `member_discount` 是否为响应字段尚未证实**，
而且它依赖会员身份——需要在 TRAE 客户端里抓一次真实响应才能定论。

⚠️ `~/.trae-cn` 与 `%APPDATA%\Trae CN` 里搜不到这些中文标签，说明文案只存在于
客户端包内，**不能**从数据目录反推字段名。

---

## 已解决：完整词表 + 真实归属（2026-10-09）

上面那个"卡住"的点已经查清。两个来源互相印证：

### 来源一：客户端词表（`activity_discount.*`，中/英/日三语）

| `discount_type` | 官方短标签 | 客户端完整文案 |
|---|---|---|
| `off_peak` | `闲时折扣` | 空闲时段{fold}折，积分消耗从{before}降至{after}。 |
| `off_peak_member` | `闲时折扣` | **非会员用户**仅空闲时段{fold}折：{windows}。 |
| `subsidy` | `专属补贴` | — |
| `subsidy_member` | `专属补贴` | 当前补贴{subsidyFold}折，开通会员享{memberFold}折… |
| `member` | `会员{fold}折` | 会员专享{fold}折，积分消耗从{before}降至{after}。 |
| `member_all_day` | `会员{fold}折` | 会员专享{fold}折…（全天） |
| `limited` | `限时{fold}折` | 限时{fold}折，{endDate}前有效，积分消耗仅{rate}。 |

（另有 `tob_seat_discount.label = 限时折扣`，是套餐级折扣，不在模型行上。）

### 来源二：本机 TRAE 日志的真实归属

`%APPDATA%\Trae CN\logs\<最新>\window1\renderer.log` 里有
`[ModelRestrictionDiagnostic]` 与 `model_select_tooltip_show` 事件，直接记录了
每个模型命中哪个 feature（且当时身份是**免费**：`userPayIdentity: 0`）：

```
member_discount          → GLM-5.2, GLM-5.3
off_peak_discount        → DeepSeek-V4-Pro
off_peak_member_discount → DeepSeek-V4.1-Flash, DeepSeek-V4-Flash
subsidy_member_discount  → Seed-2.1-Turbo, Seed-Code
```

> 这就是"豆包有 `专属补贴`、DeepSeek 没有"的真正原因：豆包那两条是
> `subsidy_member`，而 DeepSeek 三条分属 `off_peak_member`（两个）与
> `off_peak`（一个）——**不是数据缺失**，是类型不同。

### 结论（已实现）

`traeDiscountLabel()` 现在覆盖全部六种类型。两个关键判断：

1. **`off_peak_member` / `subsidy_member` 必须显示**，且与 `member` 语义相反：
   前者的文案是「**你（非会员）现在**能享什么」，是给免费用户看的；
   后者是「会员专享」。混为一谈会把"你现在有的优惠"错当成"要付费才有"。
2. **`member*` 也照显**（用户明确要求对齐官方：官方对免费用户同样挂这个标，
   日志已证）。`{fold}` 数字响应里没有，用 `after/before` 反推
   （`0.395/0.79 = 5 → 会员5折`）；**推不出整数折就不给标签**，不编
   `1.875折` 这种没人这么说的数。

`limited` 一并给标签（`限时{fold}折`），其 `end_at` 仍走 `validUntil`。

---

## 抓包定案（2026-10-09，`batch_get_detail_param` 真实响应，605 条）

上面「已解决」一节是在**没拿到响应**时写的，有两处需要以实测为准修正：
**类型标识是 `subKey` 而不是 `discount_type`**，且**没有** `member_all_day` /
裸 `subsidy` 这两型（那是从客户端词表反推的，服务端不下发）。

### 真实结构：折扣有**两个**顶层块，都在 `display_contact_config`（JSON 字符串）里

```json
// ① 活动折扣（闲时 / 补贴 / 限时）—— 49 条
"activity_discount": {
  "enable": true, "subKey": "off_peak_discount",
  "data": {
    "current":  { "discount_type": "none", "before_consumption_rate": 0.72,
                  "consumption_rate": 0.72, "discount": 100 },
    "off_peak": { "before_consumption_rate": 0.72, "after_consumption_rate": 0.36,
                  "discount": 50,
                  "time_windows": [ { "weekdays": [1,2,3,4,5,6,7],
                                      "start_minute": 0,    "end_minute": 480  },
                                    { "weekdays": [1,2,3,4,5,6,7],
                                      "start_minute": 1320, "end_minute": 1440 } ] }
  }
}

// ② 会员档位折扣（独立块，字段名不同）—— 17 条
"discount": {
  "enable": true, "subKey": "member_discount",
  "data": { "original_consumption_rate": 0.78, "consumption_rate": 0.39,
            "member_discount": 50, "is_discount_matched": false }
}
```

### 实测 subKey 分布（全 605 条）

| `subKey` | 条数 | 窗口块名 | 备注 |
|---|---|---|---|
| `off_peak_member_discount` | 18 | `off_peak`（另有 `member`） | `current` 常为 `none` |
| `member_discount` | 17 | —（`discount` 块） | 全机 `is_discount_matched: false`（免费账号） |
| `off_peak_discount` | 14 | `off_peak` | `current` 常为 `none` |
| `subsidy_member_discount` | 13 | `subsidy`（另有 `member`） | `current` 为 `subsidy`（此刻生效） |
| `limited_discount` | 4 | `limited`（带 `end_at`） | `current` 为 `limited` |

### 三条定案结论（推翻此前实现）

1. **`data.current.discount_type` 不能当"有没有活动"的判据**。实测 `off_peak` 两类
   共 32 条里，`current` 几乎都是 `discount_type: "none"` + `before === after`
   （闲时段外本就不打折）。**折扣信息在 `data.off_peak` / `data.member` /
   `data.subsidy` / `data.limited` 这些窗口块里**。旧代码只读 `current` 并在
   `none` 时 `return undefined` —— 这就是徽标一直出不来的根因。
2. **`subKey` 才是权威类型标识**（与客户端 `feature_sub_key` 同源，日志已核对）。
   标签映射按 `subKey` 做。
3. **"活动存在"与"此刻打折"是两件事，必须分开**：
   - 活动存在 → 徽标**照挂**（官方在闲时段外、免费账号下也挂）；
   - 此刻不打折（`current` 为 `none`，或 `is_discount_matched: false`）→ **灰显**，
     状态词「常时」。否则 `x0.78→x0.39` 会被读成"我现在付 0.39"，而实付 0.78。
   解析层用 `appliedNow` 把这两件事拆开带出。

### 其它实测细节

- `time_windows` 是**分钟制**（`start_minute`/`end_minute`，`0..1440`），
  `end_minute: 1440` 表示"到午夜"，转展示串时须保留 `24:00`，不能折回 `00:00`。
- 会员块字段名与活动块**不同**：`original_consumption_rate` / `consumption_rate`
  （活动块是 `before_consumption_rate` / `after_consumption_rate`）。
- `member_discount: 50` 是**百分比制**（50 = 5 折），但响应里同时给了
  `original`/`consumption` 两个价，故按倍率反推折数即可，不必依赖该字段。
- 同一个 `config_name` 在**不同 function** 下的 `display_contact_config` 内容
  **可以不同**（实测 `glm-5.2` 在 `chat_v3` 有 `discount`、在 `builder` 没有）——
  合并时以"任一条目带折扣块"为准。

