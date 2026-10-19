import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const inputPath = path.join(root, 'vocab', 'my_words.csv')
const outputPath = path.join(root, 'worker', 'src', 'my-words-data.js')

function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"' && field.length === 0) {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      row.push(field)
      field = ''
      if (char === '\r' && text[i + 1] === '\n') i++
      if (row.some(value => value !== '')) rows.push(row)
      row = []
    } else {
      field += char
    }
  }

  if (quoted) throw new Error('my_words.csv 包含未闭合的引号')
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    if (row.some(value => value !== '')) rows.push(row)
  }
  return rows
}

function normalizeWord(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
}

const csv = fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, '')
const rows = parseCsv(csv)
const header = rows.shift() || []
const columns = Object.fromEntries(header.map((name, index) => [name, index]))
if (columns.word === undefined || columns.translation === undefined) {
  throw new Error('my_words.csv 必须包含 word 和 translation 列')
}

const entries = {}
for (const row of rows) {
  const word = normalizeWord(row[columns.word])
  const translation = String(row[columns.translation] ?? '').trim()
  if (!word || !translation) continue
  if (entries[word]) throw new Error('my_words.csv 存在重复词条：' + word)
  entries[word] = [
    String(row[columns.phonetic] ?? '').trim(),
    translation,
    String(row[columns.definition] ?? '').trim(),
  ]
}

const source = [
  '// 由 scripts/build-my-words.mjs 根据 vocab/my_words.csv 生成，请勿手工修改。',
  '// 只保留查词所需的音标、中文词义和英文释义，避免 Worker 每次请求解析 CSV。',
  'export const MY_WORDS = Object.freeze(' + JSON.stringify(entries) + ')',
  'export const MY_WORDS_COUNT = ' + Object.keys(entries).length,
  '',
].join('\n')
fs.writeFileSync(outputPath, source)
console.log('已生成 worker/src/my-words-data.js：' + Object.keys(entries).length + ' 条词条')
