/**
 * routes.js — 全部 /api/* 路由（从 dict-server.mjs 的 router 段移植）
 *
 * 与本地版的差异：
 *  - 入口是纯函数 handleApi(method, pathname, searchParams, body, app) 返回 {status, body}，
 *    不再直接操作 http 的 req/res；Worker fetch 和 Node 测试共用这一个入口；
 *  - 删除了 /api/sync/*（快照同步退役）和 /api/dict/keys（百度密钥改 Worker secret）；
 *  - /api/dict/sources 不再有 local 字段（云端没有本地词典）。
 *
 * 鉴权不在这一层：index.js 在进入 handleApi 之前统一校验 Bearer 令牌。
 */

import { normalizeText, capitalizeSentence } from './text.js'
import {
  ensureEntry, getCacheEntry, getCacheEntries, cacheStats, batchSearchError,
  mapConcurrent, isSentence, isPhrase, MAX_BATCH_SEARCH_ITEMS, BATCH_SEARCH_CONCURRENCY,
} from './dict.js'
import {
  applyReview, withoutMarks, enrichItem, nextDueAt, normalizeScope,
  REVIEW_ACTIONS, TALLY_KINDS, PURE_MARK_ACTIONS, REVIEW_INTERVALS,
  startOfDay, startOfWeek, pushMark, countOf, hasReviewKey, rememberReviewKey,
} from './review.js'
import {
  loadLists, saveLists, syncListTranslation, selectedTranslation, recordStudyEvent,
  loadLabels, saveLabels, loadGoal, saveGoal, loadPrints, savePrints,
  uniquePrintId, printBatchItemsKey, enrichBatch, detectType,
  normalizeSenseIds, normalizeCustomTranslations, normalizeTranslationIds,
  DEFAULT_LIST_ID, MAX_LABEL_LENGTH, MAX_LIBRARY_ID_LENGTH,
  MAX_PRINT_BATCHES, DEFAULT_PRINT_LIMIT, MAX_PRINT_TITLE, PRINT_KINDS,
} from './lists.js'
import { enqueuePrefetch, enqueuePhoneticPrefetch, currentPrefetchState } from './prefetch.js'

export async function handleApi(method, pathname, searchParams, body, app) {
  const env = app.env
  // ── 探活（免鉴权，由 index.js 放行） ─────────────────────────────────────
  if (method === 'GET' && pathname === '/api/health') {
    return { status: 200, body: { ok: true, time: Date.now() } }
  }

  // ── Dict ──────────────────────────────────────────────────────────────
  if (method === 'GET' && pathname === '/api/dict') {
    const queryText = String(searchParams.get('word') ?? '').trim().replace(/\s+/g, ' ')
    const word = normalizeText(queryText)
    if (!word) return { status: 400, body: { error: 'missing ?word=' } }
    const refresh = searchParams.get('refresh') === '1'
    const cached = await getCacheEntry(word, app)
    // 只有「抓齐了」而且句子翻译确实来自百度的缓存才敢直接用；
    // 上次半路失败的、翻译来源不明的都往下重抓一遍
    const sentenceNeedsRefresh = isSentence(word)
      && (cached?.translationSource !== 'baidu' || !cached?.phonetic
        || cached?.phoneticStatus === 'partial' || cached?.translationStatus !== 'ok')
    if (cached && cached.status === 'ok' && !refresh && !sentenceNeedsRefresh) {
      return { status: 200, body: Object.assign({}, cached, { fromCache: true }) }
    }
    try {
      const entry = await ensureEntry(queryText, refresh, app)
      return { status: 200, body: Object.assign({}, entry, { fromCache: false }) }
    } catch (e) {
      console.warn('[dict]', word, e.message)
      // 抓取彻底失败时，有旧缓存就先给旧的，别让页面空着
      if (cached) return { status: 200, body: Object.assign({}, cached, { fromCache: true }) }
      return { status: 502, body: { error: 'fetch failed' } }
    }
  }

  // POST /api/dict/search-batch  — 批量执行与首页相同的完整查询链路。
  if (method === 'POST' && pathname === '/api/dict/search-batch') {
    if (!Array.isArray(body?.words)) return { status: 400, body: { error: 'missing words' } }

    const words = []
    const seen = new Set()
    for (const raw of body.words) {
      const word = normalizeText(raw)
      if (!word || seen.has(word)) continue
      seen.add(word)
      words.push({ word, queryText: String(raw ?? '').trim().replace(/\s+/g, ' ') })
    }
    if (words.length === 0) return { status: 400, body: { error: 'missing words' } }
    if (words.length > MAX_BATCH_SEARCH_ITEMS) {
      return { status: 400, body: { error: 'too many words', max: MAX_BATCH_SEARCH_ITEMS } }
    }

    const results = await mapConcurrent(words, BATCH_SEARCH_CONCURRENCY, async ({ word, queryText }) => {
      try {
        // ensureEntry 是首页 GET /api/dict 使用的同一条缓存 → 外部接口链路。
        const entry = await ensureEntry(queryText || word, false, app)
        if (String(entry?.translation ?? '').trim()) return { word, ok: true, entry }
        return { word, ok: false, entry, error: batchSearchError(entry) }
      } catch (error) {
        console.warn('[dict-batch]', word, error?.message || error)
        return {
          word,
          ok: false,
          error: { code: 'fetch_failed', message: error?.message || '查询失败' },
        }
      }
    })
    const succeeded = results.filter(result => result.ok).length
    return {
      status: 200,
      body: {
        results,
        total: results.length,
        succeeded,
        failed: results.length - succeeded,
      },
    }
  }

  if (method === 'GET' && pathname === '/api/cache/stats') {
    return { status: 200, body: await cacheStats(app) }
  }

  // GET /api/dict/sources  — 查词链路状态：能不能联网、缓存多少、百度密钥配没配
  if (method === 'GET' && pathname === '/api/dict/sources') {
    const hasKey = Boolean(String(env.BAIDU_TRANSLATE_API_KEY ?? ''))
    const hasAppId = Boolean(String(env.BAIDU_TRANSLATE_APP_ID ?? ''))
    const baidu = {
      hasKey,
      hasAppId,
      keyHint: hasKey ? '••••' + String(env.BAIDU_TRANSLATE_API_KEY).slice(-4) : '',
      appIdHint: hasAppId ? '••••' + String(env.BAIDU_TRANSLATE_APP_ID).slice(-4) : '',
    }
    return {
      status: 200,
      body: {
        network: !app.config.noNetwork,
        cache: await cacheStats(app),
        external: [
          {
            id: 'dictionaryapi',
            name: 'Free Dictionary API',
            url: 'https://api.dictionaryapi.dev',
            needsKey: false,
            available: !app.config.noNetwork,
          },
          {
            id: 'baidu',
            name: '百度翻译',
            url: String(env.BAIDU_TRANSLATE_API_URL || '')
              || 'https://fanyi-api.baidu.com/ait/api/aiTextTranslate',
            needsKey: true,
            available: !app.config.noNetwork && hasKey && hasAppId,
            ...baidu,
          },
        ],
      },
    }
  }

  // POST /api/dict/batch  — 只读缓存的批量查询，打印卡片前先把已有释义捞出来
  if (method === 'POST' && pathname === '/api/dict/batch') {
    const words = Array.isArray(body?.words) ? body.words : []
    const cache = await getCacheEntries(words, app)
    const entries = {}
    const missing = []
    const incomplete = []
    for (const raw of words) {
      const word = normalizeText(raw)
      if (!word || entries[word]) continue
      const entry = cache[word]
      if (!entry) {
        if (!missing.includes(word)) missing.push(word)
        continue
      }
      entries[word] = entry
      // 在缓存里但没抓齐：前端可以据此提示「还能补齐」
      if (entry.status !== 'ok' || (isSentence(word) && (!entry.phonetic
        || entry.phoneticStatus === 'partial' || entry.translationStatus !== 'ok'))) incomplete.push(word)
    }
    return { status: 200, body: { entries, missing, incomplete } }
  }

  // /api/dict/prefetch  — GET 查补齐进度，POST 把词排进后台补齐队列
  if (pathname === '/api/dict/prefetch') {
    if (method === 'GET') return { status: 200, body: await currentPrefetchState(app) }
    if (method === 'POST') {
      const queued = await enqueuePrefetch(body?.words, body?.force === true, app)
      return { status: 200, body: Object.assign({ ok: true, queued }, await currentPrefetchState(app)) }
    }
  }

  // POST /api/dict/repair  — 不传 words 就扫所有学习列表，把缺音标/释义的词排队补齐
  if (method === 'POST' && pathname === '/api/dict/repair') {
    let words = Array.isArray(body?.words) ? body.words.map(normalizeText).filter(Boolean) : []
    if (words.length === 0) {
      const seen = new Set()
      const { lists } = await loadLists(app)
      for (const list of lists) {
        for (const item of list.words) {
          if (seen.has(item.word)) continue
          seen.add(item.word)
          words.push(item.word)
        }
      }
    }
    const queued = await enqueuePrefetch(words, body?.force === true, app)
    console.log('[repair]   ', words.length, 'scanned,', queued, 'queued')
    return {
      status: 200,
      body: Object.assign({ ok: true, scanned: words.length, queued }, await currentPrefetchState(app)),
    }
  }

  // ── Lists ─────────────────────────────────────────────────────────────

  // GET /api/lists
  if (method === 'GET' && pathname === '/api/lists') {
    const { lists } = await loadLists(app)
    return {
      status: 200,
      body: lists.map(l => ({ id: l.id, name: l.name, createdAt: l.createdAt, wordCount: l.words.length })),
    }
  }

  // POST /api/lists  — create new list
  if (method === 'POST' && pathname === '/api/lists') {
    const name = body?.name?.trim()
    if (!name) return { status: 400, body: { error: 'missing name' } }
    const data = await loadLists(app)
    if (data.lists.some(l => l.name === name)) {
      return { status: 409, body: { ok: false, error: '同名列表已存在' } }
    }
    const id = 'list_' + Date.now()
    data.lists.push({ id, name, createdAt: Date.now(), words: [] })
    await saveLists(app, data)
    console.log('[list +]   ', name)
    return { status: 200, body: { ok: true, id, name } }
  }

  // Match /api/lists/:id  和  /api/lists/:id/<subpath>
  const listMatch = pathname.match(/^\/api\/lists\/([^/]+)(?:\/(.+))?$/)
  if (listMatch) {
    const listId  = decodeURIComponent(listMatch[1])
    const subpath = listMatch[2] || ''
    const data    = await loadLists(app)
    const list    = data.lists.find(l => l.id === listId)
    if (!list) return { status: 404, body: { error: 'list not found' } }

    // PATCH /api/lists/:id  — rename
    if (method === 'PATCH' && subpath === '') {
      const name = body?.name?.trim()
      if (!name) return { status: 400, body: { error: 'missing name' } }
      if (data.lists.some(l => l.id !== listId && l.name === name)) {
        return { status: 409, body: { ok: false, error: '同名列表已存在' } }
      }
      list.name = name
      await saveLists(app, data)
      console.log('[list ~]   ', listId, '->', name)
      return { status: 200, body: { ok: true, id: listId, name } }
    }

    // DELETE /api/lists/:id  — 默认列表不可删除
    if (method === 'DELETE' && subpath === '') {
      if (listId === DEFAULT_LIST_ID) {
        return { status: 400, body: { ok: false, error: '默认列表不可删除' } }
      }
      data.lists = data.lists.filter(l => l.id !== listId)
      await saveLists(app, data)
      console.log('[list -]   ', listId)
      return { status: 200, body: { ok: true } }
    }

    // GET /api/lists/:id/words
    if (method === 'GET' && subpath === 'words') {
      const now = Date.now()
      return { status: 200, body: list.words.map(w => enrichItem(w, now, env)) }
    }

    // POST /api/lists/:id/words  — add single word / sentence
    if (method === 'POST' && subpath === 'words') {
      const word = normalizeText(body?.text ?? body?.word)
      if (!word) return { status: 400, body: { error: 'missing text' } }
      if (list.words.find(w => w.word === word)) {
        return { status: 200, body: { ok: false, reason: 'already exists' } }
      }
      const sourceIds = Array.isArray(body.sourceIds) ? body.sourceIds : []
      const senseIds  = normalizeSenseIds(body?.senseIds)
      const translationIds = normalizeTranslationIds(body?.translationIds)
      const customTranslations = normalizeCustomTranslations(body?.customTranslations)
      const type = detectType(word, sourceIds)
      const item = {
        word,
        type,
        sourceIds,
        addedAt: Date.now(),
      }
      if (type === 'sentence') item.displayText = capitalizeSentence(body?.text ?? body?.word ?? word)
      const phonetic = String(body?.phonetic ?? '').trim()
      if (phonetic) item.phonetic = phonetic
      if (senseIds.length) item.senseIds = senseIds
      if (translationIds.length) item.translationIds = translationIds
      if (customTranslations.length) item.customTranslations = customTranslations
      const translation = String(body?.translation ?? '').trim()
        || (customTranslations.length ? selectedTranslation(undefined, [], customTranslations) : '')
      if (translation) item.translation = translation
      const batchKey = String(body?.batchKey ?? '').trim()
      const batchName = batchKey ? String(body?.batchName ?? '').trim() : ''
      if (batchName.length > 40) return { status: 409, body: { ok: false, error: '标签过长' } }
      if (batchKey) {
        item.batchKey = batchKey
        if (batchName) list.batchNames[batchKey] = batchName
      }
      list.words.push(item)
      await saveLists(app, data)
      // 加入学习只保存搜索页传来的快照；缺失的音标等数据交给后台补齐，不阻塞响应。
      const queued = await enqueuePhoneticPrefetch([word], app)
      console.log('[word +]   ', word, '->', listId)
      return { status: 200, body: { ok: true, item, queued } }
    }

    // GET /api/lists/:id/batches  — 每个批次（自然日）的显示名
    if (method === 'GET' && subpath === 'batches') {
      return { status: 200, body: { batchNames: list.batchNames ?? {} } }
    }

    // PATCH /api/lists/:id/batches  — 重命名某个批次；name 空串=重置为日期
    if (method === 'PATCH' && subpath === 'batches') {
      const date = String(body?.date ?? '').trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) && !/^b:/.test(date)) return { status: 400, body: { error: 'invalid date' } }
      const name = String(body?.name ?? '').trim()
      if (name.length > 40) return { status: 409, body: { ok: false, error: '标签过长' } }
      if (name) list.batchNames[date] = name
      else delete list.batchNames[date]
      await saveLists(app, data)
      console.log('[list ~]   ', listId, 'batch', date, '->', name || '(日期)')
      return { status: 200, body: { ok: true, batchNames: list.batchNames } }
    }

    // DELETE /api/lists/:id/words/:text  — remove one item
    const wordPathMatch = subpath.match(/^words\/(.+)$/)
    if (method === 'DELETE' && wordPathMatch) {
      const target = normalizeText(decodeURIComponent(wordPathMatch[1]))
      const before = list.words.length
      list.words = list.words.filter(w => w.word !== target)
      if (list.words.length === before) return { status: 404, body: { ok: false, reason: 'not found' } }
      await saveLists(app, data)
      console.log('[word -]   ', target, '<-', listId)
      return { status: 200, body: { ok: true } }
    }

    // PATCH /api/lists/:id/words/:text  — 改这个词这一阶段要背的释义
    if (method === 'PATCH' && wordPathMatch) {
      const target = normalizeText(decodeURIComponent(wordPathMatch[1]))
      const item = list.words.find(w => w.word === target)
      if (!item) return { status: 404, body: { ok: false, reason: 'not found' } }
      if ('senseIds' in (body || {})) {
        const senseIds = normalizeSenseIds(body?.senseIds)
        if (senseIds.length) item.senseIds = senseIds
        else delete item.senseIds
      }
      if ('translationIds' in (body || {})) {
        const translationIds = normalizeTranslationIds(body?.translationIds)
        if (translationIds.length) item.translationIds = translationIds
        else delete item.translationIds
      }
      if ('customTranslations' in (body || {})) {
        const customTranslations = normalizeCustomTranslations(body?.customTranslations)
        if (customTranslations.length) item.customTranslations = customTranslations
        else delete item.customTranslations
      }
      if ('translation' in (body || {})) {
        const translation = String(body?.translation ?? '').trim()
        if (translation) item.translation = translation
        else if (item.customTranslations?.length) item.translation = selectedTranslation(undefined, [], item.customTranslations)
        else delete item.translation
      }
      await saveLists(app, data)
      console.log('[word ~]   ', target, 'updated selections')
      return { status: 200, body: { ok: true, item: enrichItem(item, Date.now(), env) } }
    }

    // POST /api/lists/:id/remove  — 批量移除词条
    if (method === 'POST' && subpath === 'remove') {
      const targets = new Set()
      for (const raw of (Array.isArray(body?.words) ? body.words : [])) {
        const word = normalizeText(typeof raw === 'string' ? raw : raw?.text ?? raw?.word)
        if (word) targets.add(word)
      }
      if (targets.size === 0) return { status: 400, body: { error: 'missing words' } }
      const before = list.words.length
      list.words = list.words.filter(w => !targets.has(w.word))
      const removed = before - list.words.length
      // 一个都没对上就不写盘（比如界面上的选中项已经被别处删掉了）
      if (removed > 0) await saveLists(app, data)
      console.log('[word -]   ', removed, 'removed <-', listId)
      return { status: 200, body: { ok: true, removed, missing: targets.size - removed } }
    }

    // POST /api/lists/:id/import  — bulk import
    if (method === 'POST' && subpath === 'import') {
      const raw = Array.isArray(body?.items)
        ? body.items
        : (body?.words || []).map(w => ({ text: w, sourceIds: body?.sourceIds }))
      let added = 0, skipped = 0
      const fresh = []
      const seen = new Set(list.words.map(w => w.word))
      const importBatchKey = String(body?.batchKey ?? '').trim()
      const importBatchName = importBatchKey ? String(body?.batchName ?? '').trim() : ''
      if (importBatchName.length > 40) return { status: 409, body: { ok: false, error: '标签过长' } }
      // 批量查询页已经完成查词和中文选择：优先原样保存前端快照。
      // 缓存兜底只读一次，导入过程绝不发起查询。
      const cache = await getCacheEntries([...seen.keys()].concat(raw.map(entry => entry?.text ?? entry)), app)
      for (const entry of raw) {
        const word = normalizeText(entry?.text ?? entry)
        if (!word || seen.has(word)) { if (word) skipped++; continue }
        const sourceIds = Array.isArray(entry?.sourceIds) ? entry.sourceIds : []
        const senseIds  = normalizeSenseIds(entry?.senseIds)
        const translationIds = normalizeTranslationIds(entry?.translationIds)
        const customTranslations = normalizeCustomTranslations(entry?.customTranslations)
        const type = detectType(word, sourceIds)
        const item = {
          word,
          type,
          sourceIds,
          addedAt: Date.now(),
        }
        if (type === 'sentence') item.displayText = capitalizeSentence(entry?.text ?? entry ?? word)
        const phonetic = String(entry?.phonetic ?? '').trim()
        if (phonetic) item.phonetic = phonetic
        if (senseIds.length) item.senseIds = senseIds
        if (translationIds.length) item.translationIds = translationIds
        if (customTranslations.length) item.customTranslations = customTranslations
        // 批量查询页已经完成查词和中文选择：优先原样保存前端快照。
        const snapshot = String(entry?.translation ?? '').trim()
        const selected = snapshot || selectedTranslation(cache[word], translationIds, customTranslations)
        if (selected) item.translation = selected
        if (importBatchKey) item.batchKey = importBatchKey
        list.words.push(item)
        seen.add(word)
        fresh.push(word)
        added++
      }
      if (importBatchKey && importBatchName && fresh.length > 0) list.batchNames[importBatchKey] = importBatchName
      await saveLists(app, data)
      // 中文已在批量查询阶段确定；导入后最多后台补音标，不重新翻译、不覆盖中文快照。
      const queued = await enqueuePhoneticPrefetch(fresh, app)
      console.log('[import]   ', added, 'added,', skipped, 'skipped ->', listId)
      return { status: 200, body: { ok: true, added, skipped, queued } }
    }

    // POST /api/lists/:id/start  — 标记一批词开始学习
    if (method === 'POST' && subpath === 'start') {
      const raw = Array.isArray(body?.words) ? body.words : []
      const targets = new Set(raw.map(normalizeText).filter(Boolean))
      if (targets.size === 0) return { status: 400, body: { error: 'missing words' } }
      const at = Number(body?.startedAt) || Date.now()
      const scope = normalizeScope(body?.scope)
      let started = 0, skipped = 0
      const items = []
      for (const item of list.words) {
        if (!targets.has(item.word)) continue
        // 已经在学的词默认不动，避免重复打印时把进度清零；restart 才强制重开
        if (item.startedAt && !body?.restart) {
          skipped++
        } else {
          const again = Boolean(item.startedAt)
          item.startedAt = at
          item.stage = 0
          item.reviewedAt = []
          pushMark(item, again ? 'restart' : 'start', at)
          await recordStudyEvent(app, list, { item, action: again ? 'restart' : 'start', at, scope, stage: 0 })
          started++
        }
        items.push(enrichItem(item, at, env))
      }
      await saveLists(app, data)
      console.log('[study +]  ', started, 'started,', skipped, 'skipped ->', listId)
      return { status: 200, body: { ok: true, started, skipped, startedAt: at, items } }
    }

    // POST /api/lists/:id/review  — 复习打卡
    if (method === 'POST' && subpath === 'review') {
      const action = String(body?.action || 'done')
      if (!REVIEW_ACTIONS.has(action)) return { status: 400, body: { error: 'unknown action' } }
      if (action === 'tally' && !TALLY_KINDS.has(body?.successKind)) {
        return { status: 400, body: { error: 'tally requires successKind' } }
      }
      const raw = Array.isArray(body?.words) ? body.words : []
      const targets = new Set(raw.map(normalizeText).filter(Boolean))
      if (targets.size === 0) return { status: 400, body: { error: 'missing words' } }
      const rawIds = body?.requestIds && typeof body.requestIds === 'object' ? body.requestIds : {}
      const requestIds = new Map()
      for (const word of targets) {
        const supplied = typeof rawIds[word] === 'string' ? rawIds[word] : ''
        const current = list.words.find(item => item.word === word)
        const fallback = [
          listId,
          word,
          current?.stage ?? 0,
          current ? nextDueAt(current, env) ?? 'new' : 'new',
          action,
          body?.scope || '',
          body?.successKind || '',
        ].join('|')
        requestIds.set(word, supplied || fallback)
      }
      const { updated, items } = await applyReview(list, targets, action, {
        scope: body?.scope,
        successKind: body?.successKind,
        requestIds,
        now: Date.now(),
        hasRequest: requestId => app.history.hasRequest(requestId),
        onEvent: event => recordStudyEvent(app, list, event),
      }, app)
      await saveLists(app, data)
      console.log('[study ~]  ', action, updated, '->', listId)
      return { status: 200, body: { ok: true, updated, items } }
    }

    // POST /api/lists/:id/tally-undo  — 撤销本周期内最近一次会拼 / 会读 / 知意
    if (method === 'POST' && subpath === 'tally-undo') {
      const kind = String(body?.successKind || '')
      if (!TALLY_KINDS.has(kind)) return { status: 400, body: { error: 'invalid successKind' } }
      const scope = normalizeScope(body?.scope)
      const now = Number(body?.now) || Date.now()
      const from = scope === 'week' ? startOfWeek(now, env) : startOfDay(now, env)
      const raw = Array.isArray(body?.words) ? body.words : []
      const targets = new Set(raw.map(normalizeText).filter(Boolean))
      if (targets.size === 0) return { status: 400, body: { error: 'missing words' } }
      let undone = 0
      const items = []
      for (const item of list.words) {
        if (!targets.has(item.word)) continue
        // 事件表是唯一来源：软删本周期内最近一条 tally 事件，累计计数跟着回退
        const result = await app.history.undoTallyEvent({ listId, word: item.word, action: kind, from })
        if (result.deleted > 0) {
          if (kind === 'spelling') item.spellingCount = Math.max(0, countOf(item.spellingCount) - 1)
          else if (kind === 'reading') item.readingCount = Math.max(0, countOf(item.readingCount) - 1)
          else item.rememberedCount = Math.max(0, countOf(item.rememberedCount) - 1)
          item.markCount = Math.max(0, countOf(item.markCount) - 1)
          undone++
        }
        items.push(enrichItem(item, now, env))
      }
      await saveLists(app, data)
      console.log('[study ~]  tally-undo', kind, undone, '->', listId)
      return { status: 200, body: { ok: true, undone, items } }
    }

    // POST /api/lists/:id/mark  — 只记一次打标，不动复习排期
    if (method === 'POST' && subpath === 'mark') {
      const action = String(body?.action || 'print')
      if (!PURE_MARK_ACTIONS.has(action)) {
        return { status: 400, body: { error: 'unknown action' } }
      }
      const raw = Array.isArray(body?.words) ? body.words : []
      const targets = new Set(raw.map(normalizeText).filter(Boolean))
      if (targets.size === 0) return { status: 400, body: { error: 'missing words' } }
      const scope = normalizeScope(body?.scope)
      const now = Date.now()
      let marked = 0
      const items = []
      const rawIds = body?.requestIds && typeof body.requestIds === 'object' ? body.requestIds : {}
      for (const item of list.words) {
        if (!targets.has(item.word)) continue
        const requestId = typeof rawIds[item.word] === 'string'
          ? rawIds[item.word]
          : [listId, item.word, action, scope || ''].join('|')
        if (hasReviewKey(item, requestId) || await app.history.hasRequest(requestId)) {
          items.push(enrichItem(item, now, env))
          continue
        }
        pushMark(item, action, now)
        if (action === 'spelling') item.spellingCount = countOf(item.spellingCount) + 1
        if (action === 'reading') item.readingCount = countOf(item.readingCount) + 1
        await recordStudyEvent(app, list, { item, action, at: now, scope, stage: item.stage, requestId })
        rememberReviewKey(item, requestId)
        marked++
        items.push(enrichItem(item, now, env))
      }
      await saveLists(app, data)
      console.log('[mark +]   ', action, scope || 'day', marked, '->', listId)
      return { status: 200, body: { ok: true, marked, items } }
    }
  }

  // GET /api/word-lists?word=  — which lists contain this word
  if (method === 'GET' && pathname === '/api/word-lists') {
    const word = normalizeText(searchParams.get('word'))
    if (!word) return { status: 400, body: { error: 'missing ?word=' } }
    const { lists } = await loadLists(app)
    const found = lists
      .filter(l => l.words.find(w => w.word === word))
      .map(l => l.id)
    return { status: 200, body: { word, listIds: found } }
  }

  // ── Study plan ────────────────────────────────────────────────────────

  // GET /api/study/plan  — 所有列表里正在学习的词，按下次复习日期排序
  if (method === 'GET' && pathname === '/api/study/plan') {
    const now = Date.now()
    const { lists } = await loadLists(app)
    const items = []
    for (const list of lists) {
      for (const item of list.words) {
        if (!item.startedAt) continue
        items.push(Object.assign(withoutMarks(enrichItem(item, now, env)), {
          listId: list.id,
          listName: list.name,
          weekStart: startOfWeek(item.startedAt, env),
        }))
        // 本周期会拼 / 会读 / 知意次数：按钮直接展示，撤销也只认这段镜像
        const planItem = items[items.length - 1]
        planItem.tallyCounts = await app.history.periodTallyCounts({
          listId: list.id,
          word: item.word,
          dayStart: startOfDay(now, env),
          weekStart: startOfWeek(now, env),
        })
      }
    }
    items.sort((a, b) => {
      const da = a.nextDueAt === null ? Infinity : a.nextDueAt
      const db = b.nextDueAt === null ? Infinity : b.nextDueAt
      return da === db ? a.word.localeCompare(b.word) : da - db
    })
    return { status: 200, body: { intervals: REVIEW_INTERVALS, today: startOfDay(now, env), items } }
  }

  // ── 永久学习成果与历史 ───────────────────────────────────────────────

  if (method === 'GET' && pathname === '/api/study/achievements') {
    return { status: 200, body: await app.history.achievements({ libraryId: searchParams.get('libraryId') }) }
  }

  if (method === 'GET' && pathname === '/api/study/history') {
    return {
      status: 200,
      body: await app.history.history({
        libraryId: searchParams.get('libraryId'), word: searchParams.get('word'),
        action: searchParams.get('action'), limit: searchParams.get('limit'),
        offset: searchParams.get('offset'),
      }),
    }
  }

  if (method === 'GET' && pathname === '/api/study/history/integrity') {
    const result = await app.history.integrityCheck()
    return { status: 200, body: { ok: result === 'ok', result } }
  }

  if (method === 'POST' && pathname === '/api/study/history/purge') {
    const all = body?.all === true
    const rawWords = body?.words
    if (!all && !Array.isArray(rawWords)) {
      return { status: 400, body: { ok: false, error: 'words 必须是字符串数组' } }
    }
    if (Array.isArray(rawWords) && (rawWords.length > 500 || rawWords.some(word => typeof word !== 'string'))) {
      return { status: 400, body: { ok: false, error: 'words 必须是不超过 500 项的字符串数组' } }
    }
    const words = Array.isArray(rawWords) ? rawWords.map(word => word.trim()).filter(Boolean) : []
    if (!all && words.length === 0) {
      return { status: 400, body: { ok: false, error: '至少选择一个单词' } }
    }
    const result = await app.history.purge({ all, words })
    // 事件删了，列表里冗余的累计计数 / 复习时间也一起回退，两边重新对齐
    if (result.deletedEvents > 0) {
      await app.listsStore.resetStats({ words, all })
    }
    return { status: 200, body: { ok: true, ...result } }
  }

  const historyEventMatch = pathname.match(/^\/api\/study\/history\/events\/([^/]+)$/)
  if (method === 'DELETE' && historyEventMatch) {
    const result = await app.history.deleteEvent(decodeURIComponent(historyEventMatch[1]))
    return { status: 200, body: { ok: true, ...result } }
  }

  const historyWordMatch = pathname.match(/^\/api\/study\/history\/words\/([^/]+)$/)
  if (method === 'DELETE' && historyWordMatch) {
    const result = await app.history.clearWord(decodeURIComponent(historyWordMatch[1]))
    return { status: 200, body: { ok: true, ...result } }
  }

  // GET /api/study/goal  — 当前学习目标
  if (method === 'GET' && pathname === '/api/study/goal') {
    return { status: 200, body: await loadGoal(app) }
  }

  // PUT /api/study/goal  — 设置目标词库；libraryId 传空串表示不设目标
  if (method === 'PUT' && pathname === '/api/study/goal') {
    const raw = body?.libraryId
    if (raw != null && typeof raw !== 'string') {
      return { status: 400, body: { ok: false, error: 'libraryId 必须是字符串' } }
    }
    const libraryId = String(raw ?? '').trim()
    if (libraryId.length > MAX_LIBRARY_ID_LENGTH) {
      return { status: 400, body: { ok: false, error: 'libraryId 过长' } }
    }
    await saveGoal(app, { libraryId })
    console.log('[goal ~]   ', libraryId || '(none)')
    return { status: 200, body: { ok: true, libraryId } }
  }

  // ── 打印批次（导出卡片的留档） ─────────────────────────────────────────

  // GET /api/print-batches?limit=  — 打印记录，新的在前
  if (method === 'GET' && pathname === '/api/print-batches') {
    const now   = Date.now()
    const asked = Number(searchParams.get('limit'))
    const limit = Number.isFinite(asked) && asked > 0
      ? Math.min(Math.floor(asked), MAX_PRINT_BATCHES)
      : DEFAULT_PRINT_LIMIT
    const { lists } = await loadLists(app)
    const { batches } = await loadPrints(app)
    const out = batches
      .slice()
      .sort((a, b) => b.printedAt - a.printedAt)
      .slice(0, limit)
      .map(batch => enrichBatch(batch, lists, now, env))
    return { status: 200, body: { batches: out, total: batches.length } }
  }

  // POST /api/print-batches  — 记一次卡片导出
  if (method === 'POST' && pathname === '/api/print-batches') {
    const groups = Array.isArray(body?.groups) ? body.groups : []
    if (groups.length === 0) return { status: 400, body: { ok: false, error: 'missing groups' } }
    const printedAt = Number(body?.printedAt) || Date.now()
    const scope     = normalizeScope(body?.scope)
    const kindRaw   = String(body?.kind || 'start')
    const kind      = PRINT_KINDS.has(kindRaw) ? kindRaw : 'start'
    const data      = await loadLists(app)
    const items   = []
    const missing = []
    for (const group of groups) {
      const list  = data.lists.find(l => l.id === String(group?.listId ?? ''))
      const words = Array.isArray(group?.words) ? group.words : []
      for (const raw of words) {
        const word = normalizeText(raw)
        if (!word) continue
        const item = list ? list.words.find(w => w.word === word) : undefined
        if (!item) { missing.push(word); continue }
        // 打印本身也是一次打标：记时间、粒度和当时轮次
        pushMark(item, 'print', printedAt)
        await recordStudyEvent(app, list, {
          item, action: 'print', at: printedAt, scope, stage: item.stage,
          eventKey: ['print', printedAt, list.id, item.word].join('|'),
        })
        items.push({ listId: list.id, listName: list.name, word: item.word })
      }
    }
    // 一个词都没对上（列表删了 / 词删了）就别留空记录
    if (items.length === 0) {
      return { status: 400, body: { ok: false, error: '没有匹配到学习列表里的词', missing } }
    }
    await saveLists(app, data)
    const store = await loadPrints(app)
    const title = String(body?.title ?? '').trim().slice(0, MAX_PRINT_TITLE)
      || ('打印 ' + items.length + ' 词')
    const batch = { id: uniquePrintId(store.batches, printedAt), printedAt, kind, title, wordCount: items.length, items }
    if (scope) batch.scope = scope
    const itemsKey = printBatchItemsKey(items)
    const differentBatches = store.batches
      .filter(saved => printBatchItemsKey(saved.items) !== itemsKey)
      .sort((a, b) => b.printedAt - a.printedAt)
    // 相同的一组打印单词只保留本次记录，并把本次记录放在最前。
    store.batches = [batch, ...differentBatches].slice(0, MAX_PRINT_BATCHES)
    await savePrints(app, store)
    console.log('[print +]  ', items.length, 'words', kind, scope || 'day', '->', batch.id)
    return { status: 200, body: { ok: true, batch: enrichBatch(batch, data.lists, Date.now(), env), missing } }
  }

  const printMatch = pathname.match(/^\/api\/print-batches\/([^/]+)(?:\/(.+))?$/)
  if (printMatch) {
    const batchId = decodeURIComponent(printMatch[1])
    const subpath = printMatch[2] || ''
    const store   = await loadPrints(app)
    const batch   = store.batches.find(b => b.id === batchId)
    if (!batch) return { status: 404, body: { ok: false, error: '打印记录不存在' } }

    // POST /api/print-batches/:id/review  — 把这一批词整批打卡
    if (method === 'POST' && subpath === 'review') {
      const action = String(body?.action || 'done')
      if (!REVIEW_ACTIONS.has(action)) return { status: 400, body: { ok: false, error: 'unknown action' } }
      if (action === 'tally' && !TALLY_KINDS.has(body?.successKind)) {
        return { status: 400, body: { ok: false, error: 'tally requires successKind' } }
      }
      const now   = Date.now()
      const scope = normalizeScope(body?.scope) || batch.scope
      const data  = await loadLists(app)
      const rawIds = body?.requestIds && typeof body.requestIds === 'object' ? body.requestIds : {}
      let updated = 0
      const items = []
      for (const list of data.lists) {
        const batchItems = batch.items.filter(i => i.listId === list.id)
        const targets = new Set(batchItems.map(i => i.word))
        if (targets.size === 0) continue
        const requestIds = new Map()
        for (const item of batchItems) {
          const supplied = typeof rawIds[list.id + '|' + item.word] === 'string'
            ? rawIds[list.id + '|' + item.word]
            : (typeof rawIds[item.word] === 'string' ? rawIds[item.word] : '')
          const current = list.words.find(word => word.word === item.word)
          const fallback = [
            batchId,
            list.id,
            item.word,
            current?.stage ?? 0,
            current ? nextDueAt(current, env) ?? 'new' : 'new',
            action,
            scope || '',
            body?.successKind || '',
          ].join('|')
          requestIds.set(item.word, supplied || fallback)
        }
        const result = await applyReview(list, targets, action, {
          scope,
          successKind: body?.successKind,
          requestIds,
          now,
          hasRequest: requestId => app.history.hasRequest(requestId),
          onEvent: event => recordStudyEvent(app, list, event),
        }, app)
        updated += result.updated
        for (const item of result.items) {
          items.push(Object.assign(withoutMarks(item), { listId: list.id, listName: list.name }))
        }
      }
      await saveLists(app, data)
      if (updated > 0) {
        batch.reviewedAt    = now
        batch.reviewAction  = action
        batch.reviewedCount = updated
        batch.reviewCount   = (Number(batch.reviewCount) || 0) + 1
      }
      await savePrints(app, store)
      console.log('[print ~]  ', action, updated, '->', batchId)
      return { status: 200, body: { ok: true, updated, items, batch: enrichBatch(batch, data.lists, now, env) } }
    }

    // DELETE /api/print-batches/:id  — 只删这条记录，词的学习进度不动
    if (method === 'DELETE') {
      store.batches = store.batches.filter(b => b.id !== batchId)
      await savePrints(app, store)
      console.log('[print -]  ', batchId)
      return { status: 200, body: { ok: true, id: batchId } }
    }
  }

  // ── Vocab labels ──────────────────────────────────────────────────────

  // GET /api/vocab-labels
  if (method === 'GET' && pathname === '/api/vocab-labels') {
    return { status: 200, body: await loadLabels(app) }
  }

  // POST /api/vocab-labels  — 批量合并，前端把 localStorage 里的旧标签迁上来时用
  if (method === 'POST' && pathname === '/api/vocab-labels') {
    const incoming = body?.labels
    if (!incoming || typeof incoming !== 'object') return { status: 400, body: { error: 'missing labels' } }
    const data = await loadLabels(app)
    let merged = 0
    for (const [id, label] of Object.entries(incoming)) {
      const value = String(label ?? '').trim()
      if (!id || !value || value.length > MAX_LABEL_LENGTH) continue
      data.labels[id] = value
      merged++
    }
    await saveLabels(app, data)
    console.log('[label ^]  ', merged, 'merged')
    return { status: 200, body: { ok: true, merged, labels: data.labels } }
  }

  // 打印标签与页面显示标签分开管理；未设置时由前端回落到显示标签。
  if (method === 'GET' && pathname === '/api/vocab-print-labels') {
    return { status: 200, body: { printLabels: (await loadLabels(app)).printLabels } }
  }

  if (method === 'POST' && pathname === '/api/vocab-print-labels') {
    const incoming = body?.printLabels
    if (!incoming || typeof incoming !== 'object') return { status: 400, body: { error: 'missing printLabels' } }
    const data = await loadLabels(app)
    let merged = 0
    for (const [id, label] of Object.entries(incoming)) {
      const value = String(label ?? '').trim()
      if (!id || !value || value.length > MAX_LABEL_LENGTH) continue
      data.printLabels[id] = value
      merged++
    }
    await saveLabels(app, data)
    console.log('[print-label ^]  ', merged, 'merged')
    return { status: 200, body: { ok: true, merged, printLabels: data.printLabels } }
  }

  const printLabelMatch = pathname.match(/^\/api\/vocab-print-labels\/([^/]+)$/)
  if (printLabelMatch) {
    const libId = decodeURIComponent(printLabelMatch[1])
    const data = await loadLabels(app)

    if (method === 'PATCH') {
      const label = String(body?.label ?? '').trim()
      if (!label) return { status: 400, body: { ok: false, error: '打印标签不能为空' } }
      if (label.length > MAX_LABEL_LENGTH) {
        return { status: 400, body: { ok: false, error: '打印标签最多 ' + MAX_LABEL_LENGTH + ' 个字符' } }
      }
      data.printLabels[libId] = label
      await saveLabels(app, data)
      console.log('[print-label ~]  ', libId, '->', label)
      return { status: 200, body: { ok: true, id: libId, label } }
    }

    if (method === 'DELETE') {
      const existed = libId in data.printLabels
      delete data.printLabels[libId]
      await saveLabels(app, data)
      console.log('[print-label -]  ', libId)
      return { status: 200, body: { ok: true, id: libId, existed } }
    }
  }

  const labelMatch = pathname.match(/^\/api\/vocab-labels\/([^/]+)$/)
  if (labelMatch) {
    const libId = decodeURIComponent(labelMatch[1])
    const data  = await loadLabels(app)

    // PATCH /api/vocab-labels/:id  — 改标签
    if (method === 'PATCH') {
      const label = String(body?.label ?? '').trim()
      if (!label) return { status: 400, body: { ok: false, error: '标签不能为空' } }
      if (label.length > MAX_LABEL_LENGTH) {
        return { status: 400, body: { ok: false, error: '标签最多 ' + MAX_LABEL_LENGTH + ' 个字符' } }
      }
      // 标签会显示在搜索结果上，重复了就分不清是哪个词库
      const clash = Object.entries(data.labels).find(([id, value]) => id !== libId && value === label)
      if (clash) return { status: 409, body: { ok: false, error: '这个标签已被 ' + clash[0] + ' 占用' } }
      data.labels[libId] = label
      await saveLabels(app, data)
      console.log('[label ~]  ', libId, '->', label)
      return { status: 200, body: { ok: true, id: libId, label } }
    }

    // DELETE /api/vocab-labels/:id  — 重置为默认（回落到词库 id）
    if (method === 'DELETE') {
      const existed = libId in data.labels
      delete data.labels[libId]
      await saveLabels(app, data)
      console.log('[label -]  ', libId)
      return { status: 200, body: { ok: true, id: libId, existed } }
    }
  }

  return { status: 404, body: { error: 'not found' } }
}
