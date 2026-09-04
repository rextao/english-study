/**
 * ecdict-build.mjs — 把 ECDICT 的 csv 编译成 server/ecdict.mjs 能查的产物
 *
 *   node scripts/ecdict-build.mjs [csv 路径] [--out=产物目录]
 *
 * 默认读 data/ecdict.csv，写到 data/ecdict/（或 DICT_ECDICT_DIR）。
 * 全程流式：原始 csv 有 200MB 也只占几十 MB 内存。
 * 产物先写 *.tmp 再改名，records → index → meta 依次落地，
 * meta 最后写——中途崩掉运行中的服务不会读到半成品。
 */

import fs   from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import {
  STORE_FORMAT, STORE_FILES, RECORD_COLUMNS, INDEX_RECORD_SIZE,
  ecdictDir, ecdictKey, hashKey, encodeField,
} from '../server/ecdict.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** 没有表头时按这个列序解析（ECDICT 官方 csv 就是这个顺序） */
const DEFAULT_COLUMNS = [
  'word', 'phonetic', 'definition', 'translation', 'pos', 'collins', 'oxford',
  'tag', 'bnc', 'frq', 'exchange', 'detail', 'audio',
]

/** 只留这几列，其余（collins / oxford / bnc / detail / audio）背单词用不上 */
const WANTED = ['word', 'phonetic', 'definition', 'translation', 'exchange', 'tag', 'frq']

/** 攒够这么多字节才写一次盘 */
const WRITE_CHUNK = 4 * 1024 * 1024

// ── csv 扫描器 ────────────────────────────────────────────────────────────

/**
 * 够用的 RFC4180 解析器：支持引号包裹、"" 转义、字段里带逗号和换行。
 * 逐字符 += 太慢（200MB 要几十秒），所以用 charCodeAt 扫到分隔符再整段 slice。
 * 分隔符：44 = ',' 10 = '\n' 13 = '\r' 34 = '"'
 */
function createCsvScanner(onRow) {
  let field = ''
  let row = []
  let inQuotes = false
  let quotePending = false   // 引号里遇到 "，还不知道是转义还是收尾

  const endField = () => { row.push(field); field = '' }
  const endRow = () => { endField(); const done = row; row = []; onRow(done) }

  return {
    push(text) {
      const n = text.length
      let i = 0
      while (i < n) {
        if (inQuotes) {
          if (quotePending) {
            quotePending = false
            if (text.charCodeAt(i) === 34) { field += '"'; i++; continue }
            inQuotes = false
            continue   // 引号段结束，这个字符交给下面的非引号分支
          }
          let j = i
          while (j < n && text.charCodeAt(j) !== 34) j++
          if (j > i) {
            let seg = text.slice(i, j)
            if (seg.indexOf('\r') >= 0) seg = seg.replace(/\r/g, '')   // 字段内的 CRLF 归一成 LF
            field += seg
          }
          i = j
          if (i < n) { quotePending = true; i++ }
          continue
        }

        let j = i
        while (j < n) {
          const c = text.charCodeAt(j)
          if (c === 44 || c === 10 || c === 13 || c === 34) break
          j++
        }
        if (j > i) { field += text.slice(i, j); i = j }
        if (i >= n) break
        const c = text.charCodeAt(i)
        i++
        if (c === 44) { endField(); continue }
        if (c === 10) { endRow(); continue }
        if (c === 13) continue                              // CRLF 的前半个，直接扔
        if (field === '') inQuotes = true                   // 只有字段开头的引号才算引用
        else field += '"'
      }
    },
    end() {
      quotePending = false
      inQuotes = false
      if (field !== '' || row.length > 0) endRow()
    },
  }
}

/** 按表头名字定位需要的列；没有 word 这个表头就返回 null（说明首行是数据） */
function resolveColumns(row) {
  const lower = row.map(c => String(c ?? '').trim().toLowerCase())
  if (!lower.includes('word')) return null
  const idx = {}
  for (const name of WANTED) {
    const at = lower.indexOf(name)
    if (at >= 0) idx[name] = at
  }
  return idx
}

function defaultColumns() {
  const idx = {}
  for (const name of WANTED) {
    const at = DEFAULT_COLUMNS.indexOf(name)
    if (at >= 0) idx[name] = at
  }
  return idx
}

/** ECDICT 的多义项是字面量 \n 两个字符，还原成真换行 */
function unescapeNewlines(value) {
  const s = String(value ?? '')
  if (s.indexOf('\\') < 0) return s
  return s.replace(/\\r\\n|\\n|\\r/g, '\n')
}

// ── 构建 ──────────────────────────────────────────────────────────────────

/**
 * @param {{ csv?: string, outDir?: string, onProgress?: (p: object) => void }} [options]
 * @returns 产物 meta + { outDir, skipped, bytes, lines }
 */
export async function buildEcdict(options) {
  const opts = options || {}
  const csv = path.resolve(opts.csv || path.join(__dirname, '../data/ecdict.csv'))
  const outDir = path.resolve(opts.outDir || ecdictDir())
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null

  const stat = fs.statSync(csv, { throwIfNoEntry: false })
  if (!stat || !stat.isFile()) {
    throw new Error(
      '找不到 ECDICT 数据文件：' + csv +
      '\n先跑 npm run ecdict:fetch 下载，或者手动把 ecdict.csv 放到这个位置再跑 npm run ecdict:build'
    )
  }

  fs.mkdirSync(outDir, { recursive: true })
  const recordsTmp = path.join(outDir, STORE_FILES.records + '.tmp')
  const indexTmp   = path.join(outDir, STORE_FILES.index + '.tmp')
  const metaTmp    = path.join(outDir, STORE_FILES.meta + '.tmp')

  const out = fs.createWriteStream(recordsTmp)
  // 平行数组存索引，比几十万个小对象省内存也快得多
  const h1s = [], h2s = [], offs = [], lens = [], scores = []
  const slotOf = new Map()
  let columns = null
  let offset = 0, skipped = 0, lines = 0
  let pending = [], pendingBytes = 0, needDrain = false

  const flush = () => {
    if (pending.length === 0) return
    const text = pending.join('')
    pending = []
    pendingBytes = 0
    if (!out.write(text)) needDrain = true
  }

  const onRow = raw => {
    lines++
    if (columns === null) {
      const resolved = resolveColumns(raw)
      if (resolved) { columns = resolved; return }   // 这行是表头
      columns = defaultColumns()                     // 没表头，首行也是数据，继续往下走
    }
    const pick = name => {
      const at = columns[name]
      return at === undefined ? '' : unescapeNewlines(raw[at]).trim()
    }

    const word = pick('word')
    const key = ecdictKey(word)
    if (!key) { skipped++; return }

    const translation = pick('translation')
    const definition  = pick('definition')
    // 同一个词出现多次时留信息更全的那条
    const score = (translation ? 2 : 0) + (definition ? 1 : 0)

    const line = [
      key, word, pick('phonetic'), translation, definition,
      pick('exchange'), pick('tag'), pick('frq'),
    ].map(encodeField).join('\t') + '\n'
    const len = Buffer.byteLength(line, 'utf8')
    if (offset + len > 0xFFFFFFFF) throw new Error('records.tsv 超过 4GB，索引存不下这么大的偏移量')

    const seen = slotOf.get(key)
    if (seen !== undefined) {
      const better = score > scores[seen] || (score === scores[seen] && len > lens[seen])
      if (!better) { skipped++; return }
      // 索引改指新行，旧行留在文件里当垃圾（不影响查询）
      scores[seen] = score
      offs[seen] = offset
      lens[seen] = len
    } else {
      const [h1, h2] = hashKey(key)
      slotOf.set(key, h1s.length)
      h1s.push(h1); h2s.push(h2); offs.push(offset); lens.push(len); scores.push(score)
    }

    pending.push(line)
    pendingBytes += len
    offset += len
    if (pendingBytes >= WRITE_CHUNK) flush()
  }

  const scanner = createCsvScanner(onRow)
  const decoder = new TextDecoder('utf8')
  const stream = fs.createReadStream(csv)
  let readBytes = 0, lastReport = 0
  let streamError = null
  out.on('error', e => { streamError = e })

  for await (const chunk of stream) {
    readBytes += chunk.length
    scanner.push(decoder.decode(chunk, { stream: true }))
    if (needDrain) { needDrain = false; await once(out, 'drain') }
    if (streamError) throw streamError
    if (onProgress) {
      const now = Date.now()
      if (now - lastReport > 800) {
        lastReport = now
        onProgress({ rows: h1s.length, readBytes, totalBytes: stat.size })
      }
    }
  }
  const tail = decoder.decode()
  if (tail) scanner.push(tail)
  scanner.end()
  flush()
  await new Promise((go, fail) => {
    out.on('error', fail)
    out.end(go)
  })

  // 索引按 (h1,h2) 升序排；uint32 直接相减会溢出成负数，所以逐段比大小
  const count = h1s.length
  const order = new Uint32Array(count)
  for (let i = 0; i < count; i++) order[i] = i
  order.sort((x, y) => {
    if (h1s[x] !== h1s[y]) return h1s[x] < h1s[y] ? -1 : 1
    if (h2s[x] !== h2s[y]) return h2s[x] < h2s[y] ? -1 : 1
    return x - y
  })

  const index = Buffer.allocUnsafe(count * INDEX_RECORD_SIZE)
  for (let i = 0; i < count; i++) {
    const slot = order[i]
    const at = i * INDEX_RECORD_SIZE
    index.writeUInt32BE(h1s[slot], at)
    index.writeUInt32BE(h2s[slot], at + 4)
    index.writeUInt32BE(offs[slot], at + 8)
    index.writeUInt32BE(lens[slot], at + 12)
  }
  fs.writeFileSync(indexTmp, index)

  const meta = {
    format: STORE_FORMAT,
    count,
    builtAt: Date.now(),
    source: path.basename(csv),
    sourceBytes: stat.size,
    columns: RECORD_COLUMNS,
  }
  fs.writeFileSync(metaTmp, JSON.stringify(meta, null, 2), 'utf8')

  fs.renameSync(recordsTmp, path.join(outDir, STORE_FILES.records))
  fs.renameSync(indexTmp,   path.join(outDir, STORE_FILES.index))
  fs.renameSync(metaTmp,    path.join(outDir, STORE_FILES.meta))

  return Object.assign({}, meta, { outDir, skipped, bytes: offset, lines })
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let csv = ''
  let outDir = ''
  for (const arg of argv) {
    if (arg.startsWith('--out=')) outDir = arg.slice(6)
    else if (!arg.startsWith('-') && !csv) csv = arg
  }
  return { csv, outDir }
}

// 被 import 时不要自己跑起来（测试会 import buildEcdict）
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const { csv, outDir } = parseArgs(process.argv.slice(2))
  buildEcdict({
    csv: csv || undefined,
    outDir: outDir || undefined,
    onProgress: p => {
      const pct = p.totalBytes ? Math.floor(p.readBytes / p.totalBytes * 100) : 0
      process.stdout.write('\r  解析中 ' + pct + '%（已收 ' + p.rows + ' 条）    ')
    },
  }).then(r => {
    process.stdout.write('\r' + ' '.repeat(44) + '\r')
    console.log('本地词典构建完成：' + r.count + ' 条词条，跳过 ' + r.skipped + ' 行')
    console.log('产物目录：' + r.outDir)
    console.log('重启本地服务（npm run server）后生效。')
  }).catch(e => {
    console.error('\n构建失败：' + e.message)
    process.exit(1)
  })
}
