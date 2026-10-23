import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const database = 'english-study-sync'

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

const tempDir = await mkdtemp(join(tmpdir(), 'english-study-d1-'))
const dumpPath = join(tempDir, 'remote-dump.sql')
const resetPath = join(tempDir, 'reset-local.sql')

function sqlIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`
}

function buildResetSql(dump) {
  const tableNames = [...dump.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/gi)]
    .map((match) => match[1] ?? match[2])
    .filter((name, index, names) => names.indexOf(name) === index)
    .reverse()

  return [
    'PRAGMA foreign_keys=OFF;',
    ...tableNames.map((name) => `DROP TABLE IF EXISTS ${sqlIdentifier(name)};`),
    'PRAGMA foreign_keys=ON;',
    '',
  ].join('\n')
}

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

  await writeFile(resetPath, buildResetSql(await readFile(dumpPath, 'utf8')))

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

  console.log('正在导入本地 D1 数据库...')
  await run('npx', [
    'wrangler',
    'd1',
    'execute',
    database,
    '--local',
    '--yes',
    '--file',
    dumpPath,
  ])

  console.log('远端 D1 已同步到本地 D1。')
} finally {
  await rm(tempDir, { recursive: true, force: true })
}
