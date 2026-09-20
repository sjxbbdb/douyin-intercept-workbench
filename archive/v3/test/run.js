'use strict'
const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')

// 分层定义：name 用于输出，dir 用于发现测试文件，optional 表示缺目录时不算失败
const LAYERS = [
  { id: 'L1', name: '单元测试',        dir: 'test/unit' },
  { id: 'L2', name: '契约测试',        dir: 'test/contract' },
  { id: 'L3', name: '离线 DOM 回归',   dir: 'test/dom' },
  { id: 'L4', name: '集成测试',        dir: 'test/integration', optional: true },
]

function collectTests(dir) {
  const abs = path.join(ROOT, dir)
  if (!fs.existsSync(abs)) return []
  return fs.readdirSync(abs)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => path.join(abs, f))
}

function main() {
  const only = process.argv[2]              // node test/run.js L3
  const summary = []

  for (const layer of LAYERS) {
    if (only && layer.id !== only) continue
    const files = collectTests(layer.dir)
    if (!files.length) {
      if (!layer.optional) summary.push({ ...layer, status: 'EMPTY', code: 1 })
      else summary.push({ ...layer, status: 'SKIP', code: 0 })
      continue
    }
    // 用子进程跑 node:test，隔离每个测试文件的全局状态
    const r = spawnSync(process.execPath, ['--test', ...files], {
      cwd: ROOT, encoding: 'utf8', stdio: 'inherit',
    })
    summary.push({ ...layer, status: r.status === 0 ? 'PASS' : 'FAIL', code: r.status || 0 })
    if (r.status !== 0) break        // 快速失败
  }

  console.log('\n' + '='.repeat(56))
  for (const s of summary) console.log(`${s.id} ${s.name.padEnd(14)} ${s.status}`)
  console.log('='.repeat(56))
  const failed = summary.some((s) => s.code !== 0)
  console.log(failed ? '❌ 存在失败项' : '✅ 全部通过（注意：L5 真机验证与 L6 长稳不在此入口内）')
  process.exit(failed ? 1 : 0)
}

main()