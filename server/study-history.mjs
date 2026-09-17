import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { normalizeText } from './text.mjs'
import { openStudyDb } from './db.mjs'

const HISTORY_SCHEMA_VERSION = 1

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
  return createHash('sha256').update(parts.join('\u0000')).digest('hex')
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

function parseJson(value, fallback) {
  try { return JSON.parse(value) }
  catch { return fallback }
}

function sqlString(value) {
  return "'" + String(value).replaceAll("'", "''") + "'"
}

export function createStudyHistoryStore(options) {
  const dataDir = options.dataDir
  const listsFile = options.listsFile
  const dbFile = path.join(dataDir, 'study-history.sqlite')
  const backupDir = path.join(dataDir, 'backups')
  fs.mkdirSync(dataDir, { recursive: true })
  // 和学习列表 store 共用同一条连接（db.mjs 负责 DELETE 模式 / PRAGMA），
  // purge 这类跨表操作才能在同一个事务里完成
  const db = openStudyDb(dataDir)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      key TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS meaning_profiles (
      meaning_key TEXT PRIMARY KEY,
      word_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      language TEXT NOT NULL,
      pos TEXT NOT NULL,
      text_snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS learning_events (
      id TEXT PRIMARY KEY,
      event_key TEXT UNIQUE,
      word_key TEXT NOT NULL,
      word_snapshot TEXT NOT NULL,
      action TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      scope TEXT,
      stage INTEGER,
      list_id TEXT,
      list_name_snapshot TEXT,
      source_ids_json TEXT NOT NULL,
      translation_ids_json TEXT NOT NULL,
      sense_ids_json TEXT NOT NULL,
      meaning_snapshot TEXT,
      request_id TEXT UNIQUE,
      metadata_json TEXT NOT NULL,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS learning_event_meanings (
      event_id TEXT NOT NULL REFERENCES learning_events(id),
      meaning_key TEXT NOT NULL REFERENCES meaning_profiles(meaning_key),
      PRIMARY KEY (event_id, meaning_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS idx_learning_events_word_time
      ON learning_events(word_key, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_events_action_time
      ON learning_events(action, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_events_active_time
      ON learning_events(deleted_at, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_event_meanings_meaning
      ON learning_event_meanings(meaning_key, event_id);
  `)

  const insertMeaning = db.prepare(`
    INSERT OR IGNORE INTO meaning_profiles
      (meaning_key, word_key, kind, language, pos, text_snapshot, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO learning_events
      (id, event_key, word_key, word_snapshot, action, occurred_at, scope, stage,
       list_id, list_name_snapshot, source_ids_json, translation_ids_json,
       sense_ids_json, meaning_snapshot, request_id, metadata_json, deleted_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
  `)
  const insertEventMeaning = db.prepare(`
    INSERT OR IGNORE INTO learning_event_meanings (event_id, meaning_key) VALUES (?, ?)
  `)
  // 本周期（按天 / 按周）会拼 / 会读 / 知意次数：直接从事件表现算，不再依赖 JSON 里的 marks 镜像
  const periodTallyStmt = db.prepare(`
    SELECT action, occurred_at FROM learning_events
    WHERE word_key = ? AND deleted_at IS NULL AND list_id IS ?
      AND action IN ('spelling', 'reading', 'meaning')
  `)

  function recordInternal(input, manageTransaction = true) {
    const item = input.item || {}
    const word = normalizeText(input.word || item.word)
    if (!word) return { inserted: false, id: null }
    const requestId = String(input.requestId ?? '').trim() || null
    if (requestId && hasRequest(requestId)) return { inserted: false, id: null }
    const at = Number(input.at) || Date.now()
    const refs = meaningRefsForItem({ ...item, word })
    const id = input.id || randomUUID()
    const eventKey = String(input.eventKey ?? '').trim() || null
    if (manageTransaction) db.exec('BEGIN IMMEDIATE')
    try {
      for (const ref of refs) {
        insertMeaning.run(ref.key, word, ref.kind, ref.language, ref.pos, ref.text, at)
      }
      const result = insertEvent.run(
        id, eventKey, word, String(item.word || word), String(input.action), at,
        input.scope || null, Number.isFinite(input.stage) ? input.stage : null,
        input.listId || null, input.listName || null,
        json(Array.isArray(item.sourceIds) ? item.sourceIds : []),
        json(Array.isArray(item.translationIds) ? item.translationIds : []),
        json(Array.isArray(item.senseIds) ? item.senseIds : []),
        String(item.translation ?? '') || null, requestId, json(input.metadata || {}), at,
      )
      if (Number(result.changes) > 0) {
        for (const ref of refs) insertEventMeaning.run(id, ref.key)
      }
      if (manageTransaction) db.exec('COMMIT')
      return { inserted: Number(result.changes) > 0, id, meaningKeys: refs.map(ref => ref.key) }
    } catch (error) {
      if (manageTransaction) db.exec('ROLLBACK')
      throw error
    }
  }

  function record(input) {
    return recordInternal(input, true)
  }

  function hasRequest(requestId) {
    if (!requestId) return false
    return Boolean(db.prepare('SELECT 1 FROM learning_events WHERE request_id = ? LIMIT 1').get(requestId))
  }

  function migrateLegacyLists() {
    const migrationKey = 'legacy-study-lists-v' + HISTORY_SCHEMA_VERSION
    if (db.prepare('SELECT 1 FROM schema_migrations WHERE key = ?').get(migrationKey)) return
    let data
    try { data = JSON.parse(fs.readFileSync(listsFile, 'utf8')) }
    catch { data = { lists: [] } }
    const lists = Array.isArray(data?.lists) ? data.lists : []
    if (fs.existsSync(listsFile)) {
      fs.mkdirSync(backupDir, { recursive: true })
      const backup = path.join(backupDir, 'study-lists.before-history-' + Date.now() + '.json')
      fs.copyFileSync(listsFile, backup, fs.constants.COPYFILE_EXCL)
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const list of lists) {
        for (const item of Array.isArray(list?.words) ? list.words : []) {
          const marks = Array.isArray(item?.marks) ? item.marks : []
          marks.forEach((mark, index) => {
            const action = String(mark?.action || '')
            recordInternal({
              item, listId: list.id, listName: list.name, action,
              at: Number(mark?.at) || Number(item?.addedAt) || Date.now(),
              scope: mark?.scope, stage: mark?.stage,
              eventKey: ['legacy', list.id, normalizeText(item.word), mark?.at, action, index].join('|'),
              metadata: { migrated: true },
            }, false)
          })
          const refs = meaningRefsForItem(item)
          for (const ref of refs) {
            insertMeaning.run(ref.key, normalizeText(item.word), ref.kind, ref.language, ref.pos, ref.text, Date.now())
          }
        }
      }
      db.prepare('INSERT INTO schema_migrations (key, applied_at) VALUES (?, ?)').run(migrationKey, Date.now())
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function activeRows() {
    const events = db.prepare(`
      SELECT e.*, GROUP_CONCAT(em.meaning_key) AS meaning_keys
      FROM learning_events e
      LEFT JOIN learning_event_meanings em ON em.event_id = e.id
      WHERE e.deleted_at IS NULL
      GROUP BY e.id
      ORDER BY e.occurred_at DESC, e.created_at DESC
    `).all()
    return events
  }

  function matchesLibrary(row, libraryId) {
    if (!libraryId) return true
    return parseJson(row.source_ids_json, []).includes(libraryId)
  }

  function actionMatches(action, filter) {
    if (!filter) return true
    if (filter === 'review') {
      return action === 'done' || action === 'again' || action === 'spelling'
        || action === 'reading' || action === 'meaning'
    }
    return action === filter
  }

  function aggregate(options = {}) {
    const libraryId = String(options.libraryId ?? '').trim()
    const wordFilter = normalizeText(options.word)
    const action = String(options.action ?? 'review').trim() || 'review'
    const events = activeRows()
    const groups = new Map()
    const ensure = row => {
      let item = groups.get(row.word_key)
      if (!item) {
        item = {
          word: row.word_snapshot || row.word_key, sourceIds: [], reviewCount: 0,
          spellingCount: 0, readingCount: 0, rememberedCount: 0, forgottenCount: 0, lastAt: null,
          meanings: new Map(), events: [],
        }
        groups.set(row.word_key, item)
      }
      item.sourceIds = [...new Set([...item.sourceIds, ...parseJson(row.source_ids_json, [])])]
      return item
    }
    for (const row of events) {
      if (!matchesLibrary(row, libraryId) || !actionMatches(row.action, action)
        || (wordFilter && !row.word_key.includes(wordFilter))) continue

      const item = ensure(row)
      // done / again 推进轮次才算复习；会拼 / 会读 / 知意是熟悉度计数，各算各的
      if (row.action === 'done' || row.action === 'again') item.reviewCount++
      if (row.action === 'meaning') item.rememberedCount++
      if (row.action === 'again') item.forgottenCount++
      if (row.action === 'spelling') item.spellingCount++
      if (row.action === 'reading') item.readingCount++
      item.lastAt = item.lastAt === null ? Number(row.occurred_at) : Math.max(item.lastAt, Number(row.occurred_at))
      for (const key of String(row.meaning_keys || '').split(',').filter(Boolean)) {
        const stats = item.meanings.get(key) || { meaningKey: key, reviewCount: 0, rememberedCount: 0, forgottenCount: 0 }
        if (row.action === 'done' || row.action === 'again') stats.reviewCount++
        if (row.action === 'meaning') stats.rememberedCount++
        if (row.action === 'again') stats.forgottenCount++
        item.meanings.set(key, stats)
      }
    }
    return [...groups.values()].map(item => ({ ...item, meanings: [...item.meanings.values()] }))
      .sort((a, b) => b.reviewCount - a.reviewCount || a.word.localeCompare(b.word, 'en'))
  }

  function achievements(options = {}) {
    return { items: aggregate(options).map(({ events: _events, ...item }) => item) }
  }

  function history(options = {}) {
    const libraryId = String(options.libraryId ?? '').trim()
    const wordFilter = normalizeText(options.word)
    const action = String(options.action ?? 'review').trim() || 'review'
    const limit = Math.min(100, Math.max(1, Number(options.limit) || 20))
    const offset = Math.max(0, Number(options.offset) || 0)
    const all = aggregate({ libraryId, word: wordFilter, action })
    const events = activeRows()
    const page = all.slice(offset, offset + limit)
    const byWord = new Map(page.map(item => [normalizeText(item.word), item]))
    for (const row of events) {
      const item = byWord.get(row.word_key)
      if (!item || !matchesLibrary(row, libraryId) || !actionMatches(row.action, action)) continue
      item.events.push({
        id: row.id, action: row.action, at: Number(row.occurred_at), scope: row.scope || undefined,
        stage: row.stage == null ? undefined : Number(row.stage),
        requestId: row.request_id || undefined,
        meaningKeys: String(row.meaning_keys || '').split(',').filter(Boolean),
        meaningSnapshot: row.meaning_snapshot || undefined,
      })
    }
    return { items: page, total: all.length, limit, offset }
  }

  function backup(reason) {
    fs.mkdirSync(backupDir, { recursive: true })
    db.exec('PRAGMA wal_checkpoint(FULL)')
    const target = path.join(backupDir, 'study-history.' + reason + '-' + Date.now() + '-' + randomUUID() + '.sqlite')
    db.exec('VACUUM INTO ' + sqlString(target))
    return target
  }

  function deleteEvent(id) {
    const existing = db.prepare('SELECT id FROM learning_events WHERE id = ? AND deleted_at IS NULL').get(id)
    if (!existing) return { deleted: 0 }
    backup('before-delete-event')
    const result = db.prepare('UPDATE learning_events SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(Date.now(), id)
    return { deleted: Number(result.changes) }
  }

  /**
   * 按周期（day / week）现算某个词的会拼 / 会读 / 知意次数。
   * 事件表是唯一来源：撤销软删事件后这里自然回退，列表累计计数也只认这里。
   */
  function periodTallyCounts({ listId, word, dayStart, weekStart }) {
    const wordKey = normalizeText(word)
    const day = { spelling: 0, reading: 0, meaning: 0 }
    const week = { spelling: 0, reading: 0, meaning: 0 }
    if (!wordKey) return { day, week }
    for (const row of periodTallyStmt.all(wordKey, listId ?? null)) {
      const at = Number(row.occurred_at)
      if (!Number.isFinite(at)) continue
      if (at >= dayStart) day[row.action] = (day[row.action] || 0) + 1
      if (at >= weekStart) week[row.action] = (week[row.action] || 0) + 1
    }
    return { day, week }
  }

  /**
   * 撤销本周期内最近一次熟悉度计数：软删那条事件，累计计数由调用方回退。
   * 不做整库备份——撤销是轻量可重复的「反悔」操作，deleted_at 本身就是留痕。
   */
  function undoTallyEvent({ listId, word, action, from }) {
    const wordKey = normalizeText(word)
    if (!wordKey || !action || !Number.isFinite(Number(from))) return { deleted: 0 }
   const row = db.prepare(`
     SELECT id FROM learning_events
      WHERE word_key = ? AND action = ? AND occurred_at >= ? AND deleted_at IS NULL
       AND list_id IS ?
      ORDER BY occurred_at DESC, created_at DESC
     LIMIT 1
    `).get(wordKey, String(action), Number(from), listId ?? null)
   if (!row) return { deleted: 0 }
    const result = db.prepare('UPDATE learning_events SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(Date.now(), row.id)
    return { deleted: Number(result.changes) }
  }

  function clearWord(word) {
    const key = normalizeText(word)
    if (!key) return { deleted: 0 }
    const count = db.prepare('SELECT COUNT(*) AS count FROM learning_events WHERE word_key = ? AND deleted_at IS NULL').get(key)
    if (Number(count?.count || 0) === 0) return { deleted: 0 }
    backup('before-clear-word')
    const now = Date.now()
    const eventsResult = db.prepare('UPDATE learning_events SET deleted_at = ? WHERE word_key = ? AND deleted_at IS NULL').run(now, key)
    return { deleted: Number(eventsResult.changes) }
  }

  function purge(input = {}) {
    const purgeAll = input.all === true
    const words = [...new Set((Array.isArray(input.words) ? input.words : [])
      .map(value => normalizeText(value)).filter(Boolean))]
    if (!purgeAll && words.length === 0) {
      return { deletedEvents: 0, deletedMeanings: 0, backup: null }
    }

    const placeholders = words.map(() => '?').join(', ')
    const eventWhere = purgeAll ? '' : ` WHERE word_key IN (${placeholders})`
    const existingEvents = Number(db.prepare(
      `SELECT COUNT(*) AS count FROM learning_events${eventWhere}`,
    ).get(...words)?.count || 0)
    if (existingEvents === 0) {
      return { deletedEvents: 0, deletedMeanings: 0, backup: null }
    }

    const reason = purgeAll ? 'before-purge-all' : 'before-purge-words'
    const backupFile = backup(reason)
    db.exec('BEGIN IMMEDIATE')
    try {
      let eventMeaningResult
      let eventResult
      if (purgeAll) {
        eventMeaningResult = db.prepare('DELETE FROM learning_event_meanings').run()
        eventResult = db.prepare('DELETE FROM learning_events').run()
      } else {
        eventMeaningResult = db.prepare(`
          DELETE FROM learning_event_meanings
          WHERE event_id IN (SELECT id FROM learning_events WHERE word_key IN (${placeholders}))
        `).run(...words)
        eventResult = db.prepare(
          `DELETE FROM learning_events WHERE word_key IN (${placeholders})`,
        ).run(...words)
      }
      const meaningResult = db.prepare(`
        DELETE FROM meaning_profiles
        WHERE NOT EXISTS (
          SELECT 1 FROM learning_event_meanings em
        WHERE em.meaning_key = meaning_profiles.meaning_key
       )
     `).run()
      db.exec('COMMIT')
      return {
        deletedEvents: Number(eventResult.changes),
        deletedEventMeanings: Number(eventMeaningResult.changes),
        deletedMeanings: Number(meaningResult.changes),
        backup: path.basename(backupFile),
      }
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  migrateLegacyLists()

  return {
   dbFile, record, hasRequest, achievements, history, deleteEvent, clearWord, purge,
   undoTallyEvent,
   periodTallyCounts,
   integrityCheck: () => db.prepare('PRAGMA integrity_check').get()?.integrity_check,
    close: () => db.close(),
  }
}
