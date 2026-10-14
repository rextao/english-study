/**
 * study-history.js — 学习事件 / 成果 store（D1 版）
 *
 * 从 server/study-history.mjs 移植：表结构、meaningKey 内容寻址、聚合逻辑原样保留。
 * 与本地版的差异：
 *  - 没有 json 迁移（migrateLegacyLists）与 VACUUM INTO 备份——D1 没有文件系统，
 *    删除类操作靠 deleted_at 软删 / 事务回滚保证安全，D1 本身自带时间点恢复；
 *  - sha256 用 worker/src/sha256.js 的同步实现（输出与 node:crypto 一致，
 *    迁移进来的旧 meaning_key 能继续对上）；
 *  - integrity_check 在 D1 上不可用，返回常量 ok。
 */

import { normalizeText } from './text.js'
import { sha256Hex } from './sha256.js'

function normalizeMeaningText(value, lowerCase = false) {
  const text = String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ')
  return lowerCase ? text.toLowerCase() : text
}

const POS_ALIASES = new Map([
  ['n', 'noun'], ['noun', 'noun'], ['v', 'verb'], ['verb', 'verb'],
  ['vt', 'verb'], ['vi', 'verb'], ['adj', 'adjective'], ['adjective', 'adjective'],
  ['adv', 'adverb'], ['adverb', 'adverb'], ['prep', 'preposition'],
  ['preposition', 'preposition'], ['conj', 'conjunction'], ['conjunction', 'conjunction'],
  ['pron', 'pronoun'], ['pronoun', 'pronoun'], ['int', 'interjection'],
  ['interjection', 'interjection'],
])

function normalizePos(value) {
  const raw = normalizeMeaningText(value, true).replace(/\.$/, '')
  return POS_ALIASES.get(raw) || raw
}

function hash(parts) {
  return sha256Hex(parts.join('\u0000'))
}

function meaningKey(word, kind, language, pos, text) {
  return 'meaning:v1:' + hash([
    normalizeText(word), kind, language, normalizePos(pos),
    normalizeMeaningText(text, language === 'en'),
  ])
}

function translationMeanings(word, snapshot) {
  const out = []
  let inheritedPos = ''
  for (const group of String(snapshot ?? '').split(/[；;]/)) {
    const trimmed = group.trim()
    if (!trimmed) continue
    const match = /^([a-zA-Z]{1,12})\.\s*(.+)$/.exec(trimmed)
    const pos = normalizePos(match?.[1] || inheritedPos)
    const body = match?.[2] || trimmed
    if (pos) inheritedPos = pos
    for (const part of body.split(/[，,]/)) {
      const text = normalizeMeaningText(part)
      if (!text) continue
      out.push({
        key: meaningKey(word, 'translation', 'zh', pos, text),
        kind: 'translation', language: 'zh', pos, text,
      })
    }
  }
  return out
}

/**
 * 把学习列表里的“本阶段词义”固化为内容型身份。
 * 当前中文快照可以精确到内容；只有旧 ID、没有快照的记录进入明确的 legacy 桶，绝不猜测。
 */
export function meaningRefsForItem(item) {
  const word = normalizeText(item?.word)
  const refs = translationMeanings(word, item?.translation)
  const known = new Set(refs.map(ref => ref.key))
  for (const raw of Array.isArray(item?.senseIds) ? item.senseIds : []) {
    const text = normalizeMeaningText(raw, true)
    const key = meaningKey(word, 'legacy-sense-id', 'en', '', text)
    if (!known.has(key)) {
      known.add(key)
      refs.push({ key, kind: 'legacy-sense-id', language: 'en', pos: '', text })
    }
  }
  if (refs.length === 0) {
    const ids = [...(Array.isArray(item?.translationIds) ? item.translationIds : [])]
      .map(value => normalizeMeaningText(value, true)).filter(Boolean).sort()
    const text = ids.length > 0 ? ids.join('|') : '未区分词义'
    refs.push({
      key: meaningKey(word, 'legacy-selection', 'und', '', text),
      kind: 'legacy-selection', language: 'und', pos: '', text,
    })
  }
  return refs
}

function json(value) {
  return JSON.stringify(value ?? null)
}

const INSERT_MEANING_SQL = `
  INSERT OR IGNORE INTO meaning_profiles
    (meaning_key, word_key, kind, language, pos, text_snapshot, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`
const INSERT_EVENT_SQL = `
  INSERT OR IGNORE INTO learning_events
    (id, event_key, word_key, word_snapshot, action, occurred_at, scope, stage,
     list_id, list_name_snapshot, source_ids_json, translation_ids_json,
     sense_ids_json, meaning_snapshot, request_id, metadata_json, deleted_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
`
const INSERT_EVENT_MEANING_SQL = `
  INSERT OR IGNORE INTO learning_event_meanings (event_id, meaning_key) VALUES (?, ?)
`

export function createStudyHistoryStore(db) {
  async function recordInternal(input) {
    const item = input.item || {}
    const word = normalizeText(input.word || item.word)
    if (!word) return { inserted: false, id: null }
    const requestId = String(input.requestId ?? '').trim() || null
    if (requestId && await hasRequest(requestId)) return { inserted: false, id: null }
    const at = Number(input.at) || Date.now()
    const refs = meaningRefsForItem({ ...item, word })
    const id = input.id || crypto.randomUUID()
    const eventKey = String(input.eventKey ?? '').trim() || null
    const statements = refs.map(ref => [
      INSERT_MEANING_SQL, ref.key, word, ref.kind, ref.language, ref.pos, ref.text, at,
    ])
    statements.push([
      INSERT_EVENT_SQL,
      id, eventKey, word, String(item.word || word), String(input.action), at,
      input.scope || null, Number.isFinite(input.stage) ? input.stage : null,
      input.listId || null, input.listName || null,
      json(Array.isArray(item.sourceIds) ? item.sourceIds : []),
      json(Array.isArray(item.translationIds) ? item.translationIds : []),
      json(Array.isArray(item.senseIds) ? item.senseIds : []),
      String(item.translation ?? '') || null, requestId, json(input.metadata || {}), at,
    ])
    const changes = await db.batch(statements)
    // 最后一条是事件插入；插入命中（changes>0）才挂词义关联
    if (Number(changes[changes.length - 1]) > 0) {
      await db.batch(refs.map(ref => [INSERT_EVENT_MEANING_SQL, id, ref.key]))
    }
    return { inserted: Number(changes[changes.length - 1]) > 0, id, meaningKeys: refs.map(ref => ref.key) }
  }

  async function record(input) {
    return recordInternal(input)
  }

  async function hasRequest(requestId) {
    if (!requestId) return false
    return Boolean(await db.first('SELECT 1 FROM learning_events WHERE request_id = ? LIMIT 1', requestId))
  }

  function eventFilter(options = {}, alias = 'e') {
    const libraryId = String(options.libraryId ?? '').trim()
    const wordFilter = normalizeText(options.word)
    const action = String(options.action ?? 'review').trim() || 'review'
    const clauses = [alias + '.deleted_at IS NULL']
    const params = []
    if (libraryId) {
      clauses.push('EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(' + alias +
        '.source_ids_json) THEN ' + alias + ".source_ids_json ELSE '[]' END) source WHERE source.value = ?)")
      params.push(libraryId)
    }
    if (action === 'review') clauses.push(alias + ".action IN ('done', 'again', 'spelling', 'reading', 'meaning')")
    else {
      clauses.push(alias + '.action = ?')
      params.push(action)
    }
    if (wordFilter) {
      clauses.push('instr(' + alias + '.word_key, ?) > 0')
      params.push(wordFilter)
    }
    return { sql: clauses.join(' AND '), params }
  }

  async function aggregate(options = {}) {
    const filter = eventFilter(options)
    const rows = await db.all(
      'WITH filtered AS (SELECT e.*, FIRST_VALUE(e.word_snapshot) OVER (' +
      ' PARTITION BY e.word_key ORDER BY e.occurred_at DESC, e.created_at DESC' +
      ' ) AS display_word FROM learning_events e WHERE ' + filter.sql + ')' +
      ' SELECT word_key, display_word AS word,' +
      " SUM(CASE WHEN action IN ('done', 'again') THEN 1 ELSE 0 END) AS review_count," +
      " SUM(CASE WHEN action = 'spelling' THEN 1 ELSE 0 END) AS spelling_count," +
      " SUM(CASE WHEN action = 'reading' THEN 1 ELSE 0 END) AS reading_count," +
      " SUM(CASE WHEN action = 'meaning' THEN 1 ELSE 0 END) AS remembered_count," +
      " SUM(CASE WHEN action = 'again' THEN 1 ELSE 0 END) AS forgotten_count," +
      ' MAX(occurred_at) AS last_at FROM filtered GROUP BY word_key',
      ...filter.params,
    )
    const meaningRows = await db.all(
      'SELECT e.word_key, em.meaning_key,' +
      " SUM(CASE WHEN e.action IN ('done', 'again') THEN 1 ELSE 0 END) AS review_count," +
      " SUM(CASE WHEN e.action = 'meaning' THEN 1 ELSE 0 END) AS remembered_count," +
      " SUM(CASE WHEN e.action = 'again' THEN 1 ELSE 0 END) AS forgotten_count" +
      ' FROM learning_events e JOIN learning_event_meanings em ON em.event_id = e.id' +
      ' WHERE ' + filter.sql + ' GROUP BY e.word_key, em.meaning_key',
      ...filter.params,
    )
    const meaningsByWord = new Map()
    for (const row of meaningRows) {
      const values = meaningsByWord.get(row.word_key) || []
      values.push({ meaningKey: row.meaning_key, reviewCount: Number(row.review_count),
        rememberedCount: Number(row.remembered_count), forgottenCount: Number(row.forgotten_count) })
      meaningsByWord.set(row.word_key, values)
    }
    const sourceRows = await db.all(
      'SELECT e.word_key, source.value AS source_id FROM learning_events e,' +
      " json_each(CASE WHEN json_valid(e.source_ids_json) THEN e.source_ids_json ELSE '[]' END) source WHERE " +
      filter.sql + ' ORDER BY e.occurred_at DESC, e.created_at DESC, source.key',
      ...filter.params,
    )
    const sourcesByWord = new Map()
    for (const row of sourceRows) {
      const values = sourcesByWord.get(row.word_key) || []
      if (!values.includes(row.source_id)) values.push(row.source_id)
      sourcesByWord.set(row.word_key, values)
    }
    return rows.map(row => ({
      word: row.word || row.word_key, sourceIds: sourcesByWord.get(row.word_key) || [],
      reviewCount: Number(row.review_count), spellingCount: Number(row.spelling_count),
      readingCount: Number(row.reading_count), rememberedCount: Number(row.remembered_count),
      forgottenCount: Number(row.forgotten_count), lastAt: row.last_at == null ? null : Number(row.last_at),
      meanings: meaningsByWord.get(row.word_key) || [], wordKey: row.word_key, events: [],
    })).sort((a, b) => b.reviewCount - a.reviewCount || a.word.localeCompare(b.word, 'en'))
  }

  async function achievements(options = {}) {
    return { items: (await aggregate(options)).map(({ events: _events, wordKey: _wordKey, ...item }) => item) }
  }

  async function history(options = {}) {
    const libraryId = String(options.libraryId ?? '').trim()
    const wordFilter = normalizeText(options.word)
    const action = String(options.action ?? 'review').trim() || 'review'
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 20))
    const offset = Math.max(0, Number(options.offset) || 0)
    const all = await aggregate({ libraryId, word: wordFilter, action })
    const page = all.slice(offset, offset + limit)
    const wordKeys = page.map(item => item.wordKey)
    if (wordKeys.length > 0) {
      const filter = eventFilter({ libraryId, action })
      const placeholders = wordKeys.map(() => '?').join(', ')
      const events = await db.all(
        'SELECT e.*, GROUP_CONCAT(em.meaning_key) AS meaning_keys FROM learning_events e' +
        ' LEFT JOIN learning_event_meanings em ON em.event_id = e.id WHERE ' + filter.sql +
        ' AND e.word_key IN (' + placeholders + ') GROUP BY e.id' +
        ' ORDER BY e.occurred_at DESC, e.created_at DESC',
        ...filter.params, ...wordKeys,
      )
      const byWord = new Map(page.map(item => [item.wordKey, item]))
      for (const row of events) {
        const item = byWord.get(row.word_key)
        if (!item) continue
        item.events.push({
          id: row.id, action: row.action, at: Number(row.occurred_at), scope: row.scope || undefined,
          stage: row.stage == null ? undefined : Number(row.stage),
          requestId: row.request_id || undefined,
          meaningKeys: String(row.meaning_keys || '').split(',').filter(Boolean),
          meaningSnapshot: row.meaning_snapshot || undefined,
        })
      }
    }
    for (const item of page) delete item.wordKey
    return { items: page, total: all.length, limit, offset }
  }

  async function deleteEvent(id) {
    const existing = await db.first('SELECT id FROM learning_events WHERE id = ? AND deleted_at IS NULL', id)
    if (!existing) return { deleted: 0 }
    const changes = await db.run('UPDATE learning_events SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', Date.now(), id)
    return { deleted: changes }
  }

  /**
   * 一次聚合查询算出本周期（day / week）所有词的会拼 / 会读 / 知意次数。
   * 在 D1 聚合后返回嵌套 Map：Map<listId, Map<wordKey, { spelling, reading, meaning }>>，
   * day / week 各一份（day 窗口包含在 week 窗口内）；不把周期内每条事件搬进 Worker。
   * 事件表是唯一来源：撤销软删事件后这里自然回退，列表累计计数也只认这里。
   */
  async function periodTallyCountsAll({ dayStart, weekStart }) {
    const day = new Map()
    const week = new Map()
    const weekFrom = Number(weekStart)
    if (!Number.isFinite(weekFrom)) return { day, week }
    const dayFrom = Number(dayStart)
    const hasDay = Number.isFinite(dayFrom)
    const rows = await db.all(`
      SELECT list_id, word_key, action, COUNT(*) AS week_count,
        SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS day_count
      FROM learning_events
      WHERE deleted_at IS NULL AND action IN ('spelling', 'reading', 'meaning')
        AND occurred_at >= ?
      GROUP BY list_id, word_key, action
    `, hasDay ? dayFrom : weekFrom, weekFrom)
    for (const row of rows) {
      const wordKey = row.word_key
      if (!wordKey) continue
      bumpTally(week, row.list_id, wordKey, row.action, Number(row.week_count))
      const dayCount = Number(row.day_count)
      if (dayCount > 0) bumpTally(day, row.list_id, wordKey, row.action, dayCount)
    }
    return { day, week }
  }

  function bumpTally(map, listId, wordKey, action, count) {
    if (!map.has(listId)) map.set(listId, new Map())
    const byWord = map.get(listId)
    const counts = byWord.get(wordKey) || { spelling: 0, reading: 0, meaning: 0 }
    counts[action] = (counts[action] || 0) + count
    byWord.set(wordKey, counts)
  }

  /**
   * 撤销本周期内最近一次熟悉度计数：软删那条事件，累计计数由调用方回退。
   * deleted_at 本身就是留痕，不做额外备份。
   */
  async function undoTallyEvent({ listId, word, action, from }) {
    const wordKey = normalizeText(word)
    if (!wordKey || !action || !Number.isFinite(Number(from))) return { deleted: 0 }
    const row = await db.first(`
      SELECT id FROM learning_events
       WHERE word_key = ? AND action = ? AND occurred_at >= ? AND deleted_at IS NULL
        AND list_id IS ?
       ORDER BY occurred_at DESC, created_at DESC
      LIMIT 1
    `, wordKey, String(action), Number(from), listId ?? null)
    if (!row) return { deleted: 0 }
    const changes = await db.run('UPDATE learning_events SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', Date.now(), row.id)
    return { deleted: changes }
  }

  async function clearWord(word) {
    const key = normalizeText(word)
    if (!key) return { deleted: 0 }
    const count = await db.first('SELECT COUNT(*) AS count FROM learning_events WHERE word_key = ? AND deleted_at IS NULL', key)
    if (Number(count?.count || 0) === 0) return { deleted: 0 }
    const changes = await db.run('UPDATE learning_events SET deleted_at = ? WHERE word_key = ? AND deleted_at IS NULL', Date.now(), key)
    return { deleted: changes }
  }

  async function purge(input = {}) {
    const purgeAll = input.all === true
    const words = [...new Set((Array.isArray(input.words) ? input.words : [])
      .map(value => normalizeText(value)).filter(Boolean))]
    if (!purgeAll && words.length === 0) {
      return { deletedEvents: 0, deletedMeanings: 0, backup: null }
    }

    const placeholders = words.map(() => '?').join(', ')
    const existing = purgeAll
      ? await db.first('SELECT COUNT(*) AS count FROM learning_events')
      : await db.first('SELECT COUNT(*) AS count FROM learning_events WHERE word_key IN (' + placeholders + ')', ...words)
    if (Number(existing?.count || 0) === 0) {
      return { deletedEvents: 0, deletedMeanings: 0, backup: null }
    }

    // 一个 batch = 一个事务：删事件关联、删事件、再清孤儿词义画像，中途失败整体回滚
    const statements = purgeAll
      ? [
          ['DELETE FROM learning_event_meanings'],
          ['DELETE FROM learning_events'],
        ]
      : [
          [`DELETE FROM learning_event_meanings
            WHERE event_id IN (SELECT id FROM learning_events WHERE word_key IN (${placeholders}))`, ...words],
          [`DELETE FROM learning_events WHERE word_key IN (${placeholders})`, ...words],
        ]
    statements.push([`
      DELETE FROM meaning_profiles
      WHERE NOT EXISTS (
        SELECT 1 FROM learning_event_meanings em
        WHERE em.meaning_key = meaning_profiles.meaning_key
      )
    `])
    const changes = await db.batch(statements)
    return {
      deletedEvents: Number(changes[1]),
      deletedEventMeanings: Number(changes[0]),
      deletedMeanings: Number(changes[2]),
      backup: null,
    }
  }

  async function integrityCheck() {
    return 'ok'
  }

  return {
    record, hasRequest, achievements, history, deleteEvent, clearWord, purge,
    undoTallyEvent, periodTallyCountsAll, integrityCheck,
  }
}
