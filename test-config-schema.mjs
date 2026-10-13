// 插件 Config 专项（0.2.x）：Config 声明、volatile 字段、面板改动实时生效、越界钳制（不出图）
//
// 背景：0.2.x 的 settings 服务（SettingsForms）**没有 register()**，设置面板改由
// Loader 读插件导出的 `Config` schema，把 `.volatile()` 字段投影成表单。这个测试
// 同时覆盖「解析得到 schemastery」与「解析不到、优雅降级为 undefined」两条分支。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

fs.mkdtempSync(path.join(os.tmpdir(), 'sd-guard-config-'))

const tools = []
const ctx = {
  logger: { log: () => {} },
  effect: (fn) => fn(),
  // 故意**不提供** settings 服务：0.2.x 下由 Loader 投影，不再走 settings.register
  get: (key) => (key === 'skills' ? { register: () => () => {} } : undefined),
  tools: { register: (def) => (tools.push(def), () => {}) },
}

const mod = await import('./sd-bridge.js')
const { Config, DEFAULTS } = mod

assert.ok(
  Config === undefined || Config['~standard']?.vendor === 'schemastery',
  'Config 要么是 schemastery schema，要么 undefined（解析不到时优雅降级）',
)

if (Config === undefined) {
  console.log('schemastery 不可用 → Config = undefined（优雅降级，与旧行为一致）')
} else {
  const dict = Config.dict ?? {}
  const keys = Object.keys(dict)
  for (const key of Object.keys(DEFAULTS)) {
    assert.ok(keys.includes(key), `Config 缺字段：${key}`)
    assert.equal(dict[key].meta?.volatile, true, `${key} 必须标 .volatile()，否则设置面板看不到它`)
    assert.deepEqual(dict[key].meta?.default, DEFAULTS[key], `${key} 的 schema 默认值必须与 DEFAULTS 一致`)
  }

  // Loader 交给 apply 的形状：每个 volatile 字段都是一个引用对象
  const parsed = Config({})
  for (const key of Object.keys(DEFAULTS)) {
    const ref = parsed[key]
    assert.ok(ref && typeof ref.get === 'function', `${key} 解析后应是 volatile 引用`)
    assert.deepEqual(ref.get(), DEFAULTS[key], `${key} 引用初始值 = schema 默认值`)
  }
  // 历史 patch 里可能留着已经删掉的键，不能因此抛错、更不能让插件激活失败
  assert.doesNotThrow(() => Config({ unknownLegacyKey: 1 }), '未知键不能让校验炸掉')

  mod.apply(ctx, parsed)

  // 解包正确性：cfg 里必须是裸值，不能是引用对象
  assert.equal(typeof mod.cfg.port, 'number', 'cfg.port 必须是数字（volatile 引用已被解包）')
  assert.equal(mod.cfg.port, 7860, 'cfg.port 默认 7860')
  assert.equal(mod.cfg.autoStart, true, 'cfg.autoStart 默认 true')
  assert.equal(typeof mod.cfg.sdDir, 'string', 'cfg.sdDir 必须是字符串')
  assert.equal(typeof mod.cfg.idleStopMinutes, 'number', 'cfg.idleStopMinutes 必须是数字')
  assert.equal(mod.cfg.enabled, true, 'cfg.enabled 默认 true')

  // 面板改动 = Loader 原地 commit 新值进引用 → cfg 下一次读取即生效（不重挂插件）
  const write = Symbol.for('cosmokit.volatile.write')
  parsed.port[write](9999)
  parsed.idleStopMinutes[write](-3)
  parsed.outputDir[write]('MyPics')
  parsed.img2imgDenoising[write](5)
  parsed.startupTimeoutMs[write](10)
  assert.equal(mod.cfg.port, 9999, '面板改 port 必须即时生效')
  assert.equal(mod.cfg.outputDir, 'MyPics', '面板改 outputDir 必须即时生效')
  assert.equal(mod.cfg.idleStopMinutes, 0, '负数要被钳到 0')
  assert.equal(mod.cfg.img2imgDenoising, 1, 'denoising 越界要被钳到 1')
  assert.equal(mod.cfg.startupTimeoutMs, 30000, 'startupTimeoutMs 下限 30s')

  // 写了 Config 之后工具照样注册齐全
  assert.ok(tools.length >= 6, `六个工具都要注册（实际 ${tools.length}）`)
}

console.log('Config =', Config === undefined ? 'undefined（降级）' : `${Object.keys(Config.dict).length} 个 volatile 字段`)
console.log('CONFIG SCHEMA OK')
