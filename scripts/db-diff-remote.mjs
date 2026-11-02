/**
 * db-diff-remote.mjs — 本地 D1 与远端 D1 的轻量一致性体检
 *
 * 用同一条聚合 SQL 分别取本地库（.wrangler/state，npm run dev 读写的那份快照）
 * 与远端库（Cloudflare english-study-sync）的「指纹」：各表行数 + 关键最新时间戳。
 * 对齐输出差异，让本地快照与线上的漂移一目了然，避免拿旧数据调试却找不到原因。
 *
 * 用法：
 *   npm run db:diff                 手动体检（脚本失败时退出码 1，差异本身不算失败）
 *   node scripts/db-diff-remote.mjs --startup   npm run dev 启动时用：失败/超时只提示一行，不阻塞启动
 *
 * 远端访问走 npx wrangler d1 execute --remote，要求已登录 Cloudflare（npx wrangler login）；
 * 本地库用 node:sqlite 只读打开，要求 Node 24+。
 * 本脚本不修改任何一端的数据；要重刷本地库请用 npm run db:local:sync。
 */
import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATABASE = 'english-study-sync'
const LOCAL_DIR = join(PROJECT_ROOT, '.wrangler/state/v3/d1/miniflare-D1DatabaseObject')
const STARTUP = process.argv.slice(2).includes('--startup')
const REMOTE_TIMEOUT = STARTUP ? 20_000 : 60_000

/**
 * 指纹指标：t=表名，k=指标名，agg=聚合表达式，where=可选过滤条件（拼到 FROM table 之后），
 * time=值是否毫秒时间戳。
 * 行数能发现「有没有新数据」，最新时间戳能发现「落后了多少」，两者结合足够定位漂移方向。
 */
const SPECS = [
  { t: 'lists', k: 'rows', agg: 'COUNT(*)', time: false },
  { t: 'lists', k: 'latest_created', agg: 'MAX(created_at)', time: true },
  { t: 'list_words', k: 'rows', agg: 'COUNT(*)', time: false },
  { t: 'list_words', k: 'in_study', agg: 'COUNT(*)', where: 'started_at IS NOT NULL', time: false },
  { t: 'list_words', k: 'active', agg: 'COUNT(*)', where: 'started_at IS NOT NULL AND suspended_at IS NULL', time: false },
  { t: 'list_words', k: 'suspended', agg: 'COUNT(*)', where: 'suspended_at IS NOT NULL', time: false },
  { t: 'list_words', k: 'latest_added', agg: 'MAX(added_at)', time: true },
  { t: 'list_words', k: 'latest_started', agg: 'MAX(started_at)', time: true },
  { t: 'list_words', k: 'latest_done', agg: 'MAX(last_done_at)', time: true },
  { t: 'learning_events', k: 'rows', agg: 'COUNT(*)', time: false },
  { t: 'learning_events', k: 'active', agg: 'COUNT(*)', where: 'deleted_at IS NULL', time: false },
  { t: 'learning_events', k: 'latest', agg: 'MAX(occurred_at)', time: true },
  { t: 'meaning_profiles', k: 'rows', agg: 'COUNT(*)', time: false },
  { t: 'learning_event_meanings', k: 'rows', agg: 'COUNT(*)', time: false },
  { t: 'study_tally_operations', k: 'rows', agg: 'COUNT(*)', time: false },
  { t: 'kv', k: 'rows', agg: 'COUNT(*)', time: false },
  { t: 'kv', k: 'latest_updated', agg: 'MAX(updated_at)', time: true },
  { t: 'kv', k: 'keys', agg: "GROUP_CONCAT(key, ', ')", time: false },
  { t: 'dict_cache', k: 'rows', agg: 'COUNT(*)', time: false },
  { t: 'dict_cache', k: 'complete', agg: 'COUNT(*)', where: "status = 'ok'", time: false },
]

const FINGERPRINT_SQL = SPECS.map((spec, index) => (
  (index ? 'UNION ALL ' : '') +
  `SELECT '${spec.t}' AS t, '${spec.k}' AS k, ${spec.agg} AS v FROM ${spec.t}${spec.where ? ' WHERE ' + spec.where : ''}`
)).join('\n')

function formatValue(spec, value) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') return value
  if (spec && spec.time) {
    const date = new Date(Number(value))
    if (Number.isFinite(date.getTime())) {
      return (date.getMonth() + 1) + '/' + date.getDate() + ' '
        + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
    }
  }
  return String(value)
}

/** 取 mtime 最新的本地 D1 文件；metadata.sqlite 是 miniflare 的元数据表，不是业务库 */
function findLocalDb() {
  let names
  try {
    names = readdirSync(LOCAL_DIR).filter(name => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
  } catch {
    return null
  }
  const sorted = names
    .map(name => ({ name, mtime: statSync(join(LOCAL_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return sorted.length ? join(LOCAL_DIR, sorted[0].name) : null
}

function readLocalFingerprint(path) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare(FINGERPRINT_SQL).all()
  } finally {
    db.close()
  }
}

/** 把 wrangler 的英文报错翻成可操作的中文提示 */
function friendlyWranglerError(stderr) {
  const text = stderr || ''
  if (/auth token has expired|could not be refreshed/i.test(text)) {
    return 'Cloudflare 登录令牌已过期且无法联网刷新，请检查网络后重新 npx wrangler login'
  }
  if (/not authenticated|not logged in|authenticate/i.test(text)) {
    return 'wrangler 未登录 Cloudflare，先跑 npx wrangler login'
  }
  if (/fetch failed|ENOTFOUND|ETIMEDOUT|getaddrinfo|network is down/i.test(text)) {
    return '无法连接网络或 Cloudflare API 不可达'
  }
  if (/requires at least Node\.js/i.test(text)) {
    return '运行 wrangler 的 Node 版本太低（wrangler 需要 v22+），请确认在 Node 24 下执行'
  }
  return null
}

/**
 * wrangler 退出码非 0 时把真实原因挑出来：优先 --json 输出里的 error.text，
 * 其次才是 stderr（里面混着 npm notice 和日志文件写入失败的噪声）。
 */
function describeWranglerFailure(stdout, stderr) {
  try {
    const parsed = JSON.parse(stdout)
    const text = parsed && parsed.error && parsed.error.text
    if (typeof text === 'string' && text) return text
  } catch {
    // stdout 不是 JSON，走 stderr
  }
  const lines = (stderr || '').split('\n')
    .map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
    .filter(line => line && !/^npm (notice|warn)/.test(line) && !/\.log/i.test(line))
  return lines.slice(0, 2).join(' ') || null
}

function readRemoteFingerprint() {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn('npx', ['--yes', 'wrangler', 'd1', 'execute', DATABASE,
      '--remote', '--json', '--command', FINGERPRINT_SQL], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('远端查询超时（超过 ' + (REMOTE_TIMEOUT / 1000) + ' 秒）'))
    }, REMOTE_TIMEOUT)
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timer)
      reject(new Error('无法启动 wrangler（' + error.message + '），检查 Node 与 npx 是否可用'))
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) {
        const hint = friendlyWranglerError(stdout + '\n' + stderr)
        const tail = describeWranglerFailure(stdout, stderr)
        reject(new Error(hint || ('wrangler 退出 code=' + code + (tail ? '：' + tail : ''))))
        return
      }
      try {
        const parsed = JSON.parse(stdout)
        const rows = parsed && parsed[0] && parsed[0].results
        if (!Array.isArray(rows)) throw new Error('results 不是数组')
        resolve(rows)
      } catch (error) {
        reject(new Error('解析 wrangler --json 输出失败（' + error.message + '）'))
      }
    })
  })
}

/** 表格里的长文本（如 kv 的 keys 列表）截断，完整值仍会出现在差异明细里 */
function truncate(value) {
  const text = String(value)
  return text.length > 24 ? text.slice(0, 23) + '…' : text
}

/** 差值翻成人话：时间戳指标说「远端新/旧 X 天」，计数指标直接显示 ±N */
function describeDelta(diff) {
  if (diff.spec && diff.spec.time && typeof diff.lv === 'number' && typeof diff.rv === 'number' && diff.lv !== diff.rv) {
    const ms = diff.rv - diff.lv
    const abs = Math.abs(ms)
    const span = abs >= 86_400_000 ? (abs / 86_400_000).toFixed(1) + ' 天' : (abs / 3_600_000).toFixed(1) + ' 小时'
    return '（远端' + (ms > 0 ? '新 ' : '旧 ') + span + '）'
  }
  if (typeof diff.lv === 'number' && typeof diff.rv === 'number') {
    return '（' + (diff.rv > diff.lv ? '+' : '') + (diff.rv - diff.lv) + '）'
  }
  return ''
}

export function report(localRows, remoteRows, localPath) {
  const local = new Map(localRows.map(row => [row.t + ' · ' + row.k, row]))
  const remote = new Map(remoteRows.map(row => [row.t + ' · ' + row.k, row]))
  const labelOf = spec => spec.t + ' · ' + spec.k
  console.log('本地 D1：' + localPath.replace(PROJECT_ROOT + '/', ''))
  console.log('远端 D1：' + DATABASE + '（--remote）')
  console.log('')
  const diffs = []
  const lines = []
  for (const key of [...new Set([...local.keys(), ...remote.keys()])]) {
    const spec = SPECS.find(item => labelOf(item) === key)
    const lv = local.get(key) ? local.get(key).v : null
    const rv = remote.get(key) ? remote.get(key).v : null
    const lt = formatValue(spec, lv)
    const rt = formatValue(spec, rv)
    const same = String(lv ?? '') === String(rv ?? '')
    lines.push('  ' + key.padEnd(28) + truncate(lt).padEnd(16) + truncate(rt) + (same ? '' : '   ⚠'))
    if (!same) diffs.push({ key, lv, rv, lt, rt, spec })
  }
  console.log('  ' + '指标'.padEnd(28) + '本地'.padEnd(16) + '远端')
  for (const line of lines) console.log(line)
  console.log('')
  if (diffs.length === 0) {
    console.log('✓ 本地 D1 与远端一致（各表行数与最新时间戳全部相同）。')
    return
  }
  console.log('⚠ 与远端不一致，共 ' + diffs.length + ' 项：')
  for (const diff of diffs) {
    console.log('   • ' + diff.key + '：本地 ' + diff.lt + ' → 远端 ' + diff.rt + ' ' + describeDelta(diff))
  }
  const num = value => typeof value === 'number' ? value : 0
  const behind = diffs.some(diff => (
    (diff.key.startsWith('list_words') || diff.key.startsWith('learning_events'))
    && num(diff.rv) > num(diff.lv)
  ))
  const ahead = diffs.some(diff => diff.key.startsWith('list_words') && num(diff.lv) > num(diff.rv))
  console.log('')
  if (behind) {
    console.log('本地库落后于远端：远端有本地没有的新进度，继续调试会停留在旧数据上。')
    console.log('建议先重刷本地库：npm run db:local:sync（会用远端数据整体替换本地库）。')
  } else if (ahead) {
    console.log('本地库有远端没有的数据（dev 改动尚未上线），上线前留意别被覆盖。')
    console.log('要回到线上状态：npm run db:local:sync。')
  } else {
    console.log('两边各有增减，按上面差异判断以哪边为准；要重刷本地库：npm run db:local:sync。')
  }
}

async function main() {
  if (Number.parseInt(process.versions.node.split('.')[0], 10) < 24) {
    const msg = 'Node 版本为 v' + process.versions.node + '，本脚本需要 Node 24+（node:sqlite），请先 nvm use。'
    if (STARTUP) { console.log('· 跳过远端对比：' + msg); return }
    console.error('✗ ' + msg)
    process.exit(1)
  }
  const localPath = findLocalDb()
  if (!localPath) {
    const msg = '本地 D1 未找到（' + LOCAL_DIR.replace(PROJECT_ROOT + '/', '') + '），先运行 npm run dev 或 npm run db:local:sync 生成。'
    if (STARTUP) { console.log('· 跳过远端对比：' + msg); return }
    console.error('✗ ' + msg)
    process.exit(1)
  }
  let localRows
  try {
    localRows = readLocalFingerprint(localPath)
  } catch (error) {
    const msg = '读取本地库失败（' + (error && error.message) + '），可能是本地 schema 过期，试试 npm run db:local:sync。'
    if (STARTUP) { console.log('· 跳过远端对比：' + msg); return }
    console.error('✗ ' + msg)
    process.exit(1)
  }
  let remoteRows
  try {
    remoteRows = await readRemoteFingerprint()
  } catch (error) {
    if (STARTUP) {
      console.log('· 跳过远端对比：' + (error && error.message) + '（手动执行 npm run db:diff 可重试）')
      return
    }
    console.error('✗ ' + (error && error.message))
    process.exit(1)
  }
  report(localRows, remoteRows, localPath)
}

// 直接执行时才跑主流程；被 import 时只暴露内部函数，方便单独验证报表渲染
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main()

