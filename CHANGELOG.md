# Changelog

## 0.7.1（适配 DSH 0.2.x 的配置表单）

宿主 0.2.x 把「插件把 schema 注册给 settings 服务」换成了「表单从**插件自己的 Config** 派生」——
`@deepseek-ai/dsh-settings` 0.2.0-rc.2 的 `SettingsForms` **没有 `register()`**，于是 0.7.0 的
「设置 → 插件 → sd-bridge」在 0.2.x 上只剩一条日志、面板不出现（插件本身仍正常，工具与技能都在）。

- **新增 `export const Config`（13 个字段全 `.volatile()`）**：走 0.2.x 新范式——Loader 读插件导出的 Config，把 volatile 字段投影成表单；面板改完**不重挂插件**，Loader 直接把新值 commit 进同一个引用对象。
- **`apply()` 解包 volatile 引用 + 装访问器**：0.2.x 下 `config[key]` 是 `Volatile<T>` 引用（不是裸值），所以 ① 取值统一走 `.get()`；② 把 13 个键装成访问器，引用变了才重算，并按老规则钳制（port 1024-65535、denoising 0-1、startupTimeout ≥30s…）；`apply()` 里原有的钳制写回也不会被吞——**改完下一个工具调用即生效**。
- **每个字段都带 `.loose()`**：手写 `cordis.patch.yml` 很容易把数字/布尔写成字符串（`port: "7860"`、`enabled: "false"`），而 0.2.x 的 `resolveConfig` 是**严格**校验、失败即抛 `ValidationError` → **整个插件激活不了**。`.loose()` 让校验异常退回 schema 默认值：宁可某个字段悄悄用默认值，也绝不能让插件起不来（0.1.x 时代这里根本没有 schema，所以「加 schema」绝不能变成新的启动风险）。
- **仍然零静态依赖**：`Config` 用 **top-level await + 动态 import** 构造（裸 import → 宿主真身 `app.asar/dsh/node_modules/...` → `~/.dsh/profiles/*` 兜底），任一环节失败就导出 `undefined`、退回「没有 schema」的老行为。⛔ **绝不能写静态 `import '@deepseek-ai/schemastery'`**：插件以 `link:` 安装时 Node 按 realpath 解析依赖，静态 import 必然 `ERR_MODULE_NOT_FOUND`，**整个模块加载失败 → 插件激活不了**。
- **路径一律走 `pathToFileURL`**：宿主真身在 `app.asar` 里，路径含空格与中文，手拼 `file:///` 会失败。
- **0.1.x 兼容**：旧的 `tryLoadConfigSchema`（`settings.register` 路径）原样保留，只把「加载 schemastery」抽成公共的 `resolveSchemastery()`；0.1.x 上行为与 0.7.0 完全一致。
- 新增 `test-config-schema.mjs`：Config 13 字段 + 全部 volatile + schema 默认值与 `DEFAULTS` 一致 + 解析后是引用对象 + 未知键不抛 + `apply` 解包正确 + **面板原地 commit 新值后 `cfg` 即时生效** + 越界钳制 + 工具仍注册 6 个。

## 0.7.0（设置入口 + 环境预检 + 资源清单化拉取）

对着评论区反馈做的四件事：设置里找不到配置项、装机环境缺东西、模型拉取对象过时、缺常见 LoRA。

- **设置面板配置入口（修「设置里没有这个插件设置内容」）**：`sd-bridge.js` 新增 `registerSettings`——运行时动态 `import('@deepseek-ai/schemastery')` 构造 schema（零静态依赖，schemastery 缺失则跳过注册、工具照常可用），`settings.register('sd-bridge', schema)` 注册到 **设置 → 插件 → sd-bridge**，`DEFAULTS` 全部 13 个字段可编辑（每个带中文说明）。`scope.watch` 实时并回 `cfg`，工具调用现读 `cfg`，**改完下一个调用即生效、无需重启**。优先级：DEFAULTS < 设置面板 < `cordis.patch.yml` 显式覆盖（patch 层指定的键被冻结，面板不覆盖）。
- **环境预检段 `Test-Prereqs`（缺啥补啥，先于一切下载）**：磁盘 ≥15GB 提前拦 → 镜像探活（失败提示换 `-Mirror ""`）→ git（缺则自举 MinGit）→ Python 3.10（占位符则静默装 3.10.6）→ **VC++ 2015-2022 x64 运行库**（查注册表 `VC\Runtimes\x64`，缺则下官方 `vc_redist.x64.exe` 静默装；torch/A1111 硬依赖，缺了首轮启动报错极迷惑）。每项失败只报一条错 + 一行提示即 `exit 1`，最后打一张「✓ 就绪清单」。`-NoPrereq` / `-SkipVC` / `-SkipDiskCheck` 可分别跳过。
- **模型/VAE 拉取对象换成本机实测组合（清单化）**：`-Models` 逗号多选（`awpainting` 默认 / `revanimated` / `anythingv5` / `majicmix` / `darksushi`），`-Vaes`（`mse` 默认 / `animevae`）。**全部 5 个 checkpoint + 2 个 VAE 的 sha256 已与本机出图正常的文件逐字节比对**（HF lfs oid = sha256：AWPainting `3d1b3c42…`、ReVAnimated v1.1 `d725be5d…`、anything-v5 `7f96a1a9…`、majicMIX v7 `7c819b6d…`、dark sushi brighterPruned `099e0754…`、animevae `f921fb3f…`）。清单键写错会列出全部可用键。
- **常见 LoRA/Embedding 拉取**：`-Loras` 默认 `add_detail,easynegative,badhandv4`（细节增强 LoRA 38MB + 负面嵌入 24KB + 手部修复嵌入 18KB，均 HF 镜像直链 + sha256 校验）；LoRA 落 `models\Lora`、Embedding 落 `models\embeddings`（A1111 各自扫描目录）。`-SkipLora` 跳过、`none` 清空。**你本地那批国内站 LoRA（国风山水/赛博朋克/电商摄影等）不进清单**——直链不稳，README 写了手动放置说明。
- **`-Upgrade` 升级复验**：已存在文件做 sha 复验，不符就重拉；清单条目带 `Supersedes`（如 ReVAnimated v10 → v1.1）时旧版在、新版缺就补拉新版（**旧版保留**）。
- **资源清单汇总**：跑完打印「[类型] 文件 — ✓ 已下载 / ✓ 已存在 / ✗ 原因」一张表，失败项提示重跑自动续传。
- **文档去旧插件化**：README/`cordis.patch.yml`/源码头注释删除「替换原 `dsh-sd-bridge`」「与原插件同 id」等声明（原版从未发布）；`package.json` 仓库地址从 `YOUR-USER` 占位改为 `savinglighting`。
- **踩坑新增：编辑 `.ps1` 会丢 UTF-8 BOM**（PS5.1 无 BOM 按 GBK 读 → 语法错），改完必须补回 `EF BB BF`——本次实测踩中，靠 `[Parser]::ParseFile` 检查抓出。
- **踩坑新增：符号链接插件裸 import 依赖会落空**——插件以 profile node_modules 符号链接指向工作区时，Node 按 realpath 解析依赖，`import('@deepseek-ai/schemastery')` 必然失败 → 设置注册被静默跳过（「注册了但面板还是没有」的隐藏根因）。`tryLoadConfigSchema` 增加途径②：扫 `~/.dsh/profiles/*/node_modules/@deepseek-ai/schemastery/lib/index.mjs` 按绝对路径导入。
- 新增 `test-settings.mjs`：schema 注册（ns = `sd-bridge`、13 字段全在 `dict` 上）+ 面板改动实时并回 `cfg` + **patch 显式键不被面板覆盖** + 越界钳制（denoising 0-1、idleStop ≥0、startupTimeout ≥30s）。
- 新增 `test-install-catalog.mjs`：BOM 断言 + 三张清单（键/sha256/HF 源，含 AWPainting 与 animevae 的已验证哈希）+ 预检五项与单条退出 + `-Models`/`-Loras` 默认值 + 临时目录干跑（预检打印、记录无 BOM）+ 非法键 exit 1 并列出可用键。
- **发布整理**：README 与源码头注释的工具计数从「五件套」更正为「六件套」并补上 `sd_inpaint`（0.6.0 新增蒙版重绘后文案未同步）；README 示例图与 LICENSE 徽章改用绝对地址，在 npm 包页面同样能渲染；`package.json` 的 `files` 补 `CHANGELOG.md`，新增 `scripts`（`npm test` = 四条不出图检查，`npm run acceptance` = 真实出图验收）；`sd-direct.ps1` / `install-sd.ps1` 行尾统一为 CRLF（与 `.gitattributes` 的 `*.ps1 text eol=crlf` 声明一致），UTF-8 BOM 保持不变、`[Parser]::ParseFile` 复核 SYNTAX OK。

## 0.6.0（几个坑回填 + 脚本跑完自动开图）

从「点安装 → 新会话跑通」踩的 12 个坑全部回填进插件与安装脚本；可复现脚本新增「跑完打开这张图」。

- **脚本跑完自动打开那张图**：`sd-direct.ps1` 保存成功后用系统默认看图器打开产物，`-NoOpen` 关闭；工具描述、`sd-paint` 技能与 `asMarkdown` 头部同步说明。
- **脚本自带服务托管 + 单条报错（坑15，别人电脑实测）**：SD API 没开时脚本按 `-SdDir` > `DSH_SD_DIR` > `~/.dsh-sd-bridge.json` > 各盘常见安装名**自己拉起**并轮询就绪（`-NoStart` 关闭、`-StartTimeout` 调超时、日志 `%TEMP%\dsh-sd-direct-launch.log*`）；端口被占、目录/解释器缺失、API 调用失败、结果无图——统一 `Fail` **只报一条错误 + 一行提示就 `exit 1`**，不再出现「连不上 → 空数组 → 空值写盘 → 空 JSON」连炸 4 条。
- **坑10 · BOM（唯一影响所有会话的根因）**：安装记录读取改为「剥 BOM → JSON 解析 → 失败按字段兜底 → **大声记日志**」，读到 BOM 就**就地自愈重写**为无 BOM UTF-8；`install-sd.ps1` 写记录改用无 BOM UTF-8 并回读校验 `BOM=False`。
- **坑11 · 离线 tokenizer 失败**：只有 `<SD>\.cache\huggingface` 真有 `models--*` 才接管 `HF_HOME` 并开离线；缓存为空则不接管、保持联网（`DSH_SD_HF_ONLINE=1` 强制联网）。
- **坑6 · Blackwell**：全新安装时探测 `compute_cap ≥ 12` → 自动 `TORCH_COMMAND` 换 torch 2.7.0 + torchvision 0.22.0（cu128，本机 RTX 5060 实测 CUDA 可用）；已设 `TORCH_*` 则完全尊重。
- **坑7/8 · pip**：`PIP_CONSTRAINT` 钉 `setuptools==69.5.1`、`numpy==1.26.2`、`opencv-python==4.11.0.86`（作用到含 PEP 517 构建隔离在内的每次 pip），另设 `PIP_RETRIES=10` / `PIP_TIMEOUT=60`；`DSH_SD_PIP_CONSTRAINT=0` 可关。
- **坑9 · 上游删库**：本地缺 `repositories/stable-diffusion-stability-ai` 时自动把 `STABLE_DIFFUSION_REPO` 指向 camenduru fork（保留同一 commit `cf1d67a6…`，签名 verified）。
- **坑2 · 无 git**：`install-sd.ps1` 自动自举 MinGit 便携版——资源带 `digest` 先校验 sha256、再 `git --version` 实测，装完写入用户 PATH（保留注册表 ExpandString 类型）。
- **坑4 · 商店占位 Python**：自动静默装官方 Python 3.10.6（用户级 `PrependPath`），`pythonDir` 记进安装记录，插件 `resolvePython` 在 SD 自带 python/venv 之后兜底使用。
- **坑5 · 大文件断流**：`Get-SegmentedFile` 8 段并行 Range 下载 + 断点续传 + 长度/可选 sha256 校验（实测与单流逐字节一致）。
- **坑13（本次新发现）**：`.ps1` 固定存 **UTF-8 with BOM**——PS5.1 对无 BOM 文件按 GBK 读，中文多字节会吞掉后面的 `)` `"` 直接语法错（与坑10 的 JSON 记录恰好相反：JSON 必须无 BOM）。
- **坑14（本次新发现）**：`sd-direct.ps1` 的 `-Seed` 由 `[int]` 改为 `[long]`——SD 的 seed 是 uint32，`3845143617` 这类种子在 `[int]` 上直接参数转换失败。
- **坑16 · 新装 SD 画质差（本次新发现，根因＝模型）**：`install-sd.ps1` 默认模型从 2022 年的 SD1.5 base 换成 **AWPainting v1.2**（远端 sha256 `3d1b3c42ec…` 与本机出图正常的文件**逐字节一致**），补下 **`vae-ft-mse-840000`**（`735e4c3a…`，实测 4 段下载 + 哈希通过），并合并写入 `config.json` 的 `sd_model_checkpoint` / `sd_vae` / `CLIP_stop_at_last_layers=2`——只改点名键、保留其余键、写回不带 BOM、非 UTF-8 老文件按原编码读写、`-NoConfig` 关闭；`sd_models` 发现只有 base 模型时返回 `qualityHint` 给出升级路径。
- **坑17 · 脚本拉起的 SD 启动卡几分钟（本次新发现）**：`sd-direct.ps1` 启动前按插件同一规则设 HF 环境（缓存命中 → `HF_HOME` + 离线加载；未命中 → 保持联网走 `hf-mirror`；`DSH_SD_HF_ONLINE=1` 强制联网），修掉「去连 huggingface.co 重试 5 次×10s×多文件」——实测 HF 重试 0 次、冷启动到出图 28 秒。
- **坑18 · stderr 刷「找不到驱动器 E:」（本次新发现）**：扫盘先 `Test-Path` 跳过不存在的盘符，候选路径再包 `try/catch`。
- **句柄彻底脱离**：启动 SD 时 stdin/stdout/stderr 三者都显式重定向到文件，避免继承宿主管道导致「脚本跑完了宿主却一直挂着不返回」。
- **画质默认值（本机与所有机器生效）**：`defaultSampler: 'DPM++ 2M'`（同步数下比 A1111 默认的 Euler a 更干净）、`defaultNegative`（调用方没传负面词时补质量底线）、`img2imgDenoising: 0.55`（更贴参考图）；`sd-direct.ps1` 新增 `-Sampler`（默认同为 DPM++ 2M）并写进可复现命令，**复现结果与会话里一致**。
- **出图自检 → 优化循环（违不违规都要做）**：两个生图工具返回新增 `selfCheck` 提醒，技能正文新增「出图自检 → 优化循环」与「图生图画风一致」两节，回复骨架 / 工作流 / 工具描述同步——出图后用 `read_image` 自己看，肢体/水印/构图/风格不合格最多再改 2 轮（每轮只改 1-2 个变量、保留 seed、逐轮贴图）；**图生图**并排对照参考图，按「同源模型 + 风格词入提示词 + denoising 0.30-0.50 + 同尺寸」四步锁画风；**A 档若仍残留违规内容立即重画**，B 档照旧不出图。
- **新增 `sd_inpaint` 蒙版重绘**：只重画画面里一块，字段名逐个对照本机 A1111 源码（`mask` / `mask_blur` / `inpainting_fill` / `inpaint_full_res` / `inpaint_full_res_padding` / `inpainting_mask_invert`）。蒙版二选一：`mask` 蒙版图，或 `maskBox: "x,y,w,h"`——没有蒙版图时**插件手写 PNG 编码器**（zlib + CRC32，零第三方依赖）现场造黑底白块蒙版存进 `ref/`；返回【蒙版重绘】可复现脚本与「接缝/色差/边缘重复/越界误改」自检；`sd-direct.ps1` 新增 `-Mask / -MaskBlur / -InpaintFill / -MaskInvert / -NoFullRes / -InpaintPadding`；技能新增「蒙版重绘」章节（含 A 档可只把违规那块蒙版重画、B 档照旧不出图）。**修复**：`readImageBase64` 恒返回 Promise，漏 `await` 会让 `init_images` 变 `[null]` → 服务端 `'NoneType' has no attribute startswith` 500。
- 新增 `test-install-record.mjs`（BOM 读取 + 自愈专项，不出图、毫秒级）；`acceptance.mjs` 新增第 8 步**真跑一遍脚本**（powershell.exe PS5.1 执行 + uint32 seed 回归）与第 10 步**真实蒙版重绘**（maskBox 造蒙版 → 出图 → 断言脚本带 `-Mask`、蒙版 PNG 合法）；README 补「14 坑排查表」与「必须**新开会话**复验」的验收方法。

## 0.5.0 (portable release)

跨机器可移植发布版——别人安装插件即可使用，无需任何本地适配。

- **SD 目录自动探测**：`sdDir` 默认留空，按「配置 > `DSH_SD_DIR` 环境变量 > `~/.dsh-sd-bridge.json` 自举记录 > 扫盘候选」查找本机 SD WebUI；找不到时工具返回可读的安装指引而不是崩溃。
- **一键自举安装**：新增 `install-sd.ps1`（克隆 WebUI + 下载模型 + 记录安装位置）。
- **工作区化**：`outputDir`/`refDir` 默认改为相对路径（`SD-Picture` / `ref`），解析到会话工作区；`sd-direct.ps1` 同步到「工作区根目录 + SD 目录」，命令注入 `-OutDir`，脚本与插件保存同一目录。
- **文案模板化**：工具描述与 `sd-paint` 技能全文不再写死盘符，注册时按本机配置注入实际路径。
- **全新安装兼容**：venv 尚未创建时不跳过依赖准备、不禁用联网（首次启动可在线安装 torch 等依赖）。
- 测试去硬编码：`smoke-skill.mjs` / `acceptance.mjs` 走自动探测 + 临时工作区，新增可移植性断言。
- `sd-direct.ps1` 的 `-OutDir` 默认改为「当前目录\SD-Picture」（插件生成命令时会显式注入）。

## 0.4.0

- 图生图参考图固化：工作区外的聊天附件自动复制到 `ref/`（按内容哈希命名），脚本引用稳定副本。
- `sd_script` 与生图工具共用同一套固化逻辑。

## 0.3.0

- 违规分流协议（A 档删词出图 / B 档不出图只给合规素体脚本 / 末尾英文违规词清单）与 `sd-paint` 技能。
- `sd_script` 工具：只生成可复现脚本，不调 SD、不出图。
