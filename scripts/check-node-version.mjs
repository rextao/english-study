import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const requiredVersion = (await readFile(join(projectRoot, '.nvmrc'), 'utf8')).trim().replace(/^v/, '')
const requiredMajor = Number.parseInt(requiredVersion.split('.')[0], 10)
const currentVersion = process.versions.node
const currentMajor = Number.parseInt(currentVersion.split('.')[0], 10)

if (currentMajor !== requiredMajor) {
  console.error(`Node.js 版本不符合项目要求：当前为 v${currentVersion}，项目要求 Node ${requiredMajor}.x（推荐 v${requiredVersion}）。`)
  console.error('请先切换 Node 版本后再运行 npm run dev，例如：nvm use')
  process.exit(1)
}

console.log(`Node.js 版本检查通过：v${currentVersion}（项目要求 Node ${requiredMajor}.x）。`)
