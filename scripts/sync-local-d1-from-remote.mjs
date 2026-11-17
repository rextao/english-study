/**
 * sync-local-d1-from-remote.mjs — 用远端 D1 的导出整体重刷本地 D1
 *
 * 流程：wrangler d1 export --remote 导出临时 SQL → 删掉本地同名表 → 分批导入。
 *
 * 为什么要自己切语句：Workers 的 D1 绑定限制**单条 SQL 文本 100 KB**，超过就报
 *   statement too long: SQLITE_TOOBIG
 * 而导出里的课堂录音分片（recite_recording_chunks.data_base64）一条就有 500 KB 左右，
 * 整份 dump 直接 --file 交给 wrangler 会在 prepare 阶段整批失败。
 * 这里的处理：把超长的 INSERT 拆成「先插前一块，再用 UPDATE … SET 列 = 列 || '块'
 * WHERE 主键 = … 把剩余各块拼回去」。D1 的 --file 会把所有语句塞进一次 batch，
 * 所以再按条数 / 体积分成多个文件逐个执行，避免一次几十万行卡死。
 *
 * 用法：npm run db:local:sync（需要 wrangler 已登录 Cloudflare）。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const database = 'english-study-sync'

/** D1 单条 SQL 文本上限 100 KB，留余量按 90 KB 切；单个字符串字面量按 80 KB 一块拆 */
const MAX_STATEMENT_BYTES = 90_000
const MAX_LITERAL_BYTES = 80_000
/** 单次 wrangler 调用最多塞多少语句 / 多少字节 */
const STATEMENTS_PER_FILE = 300
const FILE_BYTES = 2_000_000
/** 拆分超长 INSERT 的循环上限，防止异常 SQL 让切分停不下来 */
const MAX_SPLIT_ROUNDS = 10_000

const encoder = new TextEncoder()
const bytesOf = (text) => encoder.encode(text).length

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} 退出，code=${code ?? 'null'} signal=${signal ?? 'null'}`))
    })
  })
}

function sqlIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`
}

/** 去掉标识符两侧的引号（"a" / `a` / [a]），保留原文里的转义 */
function unquoteIdentifier(token) {
  const text = token.trim()
  if (text.length >= 2) {
    if (text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1).replaceAll('""', '"')
    if (text.startsWith('`') && text.endsWith('`')) return text.slice(1, -1).replaceAll('``', '`')
    if (text.startsWith('[') && text.endsWith(']')) return text.slice(1, -1)
  }
  return text
}

function quoteLiteral(text) {
  return `'${text.replaceAll("'", "''")}'`
}

/** 跳过一段带引号的文本（字符串字面量或带引号的标识符），返回结束位置之后的下标 */
function skipQuoted(sql, index) {
  const open = sql[index]
  const close = open === '[' ? ']' : open
  let i = index + 1
  while (i < sql.length) {
    if (sql[i] === close) {
      // SQLite 的字符串和标识符都用「连写两个引号」转义
      if (open !== '[' && sql[i + 1] === close) {
        i += 2
        continue
      }
      return i + 1
    }
    i += 1
  }
  return i
}

/** 若 index 处是注释则返回注释之后的下标，否则返回 -1 */
function commentEnd(sql, index) {
  if (sql[index] === '-' && sql[index + 1] === '-') {
    const end = sql.indexOf('\n', index)
    return end === -1 ? sql.length : end + 1
  }
  if (sql[index] === '/' && sql[index + 1] === '*') {
    const end = sql.indexOf('*/', index + 2)
    return end === -1 ? sql.length : end + 2
  }
  return -1
}

/** 只剩空白和注释的片段（文件末尾换行、分节注释）不发给 SQLite */
function isBlankStatement(statement) {
  let i = 0
  while (i < statement.length) {
    if (/\s/.test(statement[i])) {
      i += 1
      continue
    }
    const end = commentEnd(statement, i)
    if (end === -1) return false
    i = end
  }
  return true
}

/** 把一整份 SQL 文件切成单条语句：引号、注释里的分号都不算分隔符 */
export function splitStatements(sql) {
  const statements = []
  let start = 0
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      i = skipQuoted(sql, i)
      continue
    }
    const end = commentEnd(sql, i)
    if (end !== -1) {
      i = end
      continue
    }
    if (ch === ';') {
      statements.push(sql.slice(start, i + 1))
      start = i + 1
    }
    i += 1
  }
  statements.push(sql.slice(start))
  return statements.map((item) => item.trim()).filter((item) => !isBlankStatement(item))
}

/** 从 openIndex 处的左括号开始找配对的右括号，返回下标；括号在引号里不算 */
function findClosingParen(sql, openIndex) {
  let depth = 0
  let i = openIndex
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      i = skipQuoted(sql, i)
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i
    }
    i += 1
  }
  return -1
}

/** 按顶层逗号切开（括号里、引号里的逗号不算） */
function splitTopLevel(text) {
  const items = []
  let depth = 0
  let start = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      i = skipQuoted(text, i)
      continue
    }
    if (ch === '(') depth += 1
    else if (ch === ')') depth -= 1
    else if (ch === ',' && depth === 0) {
      items.push(text.slice(start, i))
      start = i + 1
    }
    i += 1
  }
  items.push(text.slice(start))
  return items
}

function valueOf(raw) {
  const text = raw.trim()
  if (text.startsWith("'")) {
    return { raw: text, kind: 'string', text: text.slice(1, -1).replaceAll("''", "'") }
  }
  if (/^[xX]'/.test(text)) return { raw: text, kind: 'blob', text: '' }
  return { raw: text, kind: 'other', text: '' }
}

/**
 * 解析 `INSERT INTO "表" ("列", …) VALUES (…);`，返回表名、列和每个顶层值。
 * 解析不了（多行 VALUES、带 ON CONFLICT 之类）就返回 null，交给调用方原样处理。
 */
export function parseInsert(statement) {
  const head = /^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][\w$]*)\s*\(/i.exec(statement)
  if (!head) return null
  const table = head[1]
  const columnsOpen = head[0].length - 1
  const columnsClose = findClosingParen(statement, columnsOpen)
  if (columnsClose === -1) return null
  const columns = splitTopLevel(statement.slice(columnsOpen + 1, columnsClose)).map((item) => ({
    raw: item.trim(),
    name: unquoteIdentifier(item),
  }))
  const valuesHead = /^\s*VALUES\s*\(/i.exec(statement.slice(columnsClose + 1))
  if (!valuesHead) return null
  const valuesOpen = columnsClose + 1 + valuesHead[0].length - 1
  const valuesClose = findClosingParen(statement, valuesOpen)
  if (valuesClose === -1) return null
  // 值列表后面只允许分号，别把 ON CONFLICT / RETURNING 之类一起改坏
  if (!/^\s*;?\s*$/.test(statement.slice(valuesClose + 1))) return null
  const values = splitTopLevel(statement.slice(valuesOpen + 1, valuesClose)).map(valueOf)
  if (values.length !== columns.length) return null
  return { table, columns, values }
}

/** 从 dump 的 CREATE TABLE 里读出每张表的主键列，超长 INSERT 拆开后靠它定位行 */
export function buildPrimaryKeys(statements) {
  const map = new Map()
  for (const statement of statements) {
    const head = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][\w$]*)\s*\(/i.exec(statement)
    if (!head) continue
    const openIndex = head[0].length - 1
    const closeIndex = findClosingParen(statement, openIndex)
    if (closeIndex === -1) continue
    const keys = []
    for (const def of splitTopLevel(statement.slice(openIndex + 1, closeIndex))) {
      const tableLevel = /^PRIMARY\s+KEY\s*\(([\s\S]*)\)/i.exec(def.trim())
      if (tableLevel) {
        keys.push(...splitTopLevel(tableLevel[1]).map((item) => unquoteIdentifier(item)))
        continue
      }
      if (/\bPRIMARY\s+KEY\b/i.test(def)) {
        keys.push(unquoteIdentifier(def.trim().split(/\s+/)[0]))
      }
    }
    if (keys.length) map.set(unquoteIdentifier(head[1]), keys)
  }
  return map
}

function buildResetSql(statements) {
  const tableNames = statements
    .map((statement) => /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]|[A-Za-z_][\w$]*)/i.exec(statement))
    .map((match) => (match ? unquoteIdentifier(match[1]) : null))
    .filter((name, index, names) => name && names.indexOf(name) === index)
    .reverse()

  return [
    'PRAGMA foreign_keys=OFF;',
    ...tableNames.map((name) => `DROP TABLE IF EXISTS ${sqlIdentifier(name)};`),
    'PRAGMA foreign_keys=ON;',
    '',
  ].join('\n')
}

/** 按「编成 SQL 字面量后的字节数」把长文本切块，注意别把代理对切成两半 */
function splitLiteral(text) {
  const pieces = []
  let current = ''
  let size = 2 // 两侧单引号
  for (const char of text) {
    const cost = bytesOf(char) + (char === "'" ? 1 : 0)
    if (current && size + cost > MAX_LITERAL_BYTES) {
      pieces.push(current)
      current = ''
      size = 2
    }
    current += char
    size += cost
  }
  pieces.push(current)
  return pieces
}

/** 拆出来的 UPDATE 靠主键指回同一行（没有主键的表退回 rowid，紧跟前面的 INSERT） */
function buildRowPredicate(insert, primaryKeyColumns) {
  if (!primaryKeyColumns || primaryKeyColumns.length === 0) return 'rowid = last_insert_rowid()'
  const parts = []
  for (const key of primaryKeyColumns) {
    const index = insert.columns.findIndex((column) => column.name === key)
    if (index === -1) return null
    parts.push(`${sqlIdentifier(key)} IS ${insert.values[index].raw}`)
  }
  return parts.join(' AND ')
}

/**
 * 单条语句超限时拆成多条：INSERT 只写第一块，剩余各块用
 * `UPDATE … SET 列 = 列 || '块' WHERE 主键 …` 拼回去。
 * 拆不了（不是简单 INSERT、没有可拆的字符串、不知道主键）返回 null。
 */
export function splitOversizedStatement(statement, primaryKeys) {
  const insert = parseInsert(statement)
  if (!insert) return null
  let target = null
  for (const value of insert.values) {
    if (value.kind !== 'string') continue
    if (!target || value.text.length > target.text.length) target = value
  }
  if (!target || bytesOf(target.raw) <= MAX_LITERAL_BYTES) return null
  const where = buildRowPredicate(insert, primaryKeys.get(unquoteIdentifier(insert.table)))
  if (!where) return null
  const column = insert.columns[insert.values.indexOf(target)]
  const pieces = splitLiteral(target.text)
  const statements = [
    `INSERT INTO ${insert.table} (${insert.columns.map((item) => item.raw).join(',')}) VALUES (`
      + insert.values.map((value) => (value === target ? quoteLiteral(pieces[0]) : value.raw)).join(',')
      + ');',
  ]
  for (const piece of pieces.slice(1)) {
    statements.push(
      `UPDATE ${insert.table} SET ${column.raw} = ${column.raw} || ${quoteLiteral(piece)} WHERE ${where};`,
    )
  }
  return statements
}

/** 把超长语句拆到全部低于上限；返回语句数组和拆分统计 */
export function chunkStatements(statements, primaryKeys) {
  const output = []
  const pending = [...statements]
  let split = 0
  let rounds = 0
  while (pending.length) {
    rounds += 1
    if (rounds > MAX_SPLIT_ROUNDS) throw new Error('拆分超长 SQL 语句时循环次数超限，请检查导出内容')
    const statement = pending.shift()
    if (bytesOf(statement) <= MAX_STATEMENT_BYTES) {
      output.push(statement)
      continue
    }
    const parts = splitOversizedStatement(statement, primaryKeys)
    if (!parts) {
      // 拆不动的原样交回去：wrangler 会报 statement too long，至少能看出是哪条
      output.push(statement)
      continue
    }
    split += 1
    pending.unshift(...parts)
  }
  return { statements: output, split }
}

/** 按条数 / 体积把语句切成多个 SQL 文件，减少单次 wrangler 调用的 batch 规模 */
export function chunkFiles(statements, directory, prefix = 'import') {
  const files = []
  let current = []
  let bytes = 0
  const flush = () => {
    const path = join(directory, `${prefix}-${files.length + 1}.sql`)
    files.push({ path, content: current.join('\n') })
    current = []
    bytes = 0
  }
  for (const statement of statements) {
    const size = bytesOf(statement) + 1
    if (current.length && (current.length >= STATEMENTS_PER_FILE || bytes + size > FILE_BYTES)) flush()
    current.push(statement)
    bytes += size
  }
  if (current.length) flush()
  return files
}

export async function main() {
  const tempDir = await mkdtemp(join(tmpdir(), 'english-study-d1-'))
  const dumpPath = join(tempDir, 'remote-dump.sql')
  const resetPath = join(tempDir, 'reset-local.sql')

  try {
    console.log('正在导出远端 D1 数据库...')
    await run('npx', [
      'wrangler',
      'd1',
      'export',
      database,
      '--remote',
      '--skip-confirmation',
      '--output',
      dumpPath,
    ])

    // 先跑一条无害语句，确保本地库（.wrangler/state）已经建好
    await run('npx', [
      'wrangler',
      'd1',
      'execute',
      database,
      '--local',
      '--yes',
      '--command',
      'SELECT 1',
    ])

    const dumpStatements = splitStatements(await readFile(dumpPath, 'utf8'))
    const primaryKeys = buildPrimaryKeys(dumpStatements)
    const { statements, split } = chunkStatements(dumpStatements, primaryKeys)
    if (split > 0) {
      console.log(`已把 ${split} 条超过 100 KB 的语句拆成小块（D1 单条 SQL 上限）。`)
    }

    await writeFile(resetPath, buildResetSql(dumpStatements))

    console.log('正在重置本地 D1 表结构...')
    await run('npx', [
      'wrangler',
      'd1',
      'execute',
      database,
      '--local',
      '--yes',
      '--file',
      resetPath,
    ])

    const files = chunkFiles(statements, tempDir)
    for (const [index, file] of files.entries()) {
      console.log(`正在导入本地 D1 数据库（${index + 1}/${files.length}）...`)
      await writeFile(file.path, file.content)
      await run('npx', [
        'wrangler',
        'd1',
        'execute',
        database,
        '--local',
        '--yes',
        '--file',
        file.path,
      ])
    }

    console.log('远端 D1 已同步到本地 D1。')
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

// 直接执行时才跑主流程；被 import 时只暴露内部函数，方便单独验证切分逻辑
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main()
}
