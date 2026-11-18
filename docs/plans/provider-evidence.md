# 供应商独立资料核对

核对日期：2026-11-17。以下仅证明标注的端点及接口事实，不证明账号权限、模型清单完整性、上下文长度或生成成功。未完成条目仍保持原来源标记，不将旧目录换标签冒充新来源。

| 供应商 | 官方资料 | 已核对事实 |
|---|---|---|
| DeepSeek | https://api-docs.deepseek.com/ | OpenAI 兼容根地址 https://api.deepseek.com |
| Gemini | https://aistudio.google.com/docs/openai | OpenAI 兼容根地址 https://generativelanguage.googleapis.com/v1beta/openai/，使用 Gemini API key |
| Ollama | https://docs.ollama.com/api/openai-compatibility | 本地根地址 http://localhost:11434/v1/；云端 https://ollama.com/v1 使用 API key |
| Mistral | https://docs.mistral.ai/api | POST https://api.mistral.ai/v1/chat/completions，Bearer API key |
| Groq | https://console.groq.com/docs/openai | https://api.groq.com/openai/v1，使用 Groq API key |
| Together | https://docs.together.ai/docs/inference/openai-compatibility | https://api.together.ai/v1，Bearer API key；model 取 Together model ID |

待补：Anthropic 页面读取成功但当前提取未定位 API 根地址；Cerebras 指定页面不可读，需要查找官方替代页面。其余供应商尚未核对。现有模型标识涉及配置兼容，不能未经核实直接删除。

## 第二批核对

| 供应商 | 官方资料 | 已核对事实 |
|---|---|---|
| Fireworks | https://docs.fireworks.ai/tools-sdks/openai-compatibility | https://api.fireworks.ai/inference/v1，使用 Fireworks API key |
| Cohere | https://docs.cohere.com/docs/compatibility-api | https://api.cohere.ai/compatibility/v1，使用 Cohere API key |

xAI 与 Hugging Face 官方页面已读取，具体端点正在定位；LM Studio、DeepInfra、Cerebras 初始 docs 域名路径不可读，改查官方其他路径，不据此判定服务不可用。

| 供应商 | 官方资料 | 已核对事实 |
|---|---|---|
| Hugging Face | https://huggingface.co/docs/inference-providers/en/index | https://router.huggingface.co/v1，Bearer HF_TOKEN；GET /v1/models 提供模型目录 |
| xAI | https://docs.x.ai/developers/rest-api-reference/inference/responses | https://api.x.ai/v1，Bearer XAI_API_KEY；本页验证 Responses，Chat 格式需另查 |

已找到可读官方替代页：LM Studio https://lmstudio.ai/docs/developer/openai-compat；DeepInfra https://docs.deepinfra.com/chat/overview；Cerebras https://inference-docs.cerebras.ai/api-reference/chat-completions。端点字段将在下一步定位，不把仅页面可读当成完成核对。

第三批：LM Studio 文档确认 localhost:1234/v1 与 GET /v1/models；Ollama 文档确认 GET /v1/models。两条本地目录已按官方文档重建，保留现有 id、端点覆盖环境变量及空模型列表，没有新增模型发现行为。source=official，并附 sourceUrl。其余 58 条 FCC 来源记录尚未替换。

DeepInfra 官方 https://docs.deepinfra.com/chat/overview 确认 https://api.deepinfra.com/v1/openai 与 Bearer token。Novita 官方 https://docs.novita.ai/api-reference/model-apis-llm-create-chat-completion 确认 https://api.novita.ai/openai/v1/chat/completions。Cerebras 页面尚未定位根地址；Featherless、SiliconFlow 初始路径不可读，待找官方替代路径。

第四批端点证据：Cerebras https://inference-docs.cerebras.ai/resources/openai 确认 https://api.cerebras.ai/v1 与 API key；SiliconFlow https://docs.siliconflow.com/en/userguide/quickstart 确认 https://api.siliconflow.com/v1 与 API key。尚未完成对应全部模型目录核对。Featherless 第二个路径仍不可读。

Hugging Face 条目已重建：路由端点与 :fastest 语法依据官方 Inference Providers 文档；模型标识依据 Qwen 官方模型卡 https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct。原有环境变量 HUGGINGFACE_API_KEY 作为 OFM 配置兼容名保留；能力仍为 unknown/null，不凭模型名推断。尚无用户 token 的真实生成验收。

DeepInfra 与 Novita 两条已按官方接口文档和 2026-11-17 公开 /models 响应重建；原环境变量作为配置兼容标识保留，说明文字重新编写，模型能力保持 unknown。公开目录核对结果保存在 provider-model-audit.json，共 34 个已声明 HTTPS 地址；HTTP 200 且目录匹配不等于有权调用或生成成功。

OrcaRouter 官方首页 https://www.orcarouter.ai/ 确认 https://api.orcarouter.ai/v1、API key 和 Chat Completions；公开目录包含现有模型。OpenRouter 官方 quickstart 确认根地址与 API key，但当前示例偏向 Responses，Chat 需要继续核对。SambaNova quickstart 确认模型与 API key，端点尚未在当前页面定位。

SambaNova 的 API keys and URLs 文档确认根地址与 Chat 路径；OpenRouter API reference 确认 Chat 路径。SambaNova、OrcaRouter、OpenRouter 按上述官方文档与公开目录重建，旧无依据的固定免费额度说明已移除。

llama.cpp 官方 server README 当前默认端口为 9931，支持 --port 自定义。OFM 条目为兼容既有安装保留 8080，并明确它是 OFM 兼容配置而非当前上游默认；模型目录保持由用户本地加载状态决定。原配置覆盖变量不变。

接续核对：Groq 官方 https://console.groq.com/docs/models 当前列出 llama-3.3-70b-versatile 和 openai/gpt-oss-120b；不能据此确认旧目录另外两个模型仍可用。Mistral https://docs.mistral.ai/api 确认 /v1/chat/completions，并明确可用模型需查模型列表。两条目前仍未完成所有旧模型的独立核对，不修改来源标记。

第五批官方资料定位：CheaperInference https://api.cheaperinference.com/docs 确认 OpenAI 根地址 https://api.cheaperinference.com/v1；Featherless https://featherless.ai/docs/completions 确认 /v1/chat/completions，https://featherless.ai/docs/api-reference-models 声明 /v1/models（本机实测曾 404，文档与运行结果不一致须保留）。Experiential 官方文档入口为 https://platform.experientiallabs.ai/docs；Agnes 尚未找到足够资料。未完成模型与权限核对的记录不改来源标签。

Groq 条目独立重建：端点、密钥环境变量依据 https://console.groq.com/docs/openai；四个既有模型 ID 分别由 https://console.groq.com/docs/models 和 https://console.groq.com/docs/deprecations 确认。Maverick 于 2026-03-09 退役；Qwen3 32B 于 2026-07-17 对免费/开发者档退役；Llama 3.3 于 2026-08-16 对免费/开发者档退役，后二者企业合同有例外。保留旧 ID 供配置兼容，并明确限制，不承诺可调用。

Mistral 条目独立重建：https://docs.mistral.ai/api 确认根地址、Chat 路径、Bearer 与 MISTRAL_API_KEY；https://docs.mistral.ai/inference/conversations/function-calling 列出全部四个既有 latest 别名。展示名改为别名本身，避免把滚动别名误标为旧模型代数。尚未使用真实 API key 验收。

Azure OpenAI、Amazon Bedrock、Chutes 三条已按官方资料重建：
- Azure：https://learn.microsoft.com/en-us/azure/developer/ai/how-to/switching-endpoints 与 https://learn.microsoft.com/en-us/azure/ai-studio/ai-services/concepts/endpoints 确认资源 /openai/v1 地址、API key 与 deployment name。保留 OFM 的 AZURE_OPENAI_BASE_URL、AZURE_OPENAI_API_KEY 配置名，无默认端点和默认模型。
- Bedrock：https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-oss-120b.html 及 https://docs.aws.amazon.com/bedrock/latest/userguide/inference-chat-completions.html 确认 mantle us-east-1 /v1、openai.gpt-oss-120b、Chat Completions 和 Bedrock API key。保留既有环境变量与端点覆盖字段。
- Chutes：https://chutes.ai/docs/models/chutes-qwen-qwen3-32b-tee 确认 llm.chutes.ai/v1、Qwen/Qwen3-32B-TEE、Bearer CHUTES_API_KEY 与 Chat Completions。没有因官方标注能力而扩充原有能力字段，维持 unknown。
上述证明接口与标识来源，不证明真实账号生成成功。

models.dev 批量供应商元数据已通过 GitHub 连接读取 38 项 provider.toml，暂存 /tmp/ofm-models-provider-metadata.json。已发现多个当前端点与旧目录不同（如 Kimi、OpenCode、Kilo），不能直接套用或悄悄改用户路由；需按现有协议与模型逐项对应。Agnes 元数据明确提供原端点与 AGNES_API_KEY，模型目录包含 agnes-2.0-flash.toml。

MIT 模型文件批量核对已完成：请求354个路径，242个返回文本；其中部分连接输出把换行编码为字面量 \\n，需要在无真实换行的返回值中还原后按 TOML 解析。不能把仅含 base_model 的继承条目误判为缺失。解析证据暂存 /tmp/ofm-models-parsed-evidence.json。

15个供应商的全部现有模型标识在该 MIT 数据源中可找到：Agnes、ClinePass、Cohere、MiniMax、Codestral、Opper、Poolside、QwenCloud、QwenCloud Coding、SiliconFlow、Vercel、Wafer、W&B、Z.ai API、Gemini。能力字段原本均为 null，后续仍保留 unknown，避免未经解析继承关系便改变能力声明。部分模型在来源中标记 deprecated，不能声称当前全部可用。

13个供应商已改从 models.dev（MIT）重建模型目录与说明：Agnes、ClinePass、Cohere、Opper、Poolside、QwenCloud、QwenCloud Coding、SiliconFlow、Vercel、Wafer、W&B、Z.ai API、Gemini。文件路径及读取内容摘要记录于 models-dev-migration.json；完整 MIT 许可与版权行附在发布本来就包含的根 LICENSE，未增加发布文件数。保留 OFM 现有配置键、端点与模型ID，能力字段仍为 null；包含历史/退役模型，不声称当前均可调用。MiniMax 和 Codestral 的模型已匹配，协议端点差异待单独确认后再迁移。

Kimi 条目按 https://platform.kimi.ai/docs/get-your-api-key 与 https://platform.kimi.ai/docs/models 重建。官方示例确认 api.moonshot.ai/v1、Bearer 与 Chat Completions；旧 kimi-k2.5 明确列为 Deprecated，保留 ID 供兼容且注明弃用。KIMI_API_KEY 是既有 OFM 配置名，官方示例使用 MOONSHOT_API_KEY；未悄悄更改用户配置。授权入口更新到官方当前平台。未验收真实生成。

MiniMax 已迁移：官方 https://platform.minimax.io/docs/api-reference/text-openai-api 明确 https://api.minimax.io/v1、Chat Completions 与独立 reasoning_content；四个既有模型均在已解析的 models.dev MIT 文件中，摘要追加到 models-dev-migration.json。M2.7/M2.5/M2.1 标记 deprecated，已在条目说明限制，能力继续 unknown。Codestral 官方历史发布 https://mistral.ai/news/codestral/ 确认独立域名，但当前 /v1 Chat 与独立 key 的完整验证仍待补，暂不改其来源。

26个历史模型快照的根 LICENSE 已逐一经 GitHub API 核实均为 MIT，结果保存在 models-dev-history-licenses.json。Anthropic、MiniMax、OpenAI API、OpenCode Go、Z.ai Coding、OpenCode Zen 的全部原模型标识已按这些来源重建；历史来源 ref 已记录，现有配置端点作为兼容配置保留。MiniMax OpenAI 接口另外由 https://platform.minimax.io/docs/api-reference/text-openai-api 确认。上述迁移不证明历史模型仍可生成。

### NVIDIA NIM：模型目录重建

8 个模型 ID 均有已取得的 models.dev MIT 当前或历史文件证据，具体路径、内容摘要和历史提交在 models-dev-migration.json。重建名称和记录，删除此前 FCC/9router 宣传说明。历史弃用记录保留 ID 以兼容已保存设置，并不表示当前服务可用。Nemotron 3 Super 的旧 OFM 上限 131072 保留为本地兼容限制；历史来源中的供应商上限是 262144，不能混同。未知能力字段保持 null。

验证：registry-test 通过（76 个供应商、507 个模型 ID），git diff --check 通过。尚有 25 个 fcc 来源条目待核对。

### Kilo：继承能力字段核对

补取 models.dev 的 5 个 MIT 基础模型文件，与 Kilo 供应商覆盖字段合并后，11 个模型的 contextWindow、vision、reasoning 均与现有 OFM 值一致，已逐项断言。名称改用来源目录名称，保留模型 ID 和 API-key 配置。每项路径与 SHA256 写入 models-dev-migration.json，历史 crouton-alpha 标记来源提交。该迁移不能证明历史模型今天仍可调用；此前公共目录审计未返回 crouton-alpha。

registry-test 再次通过，git diff --check 通过；剩余 24 个 fcc 条目未迁移。

### Codestral：独立密钥端点核对

Mistral 官方发布说明（https://mistral.ai/news/codestral/，2024-05-29）确认专用 codestral.mistral.ai 端点；Continue 自身接入文档（https://docs.continue.dev/customize/model-providers/more/mistral）明确给出 https://codestral.mistral.ai/v1，并区分其密钥与 api.mistral.ai 密钥。据此保留现有端点及 CODESTRAL_API_KEY，模型记录使用已核验 MIT models.dev 的 codestral-latest 文件重建。没有沿用旧文案中的 FCC 注释，也不把历史免费试用期当成当前承诺。

registry-test 和 git diff --check 通过，剩余 23 个 fcc 条目。跨供应商相同 ID 的候选证据已检查：其他供应商提供某模型不证明本供应商提供该模型，不能直接据此替换来源；需要本供应商文档或历史目录佐证。

### Cerebras 与 Fireworks：补全历史目录证据

Cerebras 官方弃用页 https://inference-docs.cerebras.ai/support/deprecation 直接列出此前缺少 MIT 目录记录的 llama-3.3-70b、qwen-3-32b（2026-02-16 弃用）及 llama-4-scout-17b-16e-instruct（2025-11-03 弃用）。它还确认当前旧清单中的 GLM 4.7 和 Qwen 235B 也已弃用。保留 ID 用于已有配置，不能声称这些模型现仍可调用。

Fireworks 官方模型页 https://fireworks.ai/models/fireworks/llama-v3p3-70b-instruct 明确给出 account-scoped ID，同时标为 on-demand 支持、serverless 不支持。重建条目并标注此限制，其余两个模型沿用已核验 MIT 来源。

这两项目录已迁移，来源路径/摘要及官方 URL 已登记。registry-test、git diff --check 通过；剩余 21 个 fcc 条目。全部原模型均能在线使用的要求目前受到供应商退役事实限制，代码重写无法恢复供应商已取消的服务；发布说明必须明确此边界，不能以目录数量不变替代在线可用验证。

### Together 与 Nebius：官方 ID 补证

- Nebius 官方教程 https://nebius.com/blog/posts/launch-production-agents-at-scale 使用 `Qwen/Qwen3-30B-A3B`，补全本供应商历史 ID 证据。
- Together https://www.together.ai/models/llama-4-maverick 给出完整 Maverick FP8 ID；https://www.together.ai/blog/fine-tuning-updates-sept-2025 给出 Qwen3-235B-A22B，但后者证明的是微调及专用部署，不能据此声称共享端点可调用。
- 已按这些官方 ID 与已有 MIT 文件重建两项目录。全部旧模型 ID、未知能力字段及配置保留，实际账号可用性未验证。来源证据已写入 models-dev-migration.json。
- registry-test 与 git diff --check 通过。剩余 19 个 fcc 来源条目。

### xAI 与 Cloudflare 补证

xAI 官方 https://docs.x.ai/developers/migration/may-15-retirement 确认 grok-4-fast-reasoning 历史标识，并说明供应商将它重定向至 grok-4.3 low；不是原模型仍在服务。Cloudflare 当前正式定价页 https://developers.cloudflare.com/workers-ai/platform/pricing/ 第 157/163 行包含此前缺失的两个 llama-3.1 fp8-fast 标识；无需以第三方站点或预览页作为依据。定价仍含已退役条目，故不据此保证在线可用性。

已用 MIT 目录与上述官方标识补全两项来源迁移，保留所有 ID 及未知能力字段。registry-test 和 git diff --check 通过；剩余 17 个 fcc 条目。

### Cheaper Inference 与待核对别名

Cheaper Inference 官方模型页 https://api.cheaperinference.com/models/gpt-5.4-mini 直接给出模型 ID、/v1/chat/completions 与 Bearer 示例。已重建该单模型记录，保留原配置和未知能力值，删除 FCC 筛选说明。registry-test、git diff --check 通过；剩余 16 项。

DeepSeek 官方当前说明使用 deepseek-flash 和 deepseek-v4-pro，未确认目录中的 deepseek-v4-pro-max、deepseek-v4-pro-none、deepseek-v4.1-flash 是可直接发送的 ID。源码搜索显示这三个别名只出现在 registry，没有转换逻辑；不能只换来源标签。Scaleway 当前资料给出带日期或无供应商前缀的模型名，尚不能证明旧 deepseek/deepseek-v4-flash ID。后续需要核实这些兼容别名的实际语义，不能静默替换为另一个模型。

### 剩余目录的新增阻碍证据

- Experiential 官方文档 https://platform.experientiallabs.ai/docs/models 公开提供 GET /api/models/<slug>。本轮对 https://api.experientiallabs.ai/api/models/union-alpha 无凭据只读查询返回 HTTP 404，明确表示 public catalog 中无该模型。不能把 OpenCode 的同名模型证据当成 Experiential 支持证据。
- Ollama https://ollama.com/library/glm-4.7-flash 与 https://ollama.com/library/qwen3.5 的示例均指向本地 localhost:11434，不能证明现有 ollama_cloud 配置支持它们。
- https://ollama.com/library/deepseek-v4.1-flash 确认 :cloud 标签，但直连云端示例发送不带 :cloud 的 deepseek-v4.1-flash。当前 registry 的 :cloud 模型是否能在其配置的云端 OpenAI 端点直接使用仍未验证。

本轮未把上述不确定条目改标为已完成迁移，也未通过删除模型或静默改用不同模型掩盖兼容性问题。

### Lightning、xKiro、ZenMux、Vertex

- Lightning 官方 https://lightning.ai/lightning-ai/apps 同时列出 API base 与 lightning-ai/Qwen3.8-27B。
- xKiro 官方 https://xkiro.com/models/qwen/qwen3.7-flash%3Afree 给出完整模型 ID、API base 和请求示例。
- ZenMux 官方 https://zenmux.ai/deepseek/deepseek-v4-flash-free 确认旧 ID，但模型及两条路由均标为 Sunset，已在条目提示中说明。
- Google 官方 https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/start/openai 明确给出 google/gemini-3.5-flash、项目/位置端点模板和 ADC token 用法，补齐 Vertex 缺失证据。

四项重建均保留模型 ID、配置及未知能力字段；没有用文档代替真实推理验收。registry-test、git diff --check 通过。剩余 12 个 fcc 条目。

### LLM7 与 TokenRouter 当前目录核对

LLM7 本轮 GET https://api.llm7.io/v1/models 返回 200 和 77 项。按 JSON 的 id 严格相等比较，仅 claude-opus-5、kimi-k3 匹配旧清单；不能用全文 includes 判断（deepseek-v4-flash 会误匹配更长/不同标识或说明）。default/fast/pro 虽不在返回列表，官方主页 https://llm7.io/ 仍明确描述这三个路由别名，因此缺席列表本身不足以断言不可用。精确比较结果见 llm7-model-audit.json。

TokenRouter 官方网页 https://www.tokenrouter.com/models/ 可读取，模型按 API formats 标注，不是所有模型都提供同一种 wire。例如 GPT-5.5 标为 openai-response，Claude 多项标为 anthropic，Gemini 标为 gemini。当前统一 openai-chat 条目是否覆盖这些协议，仍需供应商兼容层证据。直接读取该网页超时，未自动重试；网页工具已有只读结果可继续核对。上述两项未虚假标为完成迁移。

### Alibaba 目录与 Kimi 编程模型边界

Alibaba 官方 Kimi/MiniMax 文档、定价及旧模型退役延期公告补全五个缺失 ID 的独立证据，另两项已有 MIT 文件。已据此重建 Alibaba 目录，保留旧国际端点并明确各模型的区域可用性未验证；具体 URL 与摘要见 models-dev-migration.json。registry-test、git diff --check 通过，剩余 11 项来源迁移。

Kimi 官方 https://www.kimi.com/code/docs/en/kimi-code/models.html 明确要求使用 k3、kimi-for-coding 等协议 ID，并指出错误 ID 可能回落到 K2.8 Preview 非思考模式。旧目录中的 kimi-k3/kimi-k2.7-code 等版本名不能自动视为等价的协议 ID；即使返回 200，也不足以证明请求的是指定模型。此项仍待处理，未静默映射或假称兼容。

### Featherless 官方模型页重建

逐个读取以下官方模型页，全部页面标题确认原有 ID；保留未知能力字段，不复制页面描述或价格。此前 /v1/models 返回 404 的证据不等同于模型不存在。实际账号调用仍未验证。

- https://featherless.ai/models/deepseek-ai/DeepSeek-V4-Pro
- https://featherless.ai/models/deepseek-ai/DeepSeek-V4-Flash
- https://featherless.ai/models/zai-org/GLM-5.2
- https://featherless.ai/models/zai-org/GLM-5.1
- https://featherless.ai/models/moonshotai/Kimi-K2.7-Code
- https://featherless.ai/models/moonshotai/Kimi-K2.6
- https://featherless.ai/models/moonshotai/Kimi-K2.5
- https://featherless.ai/models/Qwen/Qwen3-32B

registry-test、git diff --check 通过后，剩余 10 个 fcc 条目。

### Copilot 内部别名补查

通过 GitHub 连接器在 microsoft/vscode-copilot-chat、anomalyco/opencode、earendil-works/pi 默认分支搜索 goldeneye-free-auto，均未返回代码结果。第三方问题记录不能替代官方或许可明确的实现来源；此项仍未完成。

### 2026-11-18 公开目录补查

直接 GET 三个已声明的公开模型端点，无凭据：Experiential /v1/models 返回 401；Scaleway /v1/models 返回 401；NaraRouter /v1/models 返回 200，但按 id 严格相等比较，kimi-k3-free 不在当前列表。结果摘要见 public-catalog-followup.json。401 不证明模型不存在；列表缺席也不证明旧别名一定不可调用，故未删除原 ID 或改标来源完成。
