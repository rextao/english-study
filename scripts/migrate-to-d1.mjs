#!/usr/bin/env node
/**
 * migrate-to-d1.mjs — 本地 study-history.sqlite 一次性迁入 Cloudflare D1
 *
 * 本地库与 worker/schema.sql 的表名、列名完全一致（lists / list_words /
 * learning_events / learning_event_meanings / meaning_profiles / kv / dict_cache），
 * 所以就是「读本地行 → 生成 INSERT SQL → wrangler d1 execute 进 D1」。
 *
 * 用法（需能连外网）：
 *   1. npm run migrate:to-d1            # 生成 migration.sql（默认写到仓库根）
 *   2. npx wrangler d1 execute english-study-sync --remote --file=worker/schema.sql
 *   3. npx wrangler d1 execute english-study-sync --remote --file=migration.sql
 *   4. npx wrangler secret put API_TOKEN
 *      npx wrangler secret put BAIDU_TRANSLATE_API_KEY
 *      npx wrangler secret put BAIDU_TRANSLATE_APP_ID
 *
 * 参数：--db <路径>（默认 cache/study-history.sqlite）、--out <路径>（默认 migration.sql）
 * 重复执行安全：脚本开头先 DELETE 各表，整体可重跑（幂等）。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
function argOf(name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const dbPath = path.resolve(argOf('--db', path.join(repoRoot, 'cache/study-history.sqlite')))
const outPath = path.resolve(argOf('--out', path.join(repoRoot, 'migration.sql')))

const TABLES = [
  'lists', 'list_words', 'meaning_profiles', 'learning_events',
  'learning_event_meanings', 'kv', 'dict_cache',
]
// 单条 multi-row INSERT 最多多少行；D1 单语句默认 100KB 上限，批量小一点更稳
const CHUNK_ROWS = 40

if (!fs.existsSync(dbPath)) {
  console.error('找不到本地数据库：' + dbPath)
  process.exit(1)
}

const db = new DatabaseSync(dbPath, { readOnly: true })

/** SQL 字符串字面量转义；NULL 直接返回 NULL */
function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  return "'" + String(value).replace(/'/g, "''") + "'"
}

const out = []
out.push('-- 由 scripts/migrate-to-d1.mjs 生成于 ' + new Date().toISOString())
out.push('-- 源库：' + dbPath)
out.push('-- 可重复执行：先清空目标表再插入')
out.push('PRAGMA defer_foreign_keys = true;')
for (const table of [...TABLES].reverse()) out.push('DELETE FROM ' + table + ';')

let totalRows = 0
for (const table of TABLES) {
  const columns = db.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name)
  const rows = db.prepare('SELECT * FROM ' + table).all()
  if (rows.length === 0) {
    console.log(table.padEnd(28), '0 行，跳过')
    continue
  }
  const columnList = '(' + columns.join(', ') + ')'
  for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
    const chunk = rows.slice(i, i + CHUNK_ROWS)
    const values = chunk.map(row =>
      '(' + columns.map(column => sqlValue(row[column])).join(', ') + ')')
    out.push('INSERT INTO ' + table + ' ' + columnList + ' VALUES\n  ' + values.join(',\n  ') + ';')
  }
  totalRows += rows.length
  console.log(table.padEnd(28), rows.length, '行')
}

out.push('PRAGMA defer_foreign_keys = false;')
fs.writeFileSync(outPath, out.join('\n') + '\n', 'utf8')
console.log('')
console.log('共', totalRows, '行 ->', outPath)
console.log('')
console.log('后续步骤：')
console.log('  npx wrangler d1 execute english-study-sync --remote --file=worker/schema.sql')
console.log('  npx wrangler d1 execute english-study-sync --remote --file=' + path.relative(repoRoot, outPath))
console.log('  npx wrangler secret put API_TOKEN')
console.log('  npx wrangler secret put BAIDU_TRANSLATE_API_KEY')
console.log('  npx wrangler secret put BAIDU_TRANSLATE_APP_ID')
console.log('  npm run deploy')
