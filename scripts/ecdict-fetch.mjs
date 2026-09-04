/**
 * ecdict-fetch.mjs — 一条龙装上 ECDICT 本地词典：下载 → 解压 → 构建索引
 *
 *   npm run ecdict:fetch
 *   node scripts/ecdict-fetch.mjs [--url=下载地址] [--data=目录] [--keep-zip]
 *
 * 默认从 GitHub Releases 取 ecdict-csv-28.zip（约 60MB，解压出的 csv 约 200MB），
 * 放到 data/，解压成 data/ecdict.csv，再编译成 data/ecdict/ 下的查询产物。
 * data/ecdict.csv 已经在了就跳过下载 —— 手动下载的人只要把 csv 放对位置就行。
 * 环境变量 ECDICT_URL 也能改下载地址（换镜像时用）。
 *
 * 零依赖：解 zip 是这里自己写的（只认 store / deflate 两种压缩方式，
 * 遇到 zip64 就提示手动解压），因为本项目装不了 npm 包。
 */

import fs   from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { buildEcdict } from './ecdict-build.mjs'
import { ecdictDir, ecdictEntry, resetEcdict } from '../server/ecdict.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** ECDICT 官方发布页的 csv 包；换版本改这里或者用 --url= */
const DEFAULT_URL = 'https://github.com/skywind3000/ECDICT/releases/download/1.0.28/ecdict-csv-28.zip'

const EOCD_SIG = 0x06054b50   // 中央目录结尾
const CD_SIG   = 0x02014b50   // 中央目录条目
const LFH_SIG  = 0x04034b50   // 单个文件头

function human(bytes) {
  const n = Number(bytes) || 0
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return (i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)) + units[i]
}

function zip64Error() {
  return new Error(
    '这个压缩包用了 zip64 格式，本脚本读不了：\n' +
    '请手动解压出 csv 放到 data/ecdict.csv，再跑 npm run ecdict:build'
  )
}

// ── 解 zip ────────────────────────────────────────────────────────────────

/** 从尾部倒着找 EOCD（zip 结尾注释最长 64KB，所以只看最后 65KB 就够） */
function findEocd(fd, size) {
  const len = Math.min(size, 66560)
  if (len < 22) throw new Error('文件太小，不是 zip')
  const buf = Buffer.allocUnsafe(len)
  fs.readSync(fd, buf, 0, len, size - len)
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue
    return { cdSize: buf.readUInt32LE(i + 12), cdOffset: buf.readUInt32LE(i + 16) }
  }
  throw new Error('这不像一个 zip 文件（找不到目录结尾标记）')
}

/** 遍历中央目录，挑第一个 .csv */
function locateCsv(fd, eocd) {
  if (eocd.cdSize === 0xffffffff || eocd.cdOffset === 0xffffffff) throw zip64Error()
  const cd = Buffer.allocUnsafe(eocd.cdSize)
  fs.readSync(fd, cd, 0, eocd.cdSize, eocd.cdOffset)
  let at = 0
  while (at + 46 <= cd.length && cd.readUInt32LE(at) === CD_SIG) {
    const method      = cd.readUInt16LE(at + 10)
    const compSize    = cd.readUInt32LE(at + 20)
    const rawSize     = cd.readUInt32LE(at + 24)
    const nameLen     = cd.readUInt16LE(at + 28)
    const extraLen    = cd.readUInt16LE(at + 30)
    const commentLen  = cd.readUInt16LE(at + 32)
    const localOffset = cd.readUInt32LE(at + 42)
    const name = cd.toString('utf8', at + 46, at + 46 + nameLen)
    at += 46 + nameLen + extraLen + commentLen
    if (!name.toLowerCase().endsWith('.csv')) continue
    // macOS 打的包里那份 __MACOSX 影子文件不是真数据
    if (name.startsWith('__MACOSX') || name.includes('/__MACOSX')) continue
    if (compSize === 0xffffffff || rawSize === 0xffffffff || localOffset === 0xffffffff) throw zip64Error()
    if (compSize === 0) throw new Error('压缩包里的 ' + name + ' 是空的')
    return { name, method, compSize, rawSize, localOffset }
  }
  throw new Error('压缩包里没找到 csv 文件')
}

/**
 * 把 zip 里第一个 csv 流式解到 outCsvPath（先写 .tmp 再改名）。
 * 单独导出一份，方便离线用小 zip 验证这段解压逻辑。
 */
export async function unzipFirstCsv(zipPath, outCsvPath) {
  const fd = fs.openSync(zipPath, 'r')
  let found
  try {
    const size = fs.fstatSync(fd).size
    found = locateCsv(fd, findEocd(fd, size))
    const head = Buffer.allocUnsafe(30)
    fs.readSync(fd, head, 0, 30, found.localOffset)
    if (head.readUInt32LE(0) !== LFH_SIG) throw new Error('压缩包结构异常（文件头标记不对）')
    // 真正的数据从「固定 30 字节 + 文件名 + 扩展字段」之后开始
    found.dataStart = found.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
  } finally {
    fs.closeSync(fd)
  }
  if (found.method !== 0 && found.method !== 8) {
    throw new Error('不支持的压缩方式 ' + found.method + '：请手动解压出 csv 放到 data/ecdict.csv')
  }

  const tmp = outCsvPath + '.tmp'
  fs.mkdirSync(path.dirname(outCsvPath), { recursive: true })
  const src = fs.createReadStream(zipPath, {
    start: found.dataStart,
    end: found.dataStart + found.compSize - 1,
  })
  const sink = fs.createWriteStream(tmp)
  if (found.method === 8) await pipeline(src, zlib.createInflateRaw(), sink)
  else await pipeline(src, sink)
  fs.renameSync(tmp, outCsvPath)
  return { name: found.name, bytes: fs.statSync(outCsvPath).size }
}

// ── 下载 ──────────────────────────────────────────────────────────────────

async function download(url, dest, onProgress) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'english-study/ecdict-fetch' },
  })
  if (!res.ok || !res.body) throw new Error('下载失败 HTTP ' + res.status + ' — ' + url)
  const total = Number(res.headers.get('content-length')) || 0
  const part = dest + '.part'
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  let got = 0
  const body = Readable.fromWeb(res.body)
  if (onProgress) body.on('data', chunk => { got += chunk.length; onProgress(got, total) })
  await pipeline(body, fs.createWriteStream(part))
  fs.renameSync(part, dest)
  return { bytes: got, total }
}

// ── CLI ───────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  let url = process.env.ECDICT_URL || DEFAULT_URL
  let dir = ''
  let keepZip = false
  for (const arg of argv) {
    if (arg.startsWith('--url=')) url = arg.slice(6)
    else if (arg.startsWith('--data=')) dir = arg.slice(7)
    else if (arg === '--keep-zip') keepZip = true
  }
  return { url, dir, keepZip }
}

function clearLine() { process.stdout.write('\r' + ' '.repeat(48) + '\r') }

async function main(argv) {
  const { url, dir, keepZip } = parseArgs(argv)
  const base = path.resolve(dir || path.join(__dirname, '../data'))
  const csv = path.join(base, 'ecdict.csv')
  const zip = path.join(base, 'ecdict.zip')
  const outDir = dir ? path.join(base, 'ecdict') : ecdictDir()

  if (fs.existsSync(csv)) {
    console.log('已有 ' + csv + '（' + human(fs.statSync(csv).size) + '），跳过下载')
  } else {
    if (fs.existsSync(zip)) {
      console.log('已有 ' + zip + '，跳过下载')
    } else {
      console.log('下载 ' + url)
      const got = await download(url, zip, (n, total) => {
        const done = total ? Math.floor(n / total * 100) + '% / ' + human(total) : human(n)
        process.stdout.write('\r  已下载 ' + done + '    ')
      })
      clearLine()
      console.log('下载完成 ' + human(got.bytes))
    }
    console.log('解压中…')
    const un = await unzipFirstCsv(zip, csv)
    console.log('解压完成 ' + un.name + ' → ' + human(un.bytes))
    if (!keepZip) {
      fs.rmSync(zip, { force: true })
      console.log('已删掉下载的压缩包（想留着下次加 --keep-zip）')
    }
  }

  console.log('构建索引…')
  const built = await buildEcdict({
    csv,
    outDir,
    onProgress: p => {
      const pct = p.totalBytes ? Math.floor(p.readBytes / p.totalBytes * 100) : 0
      process.stdout.write('\r  解析中 ' + pct + '%（已收 ' + p.rows + ' 条）    ')
    },
  })
  clearLine()
  console.log('本地词典就绪：' + built.count + ' 条词条 · ' + built.outDir)

  // 自检：查一个常见词，确认索引真的能用
  if (path.resolve(outDir) === path.resolve(ecdictDir())) {
    resetEcdict()
    const probe = ecdictEntry('apple')
    if (probe) console.log('自检 apple → ' + (probe.phonetic || '') + ' ' + (probe.translation || ''))
    else console.log('自检没查到 apple —— 数据源的列可能对不上，跑 npm run test:server 看看')
  }
  console.log('本地服务正在跑的话重启一下（npm run server），之后查词优先用本地词典。')
}

// 被 import 时不要自己跑起来（测试会 import unzipFirstCsv）
const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main(process.argv.slice(2)).catch(e => {
    clearLine()
    console.error('装本地词典失败：' + e.message)
    console.error('也可以手动下载 ' + DEFAULT_URL + ' 解压出 csv 放到 data/ecdict.csv，再跑 npm run ecdict:build')
    process.exit(1)
  })
}
