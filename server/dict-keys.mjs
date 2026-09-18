/**
 * dict-keys.mjs — 查词链路里需要密钥的外部接口（目前只有百度翻译）
 *
 * 密钥不能放进 cache/study-history.sqlite：那个库是要提交到 git 跨设备共享的，会把密钥
 * 一起泄露。所以单独放在 cache/dict-keys.json，.gitignore 里 cache/* 整个被忽略，
 * 只有本机自己能读到。
 *
 * 覆盖规则：文件里显式写过的属性覆盖环境变量（.env.local 的 BAIDU_TRANSLATE_API_KEY /
 * BAIDU_TRANSLATE_APP_ID），没写过的回落到环境变量。这样「在设置页填一个新 key」和
 * 「继续用 .env.local」两种方式互不干扰；「清除」= 删掉文件里的覆盖项，自动回到环境变量。
 * 文件里写空串也算「明确禁用」，不再回落环境变量——要关掉百度翻译就这么干。
 */
import fs from 'node:fs'
import path from 'node:path'

const FILE_NAME = 'dict-keys.json'
/** 单个密钥最长多少字符，拦一下误粘贴成整段配置文件的情况 */
const MAX_VALUE_LEN = 200

export function dictKeysFile(dataDir) {
  return path.join(dataDir, FILE_NAME)
}

/** 每次都现读：文件极小，省掉失效逻辑，设置页改完立刻生效，不用重启服务 */
function readRaw(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(dictKeysFile(dataDir), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    // 文件不存在（没配置过）或内容损坏都当成「没有覆盖项」，回落到环境变量
    if (error.code !== 'ENOENT') console.warn('[dict-keys] 配置文件读取失败，忽略文件配置:', error.message)
    return {}
  }
}

/** 密钥本体绝不回给前端，只留后 4 位让用户确认当前配的是哪一个 */
export function maskSecret(value) {
  return typeof value === 'string' && value.length > 0 ? '••••' + value.slice(-4) : ''
}

/**
 * 百度翻译实际使用的密钥：文件覆盖 > 环境变量。
 * hasOwn 检查让「文件里写了空串」也能真正关掉百度翻译，而不是回落到环境变量。
 */
export function baiduKeys(dataDir) {
  const file = readRaw(dataDir)
  const apiKey = Object.hasOwn(file, 'baiduApiKey') && typeof file.baiduApiKey === 'string'
    ? file.baiduApiKey
    : (process.env.BAIDU_TRANSLATE_API_KEY || '')
  const appId = Object.hasOwn(file, 'baiduAppId') && typeof file.baiduAppId === 'string'
    ? file.baiduAppId
    : (process.env.BAIDU_TRANSLATE_APP_ID || '')
  return { apiKey, appId }
}

/** /api/dict/sources 和 PUT /api/dict/keys 用：不暴露密钥本体，只给「有没有」和脱敏预览 */
export function baiduKeyStatus(dataDir) {
  const { apiKey, appId } = baiduKeys(dataDir)
  return {
    hasKey: apiKey.length > 0,
    hasAppId: appId.length > 0,
    keyHint: maskSecret(apiKey),
    appIdHint: maskSecret(appId),
  }
}

/**
 * 合并写入覆盖项：字符串 = 覆盖（去首尾空白），null = 删除覆盖项回落环境变量。
 * 非法输入抛错，由接口层回 400。
 */
export function writeDictKeys(dataDir, patch) {
  const next = { ...readRaw(dataDir) }
  for (const [field, value] of Object.entries(patch)) {
    if (field !== 'baiduApiKey' && field !== 'baiduAppId') throw new Error('不支持的配置项：' + field)
    if (value === null) { delete next[field]; continue }
    if (typeof value !== 'string') throw new Error(field + ' 必须是字符串')
    const trimmed = value.trim()
    if (!trimmed) throw new Error('密钥不能为空；要停用请点「清除」')
    if (trimmed.length > MAX_VALUE_LEN) throw new Error('密钥长度超过上限（' + MAX_VALUE_LEN + ' 字符）')
    next[field] = trimmed
  }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(dictKeysFile(dataDir), JSON.stringify(next, null, 2) + '\n')
  return baiduKeyStatus(dataDir)
}
