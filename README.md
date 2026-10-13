# dsh-sd-bridge-guard

[![npm](https://img.shields.io/npm/v/dsh-sd-bridge-guard.svg)](https://www.npmjs.com/package/dsh-sd-bridge-guard)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/savinglighting/dsh-sd-bridge-guard/blob/main/LICENSE)

**DeepSeek Harness 插件 · 本机 Stable Diffusion 生图六件套 + 违规分流协议 · 跨机器零适配**

让 DeepSeek Harness 直接调用你电脑里的 Stable Diffusion WebUI 生图：不用提前打开 SD（首次调用自动以纯 API 模式拉起）、不用改任何路径——装上插件就能用。

| 文生图 | 图生图 |
| --- | --- |
| ![txt2img demo](https://raw.githubusercontent.com/savinglighting/dsh-sd-bridge-guard/main/docs/assets/demo-txt2img.jpg) | ![img2img demo](https://raw.githubusercontent.com/savinglighting/dsh-sd-bridge-guard/main/docs/assets/demo-img2img.jpg) |

## 特性

- **零本地适配**：SD 安装目录自动探测（配置 > 环境变量 `DSH_SD_DIR` > 自举安装记录 > 扫盘候选）；产物、参考图、可复现脚本全部自动落在**当前会话工作区**（`SD-Picture/`、`ref/`、`sd-direct.ps1`）。
- **没装 SD 也能用**：插件找不到 SD 时返回一条可直接运行的安装命令（包内 `install-sd.ps1`），一键装好 WebUI + **AWPainting v1.2 模型 + `vae-ft-mse-840000` VAE + 质量默认配置**并把路径记进 `~/.dsh-sd-bridge.json`，重启即用（模型/VAE 都带 sha256 校验，哈希与画质已验证的本机文件一致）。
- **六个工具**：`sd_txt2img` 文生图、`sd_img2img` 图生图、`sd_inpaint` 蒙版重绘、`sd_script` 只生成可复现脚本不出图、`sd_models` 模型清单、`sd_server` 服务管理。
- **违规分流协议**（`sd-paint` 技能内置）：轻微违规删词后照常出图并附可复现脚本；明显违规不出图、只给合规素体的可复现脚本；回复最末尾列出被剔除的违规提示词英文。
- **可复现**：每次出图返回单行 powershell 脚本（提示词高亮），用户复制整行即可在 PowerShell/cmd 复跑同一张图；脚本**自带服务托管**——SD 没开它自己拉起（首次含模型加载 1-3 分钟）、**跑完自动打开这张图**（`-NoOpen` 关闭）、**任何失败只报一条错误就退出**。
- **服务托管**：SD 没开也能生图——插件自动以 `--api --nowebui` 拉起、复用、可选空闲自动关闭。

## 安装

三种方式任选其一（装完重启 DeepSeek Harness）：

```text
# 1) 在 DSH「设置 → 插件」里粘贴 Git 安装源
github:savinglighting/dsh-sd-bridge-guard

# 2) 或粘贴 npm 包名
dsh-sd-bridge-guard

# 3) 或本地目录（开发者）
dsh plugin add link:D:\path\to\dsh-sd-bridge-guard
```

> DSH 插件暂不支持自动更新：升级需先卸载再安装新版。

## 首次使用

- **已装 SD WebUI**：什么都不用做。插件启动时自动探测（也认 `DSH_SD_DIR` 环境变量与 `cordis.patch.yml` 的 `sdDir` 覆盖）。
- **没装 SD**：让 Harness 帮你画张图，它会返回安装指引；或自己在 PowerShell 跑：

```powershell
powershell -ExecutionPolicy Bypass -File "插件目录\install-sd.ps1"
```

装完重启 DSH。首次生图会在线安装 Python/torch 依赖（10-30 分钟），之后秒级响应。

### install-sd.ps1 参数

脚本先跑**环境预检**（磁盘 ≥15GB → 镜像探活 → git → Python 3.10 → VC++ 运行库，缺啥补啥、每项失败只报一条错即退出，最后打一张就绪清单），再克隆 WebUI、按清单拉资源：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `-Models` | `awpainting` | 模型清单，逗号多选：`awpainting` / `revanimated` / `anythingv5` / `majicmix` / `darksushi`（`none` = 不拉） |
| `-Vaes` | `mse,animevae` | VAE 清单：`mse`（写进 config 默认）/ `animevae` |
| `-Loras` | `add_detail,easynegative,badhandv4` | 常见资源：细节增强 LoRA + 负面嵌入 + 手部修复嵌入（`none` = 不拉） |
| `-Upgrade` | 关 | 已存在文件做 sha 复验、不符重拉；旧版本命中 `Supersedes` 时补拉新版（旧版保留） |
| `-Mirror` | `https://hf-mirror.com` | 填 `""` 用官方源 |
| `-SkipModel` / `-SkipVae` / `-SkipLora` | 关 | 跳过对应类别的下载 |
| `-NoPrereq` / `-SkipVC` / `-SkipDiskCheck` / `-SkipGit` / `-SkipPython` | 关 | 跳过环境预检的全部或某一项 |
| `-NoConfig` | 关 | 不写 `config.json` 质量默认值 |

清单里**每个条目的 sha256 都与本机出图正常的文件逐字节比对过**（HF lfs oid = sha256）；键写错会打印全部可用键。跑完会输出一张「资源清单汇总」表（已下载 / 已存在 / 失败原因）。

> **自己的 LoRA 怎么装**：国内站资源（国风山水、赛博朋克、电商摄影这类）直链不稳，不进默认清单——手动把 `.safetensors` 放进 `<SD目录>\models\Lora\`（Embedding 放 `models\embeddings\`）即可，`sd_models` 能列出来。

## 提供的工具

| 工具 | 作用 |
| --- | --- |
| `sd_txt2img` | 文生图：提示词、负面词、尺寸/步数/CFG/采样器/seed、批次 1-4、临时换 checkpoint、LoRA、hires fix、styles、summary；返回 `script`（【文生图】脚本） |
| `sd_img2img` | 图生图：本地图片路径 + `denoisingStrength` 重绘；工作区外的参考图自动固化到 `ref/`；返回 `script`（【图生图】脚本） |
| `sd_inpaint` | **蒙版重绘（inpaint）**：只改画面里一块（补手/去杂物/局部改色/换背景）。蒙版给 `mask`（白/不透明 = 重绘区）或 `maskBox: "x,y,w,h"`（插件手写 PNG 现场造蒙版存进 `ref/`）；`maskBlur`/`inpaintingFill`/`maskInvert`/`inpaintFullRes+padding` 全可调；返回 `script`（【蒙版重绘】脚本，带 `-Mask`）与接缝自检 `selfCheck` |
| `sd_script` | **只生成可复现脚本，不调 SD、不出图**（`generatesImage` 恒为 false）——明显违规分流专用 |
| `sd_models` | 列出 checkpoints / LoRA / 采样器 / VAE / 当前选项 |
| `sd_server` | `status` / `start` / `stop`；找不到 SD 时 `status` 返回安装指引 |

### 保存与命名

- 产物目录：**会话工作区下的 `SD-Picture/`**（可用 `outputDir` 改成绝对路径）
- 文件名 = **提示词总结_三位序号.png**；`summary` 参数决定文件名，序号自动递增永不覆盖
- 返回 `paths`（绝对路径）、`fileNames`、`savedDir`、`replyImages`（Markdown，贴进回复即全尺寸展示）、`script`（可复现脚本）
- 用户手跑 `sd-direct.ps1` 时，图保存成功后脚本会**自动打开它**；批量跑加 `-NoOpen`

## 违规分流协议（`sd-paint` 技能全文内置）

判定标准 = 模型自己会拒绝执行的尺度，不依赖固定词表。需求里只要有一部分违规就触发分流，不整单拒绝：

- **A 档 · 轻微违规**（删几个词后完全正常）→ 剔除违规片段、照常出图存盘、说明剔除、附脚本、回复最末尾英文违规词清单。
- **B 档 · 明显违规**（露骨/整体性质）→ **一张图都不生成**，只给合规素体的可复现脚本（`sd_script`），末尾同样列英文违规词。

## 配置

**推荐：设置 → 插件 → `sd-bridge`**（全部字段可视化编辑、带中文说明，改完下一个工具调用即生效）。也可在 `cordis.patch.yml` 中按 id `sd-bridge` 覆盖——**patch 层显式指定的键优先级最高，设置面板不会覆盖它们**。

> **面板来自哪**：0.1.x 是插件把 `(ns, schema)` 注册给 settings 服务；**0.2.x 改成了「表单从插件自己的 Config 派生」**（`dsh-settings` 0.2.0-rc.2 的 `SettingsForms` 没有 `register()`），所以插件导出一份 13 字段全 `.volatile()` 的 `Config`，Loader 据此渲染表单，面板改完**不重挂插件**、原地 commit。两条路的代码都在，按宿主版本自动适用。
> 解析不到 `schemastery`（非 DSH 环境、被裁剪的宿主）时 `Config` 导出 `undefined`，退回「只在 `cordis.patch.yml` 里改配置」的老行为，工具与技能不受影响。

优先级：默认值 < 设置面板 < `cordis.patch.yml`。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `sdDir` | `''`（自动探测） | SD WebUI 安装目录；探测顺序：此配置 > `DSH_SD_DIR` > `~/.dsh-sd-bridge.json` > 扫盘候选 |
| `port` | `7860` | API 端口 |
| `autoStart` | `true` | 探测不到 API 时自动启动 |
| `startupTimeoutMs` | `420000` | 等待 SD 就绪的上限（含模型加载） |
| `requestTimeoutMs` | `600000` | 单次生图上限 |
| `idleStopMinutes` | `0` | 空闲 N 分钟后自动关闭插件拉起的 SD（0 = 不关） |
| `extraArgs` | `[]` | 追加给 `launch.py` 的参数（如 `["--medvram"]`） |
| `outputDir` | `'SD-Picture'` | 产物目录；相对路径解析到会话工作区 |
| `refDir` | `'ref'` | 参考图固化目录；相对路径解析到会话工作区 |
| `defaultSampler` | `'DPM++ 2M'` | 未指定采样器时的默认（同步数下比 A1111 默认的 Euler a 更干净）；留空 = 用 SD 默认 |
| `defaultNegative` | 质量底线负面词 | 未传 `negativePrompt` 时自动补上（肢体/水印/低画质）；留空 = 不补 |
| `img2imgDenoising` | `0.55` | 图生图默认重绘幅度，越小越贴参考图（保画风建议显式传 0.30-0.50） |
| `enabled` | `true` | 关掉即不注册工具 |

## 测试

```powershell
npm test                      # = 下面四条不出图的检查（CI 可跑，不需要本机 SD）
node smoke-skill.mjs          # 注册冒烟 + 双分支协议要点 + 可移植性断言（不出图）
node test-install-record.mjs  # 安装记录专项：BOM 读取 + 就地自愈（不出图、毫秒级）
node test-settings.mjs        # 设置面板专项：schema 注册 13 字段 + 面板实时生效 + patch 优先（不出图）
node test-install-catalog.mjs # 安装清单专项：三张清单 sha/源 + 环境预检 + 干跑 + 非法键（不出图）
npm run acceptance            # 真实出图验收：命名、序号、脚本字段、ref 固化（需本机 SD 在跑）
```

环境变量：`DSH_SD_DIR` 指定 SD 目录；`ACCEPTANCE_WS` 指定验收工作区（默认临时目录）。

**验收方法（重要）**：改完插件后**新开一个会话**再画一张图复验——旧会话带着旧工具描述/旧上下文，跑通了也不代表新会话没问题，建议自己多试试。

## 踩坑排查表

| # | 现象 | 根因 | 解法（现状） |
| --- | --- | --- | --- |
| 1 | 写工作区被拒 `grantWrite` | Windows 对工作区目录缺当前用户完全控制权 | 宿主侧 ACL 问题，用 `diagnose-windows-sandbox-acl` 技能一条命令诊断并修复（非插件 bug） |
| 2 | GUI 装插件失败 | 本机无 `git`，`install-sd.ps1` 与部分包管理都要 git | `install-sd.ps1` 自动下 **MinGit 便携版**：GitHub 资源带 `digest` 就先校验 sha256、再 `git --version` 实测，装完写入用户 PATH |
| 3 | `run_in_background` / `timeoutMs` 报错 | **宿主 bug**：数字与布尔被强制转成字符串 | 这两个参数干脆不传，靠 120 秒超时自动转后台 |
| 4 | 无独立 Python | 只有 WindowsApps 商店占位符（本机另有 3.13，而 A1111 在 Windows 只认 3.10） | `install-sd.ps1` 静默装官方 **Python 3.10.6**（用户级 `PrependPath`，sha256 记录），并把 `pythonDir` 写进安装记录，插件 `resolvePython` 兜底用它 |
| 5 | 大文件下载反复停滞/断流 | 网络对单连接限速掐断（单流 ~300KB/s） | `Get-SegmentedFile`：**8 段并行 Range 下载** + 断点续传 + 长度/可选 sha256 校验（实测 4 段下载与单流逐字节一致） |
| 6 | RTX 5060 跑不起来 | Blackwell（sm_120）不支持 A1111 默认 `torch==2.1.2+cu121` | 插件全新安装时探测 `compute_cap ≥ 12` → 自动设 `TORCH_COMMAND`（torch 2.7.0 + torchvision 0.22.0，cu128，本机实测 CUDA 可用） |
| 7 | CLIP 源码构建失败 | 新版 setuptools 移除了 `pkg_resources` | `PIP_CONSTRAINT` 钉 `setuptools==69.5.1`——约束作用到**每一次** pip（含 PEP 517 构建隔离里那次），等于预装 + 免隔离双保险 |
| 8 | pip 在 opencv 上卡死 | 解析器版本回溯（4.14→4.13.0.92→…）反复重下 | `PIP_CONSTRAINT` 钉 `numpy==1.26.2` + `opencv-python==4.11.0.86` 断开回溯，另设 `PIP_RETRIES=10` / `PIP_TIMEOUT=60`；`DSH_SD_PIP_CONSTRAINT=0` 可关 |
| 9 | 环境准备克隆停滞 | `Stability-AI/stablediffusion` **仓库已删除**（GitHub 对已删仓库要求认证） | 本地还没克隆该仓库时自动设 `STABLE_DIFFUSION_REPO` → **camenduru fork**（保留同一 commit `cf1d67a6…`，签名 verified） |
| 10 | 插件读不到 SD 目录、HTTP 500、反复指引重复安装 | 安装记录带 **UTF-8 BOM 头**，裸 `JSON.parse` 遇 BOM 抛错被静默吞掉 → `sdDir` 为空 | 读侧剥 BOM + 字段兜底提取 + **大声记日志** + 读到 BOM 就**就地重写自愈**；写侧用无 BOM UTF-8 并回读校验 `BOM=False`；`test-install-record.mjs` 专项覆盖。**这是唯一影响所有会话的根因** |
| 11 | 离线模式 tokenizer 加载失败 | 插件指向空的 `<SD>\.cache\huggingface` 还强开离线开关；transformers 4.30 与新版 hub 离线查找不兼容 | 只有该缓存**真有 `models--*` 模型**才接管 `HF_HOME` 并离线；缓存为空则不接管、保持联网（`DSH_SD_HF_ONLINE=1` 强制联网） |
| 12 | （测试方法） | 只查文件内容没查字节编码 = 漏判 | 三层测试：`smoke-skill`（不出图）→ `test-install-record`（BOM 专项）→ `acceptance`（真实出图），且**必须新开会话复验** |
| 13 | `.ps1` 一跑就语法错（本次新发现） | `.ps1` 存成 **UTF-8 无 BOM**，Windows PowerShell 5.1 按 GBK 读 → 中文多字节把后面的 `)` `"` 吞掉 | `sd-direct.ps1` / `install-sd.ps1` 固定存 **UTF-8 with BOM**（PS7 也认 BOM）；注意 JSON 记录恰好相反——**JSON 必须无 BOM** |
| 14 | 脚本报 `Cannot convert value "3845143617" to type System.Int32`（本次新发现） | SD 的 seed 是 **uint32**（可到 4294967295），脚本参数写成 `[int]$Seed`，超过 2147483647 就参数转换失败 | `sd-direct.ps1` 的 `-Seed` 改为 `[long]`；`acceptance.mjs` 新增第 8 步：**真跑一遍脚本**（PS5.1 执行 + uint32 seed），BOM/类型问题都会被它拦下 |
| 15 | 别人电脑上跑脚本：`Invoke-RestMethod 无法连接到远程服务器` 之后**连炸 4 条**（本次新发现） | ① 对方机器 SD API 没在跑，而脚本只会连、不会拉起；② 连接失败后没有短路，`$result.images[0]` 空数组 → `WriteAllBytes` 空值 → `ConvertFrom-Json` 空值逐级炸 | `sd-direct.ps1` 先探测 API：**没开就自己把它拉起**（目录按 `-SdDir` > `DSH_SD_DIR` > `~/.dsh-sd-bridge.json` > 各盘常见安装名扫描查找，轮询到就绪，`-NoStart` 关闭、`-StartTimeout` 调超时、日志在 `%TEMP%\dsh-sd-direct-launch.log*`）；端口被别的服务占用、目录/解释器找不到、调用失败、结果没图——**统一走 `Fail` 只报一条错误 + 一行提示就 `exit 1`** |
| 16 | **新拉取 SD 出图质量非常差**（本次新发现） | ① 新装默认模型是 2022 年的 **SD1.5 base**（`v1-5-pruned-emaonly`）+ 默认 VAE + CLIP skip 1，而这台画质好的机器是 **AWPainting v1.2 + `vae-ft-mse-840000` + CLIP skip 2**；② 没有专用 VAE 时画面发灰 | `install-sd.ps1` 默认模型换成 **AWPainting v1.2**（远端 sha256 `3d1b3c42ec…` 与本机出图正常文件**逐字节一致**），补下 mse VAE（`735e4c3a…`），并合并写入 `config.json` 的 `sd_model_checkpoint` / `sd_vae` / `CLIP_stop_at_last_layers=2`（只改点名键、保留其他键、去 BOM、非 UTF-8 老文件按原编码读写、`-NoConfig` 可关）；`sd_models` 检测到只有 base 模型时返回 `qualityHint` 提示升级 |
| 17 | 脚本拉起的 SD 启动卡几分钟（本次新发现） | 脚本没带 `HF_HOME`，transformers 去 `%USERPROFILE%\.cache\huggingface` 找 clip tokenizer，而 SD 缓存在 `<SD>\.cache\huggingface` → 找不到就连 huggingface.co **重试 5 次 × 10s × 多个文件** | `sd-direct.ps1` 启动前按插件同一套规则设 HF 环境：**缓存命中 → `HF_HOME` + 离线加载；未命中 → 保持联网并走 `hf-mirror` 镜像**（`DSH_SD_HF_ONLINE=1` 可强制联网）。实测修复后 **HF 重试 0 次、冷启动到出图 28 秒** |
| 18 | stderr 刷 `Join-Path 找不到驱动器 E:`（本次新发现） | 扫盘时对不存在的盘符也去拼路径 | 先 `Test-Path "E:\"` 跳过不存在的盘；候选路径再包一层 `try/catch`（非法路径跳过不报错） |
| 19 | 改完 `.ps1` 突然全文件语法错（本次新发现） | **编辑工具写回时丢掉 UTF-8 BOM**（PS5.1 无 BOM 按 GBK 读，中文多字节吞掉 `)` `"`） | 改完 `.ps1` 立刻补回 BOM（读首三字节 `EF BB BF`，不是就前插 3 字节），再用 `[Parser]::ParseFile` 解析一遍确认 `SYNTAX OK` |
| 20 | 设置面板没有 sd-bridge 分组（注册代码看着没问题） | 插件以**符号链接**装进 profile node_modules 时，Node 按 realpath 解析依赖 → 裸 `import('@deepseek-ai/schemastery')` 落空，注册被静默跳过 | `tryLoadConfigSchema` 两条途径：裸 import 失败后扫 `~/.dsh/profiles/*/node_modules/.../schemastery/lib/index.mjs` 按绝对路径导入；`test-settings.mjs` 覆盖 |

## 常见问题

- **新装的 SD 出图很差 / 发灰 / 不像样？** 是模型与 VAE，不是提示词：跑一遍 `install-sd.ps1`（会补装 **AWPainting v1.2** + `vae-ft-mse-840000` 并写质量默认配置，已装过 SD 也只会补缺的那部分），或先调 `sd_models`——它检测到只有新装默认的 SD1.5 base 会返回 `qualityHint`；动漫模型记得 CLIP skip = 2。
- **设置里找不到插件配置？** 面板有两种来源：**0.1.x** 靠插件向 settings 注册 schema；**0.2.x** 靠插件导出的 `Config`（13 个字段全 `.volatile()`）+ Loader 投影成表单。旧版插件在 0.2.x 上只会打一条「schemastery/注册跳过」日志、面板不出现（工具照常）——装 0.7.1 及以上即可。若依旧没有，先确认宿主版本与插件版本匹配，再新开一个会话；实在没有就改 `cordis.patch.yml`（见上表，功能完全等价）。
- **想多装几个模型 / 常见 LoRA？** `install-sd.ps1 -Models "awpainting,majicmix" -Loras "add_detail,easynegative,badhandv4"`，键见上文参数表；已有文件会跳过，`-Upgrade` 做 sha 复验并补拉新版。
- **安装时报缺 git / Python / VC++？** 不用手动补——0.7.0 起脚本先跑环境预检，缺啥自举啥（MinGit 便携版、官方 Python 3.10.6、vc_redist），每项失败只报一条错；也可 `-NoPrereq` 跳过整个预检。
- **首次启动很慢？** 加载 checkpoint 约 1-3 分钟（可调大 `startupTimeoutMs`）；全新安装还要先在线装依赖。脚本自己拉起 SD 时会带 HF 缓存/镜像环境，tokenizer 不会去连 huggingface.co 反复重试。
- **模型放哪？** `<SD 目录>\models\Stable-diffusion\`；LoRA 放 `models\Lora\`。名字用 `sd_models` 查。
- **换机器/换盘符？** 不用改任何配置——重新装插件即可，探测与工作区逻辑自动适配。

---

# English

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that drives your local **Stable Diffusion WebUI** (AUTOMATIC1111 API) with six tools — txt2img, img2img, inpaint (mask redraw), script-only (no image), model listing, server management — plus a built-in **content-guard protocol** (mild violations: draw the safe part + reproducible script; explicit requests: no image, compliant-baseline script only).

**Zero local setup**: the SD install directory is auto-detected (`sdDir` config > `DSH_SD_DIR` env > `~/.dsh-sd-bridge.json` install record > drive scan); outputs, reference images and the reproducible script always land in your **session workspace**. No SD installed? The plugin returns a one-line command that runs the bundled `install-sd.ps1` bootstrap — it runs an **environment preflight first** (disk, mirror reachability, git, Python 3.10, VC++ runtime; each missing piece is bootstrapped automatically), then clones WebUI and pulls the selected **model/VAE/LoRA catalog** (`-Models`, `-Vaes`, `-Loras`, `-Upgrade`), every file verified by sha256.

**Install**: paste `github:savinglighting/dsh-sd-bridge-guard` (or the npm name `dsh-sd-bridge-guard`) into DSH *Settings → Plugins*, then restart.

Configuration lives in **Settings → Plugins → `sd-bridge`** (editable live, applied on the next tool call); `cordis.patch.yml` overrides under id `sd-bridge` keep the highest priority — see the table above.

## License

MIT
