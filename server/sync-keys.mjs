/**
 * sync-keys.mjs — 云端同步服务的地址和令牌
 *
 * 和百度翻译密钥同样的处理：放在 cache/sync-keys.json（cache/* 被 gitignore，
 * 只本机可读），绝不写进 cache/study-history.sqlite——那个库是要提交共享的，
 * 令牌跟着库走就泄露了。环境变量 SYNC_WORKER_URL / SYNC_WORKER_TOKEN 作为回落，
 * 可以写在 .env.local 里。
 *
 * 覆盖规则与 dict-keys 一致：文件里显式写过的属性覆盖环境变量；
 * 清除 = 删掉文件里的覆盖项，自动回到环境变量。
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE_NAME = 'sync-keys.json'
/** 令牌 / 地址长度上限，拦一下误粘贴整段配置的情况 */
const MAX_VALUE_LEN = 500

export function syncKeysFile(dataDir) {
  return path.join(dataDir, FILE_NAME)
}

/** 每次都现读：文件极小，设置页改完立刻生效，不用重启服务 */
function readRaw(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncKeysFile(dataDir), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[sync-keys] 配置文件读取失败，忽略文件配置:', error.message)
    return {}
  }
}

function pickFile(file, envValue, field) {
  if (Object.hasOwn(file, field) && typeof file[field] === 'string') return file[field]
  return typeof envValue === 'string' ? envValue : ''
}

/**
 * 同步实际使用的配置：文件覆盖 > 环境变量。
 * deviceLabel 是「这台机器叫什么」，推送到云端后会显示，方便用户分辨是谁推的。
 */
export function syncKeys(dataDir) {
  const file = readRaw(dataDir)
  return {
    url: pickFile(file, process.env.SYNC_WORKER_URL, 'url').trim(),
    token: pickFile(file, process.env.SYNC_WORKER_TOKEN, 'token').trim(),
    deviceLabel: pickFile(file, process.env.SYNC_DEVICE_LABEL, 'deviceLabel').trim(),
  }
}

/** 给前端看的脱敏状态：令牌只留后 4 位，地址不脱敏（它要显示在界面上） */
export function syncKeyStatus(dataDir) {
  const { url, token, deviceLabel } = syncKeys(dataDir)
  return {
    url,
    hasToken: token.length > 0,
    tokenHint: maskSecret(token),
    deviceLabel,
    configured: url.length > 0,
  }
}

export function maskSecret(value) {
  return typeof value === 'string' && value.length > 0 ? '••••' + value.slice(-4) : ''
}

/** 简单校验同步地址：必须是 http(s) 开头，避免填成文件路径或随便一段字 */
function normalizeUrl(value) {
  const trimmed = String(value).trim()
  if (!trimmed) return ''
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('同步地址必须以 http:// 或 https:// 开头')
  if (trimmed.length > MAX_VALUE_LEN) throw new Error('同步地址过长')
  return trimmed
}

/**
 * 合并写入覆盖项：字符串 = 覆盖（去首尾空白），null = 删除覆盖项回落环境变量。
 * 空串等于「明确留空」（比如清掉设备名），非法输入抛错，由接口层回 400。
 */
export function writeSyncKeys(dataDir, patch) {
  const next = { ...readRaw(dataDir) }
  for (const [field, value] of Object.entries(patch)) {
    if (field !== 'url' && field !== 'token' && field !== 'deviceLabel') {
      throw new Error('不支持的配置项：' + field)
    }
    if (value === null) { delete next[field]; continue }
    if (typeof value !== 'string') throw new Error(field + ' 必须是字符串')
    if (field === 'url') {
      next.url = normalizeUrl(value)
      continue
    }
    const trimmed = value.trim()
    if (field === 'token' && !trimmed) throw new Error('令牌不能为空；要停用同步请清空同步地址')
    if (trimmed.length > MAX_VALUE_LEN) throw new Error(field + ' 长度超过上限（' + MAX_VALUE_LEN + ' 字符）')
    next[field] = trimmed
  }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(syncKeysFile(dataDir), JSON.stringify(next, null, 2) + '\n')
  return syncKeyStatus(dataDir)
}
