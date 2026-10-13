/**
 * dsh-sd-bridge-guard — 本机 Stable Diffusion 生图六件套 + 违规分流协议（v0.7，跨机器可移植）。
 *
 * 目标：用户不需要提前打开 SD WebUI。第一次生图时插件自己把 API 服务拉起来
 * （`python launch.py --api --nowebui --port 7860`，纯 API、不开浏览器、不开 Gradio 页面），
 * 之后所有请求都走 A1111 的 REST 接口 `/sdapi/v1/*`。如果 SD 已经在跑且开了 `--api`，
 * 插件探测到就直接复用，不会重复启动。
 *
 * 可移植性（v0.5 起）：源码不写死任何机器专属路径。
 *   - SD 目录自动探测：配置 > DSH_SD_DIR 环境变量 > ~/.dsh-sd-bridge.json（install-sd.ps1 自举记录）
 *     > 扫盘候选；找不到时工具返回可读的安装指引（跑包内 install-sd.ps1），而不是崩溃。
 *   - 产物/参考图/脚本同步目录全部相对**会话工作区**解析，任何机器装上即用。
 *   - 工具描述与 sd-paint 技能全文在 apply 时按本机配置注入路径（%SD%/%OUT%/%REF%/%DIRECT%）。
 *
 * v0.6（装机 12 坑回填）：
 *   - 坑10 安装记录 BOM：读侧剥 BOM + 字段兜底 + 失败大声记日志 + 读到 BOM 就地自愈重写。
 *   - 坑11 HF 离线：仅当 <SD>\.cache\huggingface 真有 models--* 才接管 HF_HOME 并开离线，空缓存保持联网。
 *   - 坑6/7/8/9 全新安装预置：Blackwell 自动 cu128 torch、PIP_CONSTRAINT 钉 setuptools/numpy/opencv、
 *     上游已删除的 Stability-AI/stablediffusion 自动换 camenduru fork（同 commit，签名 verified）。
 *   - 坑13 sd-direct.ps1 / install-sd.ps1 固定存 UTF-8 **with BOM**（PS5.1 无 BOM 按 GBK 读会语法错）。
 *
 * 六个工具：
 *   sd_txt2img  文生图（支持 checkpoint 临时切换、LoRA 语法、hires fix、批次）
 *   sd_img2img  图生图（本地图片路径 → base64）
 *   sd_inpaint  蒙版重绘（mask 图或 maskBox 现场造蒙版，只改画面里一块）
 *   sd_script   只生成可复现脚本，不碰 SD、不出图（违规分流 B 档专用）
 *   sd_models   列出 checkpoints / LoRA / 采样器 / VAE / 当前选项
 *   sd_server   服务状态 / 启动 / 停止
 *
 * 违规分流协议（两档）：
 *   A 档轻微违规（删几个词后完全正常）：
 *     剔除违规片段 → 照常出图存盘贴图 → 回复说明剔除 → 附 script 脚本 →
 *     回复最末尾列出被剔除违规提示词的英文，注明不能加进脚本/给别人使用。
 *   B 档明显违规（露骨/整体性质）：
 *     **不调生图工具、一张图都不生成** —— 只把原需求译成提示词、提炼出合规素体，
 *     调 sd_script 拿可复现脚本（【文生图】/【图生图】标注）贴进回复，
 *     用户自己运行 sd-direct.ps1 出图并存进要求路径；回复最末尾同样列英文违规词。
 *   判定发生在模型层（skill 行为规范），插件不做过滤词表；sd_script 负责 B 档脚本的
 *   参数转义与格式生成（提示词在 powershell 代码块中高亮成蓝色）。
 *
 * @module dsh-sd-bridge-guard/index.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const name = 'sd-bridge'
export const inject = ['tools']

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)))

/** 本插件版本（读自己的 package.json，读不到就 null）。`sd_server status` 会带出来——排查「改完没生效」时先看它。 */
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version
  } catch {
    return null
  }
})()

const DEFAULTS = {
  /**
   * SD WebUI 安装目录（含 launch.py 与 venv/python）。
   * 留空 = 自动探测：配置覆盖 > 环境变量 DSH_SD_DIR > 自举安装记录（~/.dsh-sd-bridge.json）
   * > 常见目录扫描（各盘根的 SD.4.8 / stable-diffusion-webui 等）。装过 SD 的机器零配置可用。
   */
  sdDir: '',
  /** API 端口；与 SD 默认端口一致，便于复用已打开的服务 */
  port: 7860,
  /** 探测不到 API 时是否由插件自动启动 SD */
  autoStart: true,
  /** 启动 SD 的最长等待（首次还要加载 checkpoint，给足余量） */
  startupTimeoutMs: 420000,
  /** 单次生图请求的最长等待 */
  requestTimeoutMs: 600000,
  /** 空闲多少分钟后自动关掉由本插件拉起的 SD（0 = 不自动关） */
  idleStopMinutes: 0,
  /** 追加给 launch.py 的额外命令行参数（高级项） */
  extraArgs: [],
  /**
   * 生图产物目录：绝对路径原样使用，相对路径解析到**会话工作区**。
   * 默认 `SD-Picture` = 每台机器的工作区下自建 SD-Picture 目录，文件名 = 提示词总结_序号.png。
   */
  outputDir: 'SD-Picture',
  /**
   * 图生图参考图固化目录（相对路径同样解析到会话工作区）：用户给的图若在工作区之外
   * （聊天附件缓存、临时目录……），复制一份到这里，脚本 -InitImage 引用这份稳定副本
   * （内容与用户给的图逐字节一致）；已在工作区内的图原样使用，绝不替换成其他图片。
   */
  refDir: 'ref',
  /** 注册生图工具 */
  enabled: true,
  /**
   * 未显式指定采样器时的默认采样器。`DPM++ 2M` 在同样步数下比 A1111 默认的 Euler a
   * 更干净、收敛更稳（少噪点、少脏线），是本机画质优化的默认项；留空 = 交给 SD 自己的默认。
   * 可用名见 `sd_models`（本机有 DPM++ 2M / DPM++ SDE / Euler a 等）。
   */
  defaultSampler: 'DPM++ 2M',
  /**
   * 未传 negativePrompt 时补的画质底线负面词。留空 = 不补。
   * （调用方经常忘传负面词，空负面 = 肢体崩/糊/带水印都拦不住。）
   */
  defaultNegative:
    'lowres, bad anatomy, bad hands, extra fingers, fewer digits, malformed limbs, watermark, text, signature, jpeg artifacts, worst quality, low quality',
  /**
   * 图生图默认重绘幅度：0.55 比 A1111 默认的 0.6 更贴参考图（画风更稳）。
   * 想最大程度保画风请显式传 0.30-0.50，想彻底重画传 0.70+（见 sd-paint 技能）。
   */
  img2imgDenoising: 0.55,
}

// ---------------------------------------------------------------------------
// SD WebUI 目录探测（可移植性的核心：任何机器零配置找到本机 SD）
// ---------------------------------------------------------------------------

/** 自举安装（install-sd.ps1）把装到哪记在这里，插件下次启动直接读 */
const STATE_FILE = path.join(
  process.env.USERPROFILE || process.env.HOME || process.env.USERPROFILE || '.',
  '.dsh-sd-bridge.json',
)

/** 目录是否是一个可用的 SD WebUI 安装（判据：存在 launch.py） */
function looksLikeSdDir(dir) {
  try {
    return Boolean(dir) && fs.existsSync(path.join(dir, 'launch.py'))
  } catch {
    return false
  }
}

/**
 * 读自举安装记录 `~/.dsh-sd-bridge.json`。
 *
 * 历史故障（12 坑里的第 10 项，也是唯一影响所有会话的根因）：Windows PowerShell 5.1 的
 * `Set-Content -Encoding UTF8` 会写 **UTF-8 BOM 头**，裸 `JSON.parse` 一遇 BOM 就抛错、
 * 又被 catch 吞成「没有安装记录」→ sdDir 为空 → 工具每次都说没装 SD、指引去重复安装；
 * 而且是**静默**失败，第一轮排查只看文件内容、没看字节编码就会漏判。
 *
 * 因此这里做三件事：① 解析前剥 BOM/首尾空白；② 解析失败大声记日志并按字段兜底提取；
 * ③ 发现记录带 BOM 就地重写成规范无 BOM UTF-8（自愈），让任何读取方都不会再踩这个坑。
 *
 * @param {string} [file] 记录路径（测试用覆盖，默认 STATE_FILE）
 * @returns {string} 可用的 SD 目录，找不到/读不出返回 ''
 */
export function readInstallRecord(file = STATE_FILE) {
  let raw
  try {
    raw = fs.readFileSync(file)
  } catch (error) {
    if (error && error.code !== 'ENOENT') log('读取自举安装记录失败：', file, error.message)
    return ''
  }
  const hasBom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
  const text = raw.toString('utf8').replace(/^\uFEFF/, '').replace(/^\s+/, '')
  if (!text.trim()) return ''

  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    log(`自举安装记录解析失败（${error.message}）：${file}——按字段兜底提取 sdDir`)
    const hit = /"sdDir"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
    if (!hit) return ''
    try {
      parsed = JSON.parse(`{"sdDir":"${hit[1]}"}`)
    } catch {
      return ''
    }
  }

  const dir = parsed && typeof parsed.sdDir === 'string' ? parsed.sdDir.replace(/[\\/]+$/, '') : ''
  if (!looksLikeSdDir(dir)) return ''

  if (hasBom) healInstallRecord(file, parsed)
  return dir
}

/** 自愈：把带 BOM 的记录原地重写为规范无 BOM UTF-8（写失败只记日志，不影响本次运行） */
function healInstallRecord(file, parsed) {
  try {
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    log('已自愈带 BOM 的自举安装记录（重写为无 BOM UTF-8）：', file)
  } catch (error) {
    log('自愈自举安装记录失败（不影响本次运行）：', error.message)
  }
}

/**
 * 记录里 install-sd.ps1 自举装出的 Python 目录（坑4：机器上只有 WindowsApps 占位符或
 * 3.11+ 时，A1111 在 Windows 只认 3.10）——只做**兜底**：SD 自带 python/venv 优先。
 */
function statePythonDir() {
  try {
    const text = fs.readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(text)
    const dir = parsed && typeof parsed.pythonDir === 'string' ? parsed.pythonDir.replace(/[\\/]+$/, '') : ''
    const exe = dir ? path.join(dir, 'python.exe') : ''
    return exe && fs.existsSync(exe) ? dir : ''
  } catch {
    return ''
  }
}

/**
 * 探测顺序：显式配置 > 环境变量 DSH_SD_DIR > 自举安装记录 > 扫盘候选目录。
 * 扫盘只做 existsSync（微秒级），候选名有限、不会拖慢插件启动。
 */
function detectSdDir(explicit) {
  const explicitDir = String(explicit || '').replace(/[\\/]+$/, '')
  if (explicitDir) {
    if (looksLikeSdDir(explicitDir)) return explicitDir
    log(`配置的 sdDir 不是 SD WebUI 目录（缺 launch.py）：${explicitDir}，继续自动探测`)
  }
  const fromEnv = String(process.env.DSH_SD_DIR || '').replace(/[\\/]+$/, '')
  if (looksLikeSdDir(fromEnv)) return fromEnv
  const fromRecord = readInstallRecord()
  if (fromRecord) return fromRecord

  const dirNames = [
    'SD.4.8',
    'SD',
    'sd',
    'stable-diffusion-webui',
    'stable-diffusion-webui-master',
    'sd.webui',
    'webui',
    'a1111',
    'sd-webui',
  ]
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const localAppData = process.env.LOCALAPPDATA || ''
  const fixedCandidates = [
    home && path.join(home, 'stable-diffusion-webui'),
    home && path.join(home, 'sd.webui'),
    localAppData && path.join(localAppData, 'stable-diffusion-webui'),
    localAppData && path.join(localAppData, 'Programs'),
    'D:/SD.4.8',
  ]
  for (const candidate of fixedCandidates) {
    if (looksLikeSdDir(candidate)) return path.resolve(candidate).replace(/[\\/]+$/, '')
  }
  // 各盘根目录下的常见安装名
  for (let code = 67; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:/`
    for (const name of dirNames) {
      const candidate = path.join(root, name)
      if (looksLikeSdDir(candidate)) return path.resolve(candidate).replace(/[\\/]+$/, '')
    }
  }
  return ''
}

/** 找不到 SD 时给所有工具统一的可读指引（不抛栈、不静默） */
function installGuidance() {
  const script = path.join(PKG_DIR, 'install-sd.ps1')
  return (
    'sd-bridge: 未找到本机 Stable Diffusion WebUI（配置 sdDir 为空且自动探测无果）。\n' +
    `尚未安装 SD？在 PowerShell 里跑一条命令自动装（WebUI + 模型，约 10-30 分钟）：\n` +
    `powershell -ExecutionPolicy Bypass -File "${script}"\n` +
    '装完重启 DSH 即可；已装过 SD？把路径写进环境变量 DSH_SD_DIR，' +
    '或在 cordis.patch.yml 按 id sd-bridge 覆盖 sdDir。'
  )
}

// ---------------------------------------------------------------------------
// 运行时状态（模块级；插件热重载会重新执行 apply，这里的句柄自然作废）
// ---------------------------------------------------------------------------

const state = {
  child: null,
  startedByUs: false,
  starting: null,
  base: '',
  logTail: [],
  idleTimer: null,
  lastUsedAt: 0,
  /** GPU 探测结果缓存：undefined = 未探测（true = Blackwell） */
  blackwell: undefined,
}

const cfg = { ...DEFAULTS }

function baseUrl() {
  return `http://127.0.0.1:${cfg.port}`
}

function log(...args) {
  try {
    // Cordis 的 logger 是 %s 风格；这里只做原样输出，缺 logger 时退回 console。
    (state.logger ?? console).log?.('[sd-bridge]', ...args)
  } catch {
    /* logging must never break a tool call */
  }
}

function pushLog(chunk) {
  const lines = String(chunk).split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length === 0) return
  state.logTail.push(...lines)
  if (state.logTail.length > 120) state.logTail.splice(0, state.logTail.length - 120)
}

function logTailText() {
  return state.logTail.slice(-25).join('\n')
}

// ---------------------------------------------------------------------------
// HTTP：探测 / 调用
// ---------------------------------------------------------------------------

async function probeApi(timeoutMs = 4000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl()}/sdapi/v1/options`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (res.ok) {
      const text = await res.text()
      try {
        return { kind: 'ready', options: JSON.parse(text) }
      } catch {
        return { kind: 'ready', options: {} }
      }
    }
    return { kind: 'http-error', status: res.status }
  } catch (error) {
    if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
      return { kind: 'timeout' }
    }
    return { kind: 'offline' }
  } finally {
    clearTimeout(timer)
  }
}

async function apiGet(route, timeoutMs = 20000) {
  const res = await fetch(`${baseUrl()}${route}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`SD API GET ${route} 失败：HTTP ${res.status} ${body.slice(0, 400)}`)
  }
  return res.json()
}

async function apiPost(route, payload, timeoutMs) {
  const res = await fetch(`${baseUrl()}${route}`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`SD API POST ${route} 失败：HTTP ${res.status} ${body.slice(0, 800)}`)
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// 服务生命周期
// ---------------------------------------------------------------------------

function resolvePython() {
  const candidates = [
    path.join(cfg.sdDir, 'python', 'python.exe'),
    path.join(cfg.sdDir, 'venv', 'Scripts', 'python.exe'),
    path.join(cfg.sdDir, 'venv', 'bin', 'python'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  // 兜底：install-sd.ps1 自举装的 Python（记录里的 pythonDir），排在 SD 自带 python/venv 之后
  const recorded = statePythonDir()
  if (recorded) return path.join(recorded, 'python.exe')
  return 'python'
}

// ---------------------------------------------------------------------------
// 启动环境：HuggingFace 缓存（坑11）+ 全新安装依赖预置（坑6/7/8/9）
// ---------------------------------------------------------------------------

/** 该 HF 缓存目录里是否**真的**有已下载模型（hub/ 或根下的 models--* 任一） */
function hfCacheHasModels(hfHome) {
  for (const dir of [path.join(hfHome, 'hub'), hfHome]) {
    try {
      if (fs.readdirSync(dir).some((name) => name.startsWith('models--'))) return true
    } catch {
      /* 目录不存在 = 没有缓存 */
    }
  }
  return false
}

/**
 * HuggingFace 环境（坑11：离线模式 tokenizer 加载失败）。
 * 旧逻辑**无条件**把 HF_HOME 指到 `<SD>\.cache\huggingface` 并打开离线开关——那目录是空的时候，
 * transformers 在离线模式下既不会回落在线下载、也找不到 tokenizer，必然报错。
 * 现在先验缓存：本地缓存里真有模型才用它并离线（避免直连 huggingface.co 每文件重试 5×10s 卡死生图）；
 * 缓存为空就**不接管** HF_HOME、不禁用联网，让库走自己的默认缓存正常下载。
 * 想强制联网留了口子：环境变量 DSH_SD_HF_ONLINE=1。
 */
function buildHfEnv(prepared) {
  if (!prepared) return {}
  if (process.env.DSH_SD_HF_ONLINE === '1') return {}
  const localCache = path.join(cfg.sdDir, '.cache', 'huggingface')
  if (!hfCacheHasModels(localCache)) {
    log(`HuggingFace 本地缓存为空（${localCache}），不接管 HF_HOME、保持联网启动`)
    return {}
  }
  return {
    HF_HOME: localCache,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    ...(process.env.HF_ENDPOINT ? {} : { HF_ENDPOINT: 'https://hf-mirror.com' }),
  }
}

/**
 * GPU 是否为 Blackwell（RTX 50 系 / compute_cap ≥ 12，坑6：sm_120 跑不了 A1111 默认的 cu121 torch）。
 * 结果缓存一次；探测失败按「非 Blackwell」处理，绝不影响启动。
 */
function isBlackwellGpu() {
  if (state.blackwell !== undefined) return state.blackwell
  let blackwell = false
  try {
    const res = spawnSync('nvidia-smi', ['--query-gpu=name,compute_cap', '--format=csv,noheader'], {
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf8',
    })
    const line = String((res && res.stdout) || '').split(/\r?\n/)[0].trim()
    if (line) {
      const cap = /(\d+)\.\d+\s*$/.exec(line)
      const rtx = /RTX\s*(\d{4})/i.exec(line)
      const major = cap ? Number(cap[1]) : 0
      blackwell = major >= 12 || (rtx ? Number(rtx[1]) >= 5000 : false)
      log('GPU 探测：', line, '→', blackwell ? 'Blackwell(sm_120)，预置 torch 2.7.0+cu128' : '非 Blackwell，用 A1111 默认 torch')
    }
  } catch (error) {
    log('GPU 探测失败（按非 Blackwell 处理）：', error.message)
  }
  state.blackwell = blackwell
  return blackwell
}

/**
 * 全新安装首次依赖准备用的 pip 约束（坑7/坑8）：
 * - setuptools 69.5.1 —— 新版 setuptools 移除了 `pkg_resources`，CLIP 源码构建直接失败；
 *   约束文件会作用到**每一次** pip（含 PEP 517 构建隔离里那次），等于「预装 + 免隔离」双保险。
 * - numpy / opencv —— 钉住可解析组合，断开 pip 版本回溯（4.14→4.13.0.92→… 反复重下直到卡死）。
 * DSH_SD_PIP_CONSTRAINT=0 可整体关掉（回到 A1111 原生解析行为）。
 */
function writePipConstraints() {
  if (process.env.DSH_SD_PIP_CONSTRAINT === '0') return ''
  try {
    const file = path.join(os.tmpdir(), 'dsh-sd-bridge-pip-constraints.txt')
    const body = [
      '# dsh-sd-bridge-guard 生成：全新安装首次依赖准备的 pip 约束（DSH_SD_PIP_CONSTRAINT=0 关闭）',
      '# 坑7：新版 setuptools 移除 pkg_resources → CLIP 源码构建失败',
      'setuptools==69.5.1',
      '# 坑8：断开 pip 在 opencv/numpy 上的版本回溯',
      'numpy==1.26.2',
      'opencv-python==4.11.0.86',
      '',
    ].join('\n')
    fs.writeFileSync(file, body, 'utf8')
    return file
  } catch (error) {
    log('写 pip 约束文件失败（跳过该优化）：', error.message)
    return ''
  }
}

/**
 * 全新安装（prepare_environment 会跑）时的环境预置：把上一轮装机踩过的坑先挡掉。
 * 成型安装走 `--skip-prepare-environment`，这些变量不会被用到，因此对已跑通的机器零影响。
 */
function buildFreshEnv() {
  const env = {}

  // 坑6：Blackwell 不吃 A1111 默认的 torch==2.1.2+cu121 → 换本机实测可用的 2.7.0+cu128
  //（RTX 5060 / sm_120 实测 torch.cuda.is_available()=True）。用户已设 TORCH_* 则完全尊重。
  if (isBlackwellGpu()) {
    if (!process.env.TORCH_COMMAND) {
      env.TORCH_COMMAND = 'pip install torch==2.7.0 torchvision==0.22.0 --extra-index-url https://download.pytorch.org/whl/cu128'
    }
    if (!process.env.TORCH_INDEX_URL) env.TORCH_INDEX_URL = 'https://download.pytorch.org/whl/cu128'
  }

  // 坑7/坑8：pip 约束 + 更宽容的网络重试
  const constraints = writePipConstraints()
  if (constraints) env.PIP_CONSTRAINT = constraints
  if (!process.env.PIP_RETRIES) env.PIP_RETRIES = '10'
  if (!process.env.PIP_TIMEOUT) env.PIP_TIMEOUT = '60'

  // 坑9：上游 Stability-AI/stablediffusion 已被删除（GitHub 对已删仓库要求认证，克隆停滞）。
  // 本地还没克隆该仓库时换成 camenduru fork——它保留 A1111 要求的同一 commit
  // cf1d67a6fd5ea1aa600c4df58e5b47da45f6bdbf，且该 commit 签名 verified。
  const sdRepoDir = path.join(cfg.sdDir, 'repositories', 'stable-diffusion-stability-ai')
  if (!fs.existsSync(sdRepoDir) && !process.env.STABLE_DIFFUSION_REPO) {
    env.STABLE_DIFFUSION_REPO = 'https://github.com/camenduru/stablediffusion.git'
    log('Stability-AI/stablediffusion 未克隆且上游已删除，改用 camenduru fork（同一 commit，签名可验证）')
  }
  return env
}

/** 组装 spawn 环境：基础项 + HF 缓存（坑11）+ 全新安装预置（坑6/7/8/9） */
function buildLaunchEnv(prepared) {
  return {
    ...process.env,
    GRADIO_ANALYTICS_ENABLED: 'False',
    ...buildHfEnv(prepared),
    ...(prepared ? {} : buildFreshEnv()),
  }
}

function spawnServer() {
  const python = resolvePython()
  const launchPy = path.join(cfg.sdDir, 'launch.py')
  if (!fs.existsSync(launchPy)) {
    throw new Error(installGuidance())
  }
  // 全新安装（venv 尚未创建）时不能跳过环境准备，也不能离线——首次启动要联网装 torch 等依赖
  const prepared = fs.existsSync(path.join(cfg.sdDir, 'venv')) || fs.existsSync(path.join(cfg.sdDir, 'python'))
  const args = [
    launchPy,
    '--api',
    '--nowebui',
    '--port', String(cfg.port),
    ...(prepared ? ['--skip-prepare-environment'] : []),
    '--skip-version-check',
    ...(Array.isArray(cfg.extraArgs) ? cfg.extraArgs : []),
  ]
  log('启动 SD API：', python, args.join(' '))
  const child = spawn(python, args, {
    cwd: cfg.sdDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // 环境变量分三块（buildLaunchEnv）：基础项 / HF 缓存（坑11：空缓存不进离线模式）/
    // 全新安装预置（坑6 Blackwell torch、坑7/8 pip 约束、坑9 已删仓库 fork）
    env: buildLaunchEnv(prepared),
  })
  child.stdout?.on('data', (chunk) => pushLog(chunk))
  child.stderr?.on('data', (chunk) => pushLog(chunk))
  child.on('error', (error) => pushLog(`spawn error: ${error.message}`))
  child.on('exit', (code, signal) => {
    pushLog(`SD 进程退出 code=${code} signal=${signal}`)
    if (state.child === child) {
      state.child = null
      state.startedByUs = false
    }
  })
  state.child = child
  state.startedByUs = true
  return child
}

function stopServer() {
  const child = state.child
  if (!child) {
    return { ok: false, reason: '当前没有由 sd-bridge 拉起的 SD 进程（若 SD 是手动打开的，请手动关闭）' }
  }
  state.child = null
  state.startedByUs = false
  try {
    child.kill()
    return { ok: true, reason: '已发送停止信号' }
  } catch (error) {
    return { ok: false, reason: `停止失败：${error.message}` }
  }
}

/**
 * 保证 API 可用：已在跑就复用；没在跑且允许 autoStart 就启动并等待就绪。
 * 并发调用共享同一个启动 Promise。
 */
async function ensureServer({ allowStart = true } = {}) {
  const probe = await probeApi()
  if (probe.kind === 'ready') {
    state.base = baseUrl()
    touchIdleTimer()
    return probe.options
  }
  if (probe.kind === 'http-error' && probe.status === 401) {
    throw new Error(`sd-bridge: ${baseUrl()} 需要 API 认证（--api-auth），插件当前没有凭据配置`)
  }
  if (probe.kind === 'http-error') {
    throw new Error(
      `sd-bridge: 端口 ${cfg.port} 已被占用，但该服务没有 A1111 API（HTTP ${probe.status}）。` +
      '请换一个端口，或关闭占用进程后重试。',
    )
  }
  if (!allowStart || !cfg.autoStart) {
    throw new Error(`sd-bridge: SD API 未运行（${baseUrl()}），且当前不允许自动启动`)
  }
  if (!cfg.sdDir) {
    // 自动探测无果：给可执行的安装/指向指引，而不是 spawn 一个不存在的 launch.py
    throw new Error(installGuidance())
  }
  if (state.starting) return state.starting

  state.starting = (async () => {
    if (state.child) stopServer()
    spawnServer()
    const deadline = Date.now() + Number(cfg.startupTimeoutMs || DEFAULTS.startupTimeoutMs)
    let lastKind = ''
    while (Date.now() < deadline) {
      if (!state.child) {
        throw new Error(
          `sd-bridge: SD 启动进程提前退出，最近输出：\n${logTailText() || '(无输出)'}`,
        )
      }
      const current = await probeApi(3000)
      if (current.kind === 'ready') {
        state.base = baseUrl()
        log('SD API 就绪')
        touchIdleTimer()
        return current.options
      }
      lastKind = current.kind
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    throw new Error(
      `sd-bridge: 等待 SD API 就绪超时（${Math.round(Number(cfg.startupTimeoutMs) / 1000)}s，最后状态 ${lastKind}），` +
      `最近输出：\n${logTailText() || '(无输出)'}`,
    )
  })().finally(() => {
    state.starting = null
  })
  return state.starting
}

function touchIdleTimer() {
  state.lastUsedAt = Date.now()
  if (state.idleTimer) {
    clearTimeout(state.idleTimer)
    state.idleTimer = null
  }
  const minutes = Number(cfg.idleStopMinutes || 0)
  if (minutes > 0 && state.child && state.startedByUs) {
    state.idleTimer = setTimeout(() => {
      if (Date.now() - state.lastUsedAt >= minutes * 60000) {
        log(`空闲 ${minutes} 分钟，关闭由 sd-bridge 启动的 SD`)
        stopServer()
      }
    }, minutes * 60000)
    state.idleTimer.unref?.()
  }
}

// ---------------------------------------------------------------------------
// 工具公共件
// ---------------------------------------------------------------------------

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

function sessionCwd(exec) {
  const session = exec && exec.agent && exec.agent.session
  const cwd = session && session.header && session.header.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/** 产物目录：绝对路径原样用，相对路径解析到会话工作区（跨机器零适配的关键之一） */
function resolveOutputDir(exec) {
  const cwd = sessionCwd(exec)
  const raw = String(cfg.outputDir || DEFAULTS.outputDir)
  return path.resolve(path.isAbsolute(raw) ? raw : path.resolve(cwd, raw))
}

function multipleOf8(value, fallback) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(64, Math.min(2048, Math.round(n / 8) * 8))
}

function clampInt(value, fallback, min, max) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/**
 * 从图片头解析像素尺寸（PNG / JPEG / WebP / BMP），
 * 让 img2img 在模型没给 width/height 时按原图尺寸重绘，而不是被裁成 512x512。
 */
function imageSizeOf(buffer) {
  try {
    if (buffer.length > 32 && buffer.readUInt32BE(0) === 0x89504e47) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
    }
    if (buffer.length > 30 && buffer.toString('ascii', 0, 2) === 'BM') {
      return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) }
    }
    if (
      buffer.length > 30 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
      const chunk = buffer.toString('ascii', 12, 16)
      if (chunk === 'VP8X') {
        return {
          width: 1 + buffer.readUIntLE(24, 3),
          height: 1 + buffer.readUIntLE(27, 3),
        }
      }
      if (chunk === 'VP8 ') {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff }
      }
      if (chunk === 'VP8L') {
        const bits = buffer.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
    }
    if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1
          continue
        }
        const marker = buffer[offset + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          offset += 2
          continue
        }
        const size = buffer.readUInt16BE(offset + 2)
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
        if (isSof) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
        }
        if (size <= 0) break
        offset += 2 + size
      }
    }
  } catch {
    /* 头解析失败时回退默认值 */
  }
  return null
}

function readImageBase64(exec, rawPath) {
  const input = String(rawPath ?? '').trim()
  if (!input) throw new Error('sd_img2img: init_image 不能为空（本地图片绝对路径或工作区相对路径）')
  const fsService = typeof ctxRef.get === 'function' ? ctxRef.get('fs') : undefined
  const cwd = sessionCwd(exec)
  const localPath = path.isAbsolute(input) ? input : path.resolve(cwd, input)

  const finish = (buffer) => {
    if (!buffer || buffer.length === 0) {
      throw new Error(`sd_img2img: 图片为空或不可读：${localPath}`)
    }
    if (buffer.length > 32 * 1024 * 1024) {
      throw new Error(`sd_img2img: 图片过大（${Math.round(buffer.length / 1048576)}MB），请先缩到 32MB 以内`)
    }
    const ext = path.extname(localPath).toLowerCase()
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.webp' ? 'image/webp' : 'image/png'
    const size = imageSizeOf(buffer)
    // 用户给的那张图若是临时/附件路径，固化成工作区内的稳定副本，脚本 -InitImage 指向它
    const stablePath = stabilizeRefImage(localPath, buffer, cwd)
    return { base64: buffer.toString('base64'), mime, localPath: stablePath, originalPath: localPath, width: size?.width, height: size?.height }
  }

  if (fsService && typeof fsService.resolve === 'function' && typeof fsService.readBytes === 'function') {
    return (async () => {
      try {
        const target = await fsService.resolve(localPath, { cwd })
        const bytes = await fsService.readBytes(target, undefined, 32 * 1024 * 1024)
        return finish(Buffer.from(bytes))
      } catch (error) {
        // 沙箱拒绝时给出可读错误；文件不存在也落到同一分支
        throw new Error(`sd_img2img: 读取图片失败 ${localPath}（${error && error.message ? error.message : error}）`)
      }
    })()
  }
  return Promise.resolve().then(() => finish(fs.readFileSync(localPath)))
}

/**
 * 图生图参考图固化：用户给的那张图若是聊天附件/临时路径（在工作区之外），
 * 复制一份到 cfg.refDir（相对路径解析到会话工作区），脚本与返回值都改用这份稳定副本——
 * 内容与用户给的图逐字节一致（按源文件 sha1 命名，重复上传自动复用同名），
 * 不会随临时目录清理而失效。工作区内的图原样返回，不复制。
 */
function stabilizeRefImage(localPath, buffer, wsRoot) {
  try {
    const root = path.resolve(wsRoot || process.cwd())
    const abs = path.resolve(localPath)
    if (abs.toLowerCase().startsWith(root.toLowerCase() + path.sep) || abs.toLowerCase() === root.toLowerCase()) {
      return abs
    }
    const raw = String(cfg.refDir || DEFAULTS.refDir)
    const refDir = path.resolve(root, path.isAbsolute(raw) ? raw : raw)
    fs.mkdirSync(refDir, { recursive: true })
    const ext = path.extname(abs).toLowerCase() || '.png'
    const base = path.basename(abs, path.extname(abs)).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || 'ref'
    const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 8)
    const target = path.join(refDir, `${base}_${hash}${ext}`)
    if (!fs.existsSync(target)) fs.writeFileSync(target, buffer)
    log('参考图已固化 →', target, `（源：${abs}）`)
    return target
  } catch (error) {
    // 固化失败不致命：退回原路径，脚本仍指向用户给的那张图
    log('参考图固化失败（沿用原路径）：', error && error.message ? error.message : error)
    return localPath
  }
}

// ---------------------------------------------------------------------------
// 蒙版（inpaint）：maskBox → 手搓一张「黑底白块」灰度 PNG，交给 SD 当蒙版
// （不引第三方图像库：PNG = 签名 + IHDR + IDAT(deflate) + IEND，各自带 CRC32）
// ---------------------------------------------------------------------------

const PNG_CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function pngCrc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = PNG_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

/** 解析 maskBox："x,y,w,h" / [x,y,w,h] / {x,y,width,height}（相对左上角的像素） */
function parseMaskBox(raw, boxWidth, boxHeight) {
  let x
  let y
  let w
  let h
  if (Array.isArray(raw)) {
    ;[x, y, w, h] = raw.map(Number)
  } else if (raw && typeof raw === 'object') {
    x = Number(raw.x)
    y = Number(raw.y)
    w = Number(raw.width ?? raw.w)
    h = Number(raw.height ?? raw.h)
  } else {
    const parts = String(raw)
      .split(/[\s,;:]+/)
      .filter((s) => s !== '')
      .map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      throw new Error(`sd_inpaint: maskBox 格式应为 "x,y,w,h"（相对图像左上角的像素），收到：${JSON.stringify(raw)}`)
    }
    ;[x, y, w, h] = parts
  }
  if (![x, y, w, h].every((n) => Number.isFinite(n))) {
    throw new Error(`sd_inpaint: maskBox 含非数字：${JSON.stringify(raw)}`)
  }
  const x0 = Math.max(0, Math.round(x))
  const y0 = Math.max(0, Math.round(y))
  const x1 = Math.min(boxWidth, x0 + Math.round(w))
  const y1 = Math.min(boxHeight, y0 + Math.round(h))
  if (x1 <= x0 || y1 <= y0) {
    throw new Error(
      `sd_inpaint: maskBox 落在图像外（图像 ${boxWidth}x${boxHeight}，收到 x=${x} y=${y} w=${w} h=${h}）`,
    )
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** 生成黑底白矩形的 8bit 灰度 PNG（白 = 重绘区），尺寸与出图尺寸一致 */
function makeBoxMaskPng(width, height, box) {
  const stride = width + 1 // 每行首字节是 PNG 过滤器标记（0）
  const raw = Buffer.alloc(stride * height) // 全 0 = 过滤器 0 + 黑像素
  for (let row = box.y; row < box.y + box.h; row += 1) {
    const from = row * stride + 1 + box.x
    raw.fill(0xff, from, from + box.w)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 0 // color type: grayscale
  const idat = zlib.deflateSync(raw, { level: 6 })
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** 生成的蒙版落到工作区 ref/，可复现脚本的 -Mask 就指向它 */
function saveGeneratedMask(exec, png, tag) {
  const root = path.resolve(sessionCwd(exec))
  const raw = String(cfg.refDir || DEFAULTS.refDir)
  const refDir = path.resolve(root, raw)
  fs.mkdirSync(refDir, { recursive: true })
  const file = path.join(refDir, `mask_${tag}.png`)
  fs.writeFileSync(file, png)
  log('蒙版已生成 →', file)
  return file
}

/** 把 A1111 返回的 base64 图片落盘 + 挂附件，构造统一返回值。 */async function materializeImages(exec, images, meta) {
  // 统一成 Windows 原生反斜杠绝对路径，回复里的 Markdown 路径才稳定可渲染
  const dir = resolveOutputDir(exec)
  fs.mkdirSync(dir, { recursive: true })

  const summary = sanitizeSummary(meta.summary || meta.prompt || 'sd')
  const base = nextSequence(dir, summary)
  const total = images.length

  const paths = []
  const fileNames = []
  const attachments = []
  const replyImages = []
  const attachmentsService = typeof ctxRef.get === 'function' ? ctxRef.get('attachments') : undefined

  let index = 0
  for (const b64 of images) {
    index += 1
    const buffer = Buffer.from(b64, 'base64')
    const seq = total > 1 ? `${base + index - 1}` : `${base}`
    const fileName = `${summary}_${String(seq).padStart(3, '0')}.png`
    const file = path.join(dir, fileName)
    fs.writeFileSync(file, buffer)
    paths.push(file)
    fileNames.push(fileName)
    replyImages.push(`![${summary}](<${file}>)`)
    if (attachmentsService && typeof attachmentsService.saveImage === 'function') {
      try {
        const ref = await attachmentsService.saveImage({ data: buffer, mediaType: 'image/png', name: summary })
        attachments.push(ref)
      } catch (error) {
        log('附件保存失败（不影响出图）：', error && error.message ? error.message : error)
      }
    }
  }
  return { paths, fileNames, dir, attachments, replyImages }
}

/**
 * 提示词总结 → 文件名安全片段：去掉路径/Windows 非法字符与标签权重语法，
 * 取前几个关键词拼成 12-24 字的短标题（中英文均可）。
 */
function sanitizeSummary(raw) {
  let text = String(raw ?? '')
    .replace(/<lora:[^>]*>/gi, ' ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[,，;；:：!！?？"'“”‘’\\\/\*\?<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) text = 'sd'
  // 优先按逗号切分的标签取前 4 个有意义词，保证「总结」而不是整段提示词
  const tokens = text.split(' ').filter((t) => t && !/^(and|the|of|a|an|with|in|on)$/i.test(t))
  text = tokens.slice(0, 4).join(' ')
  text = text.slice(0, 30).replace(/[.\s]+$/, '')
  // Windows 文件名非法字符兜底
  text = text.replace(/[\\/:*?"<>|]/g, '').trim()
  return text || 'sd'
}

/** 为「总结_NNN」找下一个可用序号（扫描目录里同名前缀的最大编号 +1）。 */
function nextSequence(dir, summary) {
  let max = 0
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return 1
  }
  const re = new RegExp(`^${escapeRegExp(summary)}_(\\d{1,6})\\.png$`, 'i')
  for (const entry of entries) {
    const match = re.exec(entry)
    if (match) {
      const n = Number.parseInt(match[1], 10)
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return max + 1
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function presentOutput(value) {
  const { attachments, ...rest } = value
  const blocks = [{ type: 'text', text: JSON.stringify(rest) }]
  for (const attachment of attachments || []) {
    blocks.push({ type: 'image', attachment })
  }
  return blocks
}

// ---------------------------------------------------------------------------
// 违规分流协议：可复现脚本（sd-direct.ps1）生成
// ---------------------------------------------------------------------------

/**
 * 自愈：把包内附带的 sd-direct.ps1 同步到「当前工作区根目录」与「SD 目录」两处。
 * 命令里用哪条路径由 resolveDirectPath 按会话工作区决定；同步过的工作区记在缓存里，
 * 避免每次生图都重复读盘比对。任一目标缺失或内容过期时覆盖，保证两条路径都能直接跑。
 */
const syncedRoots = new Set()

function syncDirectScripts(wsRoot) {
  const source = path.join(PKG_DIR, 'sd-direct.ps1')
  let body
  try {
    body = fs.readFileSync(source)
  } catch (error) {
    log('包内 sd-direct.ps1 缺失，跳过同步：', error && error.message ? error.message : error)
    return
  }
  const root = path.resolve(wsRoot || process.cwd())
  const targets = [path.join(root, 'sd-direct.ps1')]
  if (cfg.sdDir) targets.push(path.join(cfg.sdDir, 'sd-direct.ps1'))
  let allOk = true
  for (const target of targets) {
    try {
      let same = false
      try {
        same = fs.readFileSync(target).equals(body)
      } catch {
        same = false
      }
      if (same) continue
      fs.writeFileSync(target, body)
      log('已同步 sd-direct.ps1 →', target)
    } catch (error) {
      allOk = false
      log('同步 sd-direct.ps1 失败（不影响工具）：', target, error && error.message ? error.message : error)
    }
  }
  if (allOk) syncedRoots.add(root)
}

/** 命令里的脚本路径 = 当前工作区根目录下的 sd-direct.ps1（绝对路径，单行命令可直接复制运行） */
function directPathFor(wsRoot) {
  const root = path.resolve(wsRoot || process.cwd())
  if (!syncedRoots.has(root)) syncDirectScripts(root)
  return path.join(root, 'sd-direct.ps1')
}

/** 文本 → powershell 双引号字符串字面量（PowerShell 用反引号转义 ` " $） */
function psQuote(text) {
  return (
    '"' +
    String(text ?? '')
      .replace(/`/g, '``')
      .replace(/"/g, '`"')
      .replace(/\$/g, '`$') +
    '"'
  )
}

/**
 * 生成与本次调用等价的 sd-direct.ps1 命令行，供模型原样贴进回复的
 * ```powershell 代码块（宿主会把字符串高亮成蓝色）。
 * 命令恒为**单行完整命令**：以 `powershell -ExecutionPolicy Bypass -File "..."` 开头，
 * 复制整行到 PowerShell / cmd 都能直接跑——不给这个前缀，用户裸跑 .ps1 会被执行策略拦，
 * 写成 `& "路径"` 又容易被模型自造路径（历史故障：模型猜出不存在的 skills\...\sd-direct.ps1）。
 * 脚本路径与输出目录都由插件注入，与本次会话工作区一致，用户机器无需任何本地适配。
 * mode：'文生图' | '图生图'
 */
function buildCommand(mode, opts, directPath, outDir) {
  const parts = ['powershell', '-ExecutionPolicy', 'Bypass', '-File', psQuote(directPath), '-Prompt', psQuote(opts.prompt)]
  if (opts.negative) parts.push('-Negative', psQuote(opts.negative))
  const usesInitImage = mode === '图生图' || mode === '蒙版重绘'
  if (usesInitImage) {
    if (opts.initImage) parts.push('-InitImage', psQuote(opts.initImage))
    if (opts.denoising !== undefined) parts.push('-Denoising', String(opts.denoising))
  }
  if (mode === '蒙版重绘') {
    if (opts.mask) parts.push('-Mask', psQuote(opts.mask))
    if (opts.maskBlur !== undefined) parts.push('-MaskBlur', String(opts.maskBlur))
    if (opts.inpaintingFill !== undefined) parts.push('-InpaintFill', String(opts.inpaintingFill))
    if (opts.maskInvert) parts.push('-MaskInvert')
    if (opts.inpaintFullRes === false) parts.push('-NoFullRes')
    if (opts.padding !== undefined) parts.push('-InpaintPadding', String(opts.padding))
  }
  parts.push('-Width', String(opts.width), '-Height', String(opts.height))
  if (opts.steps !== undefined) parts.push('-Steps', String(opts.steps))
  if (opts.sampler) parts.push('-Sampler', psQuote(opts.sampler))   // 采样器显式带上，复现才一致
  if (Number.isFinite(opts.seed) && opts.seed >= 0) parts.push('-Seed', String(opts.seed))
  if (outDir) parts.push('-OutDir', psQuote(outDir))
  if (mode === '文生图' && opts.name) parts.push('-Name', psQuote(opts.name))
  return parts.join(' ')
}

/** 脚本块上方的模式标注 + 代码块，模型直接贴进回复。 */
function commandBlock(mode, command) {
  return {
    mode,
    command,
    asMarkdown:
      '【' + mode + '】\n```powershell\n' +
      '# 复制下面整行到 PowerShell / cmd 直接运行（已含 powershell -ExecutionPolicy Bypass 前缀，勿拆行、勿改成 & "路径" 调用；跑完保存后会**自动打开这张图**，加 -NoOpen 可关）\n' +
      command +
      '\n```',
  }
}

// apply() 里赋值，工具闭包通过它拿 Context（避免把 ctx 传得到处都是）
const ctxRef = { get: undefined }

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const txt2imgTool = {
  name: 'sd_txt2img',
  description:
    '用本机 Stable Diffusion 文生图（SD 目录：%SD%）。SD 未提前打开也没关系：第一次调用会自动启动 API 服务（首次约需 1-3 分钟，含模型加载），之后秒级响应。' +
    'prompt 用英文标签风格效果最好（如 "1girl, silver hair, school uniform, cherry blossoms, masterpiece, best quality"），负面提示写进 negativePrompt。' +
    '想换模型用 checkpoint 参数（先调 sd_models 看可用名）；LoRA 直接写在 prompt 里，语法 <lora:名称:权重>。' +
    '图片固定保存到 %OUT%，文件名 = summary（提示词总结）+ 三位序号，如 银发少女樱花_001.png；' +
    '请务必传 summary（3-15 字中文概括），留空会自动从 prompt 取前几个英文词。' +
    '返回 JSON：paths 为落盘绝对路径，fileNames 为文件名，replyImages 是可直接粘进回复的 Markdown 图片语法，attachments 是工具卡片缩略图；' +
    'script 是违规分流协议要求的可复现脚本：把 asMarkdown 原样贴进回复（含【文生图】标注 + powershell 代码块，提示词会高亮成蓝色）。' +
    '代码块里是一条**单行完整命令**（以 powershell -ExecutionPolicy Bypass -File 开头），用户复制整行即可运行；脚本自带**自动拉起 SD**（API 没开它自己启动，首次含模型加载 1-3 分钟；失败只报一条错误就退出，不级联刷屏），跑完保存后会**自动打开那张图**（不想弹窗就在命令末尾加 -NoOpen）。' +
    '不要把它改写成 `& "路径"` 形式、不要拆成多行、不要自己替换脚本路径。' +
    '出图后必须把 replyImages 原样贴进你的可见回复（一行一张），宿主会全尺寸渲染，用户即可在聊天窗口直接看到图；不要只依赖工具卡片。' +
    '**拿到图后还要用 read_image 自己看一遍**（返回里的 `selfCheck` 就是提醒）：肢体/水印/构图/风格不合格就按 sd-paint 技能「出图自检 → 优化循环」最多再改 2 轮、每轮贴图说明改了什么；**违规图同样要自检**，画面里若仍残留被剔除的违规内容立即重画，绝不贴出。' +
    '若提示词里有被你判定违规、已剔除的部分，先分叉：' +
    '**轻微违规**（删几个词后完全正常）→ 照常用本工具出图存盘，回复里说明有违规内容被剔除，' +
    '并在回复最末尾把被剔除的违规提示词译成英文单独列出，注明不能加进脚本、不能给别人使用；' +
    '**明显违规**（露骨/整体性质，你不会自己出图）→ 不要调本工具、不生成任何图片，改调 sd_script 只给合规素体的可复现脚本，' +
    '同样在回复最末尾列出被剔除的违规提示词英文并注明不能加进脚本、不能给别人使用。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '英文标签式正向提示词' },
      negativePrompt: { type: 'string', description: '负向提示词，如 lowres, bad anatomy, bad hands, watermark' },
      width: { type: 'integer', description: '宽度（8 的倍数，默认 512）' },
      height: { type: 'integer', description: '高度（8 的倍数，默认 768）' },
      steps: { type: 'integer', description: '采样步数，默认 22' },
      cfgScale: { type: 'number', description: '提示词相关度 CFG，默认 7' },
      samplerName: { type: 'string', description: '采样器名，留空用插件默认 DPM++ 2M（比 Euler a 更干净）；可用名见 sd_models' },
      seed: { type: 'integer', description: '随机种子，-1 = 随机；复现同一张图时填上次返回的 seed' },
      batchSize: { type: 'integer', description: '一次生成几张（1-4，默认 1）' },
      checkpoint: { type: 'string', description: '临时使用的模型（checkpoint）名称，仅本次生效' },
      lora: { type: 'string', description: '要注入的 LoRA 片段，如 "xxx:0.8"；会拼进 prompt，等价于自行写 <lora:xxx:0.8>"' },
      restoreFaces: { type: 'boolean', description: '启用面部修复（ADetailer/GFPGAN），默认 false' },
      enableHiresFix: { type: 'boolean', description: '启用 hires fix 高分辨率修复，默认 false' },
      hiresScale: { type: 'number', description: 'hires fix 放大倍率，默认 2' },
      styles: { type: 'array', items: { type: 'string' }, description: '使用的 SD 预设风格名（WebUI 里的 styles）' },
      summary: {
        type: 'string',
        description: '提示词总结：3-15 字概括这张图（用于文件命名，如"银发少女樱花"）；留空自动从 prompt 提取前几个关键词',
      },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        paths: { type: 'array', items: { type: 'string' } },
        fileNames: { type: 'array', items: { type: 'string' } },
        savedDir: { type: 'string' },
        replyImages: { type: 'array', items: { type: 'string' } },
        seed: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        elapsedMs: { type: 'integer' },
        info: { type: 'string' },
        script: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['文生图', '图生图'] },
            command: { type: 'string' },
            asMarkdown: { type: 'string' },
          },
          description:
            '违规分流协议的可复现脚本；asMarkdown 含【文生图】标注与 powershell 代码块（单行完整命令，powershell -ExecutionPolicy Bypass -File 开头），原样贴进回复',
        },
        selfCheck: {
          type: 'string',
          description: '出图自检提醒：用 read_image 看图并按「出图自检 → 优化循环」最多再改 2 轮，违不违规都要做',
        },
      },
    },
    render: (_args, value) => presentOutput(value),
  },
  async execute(args, exec) {
    const startedAt = Date.now()
    await ensureServer()

    // 画质默认：调用方没给负面词/采样器时用本机验证过的默认值（而不是 SD 的裸默认）
    const sampler = String(args.samplerName ?? '').trim() || String(cfg.defaultSampler ?? '').trim()
    const negative = String(args.negativePrompt ?? '').trim() || String(cfg.defaultNegative ?? '').trim()

    const payload = {
      prompt: String(args.prompt ?? ''),
      negative_prompt: negative,
      width: multipleOf8(args.width, 512),
      height: multipleOf8(args.height, 768),
      steps: clampInt(args.steps, 22, 1, 150),
      cfg_scale: Number.isFinite(Number(args.cfgScale)) ? Number(args.cfgScale) : 7,
      seed: Number.isFinite(Number(args.seed)) ? Math.trunc(Number(args.seed)) : -1,
      batch_size: clampInt(args.batchSize, 1, 1, 4),
      n_iter: 1,
      save_images: false,
      restore_faces: args.restoreFaces === true,
      ...(sampler ? { sampler_name: sampler } : {}),
      ...(String(args.checkpoint ?? '').trim() !== ''
        ? {
            override_settings: { sd_model_checkpoint: String(args.checkpoint).trim() },
            override_settings_restore_afterwards: true,
          }
        : {}),
      ...(args.enableHiresFix === true
        ? {
            enable_hr: true,
            hr_scale: Number.isFinite(Number(args.hiresScale)) ? Number(args.hiresScale) : 2,
            hr_second_pass_steps: 0,
          }
        : {}),
      ...(Array.isArray(args.styles) && args.styles.length > 0
        ? { styles: args.styles.map((s) => String(s)) }
        : {}),
    }

    // LoRA 片段拼进 prompt（A1111 的 extra networks 语法）
    const lora = String(args.lora ?? '').trim().replace(/^<lora:|>$/g, '')
    if (lora) payload.prompt = `<lora:${lora}> ${payload.prompt}`

    const data = await apiPost('/sdapi/v1/txt2img', payload, Number(cfg.requestTimeoutMs))
    const images = Array.isArray(data.images) ? data.images : []
    if (images.length === 0) {
      throw new Error(`sd_txt2img: SD 没有返回图片。info=${String(data.info ?? '').slice(0, 400)}`)
    }

    let seed = payload.seed
    let infoText = ''
    try {
      const info = typeof data.info === 'string' ? JSON.parse(data.info) : data.info
      infoText = typeof data.info === 'string' ? data.info : JSON.stringify(info)
      if (info && Number.isFinite(Number(info.seed))) seed = Number(info.seed)
    } catch {
      infoText = String(data.info ?? '')
    }

    const { paths, fileNames, dir, attachments, replyImages } = await materializeImages(exec, images, {
      seed,
      summary: args.summary,
      prompt: payload.prompt,
    })
    touchIdleTimer()
    const script = commandBlock(
      '文生图',
      buildCommand(
        '文生图',
        {
          prompt: payload.prompt,
          negative: payload.negative_prompt,
          width: payload.width,
          height: payload.height,
          steps: payload.steps,
          seed,
          sampler: payload.sampler_name || '',
          name: String(args.summary || 'direct'),
        },
        directPathFor(sessionCwd(exec)),
        resolveOutputDir(exec),
      ),
    )
    return {
      ok: true,
      paths,
      fileNames,
      savedDir: dir,
      replyImages,
      attachments,
      seed,
      width: payload.width,
      height: payload.height,
      elapsedMs: Date.now() - startedAt,
      info: infoText.slice(0, 1500),
      script,
      selfCheck:
        '出图自检（**不管违不违规都要做**）：用 read_image 打开 paths[0] 自己看一遍——肢体/手指/面部是否崩、有无水印与残留文字、' +
        '构图是否把主体切掉、风格是否符合需求。不合格就按 sd-paint 技能「出图自检 → 优化循环」最多再改 2 轮（每轮只改 1-2 个变量、保留 seed），' +
        '每一轮的图都要贴出来并说明改了什么；两轮仍不行就如实说明卡在哪。',
      hint:
        '图片已保存并作为附件展示。请把 replyImages 里的 Markdown 原样贴进你的可见回复（一行一张），' +
        '宿主会把绝对路径渲染成全尺寸图片，用户即可在聊天窗口直接看到图。' +
        '另外把 script.asMarkdown 也原样贴进回复：它是可复现的 powershell 脚本，带【文生图】标注，提示词会高亮成蓝色。',
    }
  },
}

const img2imgTool = {
  name: 'sd_img2img',
  description:
    '用本机 Stable Diffusion 图生图：给一张本地图片（绝对路径或工作区相对路径）+ 提示词，按 denoisingStrength 重绘。' +
    'init_image 就是**用户给出的那一张**参考图，原样传路径即可——图在工作区之外时插件自动复制到 %REF% 供脚本长期引用（返回 source/sourceOriginal 说明实际用了哪份）。' +
    'SD 未提前打开也没关系，会自动启动。denoisingStrength 越小越像原图（0.3 微调/上色），越大改动越大（0.75 基本重画）。' +
    '图片固定保存到 %OUT%，文件名 = summary（提示词总结）+ 三位序号；请务必传 summary。' +
    '返回 JSON：paths 为输出 PNG 绝对路径，fileNames 为文件名，replyImages 必须原样贴进可见回复以在聊天窗口展示图片；' +
    '**出图后用 read_image 同时打开参考图与结果图并排对照**（返回里的 `selfCheck` 就是提醒）：按 sd-paint 技能「图生图画风一致」清单检查线条/上色/光影/氛围，不像就降 denoising（保画风 0.30-0.50）或把参考图风格词写进提示词，最多再改 2 轮；**违规图同样要自检**，残留被剔除的违规内容立即重画。' +
    'script 是违规分流协议要求的可复现脚本：把 asMarkdown 原样贴进回复（含【图生图】标注 + powershell 代码块，提示词会高亮成蓝色）。' +
    '代码块里是一条**单行完整命令**（以 powershell -ExecutionPolicy Bypass -File 开头），用户复制整行即可运行；脚本自带**自动拉起 SD**（API 没开它自己启动，首次含模型加载 1-3 分钟；失败只报一条错误就退出，不级联刷屏），跑完保存后会**自动打开那张图**（不想弹窗就在命令末尾加 -NoOpen）。' +
    '不要把它改写成 `& "路径"` 形式、不要拆成多行、不要自己替换脚本路径。' +
    '若提示词里有被你判定违规、已剔除的部分，先分叉：' +
    '**轻微违规**（删几个词后完全正常）→ 照常用本工具出图存盘，回复里说明有违规内容被剔除，' +
    '并在回复最末尾把被剔除的违规提示词译成英文单独列出，注明不能加进脚本、不能给别人使用；' +
    '**明显违规**（露骨/整体性质，你不会自己出图）→ 不要调本工具、不生成任何图片，改调 sd_script 只给合规素体的可复现脚本，' +
    '同样在回复最末尾列出被剔除的违规提示词英文并注明不能加进脚本、不能给别人使用。',
  parameters: {
    type: 'object',
    properties: {
      init_image: {
        type: 'string',
        description:
          '输入图片路径（png/jpg/webp，绝对或相对工作区）——**就是用户给的那一张**（聊天附件/本地图都行）。' +
          '若它在工作区之外（如聊天附件临时路径），插件会自动复制一份到 %REF% 供脚本长期引用，原图内容不变',
      },
      prompt: { type: 'string', description: '英文标签式正向提示词' },
      negativePrompt: { type: 'string', description: '负向提示词' },
      denoisingStrength: { type: 'number', description: '重绘幅度 0-1，默认 0.55（更贴参考图）；保画风传 0.30-0.50，彻底重画 0.70+' },
      width: { type: 'integer', description: '输出宽度（8 的倍数，默认跟随输入宽）' },
      height: { type: 'integer', description: '输出高度（8 的倍数，默认跟随输入高）' },
      steps: { type: 'integer', description: '采样步数，默认 22' },
      cfgScale: { type: 'number', description: 'CFG，默认 7' },
      samplerName: { type: 'string', description: '采样器名，留空用默认' },
      seed: { type: 'integer', description: '随机种子，-1 = 随机' },
      checkpoint: { type: 'string', description: '临时使用的模型名称，仅本次生效' },
      summary: {
        type: 'string',
        description: '提示词总结：3-15 字概括（用于文件命名）；留空自动从 prompt 提取关键词',
      },
    },
    required: ['init_image', 'prompt'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        paths: { type: 'array', items: { type: 'string' } },
        fileNames: { type: 'array', items: { type: 'string' } },
        savedDir: { type: 'string' },
        replyImages: { type: 'array', items: { type: 'string' } },
        source: { type: 'string', description: '实际使用的参考图（图生图脚本 -InitImage 指向它）' },
        sourceOriginal: { type: 'string', description: '用户原始给出的图片路径' },
        seed: { type: 'integer' },
        elapsedMs: { type: 'integer' },
        script: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['文生图', '图生图'] },
            command: { type: 'string' },
            asMarkdown: { type: 'string' },
          },
          description:
            '违规分流协议的可复现脚本；asMarkdown 含【图生图】标注与 powershell 代码块（单行完整命令，powershell -ExecutionPolicy Bypass -File 开头），原样贴进回复',
        },
        selfCheck: {
          type: 'string',
          description: '图生图自检提醒：与参考图并排对照画风，按「图生图画风一致」最多再改 2 轮，违不违规都要做',
        },
      },
    },
    render: (_args, value) => presentOutput(value),
  },
  async execute(args, exec) {
    const startedAt = Date.now()
    const source = await readImageBase64(exec, args.init_image)
    await ensureServer()

    const outWidth = multipleOf8(args.width, source.width || 512)
    const outHeight = multipleOf8(args.height, source.height || 768)

    // 画质/画风默认：采样器与负面词补默认；重绘幅度默认 0.55（比 0.6 更贴参考图）
    const sampler = String(args.samplerName ?? '').trim() || String(cfg.defaultSampler ?? '').trim()
    const negative = String(args.negativePrompt ?? '').trim() || String(cfg.defaultNegative ?? '').trim()
    const denoisingArg = Number(args.denoisingStrength)
    const denoising = Number.isFinite(denoisingArg)
      ? Math.max(0.05, Math.min(1, denoisingArg))
      : Math.max(0.05, Math.min(1, Number(cfg.img2imgDenoising) || 0.55))

    const payload = {
      init_images: [source.base64],
      prompt: String(args.prompt ?? ''),
      negative_prompt: negative,
      denoising_strength: denoising,
      width: outWidth,
      height: outHeight,
      resize_mode: 0,
      steps: clampInt(args.steps, 22, 1, 150),
      cfg_scale: Number.isFinite(Number(args.cfgScale)) ? Number(args.cfgScale) : 7,
      seed: Number.isFinite(Number(args.seed)) ? Math.trunc(Number(args.seed)) : -1,
      batch_size: 1,
      n_iter: 1,
      save_images: false,
      ...(sampler ? { sampler_name: sampler } : {}),
      ...(String(args.checkpoint ?? '').trim() !== ''
        ? {
            override_settings: { sd_model_checkpoint: String(args.checkpoint).trim() },
            override_settings_restore_afterwards: true,
          }
        : {}),
    }

    const data = await apiPost('/sdapi/v1/img2img', payload, Number(cfg.requestTimeoutMs))
    const images = Array.isArray(data.images) ? data.images : []
    if (images.length === 0) {
      throw new Error(`sd_img2img: SD 没有返回图片。info=${String(data.info ?? '').slice(0, 400)}`)
    }

    let seed = payload.seed
    try {
      const info = typeof data.info === 'string' ? JSON.parse(data.info) : data.info
      if (info && Number.isFinite(Number(info.seed))) seed = Number(info.seed)
    } catch {
      /* info 解析失败不致命 */
    }

    const { paths, fileNames, dir, attachments, replyImages } = await materializeImages(exec, images, {
      seed,
      summary: args.summary,
      prompt: payload.prompt,
    })
    touchIdleTimer()
    const script = commandBlock(
      '图生图',
      buildCommand(
        '图生图',
        {
          prompt: payload.prompt,
          negative: payload.negative_prompt,
          initImage: source.localPath,
          denoising: payload.denoising_strength,
          width: outWidth,
          height: outHeight,
          steps: payload.steps,
          seed,
          sampler: payload.sampler_name || '',
        },
        directPathFor(sessionCwd(exec)),
        resolveOutputDir(exec),
      ),
    )
    return {
      ok: true,
      paths,
      fileNames,
      savedDir: dir,
      replyImages,
      attachments,
      source: source.localPath,
      sourceOriginal: source.originalPath,
      seed,
      elapsedMs: Date.now() - startedAt,
      script,
      selfCheck:
        '图生图自检（**不管违不违规都要做**）：用 read_image **同时打开参考图与结果图**并排对照——' +
        '线条粗细、上色方式、光影氛围、镜头质感是否与参考图同类；再看有没有肢体崩/水印/文字。' +
        '画风不像就按 sd-paint 技能「图生图画风一致」调：降 denoising（0.30-0.50 保画风）或把参考图的风格词写进提示词，最多再改 2 轮，每轮贴图说明。',
      hint:
        '图片已保存并作为附件展示。请把 replyImages 里的 Markdown 原样贴进你的可见回复（一行一张），' +
        '宿主会把绝对路径渲染成全尺寸图片，用户即可在聊天窗口直接看到图。' +
        '另外把 script.asMarkdown 也原样贴进回复：它是可复现的 powershell 脚本，带【图生图】标注，提示词会高亮成蓝色。',
    }
  },
}

/**
 * sd_inpaint —— 蒙版重绘（局部重画）：只改画面里一块，其余像素尽量不动。
 * 底图 + 蒙版（白 / 不透明 = 重绘区）走 A1111 的 /sdapi/v1/img2img + mask 分支；
 * 没有蒙版图时按 maskBox 现场造一张黑底白块 PNG（不引第三方图像库）。
 */
const inpaintTool = {
  name: 'sd_inpaint',
  description:
    '用本机 SD 的**蒙版重绘（inpaint）**：只重画图片里的一块，其余部分保持不动——补手、换脸、去杂物、局部改色、换一块背景用它；整张重画才用 sd_txt2img / sd_img2img。' +
    '蒙版二选一：`mask`（蒙版图路径，**白色 / 不透明处 = 重绘区**）或 `maskBox`（"x,y,w,h" 相对左上角像素，插件自动造蒙版并存进 %REF%）。' +
    '参数：denoisingStrength 默认 0.6（修瑕补全 0.40-0.55，换内容 0.65-0.80）；maskBlur 默认 4（接缝明显调 8-16）；' +
    'inpaintingFill 0=填充(默认) 1=保留原图 2=噪声 3=空潜空间（换新内容用 2）；maskInvert 反转蒙版；inpaintFullRes 默认 true（只在蒙版区按原分辨率重绘）+ padding 32。' +
    '尺寸默认跟随底图（8 的倍数）。图片固定保存到 %OUT%，文件名 = summary_序号.png，**务必传 summary**。' +
    '返回 JSON：paths、replyImages（必须原样贴进可见回复）、mask（实际用的蒙版路径）、script（【蒙版重绘】可复现脚本，SD 没开会自动拉起、跑完自动开图）、selfCheck。' +
    '出图后**必须 read_image 打开结果并与底图对照**：查接缝、色差、边缘重复纹理，不合格按 sd-paint「蒙版重绘」最多再改 2 轮、每轮贴图。' +
    '**违规照旧分流**：A 档可用蒙版把违规那块单独重画掉（比整张重画更保画风）；B 档依旧不出图，只给 sd_script 脚本（它同样支持 -Mask）。',
  parameters: {
    type: 'object',
    properties: {
      image: { type: 'string', description: '底图路径（要局部重绘的那张，绝对路径或工作区相对路径）' },
      mask: { type: 'string', description: '蒙版图路径：白色/不透明 = 重绘区；与 maskBox 二选一（mask 优先）' },
      maskBox: {
        type: 'string',
        description: '没有蒙版图时用：原图上的矩形 "x,y,w,h"（相对左上角，像素），插件自动生成黑底白块蒙版',
      },
      prompt: { type: 'string', description: '重绘区域应变成什么（英文标签式，只描述要改的那块）' },
      negativePrompt: { type: 'string', description: '负面词，留空用插件默认质量底线' },
      denoisingStrength: {
        type: 'number',
        description: '重绘幅度 0-1，默认 0.6：修瑕/补全 0.40-0.55，换内容 0.65-0.80',
      },
      maskBlur: { type: 'integer', description: '蒙版边缘羽化 px，默认 4；接缝明显就调到 8-16' },
      inpaintingFill: {
        type: 'integer',
        description: '蒙版区底色：0=填充(默认) 1=保留原图 2=噪声 3=空潜空间；要换全新内容用 2',
      },
      maskInvert: { type: 'boolean', description: '反转蒙版（改为重绘蒙版以外的区域），默认 false' },
      inpaintFullRes: { type: 'boolean', description: '只在蒙版区域按原分辨率重绘，默认 true' },
      inpaintFullResPadding: { type: 'integer', description: '蒙版区域外扩像素，默认 32，越大边缘越自然' },
      width: { type: 'integer', description: '输出宽度，留空跟随底图（8 的倍数）' },
      height: { type: 'integer', description: '输出高度，留空跟随底图（8 的倍数）' },
      steps: { type: 'integer', description: '步数，默认 22' },
      cfgScale: { type: 'number', description: 'CFG，默认 7' },
      seed: { type: 'integer', description: '随机种子，-1 = 随机' },
      samplerName: { type: 'string', description: '采样器，留空用插件默认 DPM++ 2M' },
      checkpoint: { type: 'string', description: '临时换 checkpoint，名字用 sd_models 查' },
      summary: { type: 'string', description: '提示词总结 3-15 字，就是保存的文件名' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        paths: { type: 'array', items: { type: 'string' } },
        fileNames: { type: 'array', items: { type: 'string' } },
        savedDir: { type: 'string' },
        replyImages: { type: 'array', items: { type: 'string' } },
        mask: { type: 'string', description: '实际使用的蒙版路径（maskBox 生成的落在 ref\\ 下）' },
        seed: { type: 'integer' },
        elapsedMs: { type: 'integer' },
        script: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: ['蒙版重绘'] },
            command: { type: 'string' },
            asMarkdown: { type: 'string' },
          },
          description: '【蒙版重绘】可复现脚本，原样贴进回复',
        },
        selfCheck: {
          type: 'string',
          description: '蒙版重绘自检：与底图对照查接缝/色差/边缘重复，最多再改 2 轮',
        },
      },
    },
    render: (_args, value) => presentOutput(value),
  },
  async execute(args, exec) {
    const startedAt = Date.now()
    await ensureServer()

    const source = await readImageBase64(exec, args.image) // 该函数恒返回 Promise，漏 await 会得到 undefined → init_images 变 [null]、服务端 500
    const sampler = String(args.samplerName ?? '').trim() || String(cfg.defaultSampler ?? '').trim()
    const negative = String(args.negativePrompt ?? '').trim() || String(cfg.defaultNegative ?? '').trim()
    const denoisingArg = Number(args.denoisingStrength)
    const denoising = Number.isFinite(denoisingArg) ? Math.max(0.05, Math.min(1, denoisingArg)) : 0.6
    const outWidth = multipleOf8(args.width, source.width || 512)
    const outHeight = multipleOf8(args.height, source.height || 768)

    // 蒙版：显式 mask 优先；否则用 maskBox 现造（坐标按原图算，再按输出尺寸等比换算）
    let maskBase64 = ''
    let maskPath = ''
    const maskInput = String(args.mask ?? '').trim()
    const boxInput = args.maskBox
    const hasBox = boxInput !== undefined && boxInput !== null && String(boxInput).trim() !== ''
    if (maskInput) {
      const mask = await readImageBase64(exec, maskInput)
      maskBase64 = mask.base64
      maskPath = mask.localPath
    } else if (hasBox) {
      const srcW = source.width || outWidth
      const srcH = source.height || outHeight
      const box = parseMaskBox(boxInput, srcW, srcH)
      const sx = outWidth / srcW
      const sy = outHeight / srcH
      let scaled = {
        x: Math.round(box.x * sx),
        y: Math.round(box.y * sy),
        w: Math.max(1, Math.round(box.w * sx)),
        h: Math.max(1, Math.round(box.h * sy)),
      }
      scaled = {
        x: Math.max(0, Math.min(outWidth - 1, scaled.x)),
        y: Math.max(0, Math.min(outHeight - 1, scaled.y)),
        w: Math.max(1, Math.min(outWidth - scaled.x, scaled.w)),
        h: Math.max(1, Math.min(outHeight - scaled.y, scaled.h)),
      }
      const png = makeBoxMaskPng(outWidth, outHeight, scaled)
      maskBase64 = png.toString('base64')
      maskPath = saveGeneratedMask(exec, png, `box_${scaled.x}_${scaled.y}_${scaled.w}_${scaled.h}_${outWidth}x${outHeight}`)
    } else {
      throw new Error(
        'sd_inpaint: 缺蒙版。传 mask（蒙版图路径，白色/不透明处 = 重绘区）或 maskBox（"x,y,w,h" 像素，插件自动造蒙版）。',
      )
    }

    const payload = {
      init_images: [source.base64],
      mask: maskBase64,
      prompt: String(args.prompt ?? ''),
      negative_prompt: negative,
      denoising_strength: denoising,
      width: outWidth,
      height: outHeight,
      resize_mode: 0,
      steps: clampInt(args.steps, 22, 1, 150),
      cfg_scale: Number.isFinite(Number(args.cfgScale)) ? Number(args.cfgScale) : 7,
      seed: Number.isFinite(Number(args.seed)) ? Math.trunc(Number(args.seed)) : -1,
      batch_size: 1,
      n_iter: 1,
      save_images: false,
      // 蒙版相关（字段名与 A1111 的 StableDiffusionProcessingImg2Img 一致，API 模型自动生成自该 dataclass）
      mask_blur: clampInt(args.maskBlur, 4, 0, 64),
      inpainting_fill: clampInt(args.inpaintingFill, 0, 0, 3),
      inpaint_full_res: args.inpaintFullRes !== false,
      inpaint_full_res_padding: clampInt(args.inpaintFullResPadding, 32, 0, 256),
      inpainting_mask_invert: args.maskInvert === true ? 1 : 0,
      ...(sampler ? { sampler_name: sampler } : {}),
      ...(String(args.checkpoint ?? '').trim() !== ''
        ? {
            override_settings: { sd_model_checkpoint: String(args.checkpoint).trim() },
            override_settings_restore_afterwards: true,
          }
        : {}),
    }

    const data = await apiPost('/sdapi/v1/img2img', payload, Number(cfg.requestTimeoutMs))
    const images = Array.isArray(data.images) ? data.images : []
    if (images.length === 0) {
      throw new Error(`sd_inpaint: SD 没有返回图片。info=${String(data.info ?? '').slice(0, 400)}`)
    }

    let seed = payload.seed
    try {
      const info = typeof data.info === 'string' ? JSON.parse(data.info) : data.info
      if (info && Number.isFinite(Number(info.seed))) seed = Number(info.seed)
    } catch {
      /* info 解析失败不致命 */
    }

    const { paths, fileNames, dir, attachments, replyImages } = await materializeImages(exec, images, {
      seed,
      summary: args.summary,
      prompt: payload.prompt,
    })
    touchIdleTimer()
    const script = commandBlock(
      '蒙版重绘',
      buildCommand(
        '蒙版重绘',
        {
          prompt: payload.prompt,
          negative: payload.negative_prompt,
          initImage: source.localPath,
          mask: maskPath,
          maskBlur: payload.mask_blur,
          inpaintingFill: payload.inpainting_fill,
          maskInvert: payload.inpainting_mask_invert === 1,
          inpaintFullRes: payload.inpaint_full_res,
          padding: payload.inpaint_full_res_padding,
          denoising: payload.denoising_strength,
          width: outWidth,
          height: outHeight,
          steps: payload.steps,
          seed,
          sampler: payload.sampler_name || '',
        },
        directPathFor(sessionCwd(exec)),
        resolveOutputDir(exec),
      ),
    )
    return {
      ok: true,
      paths,
      fileNames,
      savedDir: dir,
      replyImages,
      attachments,
      mask: maskPath,
      seed,
      elapsedMs: Date.now() - startedAt,
      script,
      selfCheck:
        '蒙版重绘自检（**违不违规都要做**）：用 read_image **同时打开底图与结果图**对照——' +
        '① 重绘区是否达到 prompt 要求；② **接缝**有没有硬边/断层（有就加大 maskBlur 到 8-16 或 padding 到 64）；' +
        '③ 重绘区与周围**色差**是否明显（有就降 denoising、inpaintingFill 试 1）；④ 蒙版外的像素有没有被误改（改了就检查 maskBox/mask 是否选错、必要时开 maskInvert）。' +
        '不合格按 sd-paint「蒙版重绘」最多再改 2 轮、每轮贴图说明；A 档若重绘区仍残留违规内容立即重画，B 档不出图。',
      hint:
        '图片已保存并作为附件展示。请把 replyImages 里的 Markdown 原样贴进你的可见回复（一行一张），宿主会渲染成全尺寸图片。' +
        '另外把 script.asMarkdown 也原样贴进回复：它是【蒙版重绘】的可复现 powershell 脚本，带 -Mask。',
    }
  },
}

/**
 * sd_script —— 只生成可复现脚本，绝不调用 SD、不出图。
 * 违规分流协议的「明显违规」分支专用：模型判定明显违规时不得调用生图工具，
 * 改调本工具拿 asMarkdown（【文生图】/【图生图】标注的 powershell 代码块，
 * 提示词 = 剔除违规后的合规素体），用户自己跑脚本出图并存进要求路径。
 */
const scriptTool = {
  name: 'sd_script',
  description:
    '只生成可复现的 powershell 出图脚本（调 sd-direct.ps1），**不调用 SD、不生成任何图片**。' +
    '违规分流协议的「明显违规」分支专用：当你判定用户需求明显违规、按协议不得自己出图时，改调本工具，' +
    '把剔除违规后的「合规素体」提示词传进来，返回 { mode, command, asMarkdown }；' +
    '把 asMarkdown 原样贴进回复即可（含【文生图】/【图生图】标注，提示词高亮成蓝色），用户自己运行脚本出图。' +
    'command 是一条**单行完整命令**（以 powershell -ExecutionPolicy Bypass -File 开头，用户复制整行就能跑；SD 没开脚本会**自动拉起**、失败只报一条错就退出；跑完保存后会**自动打开那张图**，加 -NoOpen 可关）；' +
    '贴进回复时保持单行、不要改写成 `& "路径"`、不要换路径。' +
    'command 里的脚本路径以本工具返回为准，**不要自己改路径或参数**（插件会把脚本同步到 %DIRECT% 与 SD 目录各一份，命令用哪份以返回值为准）。' +
    '给了 initImage 走【图生图】（-InitImage -Denoising），没给走【文生图】（-Width -Height -Name）。' +
    '正常需求或「轻微违规仍出图」时不要用本工具，直接调 sd_txt2img / sd_img2img。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '剔除违规后的合规素体提示词（英文标签式）' },
      negativePrompt: { type: 'string', description: '负向提示词' },
      initImage: {
        type: 'string',
        description:
          '参考图绝对路径（用户给的那一张）；给了就是【图生图】，留空是【文生图】。' +
          '工作区之外的临时路径会被固化到 %REF% 后再写进脚本',
      },
      denoising: { type: 'number', description: '图生图重绘幅度 0-1，默认 0.55（保画风 0.30-0.50，重画 0.70+）' },
      width: { type: 'integer', description: '宽度（8 的倍数，默认 640）' },
      height: { type: 'integer', description: '高度（8 的倍数，默认 960）' },
      steps: { type: 'integer', description: '采样步数，默认 24' },
      seed: { type: 'integer', description: '种子，-1 = 随机（不写进脚本）' },
      name: { type: 'string', description: '文生图输出文件名前缀（sd-direct.ps1 的 -Name），如 shorekeeper' },
    },
    required: ['prompt'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['文生图', '图生图'] },
        command: { type: 'string', description: '单行完整 powershell 命令，以 powershell -ExecutionPolicy Bypass -File 开头' },
        asMarkdown: { type: 'string' },
        generatesImage: { type: 'boolean', description: '恒为 false：本工具不生图' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.asMarkdown ?? JSON.stringify(value) }],
  },
  async execute(args, exec) {
    const wsRoot = sessionCwd(exec)
    const rawInitImage = String(args.initImage ?? '').trim()
    // 用户给的参考图若是临时/附件路径，固化到 ref\ 让脚本长期可跑；读不到就原样透传
    let initImage = rawInitImage
    if (rawInitImage) {
      try {
        const abs = path.isAbsolute(rawInitImage) ? rawInitImage : path.resolve(wsRoot, rawInitImage)
        initImage = stabilizeRefImage(abs, fs.readFileSync(abs), wsRoot)
      } catch {
        initImage = rawInitImage
      }
    }
    const mode = initImage ? '图生图' : '文生图'
    const block = commandBlock(
      mode,
      buildCommand(
        mode,
        {
          prompt: String(args.prompt ?? ''),
          negative: String(args.negativePrompt ?? ''),
          initImage,
          denoising: Number.isFinite(Number(args.denoising)) ? Number(args.denoising) : 0.55,
          width: clampInt(args.width, 640, 64, 2048),
          height: clampInt(args.height, 960, 64, 2048),
          steps: clampInt(args.steps, 24, 1, 150),
          seed: Number.isFinite(Number(args.seed)) ? Math.trunc(Number(args.seed)) : -1,
          name: String(args.name ?? 'direct'),
        },
        directPathFor(wsRoot),
        resolveOutputDir(exec),
      ),
    )
    return { ...block, generatesImage: false }
  },
}

const modelsTool = {
  name: 'sd_models',
  description:
    '列出本机 Stable Diffusion 可用的模型资源：checkpoints、LoRA、采样器、VAE、当前生效选项（当前 checkpoint / CLIP skip 等），以及 SD 服务状态。' +
    'sd_txt2img / sd_img2img 换模型前先用它确认名称。会自动拉起 SD API（若未运行）。' +
    '当前只有 SD1.5 base（新装默认）时会返回 qualityHint——画质差就照它说的升级模型/VAE，并把结论告诉用户。',
  parameters: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: ['all', 'checkpoints', 'loras', 'samplers', 'vaes', 'options'],
        description: '只查某一类时指定，默认 all',
      },
    },
    additionalProperties: false,
  },
  output: stringOutput,
  async execute(args) {
    const options = await ensureServer()
    const section = String(args.section ?? 'all')
    const want = (name) => section === 'all' || section === name

    const result = { baseUrl: baseUrl(), port: cfg.port, managedByPlugin: Boolean(state.child) }
    if (want('options')) {
      result.options = {
        sd_model_checkpoint: options?.sd_model_checkpoint,
        sd_vae: options?.sd_vae,
        CLIP_stop_at_last_layers: options?.CLIP_stop_at_last_layers,
      }
    }
    if (want('checkpoints')) {
      const models = await apiGet('/sdapi/v1/sd-models')
      result.checkpoints = models.map((m) => m.title)
    }
    if (want('loras')) {
      const loras = await apiGet('/sdapi/v1/loras')
      result.loras = loras.map((l) => l.name)
    }
    if (want('samplers')) {
      const samplers = await apiGet('/sdapi/v1/samplers')
      result.samplers = samplers.map((s) => s.name)
    }
    if (want('vaes')) {
      const vaes = await apiGet('/sdapi/v1/sd-vae')
      result.vaes = (vaes || []).map((v) => v.model_name || v.name).filter(Boolean)
    }

    // 画质诊断：新装的 SD 往往只有 2022 年的 SD1.5 base + 默认 VAE —— 这就是
    // 「别人电脑上新拉取 SD 画质非常差」的根因（本机跑得好的是 AWPainting + mse VAE + CLIP skip 2）。
    const active = String(options?.sd_model_checkpoint || '')
    const titles = result.checkpoints || []
    const isBase = (t) => /v1-5-pruned|v1-5\.ckpt|v1-4|sd-v1-/i.test(String(t || ''))
    const baseOnly = titles.length > 0 && titles.every(isBase)
    const usingBase = isBase(active)
    const defaultVae = String(options?.sd_vae || '') === 'Automatic' || !options?.sd_vae
    if (usingBase || baseOnly) {
      result.qualityHint =
        '画质提示：当前生效/可用的模型是 SD1.5 base（2022 年的 v1-5-pruned-emaonly），新装环境画质差基本就是它——' +
        '本机画质正常的配置是「AWPainting v1.2 + vae-ft-mse-840000 + CLIP skip 2」。\n' +
        '① 一键升级：跑插件自带的 install-sd.ps1（补装 AWPainting 与 mse VAE、写入质量默认配置，模型/VAE 均带 sha256 校验；已装过 SD 也会只补缺的那部分）。\n' +
        '② 手动：把更好的 .safetensors 放进 <SD>\\models\\Stable-diffusion 后重跑本工具，再让生图工具用它；' +
        '动漫/插画选 AWPainting / ReVAnimated / anything-v5，写实选 majicMIX realistic。\n' +
        (defaultVae
          ? '③ VAE 目前是 Automatic：建议显式用 models\\VAE\\vae-ft-mse-840000-ema-pruned.safetensors（画面更干净、不发灰）。'
          : '')
    }
    touchIdleTimer()
    return JSON.stringify(result, null, 2)
  },
}

const serverTool = {
  name: 'sd_server',
  description:
    '管理本机 Stable Diffusion API 服务：status 查看状态，start 启动（纯 API 模式、不开浏览器），stop 停止由 sd-bridge 启动的进程。' +
    '生图工具本身也会按需自动启动，通常不需要手动 start。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['status', 'start', 'stop'], description: '默认 status' },
    },
    additionalProperties: false,
  },
  output: stringOutput,
  async execute(args) {
    const action = String(args.action ?? 'status')
    if (action === 'start') {
      const options = await ensureServer({ allowStart: true })
      return JSON.stringify(
        {
          ok: true,
          state: 'ready',
          baseUrl: baseUrl(),
          checkpoint: options?.sd_model_checkpoint,
          managedByPlugin: Boolean(state.child && state.startedByUs),
        },
        null,
        2,
      )
    }
    if (action === 'stop') {
      const outcome = stopServer()
      return JSON.stringify({ ok: outcome.ok, state: 'stopped', reason: outcome.reason }, null, 2)
    }
    const probe = await probeApi()
    return JSON.stringify(
      {
        ok: true,
        // 跑的是哪一版：排查「改完没生效 / 面板没有」时第一眼要看的东西
        pluginVersion: PLUGIN_VERSION,
        configSchema: Config === undefined ? 'unavailable' : 'exported',
        state: probe.kind === 'ready' ? 'ready' : 'offline',
        baseUrl: baseUrl(),
        sdDir: cfg.sdDir || undefined,
        checkpoint: probe.kind === 'ready' ? probe.options?.sd_model_checkpoint : undefined,
        managedByPlugin: Boolean(state.child && state.startedByUs),
        pid: state.child ? state.child.pid : undefined,
        idleStopMinutes: Number(cfg.idleStopMinutes || 0),
        // 找不到 SD 时给出可执行的安装/指向指引，而不是让人对着空配置猜
        installHint: cfg.sdDir ? undefined : installGuidance(),
        recentLog: state.logTail.slice(-8),
      },
      null,
      2,
    )
  },
}

// ---------------------------------------------------------------------------
// 插件入口
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 文案占位符 → 本机实际路径：工具描述与技能全文在 apply 时按配置注入，
// 源码里不残留任何机器专属路径（可移植性 + 隐私要求）。
// ---------------------------------------------------------------------------

function docLabels() {
  const outRaw = String(cfg.outputDir || DEFAULTS.outputDir)
  const refRaw = String(cfg.refDir || DEFAULTS.refDir)
  const asLabel = (raw) =>
    path.isAbsolute(raw) ? path.normalize(raw) : `工作区${path.sep}${raw}`
  return {
    '%SD%': cfg.sdDir ? path.normalize(cfg.sdDir) : '自动探测到的 SD WebUI 目录',
    '%OUT%': asLabel(outRaw),
    '%REF%': asLabel(refRaw),
    '%DIRECT%': `工作区${path.sep}sd-direct.ps1`,
  }
}

function applyDocTokens(text) {
  let out = String(text)
  for (const [token, value] of Object.entries(docLabels())) out = out.split(token).join(value)
  return out
}

function applyDocsToTools() {
  for (const tool of [txt2imgTool, img2imgTool, scriptTool, modelsTool, serverTool]) {
    tool.description = applyDocTokens(tool.description)
    const props = tool.parameters && tool.parameters.properties
    if (!props) continue
    for (const prop of Object.values(props)) {
      if (prop && typeof prop.description === 'string') prop.description = applyDocTokens(prop.description)
    }
  }
}

/** 深度遍历对象，把所有字符串里的路径占位符换成本机实际值（用于技能定义整体注入） */
function mapStringsDeep(value) {
  if (typeof value === 'string') return applyDocTokens(value)
  if (Array.isArray(value)) return value.map(mapStringsDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = mapStringsDeep(item)
    return out
  }
  return value
}

// ---------------------------------------------------------------------------
// 设置面板（设置 → 插件 → sd-bridge）：把 DEFAULTS 注册成可编辑配置。
// 范式同 dsh-raw-html-v2：运行时动态 import schemastery，缺失则跳过注册、
// 其余功能不受影响（静态 import 链只剩 node 内置模块）。
// ---------------------------------------------------------------------------

/** 设置面板分组命名空间 = 插件 id（cordis.patch.yml 的按 id 覆盖项语义不变）。 */
const SETTINGS_NS = 'sd-bridge'

/** 尝试加载配置 schema（0.1.x 的 settings.register 路径）；失败返回 null（跳过注册，其余功能不受影响）。 */
async function tryLoadConfigSchema() {
  const z = await resolveSchemastery()
  if (z === null) return null
  try {
    return z.object({
      enabled: z
        .boolean()
        .default(DEFAULTS.enabled)
        .description('注册生图工具（sd_txt2img 等 6 个）。关闭后需重开会话生效。'),
      sdDir: z
        .string()
        .default(DEFAULTS.sdDir)
        .description(
          'SD WebUI 安装目录（含 launch.py）。留空 = 自动探测：环境变量 DSH_SD_DIR > 自举安装记录 ~/.dsh-sd-bridge.json > 各盘常见目录扫描。',
        ),
      port: z
        .number()
        .default(DEFAULTS.port)
        .description('SD API 端口，与 WebUI 默认端口一致（1024-65535，越界自动纠正）。'),
      autoStart: z
        .boolean()
        .default(DEFAULTS.autoStart)
        .description('探测不到已运行的 API 时，是否由插件自动以纯 API 模式（--api --nowebui）拉起 SD。'),
      startupTimeoutMs: z
        .number()
        .default(DEFAULTS.startupTimeoutMs)
        .description('启动 SD 的最长等待毫秒数（首次还要加载 checkpoint，给足余量；默认 420000 = 7 分钟）。'),
      requestTimeoutMs: z
        .number()
        .default(DEFAULTS.requestTimeoutMs)
        .description('单次生图请求的最长等待毫秒数（默认 600000 = 10 分钟，高清/大批量给足）。'),
      idleStopMinutes: z
        .number()
        .default(DEFAULTS.idleStopMinutes)
        .description('空闲多少分钟后自动关掉由本插件拉起的 SD；0 = 不自动关。'),
      extraArgs: z
        .array(z.string())
        .default(DEFAULTS.extraArgs)
        .description('追加给 launch.py 的额外命令行参数（高级项，每项一个字符串）。'),
      outputDir: z
        .string()
        .default(DEFAULTS.outputDir)
        .description('生图产物目录：绝对路径原样使用；相对路径解析到会话工作区（默认 SD-Picture）。'),
      refDir: z
        .string()
        .default(DEFAULTS.refDir)
        .description('图生图参考图固化目录（工作区外的聊天附件会复制到这里）；相对路径解析到会话工作区。'),
      defaultSampler: z
        .string()
        .default(DEFAULTS.defaultSampler)
        .description('未指定采样器时的默认采样器；留空 = 交给 SD 自己的默认。DPM++ 2M 同样步数下比 Euler a 更干净。可用名见 sd_models。'),
      defaultNegative: z
        .string()
        .default(DEFAULTS.defaultNegative)
        .description('调用方没传 negativePrompt 时自动补的画质底线负面词；留空 = 不补（空负面会漏拦肢体崩/水印）。'),
      img2imgDenoising: z
        .number()
        .default(DEFAULTS.img2imgDenoising)
        .description('图生图默认重绘幅度 0-1：0.55 更贴参考图；保画风传 0.30-0.50，彻底重画 0.70+。'),
    })
  } catch {
    return null
  }
}

/**
 * 注册设置面板配置 scope，并把面板改动实时并回 cfg（工具调用时现读 cfg，改完下一个调用即生效）。
 * 优先级：DEFAULTS < 设置面板 < cordis.patch.yml 显式覆盖（patchKeys 冻结的键不受面板影响）。
 */
function registerSettings(ctx, patchKeys) {
  const settings = ctx.get('settings')
  if (settings === undefined || typeof settings.register !== 'function') return
  void (async () => {
    const schema = await tryLoadConfigSchema()
    if (schema === null) {
      log('配置 schema 不可用（schemastery 缺失），跳过设置面板注册——工具照常可用')
      return
    }
    try {
      const scope = settings.register(SETTINGS_NS, schema)
      /** 把面板值并入 cfg（跳过 cordis.patch.yml 显式覆盖的键）。 */
      const pull = () => {
        let cur = {}
        try {
          cur = scope.get() || {}
        } catch {
          return
        }
        for (const key of Object.keys(DEFAULTS)) {
          if (patchKeys.has(key)) continue
          if (cur[key] !== undefined && cur[key] !== null) cfg[key] = cur[key]
        }
        cfg.port = clampInt(cfg.port, 7860, 1024, 65535)
        cfg.idleStopMinutes = Math.max(0, Math.trunc(Number(cfg.idleStopMinutes) || 0))
        cfg.startupTimeoutMs = Math.max(30000, Math.trunc(Number(cfg.startupTimeoutMs) || DEFAULTS.startupTimeoutMs))
        cfg.requestTimeoutMs = Math.max(30000, Math.trunc(Number(cfg.requestTimeoutMs) || DEFAULTS.requestTimeoutMs))
        cfg.img2imgDenoising = Math.min(1, Math.max(0, Number(cfg.img2imgDenoising) || DEFAULTS.img2imgDenoising))
        cfg.outputDir = String(cfg.outputDir ?? DEFAULTS.outputDir).trim() || DEFAULTS.outputDir
        cfg.refDir = String(cfg.refDir ?? DEFAULTS.refDir).trim() || DEFAULTS.refDir
        // sdDir：面板留空 = 自动探测；填了则校验（缺 launch.py 会记日志并回退探测）
        cfg.sdDir = detectSdDir(String(cfg.sdDir ?? '').trim())
      }
      pull()
      scope.watch(() => {
        pull()
        log(`设置面板已更新（sdDir=${cfg.sdDir || '未找到'}, port=${cfg.port}, autoStart=${cfg.autoStart}, defaultSampler=${cfg.defaultSampler || 'SD 默认'}）`)
      })
      log('设置面板配置已注册：设置 → 插件 → sd-bridge')
    } catch (error) {
      log('设置面板注册失败（不影响工具）：', error && error.message ? error.message : error)
    }
  })()
}

// ---------------------------------------------------------------------------
// 插件 Config 声明（0.2.x：设置面板的表单从**插件自己的 Config**派生）
//
// 0.1.x 时代是插件把 (ns, schema) 注册给 settings 服务；0.2.x 的 settings 服务
// （SettingsForms）**没有 register()**，改成 Loader 读插件导出的 Config schema，
// 把标了 `.volatile()` 的字段投影成表单，面板改完**不重挂插件** —— Loader 直接把
// 新值 commit 进同一个引用对象（`Volatile<T>.get()` 现取现得），下面的 cfg 访问器
// 因此能做到「改完下一个工具调用即生效」。
//
// ⛔ 不能用静态 import '@deepseek-ai/schemastery'：本插件常以 `link:` 安装
//   （profile/node_modules → 工作区），Node 按 realpath 解析依赖，静态 import 必然
//   ERR_MODULE_NOT_FOUND，整个模块**加载即失败** → 插件激活不了（本机全部 link:
//   插件都遵守这条）。所以用 top-level await + 动态 import（裸 import → 宿主真身
//   → profile 兜底）；两条路都失败就 `Config = undefined`，Loader 当没有 schema，
//   退回老行为，功能不受影响。
// ---------------------------------------------------------------------------

/** volatile 引用用**全局** Symbol 标记，因此跨 ESM/CJS 副本、跨不同 schemastery 实例都能识别。 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

/** 是不是 0.2.x Loader 放进 config 的那种 volatile 引用对象。 */
function isVolatileRef(value) {
  return Boolean(value) && typeof value === 'object' && VOLATILE_WRITE in value
}

/** 取 volatile 引用的当前值（引用由 Loader 原地更新）；非引用原样返回。 */
function volatileValue(value) {
  if (!isVolatileRef(value)) return value
  try {
    return value.get()
  } catch {
    return undefined
  }
}

/**
 * 把一个配置值规范化成 cfg 里该有的样子（补默认、钳制范围、解析 SD 目录）。
 * 原先散在设置面板 pull() 与 apply() 里的那几行钳制收拢到这里，读写两侧共用一份规则，
 * 顺带保证**重算只发生在引用真变了的时候**（detectSdDir 会扫盘，不能每次读 cfg 都跑）。
 */
function normalizeConfigValue(key, value) {
  switch (key) {
    case 'enabled':
      return value !== false
    case 'autoStart':
      return value !== false
    case 'port':
      return clampInt(value, DEFAULTS.port, 1024, 65535)
    case 'idleStopMinutes':
      return Math.max(0, Math.trunc(Number(value) || 0))
    case 'startupTimeoutMs':
      return Math.max(30000, Math.trunc(Number(value) || DEFAULTS.startupTimeoutMs))
    case 'requestTimeoutMs':
      return Math.max(30000, Math.trunc(Number(value) || DEFAULTS.requestTimeoutMs))
    case 'img2imgDenoising':
      return Math.min(1, Math.max(0, Number(value) || DEFAULTS.img2imgDenoising))
    case 'outputDir':
      return String(value ?? DEFAULTS.outputDir).trim() || DEFAULTS.outputDir
    case 'refDir':
      return String(value ?? DEFAULTS.refDir).trim() || DEFAULTS.refDir
    case 'extraArgs':
      return Array.isArray(value) ? value.map((item) => String(item)) : []
    case 'sdDir':
      // 显式配置优先，为空/无效则自动探测（环境变量 / 自举记录 / 扫盘）
      return detectSdDir(String(value ?? '').trim())
    default:
      return value === undefined || value === null ? DEFAULTS[key] : value
  }
}

/**
 * 把某个 cfg 键装成 volatile 访问器：读的时候现取引用的值（引用变了就重算并丢掉本进程的改写），
 * 写的时候落成本进程的覆盖值。这样设置面板改完无需重挂插件、下一个工具调用就生效，
 * 同时 apply() 里那几行 `cfg.x = 钳制后(cfg.x)` 也不会被吞掉。
 */
function installVolatileAccessor(holder, key, ref) {
  let seen = Symbol('unset')
  let normalized
  let override
  let hasOverride = false
  Object.defineProperty(holder, key, {
    enumerable: true,
    configurable: true,
    get() {
      const fresh = volatileValue(ref)
      if (!Object.is(fresh, seen)) {
        seen = fresh
        normalized = normalizeConfigValue(key, fresh)
        override = undefined
        hasOverride = false
      }
      return hasOverride ? override : normalized
    },
    set(value) {
      override = value
      hasOverride = true
    },
  })
}

/** 设置面板里每个字段的中文说明（沿用 0.1.x schema 的文案，一字未改）。 */
const CONFIG_FIELD_DOCS = {
  enabled: '注册生图工具（sd_txt2img 等 6 个）。关闭后需重开会话生效。',
  sdDir:
    'SD WebUI 安装目录（含 launch.py）。留空 = 自动探测：环境变量 DSH_SD_DIR > 自举安装记录 ~/.dsh-sd-bridge.json > 各盘常见目录扫描。',
  port: 'SD API 端口，与 WebUI 默认端口一致（1024-65535，越界自动纠正）。',
  autoStart: '探测不到已运行的 API 时，是否由插件自动以纯 API 模式（--api --nowebui）拉起 SD。',
  startupTimeoutMs: '启动 SD 的最长等待毫秒数（首次还要加载 checkpoint，给足余量；默认 420000 = 7 分钟）。',
  requestTimeoutMs: '单次生图请求的最长等待毫秒数（默认 600000 = 10 分钟，高清/大批量给足）。',
  idleStopMinutes: '空闲多少分钟后自动关掉由本插件拉起的 SD；0 = 不自动关。',
  extraArgs: '追加给 launch.py 的额外命令行参数（高级项，每项一个字符串）。',
  outputDir: '生图产物目录：绝对路径原样使用；相对路径解析到会话工作区（默认 SD-Picture）。',
  refDir: '图生图参考图固化目录（工作区外的聊天附件会复制到这里）；相对路径解析到会话工作区。',
  defaultSampler:
    '未指定采样器时的默认采样器；留空 = 交给 SD 自己的默认。DPM++ 2M 同样步数下比 Euler a 更干净。可用名见 sd_models。',
  defaultNegative: '调用方没传 negativePrompt 时自动补的画质底线负面词；留空 = 不补（空负面会漏拦肢体崩/水印）。',
  img2imgDenoising: '图生图默认重绘幅度 0-1：0.55 更贴参考图；保画风传 0.30-0.50，彻底重画传 0.70+。',
}

/**
 * 把 DEFAULTS 声明成 0.2.x 的插件 Config：13 个字段全部 `.volatile()`（面板可实时编辑）。
 *
 * ⚠️ 每个字段都带 `.loose()`：手写 `cordis.patch.yml` 很容易把数字/布尔写成字符串
 * （`port: "7860"`、`enabled: "false"`），而 0.2.x 的 `resolveConfig` 是**严格**校验、
 * 失败就抛 ValidationError → **整个插件激活不了**。`.loose()` 让校验异常退回 schema
 * 默认值：宁可某个字段悄悄用默认值，也绝不能让插件起不来（0.1.x 时代这里根本没有 schema，
 * 所以「加 schema」绝不能变成新的启动风险）。
 */
function buildPluginConfigSchema(z) {
  const docs = (key, node) => (CONFIG_FIELD_DOCS[key] ? node.description(CONFIG_FIELD_DOCS[key]) : node)
  const bool = (key) => docs(key, z.boolean().default(DEFAULTS[key]).volatile().loose())
  const num = (key) => docs(key, z.number().default(DEFAULTS[key]).volatile().loose())
  const text = (key) => docs(key, z.string().default(DEFAULTS[key]).volatile().loose())
  return z.object({
    enabled: bool('enabled'),
    sdDir: text('sdDir'),
    port: num('port'),
    autoStart: bool('autoStart'),
    startupTimeoutMs: num('startupTimeoutMs'),
    requestTimeoutMs: num('requestTimeoutMs'),
    idleStopMinutes: num('idleStopMinutes'),
    extraArgs: docs('extraArgs', z.array(z.string()).default(DEFAULTS.extraArgs).volatile().loose()),
    outputDir: text('outputDir'),
    refDir: text('refDir'),
    defaultSampler: text('defaultSampler'),
    defaultNegative: text('defaultNegative'),
    img2imgDenoising: num('img2imgDenoising'),
  })
}

/**
 * 解析 schemastery —— 0.2.x 插件 Config 的唯一依赖。两条途径，全失败返回 null：
 *   ① 裸 import：插件被 Node 以 profile node_modules **真实路径**加载时可用；
 *   ② 按已知位置找 lib/index.mjs：插件是符号链接时（link: 安装）走这条 ——
 *      先试 Electron 宿主真身 `app.asar/dsh/node_modules/...`，再扫 `~/.dsh/profiles/*`。
 * 跨实例是安全的：volatile 引用靠 `Symbol.for` 互通，schema 靠 `'~standard'.vendor` 识别，
 * 且本机这三处的 schemastery 逐字节相同（sha256 一致）。
 */
async function resolveSchemastery() {
  /** 认出 schemastery 的默认导出（不同打包方式的形状不一样）。 */
  const pick = (mod) => {
    const z = mod && mod.default ? mod.default : mod
    return z && typeof z.object === 'function' ? z : null
  }
  try {
    const hit = pick(await import('@deepseek-ai/schemastery'))
    if (hit) return hit
  } catch {
    /* 途径① 落空 → 走途径② */
  }
  try {
    const path = await import('node:path')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const { pathToFileURL } = await import('node:url')
    const tail = ['node_modules', '@deepseek-ai', 'schemastery', 'lib', 'index.mjs']
    const candidates = []
    // ②a 宿主真身（Electron 把 harness 打进 app.asar；路径含空格/中文，必须走 pathToFileURL）
    const resources = process.resourcesPath
    if (resources) candidates.push(path.join(resources, 'app.asar', 'dsh', ...tail))
    // ②b profile 里随宿主安装/抽取的那份（再兜底当前工作目录）
    try {
      const root = path.join(os.homedir(), '.dsh', 'profiles')
      if (fs.existsSync(root)) {
        for (const dir of fs.readdirSync(root)) candidates.push(path.join(root, dir, ...tail))
      }
    } catch {
      /* 列不出来就算了 */
    }
    candidates.push(path.join(process.cwd(), ...tail))
    for (const hit of candidates) {
      try {
        if (!fs.existsSync(hit)) continue
        const z = pick(await import(pathToFileURL(hit).href))
        if (z) return z
      } catch {
        /* 这个候选不行 → 继续下一个 */
      }
    }
  } catch {
    /* 扫描失败 → 放弃 */
  }
  return null
}

/**
 * 0.2.x 插件 Config。top-level await 保证 Loader 读 `runtime.Config` 时它已经就位
 * （动态 import 的 promise 会等 TLA 跑完）；解析不到 schemastery 时导出 undefined，
 * Loader 就当这个插件没有 schema，退回「无面板」的老行为。
 */
const configSchemastery = await resolveSchemastery()
export const Config = configSchemastery === null ? undefined : buildPluginConfigSchema(configSchemastery)
if (Config === undefined) {
  log('schemastery 不可用（裸 import 与 profile/asar 兜底都没命中），跳过设置面板 schema——工具与技能照常')
}

export function apply(ctx, config = {}) {
  state.logger = ctx.logger ?? console
  /** cordis.patch.yml 显式覆盖的键（0.1.x 设置面板用；0.2.x 下优先级由 Loader 把关）。 */
  const patchKeys = new Set()
  /** 0.2.x：volatile 字段在 config 里是引用对象，装成访问器让面板改动即时生效。 */
  const volatileRefs = new Map()
  for (const key of Object.keys(DEFAULTS)) {
    const raw = config ? config[key] : undefined
    if (isVolatileRef(raw)) {
      volatileRefs.set(key, raw)
      continue
    }
    if (raw !== undefined && raw !== null) {
      patchKeys.add(key)
      cfg[key] = raw
    }
  }
  for (const [key, ref] of volatileRefs) installVolatileAccessor(cfg, key, ref)

  cfg.port = clampInt(cfg.port, 7860, 1024, 65535)
  // sdDir：显式配置优先，为空则自动探测（环境变量 / 自举记录 / 扫盘）
  cfg.sdDir = detectSdDir(cfg.sdDir)

  registerSettings(ctx, patchKeys)

  ctxRef.get = (key) => (typeof ctx.get === 'function' ? ctx.get(key) : undefined)

  syncDirectScripts(process.cwd())
  applyDocsToTools()

  if (cfg.enabled === false) {
    log('sd-bridge 已在配置中禁用（enabled: false）')
    return
  }

  const disposers = []
  for (const tool of [txt2imgTool, img2imgTool, inpaintTool, scriptTool, modelsTool, serverTool]) {
    disposers.push(ctx.tools.register(tool))
  }

  // 技能：教模型「按 SD 规则写提示词 → 违规分流判定 → 出图 → 贴图 + 脚本 + 违规词回执」的完整流程。
  const skills = ctx.get('skills')
  if (skills !== undefined && typeof skills.register === 'function') {
    try {
      disposers.push(
        skills.register(
          mapStringsDeep({
          name: 'sd-paint',
          title: 'Stable Diffusion 画图 · SD 提示词规范 + 违规分流协议',
          description:
            '用本机 SD（dsh-sd-bridge-guard 六件套）画图的完整规范：如何按 SD 规则把用户需求写成英文标签提示词、参数怎么选、出图后如何展示与保存，' +
            '以及违规分流协议——轻微违规删词后照常出图、明显违规不出图只给合规素体的可复现脚本、回复最末尾列出被剔除的违规提示词英文。',
          whenToUse:
            '用户提出任何画图/生成图片/插画/壁纸/头像/图标图等请求时使用：先读本技能写提示词，再调 sd_txt2img 出图；' +
            '只想改画面里一块（补手/去杂物/局部改色/换一块背景）→ 用 sd_inpaint 蒙版重绘；' +
            '用户问「哪些提示词被拦了/为什么没画出来」时也读本技能。',
          source: 'dsh-sd-bridge-guard',
          content:
            '# Stable Diffusion 画图规范（dsh-sd-bridge-guard）\n\n' +
            '本机 SD 在 %SD%，由 dsh-sd-bridge-guard 提供工具，**无需提前打开 SD**：首次调用会自动后台启动纯 API 模式（首次含模型加载约 1-3 分钟，之后每次 2-10 秒）。\n\n' +
            '## 违规分流协议（本插件核心，优先级最高）\n' +
            '判定标准 = **你自己会拒绝执行的尺度**（露骨性内容、未成年人相关、真实人物色情、极端血腥、违法用途等），不依赖固定词表。\n' +
            '需求里只要有一部分违规就触发分流，**不整单拒绝**——但先分清是哪一档：\n\n' +
            '### A 档 · 轻微违规（删几个词后完全正常）→ 照常出图\n' +
            '1. **拆分**：剔除违规片段，保留可执行部分。\n' +
            '2. **出图**：用可执行部分调 `sd_txt2img` / `sd_img2img`，**先把图存进要求路径**（%OUT%）并贴进回复。\n' +
            '3. **提示**：图下方写一行：原需求含违规内容、已被剔除、当前图为剔除后所生成。**不许静默丢弃**。\n' +
            '4. **给脚本（每次出图都给）**：贴工具返回的 `script.asMarkdown`（【图生图】/【文生图】标注 + powershell 代码块，提示词蓝色高亮）。\n' +
            '5. **末尾列违规词**（见通用第 5 步）。\n\n' +
            '### B 档 · 明显违规（露骨/整体性质，你不会自己出图）→ **不出图，只给脚本**\n' +
            '1. **禁止调 `sd_txt2img` / `sd_img2img`，一张图都不生成**——聊天窗里不出现图片，也不写「已存图」。\n' +
            '2. **产出合规素体提示词**：把原需求翻译成英文标签（用户给图就先把那张图译成提示词），剔除全部违规片段，剩下的就是**合规素体**。\n' +
            '3. **调 `sd_script`**（只生成命令、不碰 SD），把素体提示词与参考图路径传进去，拿到 `asMarkdown` 原样贴进回复——\n' +
            '   这就是用户要的**可复现脚本**：标明【图生图】或【文生图】，提示词蓝色高亮，用户自己运行它出图并存进要求路径。\n' +
            '4. **说明**：明确写「原需求含明显违规内容，已剔除；下方脚本给出的是合规素体，运行即可保存到 %OUT%」。\n' +
            '5. **末尾列违规词**（见下）。\n' +
            '   典型场景：用户丢一张图说「翻译成提示词」→ 若原图含违规内容，同样走 B 档：不出图，只回素体提示词脚本。\n\n' +
            '### 通用 · 末尾列违规词（A/B 两档都要，最重要）\n' +
            '回复**最末尾**单独一段，把被剔除的违规部分**译成英文**逐条列出，标题写「已剔除的违规提示词（不能加进脚本、不能给别人使用）」——用户要拿去告知别人这些词不能加。\n' +
            '若需求**全部**违规、连素体都提炼不出：仍按 B 档只给 `sd_script` 脚本（prompt 写能成立的最素版本），末尾照列违规词。\n\n' +
            '正常需求（无违规）：出图 → 贴 replyImages → 贴 script 脚本 → 一句话说明保存位置/文件名/seed，无需违规提示与末尾清单。\n\n' +
            '## 回复骨架（对照执行）\n' +
            '1. **自检优先**：出图后先 `read_image` 看图（见「出图自检 → 优化循环」），合格才往下走；不合格就改参数再出，最多 2 轮。\n' +
            '2. 图片（仅 A 档与正常需求）：`replyImages` 原样贴出（一行一张）；**改过第二轮就把每一轮的图都贴上**并注明轮次；B 档没有这一步。\n' +
            '3. 自检结论一句话：「已自检：肢体/水印/构图/风格无问题」或「第 2 轮把 denoising 降到 0.4，画风对齐了」。\n' +
            '4. 保存说明：%OUT%、文件名、seed；B 档说明「运行脚本后会存进去」。脚本会在 **SD 没开时自动拉起**（首次 1-3 分钟）、跑完**自动打开那张图**，这两点都顺带告诉用户（不想弹窗就在命令末尾加 `-NoOpen`）。\n' +
            '5. 模式标注 + 脚本：`【图生图】` / `【文生图】` / `【蒙版重绘】`，下接 powershell 代码块（A 档/正常用 `script.asMarkdown`，B 档用 `sd_script` 返回的 `asMarkdown`）。**脚本必须原样粘贴，禁止改写其中的路径与参数**——代码块里是**一条单行完整命令**，以 `powershell -ExecutionPolicy Bypass -File "%DIRECT%"` 开头，用户复制整行到 PowerShell/cmd 直接就能跑。\n' +
            '   **禁止**把它改写成 `& "..."` + 多行反引号续行的形式：`&` 调用受执行策略限制会直接报错，且模型自造路径根本不存在，会报 CommandNotFoundException。\n' +
            '   `sd-direct.ps1` 由插件同步在工作区根目录与 SD 目录各一份，命令里用哪份**以工具返回的 command 为准**，不要自己拼路径。\n' +
            '6. （仅违规时）违规提示行 + 回复最末尾的英文违规词清单。\n\n' +
            '## 工作流（每次画图都走这条）\n' +
            '1. 先看用户需求，若需要特定风格/模型再调 `sd_models` 确认 checkpoint、LoRA 名称（不确定名称时才查，已知可跳过）。\n' +
            '2. **先做违规分流判定**（A 档/B 档，见上），再按下方规则写出英文标签式 `prompt` 与 `negativePrompt`。\n' +
            '3. B 档走 `sd_script` 到此为止；A 档与正常需求继续：整张出图调 `sd_txt2img`（按参考图重绘用 `sd_img2img`，**只改画面里一块**用 `sd_inpaint` 蒙版重绘），**必须传 `summary`**：3-15 字中文概括（如「银发少女樱花」），它就是保存的文件名。\n' +
            '4. **自检**：用 `read_image` 打开 `paths[0]`（图生图要**同时打开参考图**）自己看一遍——不合格按「出图自检 → 优化循环」最多再改 2 轮；**违不违规都要自检**。\n' +
            '5. 拿到返回后，**把 `replyImages` 里的 Markdown 原样贴进你的可见回复**（一行一张、放在正文里），宿主会渲染成全尺寸图片，用户就能在聊天窗口直接看到图。工具卡片只是缩略图，会被后续消息顶走。\n' +
            '6. 回复里顺带给用户一句话说明：自检结论、保存位置 %OUT%、文件名、seed（方便复现），并贴 `script.asMarkdown`。\n\n' +
            '## 出图自检 → 优化循环（**不管违不违规都要做**，最重要）\n' +
            '出图不是「调工具 → 拿到就贴」，而是「出图 → 自己看 → 不满意就改 → 再看」：\n' +
            '1. **必看**：拿到 `paths` 后立刻用 `read_image` 打开，把自己当成审稿人；只看工具卡片缩略图不算看。\n' +
            '2. **看什么**（按优先级）：① 手指/肢体/面部有没有崩；② 有没有水印、签名、残留文字；③ 构图有没有把主体切掉、有没有多余肢体；④ 风格是否符合需求；⑤ 图生图还要看**与参考图的画风一致度**。\n' +
            '3. **不合格就改**（最多 2 轮，每轮只动 1-2 个变量，保留 seed 方便对照）：\n' +
            '   - 肢体/手崩 → negative 补 `bad hands, extra fingers, fewer digits, malformed limbs`，或把 CFG 降到 6；两轮都崩就换 seed 重出。\n' +
            '   - 糊/噪点多 → steps +4~6、开 `enableHiresFix`（scale 1.5-2）、确认没把 denoising 压太低。\n' +
            '   - 风格不对 → `sd_models` 换 checkpoint（动漫 AWPainting / 写实 majicMIX），提示词补画风词。\n' +
            '   - 画面脏/出戏 → 负面词与构图词再收一收；不要一味加步数。\n' +
            '4. **每轮都要贴图**：聊天窗里贴 `replyImages`（原图与改后图都贴，一行一张），并写明「第 N 轮改了什么」。\n' +
            '5. **两轮仍不合格** → 如实告诉用户卡在哪、给出可选方向（换模型/换 seed/需要更具体的描述），不许假装成功。\n' +
            '6. **违规分支不变**：A 档自检时若发现画面里**仍残留被剔除的违规内容 → 当场重画**，绝不能把它贴出来；B 档照旧不出图、只给脚本，自检循环不适用于 B 档。\n\n' +
            '## 图生图画风一致（用户最在意的一条）\n' +
            '1. **先看参考图**：`read_image` 打开用户给的那张，提炼画风四要素——媒介（赛璐璐/水彩/厚涂/写实摄影）、线条粗细、上色与色调、光影与镜头感。\n' +
            '2. **把画风写进提示词**：主体按用户要求改，风格词照参考图写（如 `anime style, cel shading, soft warm palette` / `photorealistic, natural light, film grain`），结尾补质量词。\n' +
            '3. **denoising 定生死**：保画风保构图 → `0.30~0.50`；要改内容还认得出原味 → `0.50~0.65`；彻底重画 → `0.70+`（此时画风只能靠提示词维持）。**默认给 0.45 起步**，工具默认 0.55。\n' +
            '4. **同源模型**：参考图是动漫就用 AWPainting 系，写实就 majicMIX 系；跨模型最容易画风漂移。\n' +
            '5. **同尺寸**：不传 width/height 时插件会**自动跟随参考图尺寸**（8 的倍数）；要传就贴参考图长宽比，避免拉伸变形。\n' +
            '6. **验收**：`read_image` 同时看参考图与新图——线条、上色、光影、氛围四项是否同类；不一致就降 denoising 或补风格词，最多 2 轮。\n' +
            '7. seed：图生图里 denoising 与提示词的影响远大于 seed；要微调保留 seed，要换感觉就 -1。\n\n' +
            '## SD 提示词规则（重要）\n' +
            '- **英文标签式**，逗号分隔，权重从高到低排列：主体 > 外貌/服装 > 场景/背景 > 光影构图 > 质量词。例：`1girl, silver hair, red ribbon, school uniform, cherry blossoms, park, depth of field, masterpiece, best quality`。\n' +
            '- 结尾固定补质量词：`masterpiece, best quality, absurdres, highly detailed`；**写实摄影风**改用 `photorealistic, raw photo, 8k uhd, film grain`。\n' +
            '- **负面词**固定底噪：`lowres, bad anatomy, bad hands, extra fingers, fewer digits, watermark, text, signature, jpeg artifacts, worst quality, low quality`；人物图再加 `nsfw` 以外的内容按用户要求。\n' +
            '- 权重语法：`(word:1.3)` 提权，`(word:0.6)` 降权，`[word]` 等价 0.9；LoRA：`<lora:名称:0.8>`（名称用 `sd_models` 查，本机有国风山水、赛博朋克、东方美学等）。\n' +
            '- 中文需求 → 英文标签的映射：银发=**silver hair**、樱花=**cherry blossoms**、赛博朋克=**cyberpunk, neon lights, rain**、国风=**traditional Chinese style, ink wash painting**、写实人像=**portrait photo, studio lighting**。\n' +
            '- 尺寸规则：头像/方图 512x512，竖屏手机壁纸 512x1024（或 768x1344 之类 8 的倍数），横屏壁纸 1280x720，插画竖图 512x768。需要更高清再开 `enableHiresFix`。\n' +
            '- 步数 20-28 即可（默认 22），CFG 6-8；想要随机多样性 seed 用 -1，用户要求「再来一张」时可保持 seed 不变只改词。\n' +
            '- checkpoint 选择：动漫/插画 → AWPainting 或 ReVAnimated 或 anything-v5；写实 → majicMIX realistic；不指定就用当前默认（AWPainting）。\n' +
            '- **画质差先看模型**：`sd_models` 返回 `qualityHint` 说明本机只有新装默认的 SD1.5 base——先把「跑 install-sd.ps1 升级模型 + mse VAE」的建议告诉用户，再继续画；否则怎么写提示词都糊。\n\n' +
            '## 保存与命名\n' +
            '- 固定保存到 **%OUT%**，文件名 = `summary_序号.png`（如 `银发少女樱花_001.png`、`赛博朋克街景_002.png`），序号自动递增，同名总结不会覆盖。\n' +
            '- `sd_txt2img` 返回里的 `paths` 是绝对路径，`fileNames` 是文件名，`savedDir` 是目录。\n' +
            '- 用户自己手跑 `sd-direct.ps1` 时：SD 没开脚本会**自己把它拉起来**（按 `-SdDir`/`DSH_SD_DIR`/安装记录/扫盘找目录，首次含模型加载 1-3 分钟），**失败只报一条错误就退出**、不级联刷屏；图保存成功后还会**自动用默认看图器打开它**（批量跑加 `-NoOpen` 关掉）。\n\n' +
            '## 图生图参考图（重要）\n' +
            '- 用户在聊天里给的图（附件或本地路径）就是参考图：把**它的路径**原样传给 `sd_img2img` 的 `init_image`（B 档传 `sd_script` 的 `initImage`），**不要换成上一张生成图、不要换成你以为的同类图**。\n' +
            '- 插件会自动处理路径：用户给的图若在工作区之外（聊天附件临时目录），会复制一份到 **%REF%**（文件名 = 原名_内容哈希），脚本里的 `-InitImage` 指向这份固化副本，内容与用户给的图逐字节一致；工作区内的图直接用原路径。\n' +
            '- 回复里说明用的是哪张：`sd_img2img` 返回的 `source` 是脚本实际引用的路径、`sourceOriginal` 是用户原始给的路径。\n\n' +
            '## 蒙版重绘（sd_inpaint：只改一块，别整张重画）\n' +
            '1. **什么时候用**：补手修脸、去杂物、局部改色、换一块背景、以及 A 档想只把违规那块重画掉——只要「大部分画面要保住」，用蒙版而不是 `sd_img2img` 硬顶。\n' +
            '2. **蒙版怎么给**：有蒙版图就传 `mask`（**白色 / 不透明处 = 重绘区**，带透明通道的 PNG 按**不透明处**重绘）；没有就传 `maskBox: "x,y,w,h"`（相对左上角像素，`read_image` 看图估一下即可），插件自动造蒙版存进 %REF%，返回的 `mask` 与脚本里的 `-Mask` 都指向它。\n' +
            '3. **参数档位**：`denoisingStrength` 修瑕补全 0.40-0.55、换内容 0.65-0.80；`maskBlur` 4 起步，**接缝有硬边就调 8-16**；`inpaintingFill` 0=填充(默认)、1=保留原图、2=噪声（要凭空长出新东西用 2）、3=空；`inpaintFullRes` 默认 true + `inpaintFullResPadding` 32（边缘不自然加到 64）；`maskInvert` 用于「反过来改蒙版外面」。\n' +
            '4. **提示词只写要改的那块**（如 `flower crown, pink roses`），其余靠原图保留，别把整段场景词再抄一遍。\n' +
            '5. **自检（必做）**：`read_image` 同时看底图与结果——① 目标改到位没有 ② **接缝**有没有硬边/断层 ③ 重绘区与四周**色差** ④ 蒙版外有没有被误改；对应调 `maskBlur` / `padding` / `denoisingStrength` / `inpaintingFill`，最多 2 轮、每轮贴图说明。\n' +
            '6. **违规不变**：A 档可只把违规区域蒙版重画（比整张重画更保画风），改完照常自检、残留就重画；B 档不出图，只给 `sd_script`（它同样支持 `-Mask`）。\n\n' +
            '## 后台运行\n' +
            '- 生图在后台进程执行，你的回复不必等待解释：调用工具 → 贴 replyImages → 贴脚本 → 简短说明即可。\n' +
            '- 想让它空闲自动关：配置 `idleStopMinutes`；手动控制用 `sd_server`（status/start/stop）。\n',
          invocation: { modelInvocable: true, userInvocable: true },
          }),
        ),
      )
    } catch (error) {
      log('技能注册失败（不影响工具）：', error && error.message ? error.message : error)
    }
  }

  // 探测一次已运行的服务，仅记录状态，不启动任何东西。
  probeApi(3000).then((probe) => {
    if (probe.kind === 'ready') log('检测到已在运行的 SD API，将直接复用：', baseUrl())
  }).catch(() => {})

  ctx.effect(
    () =>
      () => {
        for (const dispose of disposers.splice(0)) {
          try {
            dispose()
          } catch {
            /* dispose 尽力而为 */
          }
        }
        if (state.idleTimer) {
          clearTimeout(state.idleTimer)
          state.idleTimer = null
        }
        // 插件卸载不主动杀 SD：用户可能还在用 WebUI 页面；sd_server stop 负责显式关闭。
      },
    'sd-bridge: tools',
  )

  log(
    `已挂载生图工具（sdDir=${cfg.sdDir || '未找到——生图时会返回安装指引'}, port=${cfg.port}, autoStart=${cfg.autoStart}, ` +
    `outputDir=${docLabels()['%OUT%']}）`,
  )
}

export { DEFAULTS, detectSdDir, cfg }
