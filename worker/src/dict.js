/**
 * dict.js — 词典链路（云端版：缓存 → dictionaryapi.dev → 百度翻译）
 *
 * 从 dict-server.mjs 移植。与本地版的差异：
 *  - 没有本地 ECDICT：localEntry / staleAgainstLocal / fillFromLocal 整条岔路删掉，
 *    链路只剩「缓存 → 外部接口」；旧缓存（source 不是 ecdict）本来就是外部结果，无需升级；
 *  - 词条缓存不再常驻内存，每次按需读 D1（按词 IN 查询），写走 batch；
 *  - 请求超时用 AbortController（Workers 原生支持）。
 */

import { normalizeText, capitalizeSentence } from './text.js'

// ── 容量上限（与本地版一致） ────────────────────────────────────────────────

/** 单个词性最多保留多少条释义 */
export const MAX_SENSES_PER_POS = 12
/** 一个词条最多缓存多少条释义（缓存存全集，够挑就行） */
export const MAX_SENSES = 40
/** 批量查询页一次最多处理 200 个去重后的单词或句子，与前端预览上限一致。 */
export const MAX_BATCH_SEARCH_ITEMS = 200
/** 控制外部接口并发，避免批量导入时瞬间触发免费词典或百度限流。 */
export const BATCH_SEARCH_CONCURRENCY = 2

// ── 释义展示与拆分工具 ──────────────────────────────────────────────────────

const TRANSLATION_POS_LABELS = {
  noun: 'n.', n: 'n.', verb: 'v.', v: 'v.', vt: 'vt.', vi: 'vi.',
  adjective: 'a.', adj: 'a.', adverb: 'ad.', adv: 'ad.',
  preposition: 'prep.', prep: 'prep.', conjunction: 'conj.', conj: 'conj.',
  pronoun: 'pron.', pron: 'pron.', interjection: 'int.', int: 'int.',
}

export function translationPosLabel(pos) {
  const value = String(pos ?? '').trim().toLowerCase().replace(/\.$/, '')
  return TRANSLATION_POS_LABELS[value] || (value ? value + '.' : '')
}

export function splitTranslationGroups(text) {
  return String(text ?? '').split(/[；;]\s*(?=[a-zA-Z]{1,8}\.\s*)/).map(value => value.trim()).filter(Boolean)
}

export function translationParts(text, fallbackPos) {
  return splitTranslationGroups(text).flatMap(group => {
    const match = /^([a-zA-Z]{1,8})\.\s*(.+)$/.exec(group)
    const pos = match ? match[1].toLowerCase() : String(fallbackPos ?? '').trim()
    const body = match ? match[2] : group
    return body.split(/[，,]/).map(value => ({ text: value.trim(), pos })).filter(item => item.text)
  })
}

export function expandedTranslations(choices) {
  let previousPos = ''
  return (Array.isArray(choices) ? choices : []).flatMap(item => {
    const parts = translationParts(item?.text, item?.pos || previousPos)
    const lastPart = parts[parts.length - 1]
    if (lastPart?.pos) previousPos = lastPart.pos
    return parts.map((part, index) => ({ id: parts.length === 1 ? item.id : item.id + '::' + index, ...part }))
  })
}

export function formatSelectedTranslations(options) {
  const groups = []
  for (const option of options) {
    const text = String(option?.text ?? '').trim()
    if (!text) continue
    const pos = String(option?.pos ?? '').trim().toLowerCase()
    let group = groups.find(item => item.pos === pos)
    if (!group) { group = { pos, texts: [] }; groups.push(group) }
    if (!group.texts.includes(text)) group.texts.push(text)
  }
  return groups.filter(group => group.texts.length > 0)
    .map(group => (group.pos ? translationPosLabel(group.pos) + ' ' : '') + group.texts.join(','))
    .join('；')
}

// ── 缓存词条 ────────────────────────────────────────────────────────────────

/** 含空白 = 短语或句子，dictionaryapi.dev 查不到，别浪费一次请求 */
export function isPhrase(word) { return /\s/.test(word) }

/**
 * 句子直接走百度翻译；短的固定短语（例如 a few）仍按普通词条查询。
 */
export function isSentence(word) {
  const parts = normalizeText(word).split(/\s+/).filter(Boolean)
  return parts.length >= 3 || /[.!?！？。；;]/.test(word)
}

/**
 * 译文至少要包含中文；百度返回错误提示或原文时不写入缓存。
 */
export function isBadTranslation(text, word) {
  const t = String(text ?? '').trim()
  if (!t) return true
  if (t.toLowerCase() === word) return true
  return !/[\u4e00-\u9fff]/.test(t)
}

/**
 * 缓存里的词条统一长这样：
 *   { word, phonetic?, translation?, senses: [{ id, pos, definition }], cachedAt, status }
 *
 * senses 是拍平后的「释义全集」；sense.id = 词性 + '#' + 序号，重抓后 id 依然对得上。
 * status: ok = 音标/释义/中文都拿到了；partial = 有一部分没拿到，下次还要再试。
 * spellingStatus: valid = 词典明确命中；suspect = 免费词典明确 404；
 *                 unknown = 网络异常等原因尚未确认；unchecked = 含空格的句子或短语不校验。
 */
export function normalizeEntry(word, raw, app) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const w = normalizeText(word || src.word)
  const phonetic = String(src.phonetic ?? '').trim() || undefined
  const translation = String(src.translation ?? '').trim() || undefined
  const translations = []
  const translationTexts = new Set()
  let previousTranslationPos = ''
  const pushTranslation = (text, pos, source) => {
    const values = translationParts(text, pos || previousTranslationPos)
    const lastValue = values[values.length - 1]
    if (lastValue?.pos) previousTranslationPos = lastValue.pos
    for (const value of values) {
      const key = value.pos + '\u0000' + value.text
      if (translationTexts.has(key) || translations.length >= MAX_SENSES) continue
      translationTexts.add(key)
      translations.push({
        id: 'translation#' + translations.length,
        text: value.text,
        ...(value.pos ? { pos: value.pos } : {}),
        ...(source === 'api' ? { source } : {}),
      })
    }
  }
  if (Array.isArray(src.translations)) {
    for (const item of src.translations) {
      if (typeof item === 'string') pushTranslation(item, undefined, src.source)
      else pushTranslation(item?.text, item?.pos, item?.source || src.source)
    }
  }
  // 兼容旧缓存：旧 translation 是摘要，作为一个不可拆分的候选保留。
  if (translations.length === 0 && translation) pushTranslation(translation, undefined, src.source)
  // translation 是兼容旧缓存和卡片的摘要，保留来源提供的原始摘要（例如词性前缀）；
  // translations 则是给用户逐条勾选的中文候选，不把展示信息混回摘要。
  const normalizedTranslation = translation || (translations.length > 0
    ? formatSelectedTranslations(translations)
    : undefined)

  const senses = []
  const seats = {}
  const push = (pos, definition) => {
    const text = String(definition ?? '').trim()
    if (!text || senses.length >= MAX_SENSES) return
    const key = String(pos ?? '').trim() || 'other'
    const seat = seats[key] ?? 0
    if (seat >= MAX_SENSES_PER_POS) return
    seats[key] = seat + 1
    senses.push({ id: key + '#' + seat, pos: key, definition: text })
  }
  if (Array.isArray(src.senses)) {
    for (const s of src.senses) push(s?.pos, s?.definition)
  } else if (Array.isArray(src.meanings)) {
    // 老缓存格式 { partOfSpeech, definitions: [] }；例句字段（examples）读进来就丢掉
    for (const m of src.meanings) {
      const defs = Array.isArray(m?.definitions) ? m.definitions : []
      for (const d of defs) push(m?.partOfSpeech, d)
    }
  }

  const dictOk = isPhrase(w) || !!phonetic || senses.length > 0
  const status = src.status === 'ok' || src.status === 'partial'
    ? src.status
    : (dictOk && normalizedTranslation ? 'ok' : 'partial')

  const validPhoneticStatuses = new Set(['complete', 'partial', 'missing'])
  const phoneticStatus = validPhoneticStatuses.has(src.phoneticStatus)
    ? src.phoneticStatus
    : (phonetic ? 'complete' : 'missing')
  const validTranslationStatuses = new Set(['ok', 'error', 'missing'])
  const translationStatus = validTranslationStatuses.has(src.translationStatus)
    ? src.translationStatus
    : (normalizedTranslation ? 'ok' : 'missing')
  const validSpellingStatuses = new Set(['valid', 'suspect', 'unchecked', 'unknown'])
  let spellingStatus
  if (isPhrase(w)) spellingStatus = 'unchecked'
  else if (validSpellingStatuses.has(src.spellingStatus)) spellingStatus = src.spellingStatus
  // 兼容旧缓存：旧外部词典结果有音标或英文释义时视为明确命中
  else if (src.source === 'ecdict' || (src.source === 'api' && (phonetic || senses.length > 0))) spellingStatus = 'valid'
  else spellingStatus = 'unknown'
  const errors = []
  const validErrorCodes = new Set(['timeout', 'http_error', 'network_error', 'invalid_response', 'not_found', 'not_configured'])
  if (Array.isArray(src.errors)) {
    for (const item of src.errors.slice(0, 20)) {
      const source = item?.source === 'baidu' || item?.source === 'dictionaryapi' ? item.source : null
      const code = validErrorCodes.has(item?.code) ? item.code : null
      const message = String(item?.message ?? '').trim()
      if (!source || !code || !message) continue
      errors.push({
        source,
        code,
        message,
        ...(Number.isInteger(item?.status) ? { status: item.status } : {}),
        ...(String(item?.target ?? '').trim() ? { target: String(item.target).trim() } : {}),
      })
    }
  }

  // 固定字段顺序；候选数组按输入顺序生成，ID 从 translation#0 开始且可跨重抓结果复用。
  for (let i = 0; i < translations.length; i++) translations[i].id = 'translation#' + i

  const entry = { word: w }
  if (phonetic) entry.phonetic = phonetic
  if (normalizedTranslation) entry.translation = normalizedTranslation
  if (translations.length > 0) entry.translations = translations
  entry.senses = senses
  entry.cachedAt = Number(src.cachedAt) || Date.now()
  entry.status = status
  entry.phoneticStatus = phoneticStatus
  entry.translationStatus = translationStatus
  entry.spellingStatus = spellingStatus
  if (errors.length > 0) entry.errors = errors
  // 这条释义是哪个外部接口给的，界面上要标一下（ecdict 来源只存在于迁移过来的旧数据里）
  if (src.source === 'ecdict' || src.source === 'api') entry.source = src.source
  // 句子翻译来源单独记录，避免旧缓存（即使 status=ok）绕过百度翻译。
  if (src.translationSource === 'baidu') entry.translationSource = 'baidu'
  return entry
}

// ── 网络请求 ────────────────────────────────────────────────────────────────

function networkTimeoutMs(app) {
  return Math.max(1000, Number(app.env.DICT_NETWORK_TIMEOUT_MS) || 10000)
}

export function makeNetworkError(source, code, status, app) {
  const messages = {
    timeout: '请求超时（超过 ' + Math.round(networkTimeoutMs(app) / 1000) + ' 秒）',
    http_error: '请求失败（HTTP ' + status + '）',
    network_error: '网络请求失败',
    invalid_response: '返回格式无效',
    not_found: '未找到词条',
    not_configured: '未完整配置百度翻译 API Key 和 App ID',
  }
  const error = new Error(messages[code] || '请求失败')
  error.source = source
  error.code = code
  if (Number.isInteger(status)) error.status = status
  return error
}

export function publicNetworkError(error, source, target) {
  const actualSource = error?.source === 'baidu' || error?.source === 'dictionaryapi'
    ? error.source
    : source
  const code = ['timeout', 'http_error', 'network_error', 'invalid_response', 'not_found', 'not_configured'].includes(error?.code)
    ? error.code
    : 'network_error'
  const result = {
    source: actualSource,
    code,
    message: error?.message || '请求失败',
  }
  if (Number.isInteger(error?.status)) result.status = error.status
  if (String(target ?? '').trim()) result.target = String(target).trim()
  return result
}

async function fetchJson(url, options = {}, app) {
  const source = options.source === 'baidu' ? 'baidu' : 'dictionaryapi'
  const requestOptions = { ...options }
  delete requestOptions.source
  const controller = new AbortController()
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(makeNetworkError(source, 'timeout', undefined, app))
    }, networkTimeoutMs(app))
  })
  try {
    const request = fetch(url, { ...requestOptions, signal: controller.signal })
    const res = await Promise.race([request, timeout])
    if (!res.ok) {
      throw makeNetworkError(source, res.status === 404 ? 'not_found' : 'http_error', res.status, app)
    }
    try {
      return await res.json()
    } catch {
      throw makeNetworkError(source, 'invalid_response', undefined, app)
    }
  } catch (error) {
    if (error?.source && error?.code) throw error
    if (error?.name === 'AbortError') throw makeNetworkError(source, 'timeout', undefined, app)
    throw makeNetworkError(source, 'network_error', undefined, app)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 句子没有可直接查询的整句音标，所以按单词查音标再按原句拼回去。
 * 每个单词都打 dictionaryapi.dev（云端没有本地词典可先查）。
 */
async function fetchSentencePhonetic(text, app) {
  const matches = [...String(text).matchAll(/[A-Za-z]+(?:['’][A-Za-z]+)*/g)]
  if (matches.length === 0) return { phonetic: undefined, complete: false, missing: [], errors: [] }

  const tokens = [...new Set(matches.map(match => match[0].toLowerCase()))]
  const phonetics = new Map()
  const missing = []
  const errors = []
  await Promise.all(tokens.map(async token => {
    if (app.config.noNetwork) { missing.push(token); return }
    try {
      const data = await fetchJson(
        'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(token),
        { source: 'dictionaryapi' },
        app,
      )
      const entry = Array.isArray(data) ? data[0] : null
      const phonetic = entry?.phonetic || entry?.phonetics?.find(item => item.text)?.text
      if (phonetic) phonetics.set(token, phonetic)
      else {
        missing.push(token)
        errors.push(publicNetworkError(makeNetworkError('dictionaryapi', 'invalid_response', undefined, app), 'dictionaryapi', token))
      }
    } catch (e) {
      // 单个单词查不到只影响这一处音标，不能阻塞整句翻译。
      missing.push(token)
      errors.push(publicNetworkError(e, 'dictionaryapi', token))
      if (e.code !== 'not_found') console.warn('[sentence-phonetic]', token, e.message)
    }
  }))

  let cursor = 0
  let result = ''
  for (const match of matches) {
    result += text.slice(cursor, match.index) + (phonetics.get(match[0].toLowerCase()) || match[0])
    cursor = match.index + match[0].length
  }
  return {
    phonetic: phonetics.size > 0 ? (result + text.slice(cursor)).trim() : undefined,
    complete: phonetics.size === tokens.length,
    missing,
    errors,
  }
}

/**
 * 调用百度大模型文本翻译 API（Bearer API Key 鉴权）。
 * 密钥来自 Worker 的 secret（BAIDU_TRANSLATE_API_KEY / BAIDU_TRANSLATE_APP_ID），
 * 不再支持设置页覆盖——secrets 无法经 API 写入。
 */
async function fetchBaiduTranslation(text, app) {
  if (app.config.noNetwork) return { translation: undefined, errors: [] }
  const apiKey = String(app.env.BAIDU_TRANSLATE_API_KEY ?? '')
  const appId = String(app.env.BAIDU_TRANSLATE_APP_ID ?? '')
  if (!apiKey || !appId) {
    return { translation: undefined, errors: [publicNetworkError(makeNetworkError('baidu', 'not_configured', undefined, app), 'baidu')] }
  }
  const baiduUrl = String(app.env.BAIDU_TRANSLATE_API_URL || '')
    || 'https://fanyi-api.baidu.com/ait/api/aiTextTranslate'
  try {
    const data = await fetchJson(baiduUrl, {
      source: 'baidu',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        appid: appId,
        from: 'en',
        to: 'zh',
        q: text,
      }),
    }, app)
    // 兼容百度翻译接口和大模型网关常见的返回包装，统一只取最终译文。
    const candidates = [
      data?.result?.translation,
      data?.result?.translated_text,
      data?.result?.text,
      data?.translation,
      data?.translated_text,
      data?.text,
      ...(Array.isArray(data?.result?.trans_result) ? data.result.trans_result.map(x => x?.dst) : []),
      ...(Array.isArray(data?.trans_result) ? data.trans_result.map(x => x?.dst) : []),
      data?.choices?.[0]?.message?.content,
      data?.choices?.[0]?.text,
    ]
    const translation = candidates.find(value => !isBadTranslation(value, normalizeText(text)))
    if (!translation) throw makeNetworkError('baidu', 'invalid_response', undefined, app)
    return { translation: String(translation).trim(), errors: [] }
  } catch (e) {
    console.warn('[baidu-translate]', normalizeText(text), e.message)
    return { translation: undefined, errors: [publicNetworkError(e, 'baidu')] }
  }
}

/** 抓一次外部接口：单词的音标 + 英文释义（dictionaryapi.dev）+ 中文（百度） */
export async function fetchDictEntry(word, app) {
  const queryText = String(word ?? '').trim().replace(/\s+/g, ' ')
  const w = normalizeText(word)
  if (app.config.noNetwork) return normalizeEntry(w, { status: 'partial' }, app)

  let phonetic, translation
  let phoneticStatus = 'missing'
  let translationStatus = 'missing'
  const errors = []
  const senses = []
  let dictOk = isPhrase(w)
  let spellingStatus = isPhrase(w) ? 'unchecked' : 'unknown'

  if (isSentence(w)) {
    const sentence = await fetchSentencePhonetic(capitalizeSentence(queryText), app)
    phonetic = sentence.phonetic
    phoneticStatus = sentence.complete ? 'complete' : (phonetic ? 'partial' : 'missing')
    errors.push(...sentence.errors)
    // 句子音标允许部分成功；整句中文翻译必须继续执行。
    dictOk = true
  }

  if (!isPhrase(w)) {
    try {
      const data = await fetchJson(
        'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w),
        { source: 'dictionaryapi' },
        app,
      )
      const e = Array.isArray(data) ? data[0] : null
      if (!e || typeof e !== 'object') throw makeNetworkError('dictionaryapi', 'invalid_response', undefined, app)
      phonetic = e?.phonetic || e?.phonetics?.find(p => p.text)?.text
      // 释义全集：勾选要背哪几条是前端的事
      for (const m of e?.meanings ?? []) {
        for (const d of m?.definitions ?? []) {
          senses.push({ pos: m.partOfSpeech, definition: d.definition })
        }
      }
      phoneticStatus = phonetic ? 'complete' : 'missing'
      dictOk = true
      spellingStatus = 'valid'
    } catch (e) {
      // 404 = 词典确认没这个词，不用反复重试；超时/限流留着下次补
      if (e.code === 'not_found') {
        dictOk = true
        spellingStatus = 'suspect'
      }
      else console.warn('[dict-api]', w, e.message)
      errors.push(publicNetworkError(e, 'dictionaryapi', w))
    }
  }

  const baidu = await fetchBaiduTranslation(isSentence(w) ? capitalizeSentence(queryText) : w, app)
  translation = baidu.translation
  translationStatus = translation ? 'ok' : (baidu.errors.some(error => error.code === 'not_configured') ? 'missing' : 'error')
  errors.push(...baidu.errors)

  return normalizeEntry(w, {
    phonetic, translation,
    translations: translation ? [{ text: translation, source: 'api' }] : [],
    senses,
    cachedAt: Date.now(),
    status: dictOk && translation ? 'ok' : 'partial',
    phoneticStatus,
    translationStatus,
    spellingStatus,
    errors,
    source: 'api',
    translationSource: translation ? 'baidu' : undefined,
  }, app)
}

// ── 缓存读写（D1） ─────────────────────────────────────────────────────────

/** 读一个词条（已归一化）；缓存里没有返回 null */
export async function getCacheEntry(word, app) {
  const w = normalizeText(word)
  if (!w) return null
  const raw = await app.kv.getCacheEntries([w])
  return raw[w] ? normalizeEntry(w, raw[w], app) : null
}

/** 读一批词条（已归一化），返回 { 规范化词: entry } */
export async function getCacheEntries(words, app) {
  const list = [...new Set(words.map(word => normalizeText(word)).filter(Boolean))]
  const raw = await app.kv.getCacheEntries(list)
  const out = {}
  for (const w of list) {
    if (raw[w]) out[w] = normalizeEntry(w, raw[w], app)
  }
  return out
}

async function putCache(entry, app) {
  await app.kv.putCacheEntry(entry)
  return entry
}

// ── 取词条的唯一实现 ───────────────────────────────────────────────────────

/**
 * 合并两份来源：这次抓的 > 旧缓存。句子/短语/单词的拼写状态与本地版语义一致，
 * 只是没有「本地词典永远赢」这条岔路了。
 */
function mergeEntry(word, sources, app) {
  const { fresh, old } = sources
  const senses = fresh && fresh.senses.length > 0 ? fresh.senses : (old?.senses || [])
  const phonetic    = fresh?.phonetic || old?.phonetic
  const translations = fresh?.translations?.length
    ? fresh.translations
    : old?.translations
  const translation = fresh?.translation || old?.translation
    || (translations?.length ? translations.map(item => item.text).join('；') : undefined)
  const translationSource = fresh?.translationSource === 'baidu' || old?.translationSource === 'baidu' ? 'baidu' : undefined
  const phoneticStatus = fresh?.phoneticStatus || (fresh?.phonetic ? 'complete' : undefined)
    || old?.phoneticStatus || (old?.phonetic ? 'complete' : 'missing')
  const translationStatus = translation
    ? 'ok'
    : (fresh?.translationStatus || old?.translationStatus || 'missing')
  const errors = fresh
    ? (fresh.errors || [])
    : (old?.errors || [])
  const spellingStatus = isPhrase(word)
    ? 'unchecked'
    : (fresh?.spellingStatus || old?.spellingStatus || 'unknown')
  const dictOk = isSentence(word) ? true : isPhrase(word) || !!phonetic || senses.length > 0
  return normalizeEntry(word, {
    phonetic, translation, translations, senses,
    cachedAt: Date.now(),
    status: dictOk && translation ? 'ok' : 'partial',
    phoneticStatus,
    translationStatus,
    spellingStatus,
    errors,
    source: fresh?.source || old?.source,
    translationSource,
  }, app)
}

/**
 * 取词条的唯一实现。顺序是「缓存 → 外部接口」：
 * 缓存已抓齐（status=ok）直接返回；句子必须由百度翻译，翻译来源不对就重抓。
 * 返回 network 标记，补齐队列据此决定要不要限速。
 */
export async function resolveEntry(word, force, app) {
  const queryText = String(word ?? '').trim().replace(/\s+/g, ' ')
  const w = normalizeText(word)
  if (!w) throw new Error('missing word')
  const old = await getCacheEntry(w, app)
  // 旧版本可能把句子按固定短语缓存；句子现在必须由百度翻译，不能被这条缓存短路挡住。
  const sentenceNeedsRefresh = isSentence(w)
    && (old?.translationSource !== 'baidu' || !old?.phonetic
      || old?.phoneticStatus === 'partial' || old?.translationStatus !== 'ok')
  if (old && old.status === 'ok' && !force && !sentenceNeedsRefresh) {
    return { entry: old, network: false }
  }
  if (app.config.noNetwork) {
    return { entry: old || normalizeEntry(w, { status: 'partial' }, app), network: false }
  }
  const fresh = await fetchDictEntry(queryText || w, app)
  return { entry: await putCache(mergeEntry(w, { fresh, old }, app), app), network: true }
}

/**
 * 加入学习后的后台任务只补音标，不重新翻译中文，也不改动已缓存的中文候选。
 * 搜索阶段已经负责完整查询，这里只是处理搜索结果仍缺音标的降级情况。
 */
export async function resolvePhoneticOnly(word, app) {
  const w = normalizeText(word)
  if (!w) throw new Error('missing word')
  const old = await getCacheEntry(w, app)
  if (old?.phonetic && old.phoneticStatus !== 'partial') return { entry: old, network: false }

  if (isSentence(w)) {
    if (app.config.noNetwork) return { entry: old || normalizeEntry(w, { status: 'partial' }, app), network: false }
    const sentence = await fetchSentencePhonetic(capitalizeSentence(w), app)
    if (!sentence.phonetic && !old) return { entry: normalizeEntry(w, { status: 'partial' }, app), network: true }
    const errors = [
      ...(old?.errors || []).filter(error => error.source !== 'dictionaryapi'),
      ...sentence.errors,
    ]
    const entry = await putCache(normalizeEntry(w, {
      ...old,
      phonetic: sentence.phonetic || old?.phonetic,
      phoneticStatus: sentence.complete ? 'complete' : (sentence.phonetic || old?.phonetic ? 'partial' : 'missing'),
      errors,
      cachedAt: Date.now(),
    }, app), app)
    return { entry, network: true }
  }

  if (app.config.noNetwork) return { entry: old || normalizeEntry(w, { status: 'partial' }, app), network: false }

  const data = await fetchJson(
    'https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(w),
    { source: 'dictionaryapi' },
    app,
  )
  const source = Array.isArray(data) ? data[0] : null
  const phonetic = source?.phonetic || source?.phonetics?.find(item => item.text)?.text
  if (!phonetic) throw makeNetworkError('dictionaryapi', 'invalid_response', undefined, app)
  const entry = await putCache(normalizeEntry(w, {
    ...old,
    phonetic,
    phoneticStatus: 'complete',
    spellingStatus: 'valid',
    errors: (old?.errors || []).filter(error => error.source !== 'dictionaryapi'),
    cachedAt: Date.now(),
  }, app), app)
  return { entry, network: true }
}

/** 保留原签名给别处用 */
export async function ensureEntry(word, force, app) {
  return (await resolveEntry(word, force, app)).entry
}

/** 缓存统计（GET /api/cache/stats 与 /api/dict/sources 用） */
export async function cacheStats(app) {
  const raw = await app.kv.getAllCache()
  let complete = 0
  const total = Object.keys(raw).length
  for (const [word, entry] of Object.entries(raw)) {
    if (normalizeEntry(word, entry, app).status === 'ok') complete++
  }
  return { total, complete, incomplete: total - complete }
}

/**
 * 保持输入顺序的有限并发映射。每一项由 task 自己转成成功或失败结果，
 * 因此一项查询失败不会 reject 整批，也不会阻止其他 worker 继续处理。
 */
export async function mapConcurrent(items, concurrency, task) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await task(items[index], index)
    }
  }
  const count = Math.min(items.length, Math.max(1, concurrency))
  await Promise.all(Array.from({ length: count }, () => worker()))
  return results
}

/** 中文没有拿到时，把搜索链路已有的明确错误透传给批量页。 */
export function batchSearchError(entry) {
  const errors = Array.isArray(entry?.errors) ? entry.errors : []
  const detail = errors.find(error => error?.source === 'baidu') || errors[0]
  if (detail) return { ...detail }
  return { code: 'no_translation', message: '未获取到中文翻译' }
}
