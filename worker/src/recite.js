/**
 * recite.js — 开始背单词的任务、会话和卡片领域服务。
 *
 * 任务词池是学习列表的快照；真正的复习排期仍由 review.js 和 list_words 负责。
 */
import { normalizeText } from './text.js'
import {
  DAY, applyReview, countOf, enrichItem, hasReviewKey, nextDueAt,
  pushMark, rememberReviewKey, startOfWeek,
} from './review.js'
import { progressRow } from './study-lists.js'
import { recordStudyEvent } from './lists.js'

const MAX_SELECTIONS = 500
const CARD_TYPES = new Set(['meaning', 'spelling'])
/** 家长一次「确定」最多提交多少张卡片；前端按同一上限分批，避免单个请求查库过多 */
const MAX_COMMIT_ANSWERS = 60

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value ?? ''))
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function stableHash(value) {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function taskRange(weekStart) {
  return { weekStart, weekEnd: weekStart + 7 * DAY }
}

/**
 * 解析配置目标周：不传默认本周；必须对齐到周一，且只能配置本周到 12 周后的任务。
 * 过去的周已经不能学习，预排太远没有实际意义。
 */
function resolveWeekStart(input, env, now) {
  const thisWeek = startOfWeek(now, env)
  if (input == null || input === '') return thisWeek
  const raw = Number(input)
  if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
    throw new Error('周开始时间无效')
  }
  if (startOfWeek(raw, env) !== raw) throw new Error('周开始时间必须对齐到周一')
  if (raw < thisWeek) throw new Error('不能配置过去的周')
  if (raw > thisWeek + 12 * 7 * DAY) throw new Error('最多预排 12 周后的任务')
  return raw
}

function sourceGroupOf(row) {
  return row.batch_key || ''
}

function rowSnapshot(row, sourceType, sourceLastAt = null, sourceGroup = '') {
  return {
    word: row.word,
    listId: row.list_id,
    listName: row.list_name || '',
    type: row.type === 'sentence' ? 'sentence' : 'word',
    displayText: row.display_text || '',
    translation: row.translation || '',
    sourceType,
    sourceGroup: sourceGroup || sourceGroupOf(row),
    sourceLastAt: sourceLastAt == null ? null : Number(sourceLastAt),
  }
}

/** recite_task_words 的行 → 与 preview 同形状的快照，供只改一次学习时原样保留其他行 */
function rowSnapshotFromRow(row) {
  return {
    word: row.word,
    listId: row.list_id,
    type: row.type,
    displayText: row.display_text || '',
    translation: row.translation || '',
    sourceType: row.source_type,
    sourceGroup: row.source_group || '',
    sourceLastAt: row.source_last_at == null ? null : Number(row.source_last_at),
  }
}

function taskWordResponse(row) {
  return {
    word: row.word,
    listId: row.list_id,
    position: Number(row.position),
    type: row.type,
    displayText: row.display_text || undefined,
    translation: row.translation || undefined,
    sourceType: row.source_type,
    sourceGroup: row.source_group || undefined,
    sourceLastAt: row.source_last_at == null ? undefined : Number(row.source_last_at),
    spellingEnabled: Number(row.spelling_enabled) === 1,
  }
}

function cardResponse(row, includeAnswer = false) {
  const card = {
    id: row.id,
    position: Number(row.position),
    word: row.word,
    listId: row.list_id,
    cardType: row.card_type,
    displayText: row.display_text || undefined,
    translation: row.translation || undefined,
    status: row.status,
    result: row.result || undefined,
    attempts: Number(row.attempts || 0),
  }
  if (includeAnswer && row.card_type === 'spelling') card.answer = row.answer || row.word
  return card
}

function summaryFromRows(session, cards) {
  return {
    sessionId: session.id,
    sessionIndex: Number(session.session_index),
    status: session.status,
    startedAt: session.started_at == null ? undefined : Number(session.started_at),
    cursor: Number(session.cursor),
    cardCount: Number(session.card_count),
    completedCount: Number(session.completed_count),
    completedCards: cards.filter(card => card.status === 'answered').length,
    knownCount: cards.filter(card => card.result === 'known').length,
    unknownCount: cards.filter(card => card.result === 'unknown').length,
    spellingCorrect: cards.filter(card => card.result === 'correct').length,
    spellingSkipped: cards.filter(card => card.result === 'skipped').length,
  }
}

function createTaskId() {
  return 'recite-task-' + crypto.randomUUID()
}

function createSessionId() {
  return 'recite-session-' + crypto.randomUUID()
}

function createCardId() {
  return 'recite-card-' + crypto.randomUUID()
}

async function loadWordRow(db, listId, word) {
  return await db.first(
    'SELECT w.*, l.name AS list_name FROM list_words w JOIN lists l ON l.id = w.list_id WHERE w.list_id = ? AND w.word = ?',
    String(listId), normalizeText(word),
  )
}

async function loadRowsByWord(db, word) {
  return await db.all(
    'SELECT w.*, l.name AS list_name FROM list_words w JOIN lists l ON l.id = w.list_id WHERE w.word = ? ORDER BY w.list_id, w.position',
    normalizeText(word),
  )
}

async function achievementCandidates(db) {
  return await db.all(
    `SELECT e.word_key AS word, MAX(e.occurred_at) AS last_at,
      (SELECT e2.source_ids_json FROM learning_events e2
       WHERE e2.word_key = e.word_key AND e2.deleted_at IS NULL
       ORDER BY e2.occurred_at DESC, e2.created_at DESC LIMIT 1) AS source_ids_json
     FROM learning_events e
     WHERE e.deleted_at IS NULL AND e.action IN ('done', 'again', 'spelling', 'reading', 'meaning')
     GROUP BY e.word_key
     ORDER BY last_at ASC, word ASC`,
  )
}

async function chooseCandidateRow(db, candidate) {
  const rows = await loadRowsByWord(db, candidate.word)
  if (rows.length === 0) return null
  const preferred = parseJson(candidate.source_ids_json, [])
  for (const listId of preferred) {
    const match = rows.find(row => row.list_id === String(listId))
    if (match) return match
  }
  return rows[0]
}

function previewResponse({ weekStart, perSessionCount, sessionCount, selected, ignored, autoFilled }) {
  const capacity = perSessionCount * sessionCount
  return {
    weekStart,
    weekEnd: weekStart + 7 * DAY,
    perSessionCount,
    sessionCount,
    capacity,
    selectedCount: selected.length,
    ignoredCount: ignored.length,
    autoFilledCount: autoFilled.length,
    gap: Math.max(0, capacity - selected.length - autoFilled.length),
    words: selected.map((item, index) => ({ ...item, position: index })),
    ignored: ignored.map((item, index) => ({ ...item, position: index })),
    autoFilled: autoFilled.map((item, index) => ({ ...item, position: selected.length + index })),
  }
}

export function createReciteStore(db) {
  async function getTask(weekStart) {
    const task = await db.first('SELECT * FROM recite_tasks WHERE week_start = ?', Number(weekStart))
    if (!task) return null
    const words = await db.all(
      'SELECT * FROM recite_task_words WHERE task_id = ? ORDER BY position, word', task.id,
    )
    return { task, words }
  }

  /** 任务响应：附上已完成会话数与进行中的会话序号，供学习页显示 X/Y 进度 */
  async function taskPayload(current) {
    if (!current) return null
    const task = current.task
    const words = current.words || []
    const progress = await db.first(
      `SELECT
        (SELECT COUNT(*) FROM recite_sessions WHERE task_id = ? AND status = 'completed') AS completed,
        (SELECT MIN(session_index) FROM recite_sessions WHERE task_id = ? AND status = 'active') AS active`,
      task.id, task.id,
    )
    return {
      id: task.id,
      weekStart: Number(task.week_start),
      weekEnd: Number(task.week_end),
      perSessionCount: Number(task.per_session_count),
      sessionCount: Number(task.session_count),
      capacity: Number(task.capacity),
      configVersion: Number(task.config_version),
      status: task.status,
      completedSessions: Number(progress?.completed || 0),
      activeSessionIndex: progress?.active == null ? null : Number(progress.active),
      words: words.map(taskWordResponse),
    }
  }

  async function currentTask(env, now = Date.now()) {
    return await getTask(startOfWeek(now, env))
  }

  /**
   * 列出全部任务：背词配置页按周一次取齐，学习页月历也要标出已配置的周。
   * 配置仍然只允许本周到 12 周后，过去的任务只读展示。
   */
  async function listTasks() {
    const tasks = await db.all('SELECT * FROM recite_tasks ORDER BY week_start')
    const payloads = []
    for (const task of tasks) {
      const words = await db.all(
        'SELECT * FROM recite_task_words WHERE task_id = ? ORDER BY position, word', task.id,
      )
      payloads.push(await taskPayload({ task, words }))
    }
    return payloads
  }

  async function preview({ env, now = Date.now(), weekStart, perSessionCount, sessionCount, selections, excludeWords }) {
    const per = Number(perSessionCount)
    const sessions = Number(sessionCount)
    if (!Number.isInteger(per) || per < 1 || per > 200) throw new Error('每次学习单词数必须是 1 到 200')
    if (!Number.isInteger(sessions) || sessions < 1 || sessions > 31) throw new Error('本周学习次数必须是 1 到 31')
    if (!Array.isArray(selections) || selections.length > MAX_SELECTIONS) throw new Error('选词数量无效')

    const selected = []
    const seen = new Set()
    const invalid = []
    for (const selection of selections) {
      const listId = String(selection?.listId ?? '').trim()
      const word = normalizeText(selection?.word)
      if (!listId || !word || seen.has(word)) continue
      const row = await loadWordRow(db, listId, word)
      if (!row) {
        invalid.push({ word, listId })
        continue
      }
      seen.add(word)
      selected.push(rowSnapshot(row, 'selected', null, String(selection?.sourceGroup || '')))
    }

    const capacity = per * sessions
    const kept = selected.slice(0, capacity)
    const ignored = selected.slice(capacity)
    // 改单行时把其他次数已用的词排掉，自动填充不会掏出重复词
    const excluded = new Set((Array.isArray(excludeWords) ? excludeWords : []).map(normalizeText).filter(Boolean))
    const autoFilled = []
    if (kept.length < capacity) {
      for (const candidate of await achievementCandidates(db)) {
        if (kept.length + autoFilled.length >= capacity) break
        const word = normalizeText(candidate.word)
        if (!word || seen.has(word) || excluded.has(word)) continue
        const row = await chooseCandidateRow(db, candidate)
        if (!row) continue
        seen.add(word)
        autoFilled.push(rowSnapshot(row, 'achievement', candidate.last_at))
      }
    }
    const range = taskRange(resolveWeekStart(weekStart, env, now))
    return {
      ...previewResponse({
        ...range, weekStart: range.weekStart, perSessionCount: per,
        sessionCount: sessions, selected: kept, ignored, autoFilled,
      }),
      invalid,
    }
  }

  async function saveTask({ env, now = Date.now(), weekStart, perSessionCount, sessionCount, selections, excludeWords, spellingWords }) {
    const previewData = await preview({ env, now, weekStart, perSessionCount, sessionCount, selections, excludeWords })
    const existing = await getTask(previewData.weekStart)
    if (existing) {
      const session = await db.first(
        "SELECT 1 FROM recite_sessions WHERE task_id = ? AND status IN ('active', 'completed') LIMIT 1",
        existing.task.id,
      )
      if (session) {
        const error = new Error('本周任务已经开始，不能静默修改已学习内容')
        error.code = 'TASK_STARTED'
        throw error
      }
    }
    const taskId = existing?.task.id || createTaskId()
    const version = Number(existing?.task.config_version || 0) + 1
    const spelling = new Set((Array.isArray(spellingWords) ? spellingWords : []).map(normalizeText).filter(Boolean))
    const words = [...previewData.words, ...previewData.autoFilled].map((item, position) => ({
      ...item,
      position,
      spellingEnabled: spelling.has(item.word) && item.type === 'word' && Boolean(item.translation),
    }))
    const statements = []
    if (existing) statements.push(['DELETE FROM recite_tasks WHERE id = ?', taskId])
    statements.push([
      `INSERT INTO recite_tasks
        (id, week_start, week_end, per_session_count, session_count, capacity, config_version, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      taskId, previewData.weekStart, previewData.weekEnd, previewData.perSessionCount,
      previewData.sessionCount, previewData.capacity, version, Number(existing?.task.created_at || now), now,
    ])
    for (const item of words) {
      statements.push([
        `INSERT INTO recite_task_words
          (task_id, word, list_id, position, type, display_text, translation, source_type, source_group, source_last_at, spelling_enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        taskId, item.word, item.listId, item.position, item.type, item.displayText || null,
        item.translation || null, item.sourceType, item.sourceGroup || null, item.sourceLastAt,
        item.spellingEnabled ? 1 : 0,
      ])
    }
    await db.batch(statements)
    const saved = await getTask(previewData.weekStart)
    return {
      task: await taskPayload(saved),
      ignored: previewData.ignored,
      invalid: previewData.invalid,
      gap: previewData.gap,
    }
  }

  /**
   * 只改某一次学习的单词：整周任务已经开始时，没开始的次数仍然可以换词。
   * 只替换这一行（按任务的每次词数切分），其他次数原样保留；这一行新选的词
   * 如果原本在别的次数里，以这一行为准，从那里去掉（同一周里一个词只出现一次）。
   */
  async function saveSessionWords({ env, now = Date.now(), weekStart, session, selections, spellingWords }) {
    const week = resolveWeekStart(weekStart, env, now)
    const existing = await getTask(week)
    if (!existing) throw new Error('这一周还没有背词任务')
    const task = existing.task
    const per = Math.max(1, Number(task.per_session_count))
    const sessions = Math.max(1, Number(task.session_count))
    const index = Number(session)
    if (!Number.isInteger(index) || index < 1 || index > sessions) throw new Error('第几次学习无效')
    const progress = await db.first(
      `SELECT
        (SELECT COUNT(*) FROM recite_sessions WHERE task_id = ? AND status = 'completed') AS completed,
        (SELECT MIN(session_index) FROM recite_sessions WHERE task_id = ? AND status = 'active') AS active`,
      task.id, task.id,
    )
    const locked = message => {
      const error = new Error(message)
      error.code = 'SESSION_STARTED'
      return error
    }
    if (index <= Number(progress?.completed || 0)) throw locked('这一次已经学过了，不能再改单词')
    if (progress?.active != null && Number(progress.active) === index) {
      throw locked('这一次正在学习中，先保存学习记录再改单词')
    }
    const start = (index - 1) * per
    const others = [...existing.words.slice(0, start), ...existing.words.slice(start + per)]
    const otherKeys = new Set(others.map(item => item.word))
    const previewData = await preview({
      env, now, weekStart: week, perSessionCount: per, sessionCount: 1, selections,
      excludeWords: [...otherKeys],
    })
    const row = [...previewData.words, ...previewData.autoFilled]
    const duplicated = row.filter(item => otherKeys.has(item.word))
    if (duplicated.length > 0) {
      const error = new Error(
        '第 ' + index + ' 次的 ' + duplicated.slice(0, 3).map(item => item.word).join('、')
        + ' 本周其他次数也在用，先从那里去掉再选',
      )
      error.code = 'DUPLICATE_WORDS'
      throw error
    }
    const merged = [
      ...others.slice(0, start).map(rowSnapshotFromRow),
      ...row,
      ...others.slice(start).map(rowSnapshotFromRow),
    ]
    const spelling = new Set((Array.isArray(spellingWords) ? spellingWords : []).map(normalizeText).filter(Boolean))
    const statements = [['DELETE FROM recite_task_words WHERE task_id = ?', task.id]]
    merged.forEach((item, position) => {
      statements.push([
        `INSERT INTO recite_task_words
          (task_id, word, list_id, position, type, display_text, translation, source_type, source_group, source_last_at, spelling_enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        task.id, item.word, item.listId, position, item.type, item.displayText || null,
        item.translation || null, item.sourceType, item.sourceGroup || null, item.sourceLastAt,
        spelling.has(item.word) && item.type === 'word' && Boolean(item.translation) ? 1 : 0,
      ])
    })
    statements.push([
      'UPDATE recite_tasks SET config_version = ?, updated_at = ? WHERE id = ?',
      Number(task.config_version || 0) + 1, now, task.id,
    ])
    await db.batch(statements)
    return {
      task: await taskPayload(await getTask(week)),
      ignored: [],
      invalid: previewData.invalid,
      gap: previewData.gap,
    }
  }

  async function startSession(app, env, now = Date.now()) {
    const current = await currentTask(env, now)
    if (!current) return { task: null, session: null, empty: true }
    const active = await db.first(
      "SELECT * FROM recite_sessions WHERE task_id = ? AND status = 'active' ORDER BY session_index LIMIT 1",
      current.task.id,
    )
    if (active) return await hydrateSession(current.task, active)
    const completed = await db.first(
      "SELECT COUNT(*) AS count FROM recite_sessions WHERE task_id = ? AND status = 'completed'",
      current.task.id,
    )
    const nextIndex = Number(completed?.count || 0) + 1
    if (nextIndex > Number(current.task.session_count)) {
      return { task: await taskPayload(current), session: null, complete: true }
    }
    const per = Number(current.task.per_session_count)
    const candidates = current.words.slice((nextIndex - 1) * per, nextIndex * per)
    const available = []
    for (const candidate of candidates) {
      const row = await loadWordRow(db, candidate.list_id, candidate.word)
      if (row) available.push({ candidate, row })
    }
    if (available.length === 0) return { task: await taskPayload(current), session: null, empty: true }
    await ensureStarted(app, available.map(item => item.row), now)

    const cards = []
    for (const { candidate, row } of available) {
      cards.push({
        word: candidate.word, listId: candidate.list_id, cardType: 'meaning',
        displayText: candidate.display_text || row.display_text || candidate.word,
        translation: candidate.translation || row.translation || '', answer: null,
        orderKey: stableHash(current.task.id + '|' + nextIndex + '|' + candidate.word + '|meaning'),
      })
      if (Number(candidate.spelling_enabled) === 1 && row.type === 'word' && (candidate.translation || row.translation)) {
        cards.push({
          word: candidate.word, listId: candidate.list_id, cardType: 'spelling',
          displayText: candidate.translation || row.translation || '',
          translation: candidate.translation || row.translation || '', answer: candidate.word,
          orderKey: stableHash(current.task.id + '|' + nextIndex + '|' + candidate.word + '|spelling'),
        })
      }
    }
    cards.sort((a, b) => a.orderKey - b.orderKey)
    avoidLongSpellingRuns(cards)
    const sessionId = createSessionId()
    const statements = [[
      `INSERT INTO recite_sessions
        (id, task_id, session_index, status, cursor, card_count, completed_count, started_at, created_at, updated_at)
       VALUES (?, ?, ?, 'active', 0, ?, 0, ?, ?, ?)`,
      sessionId, current.task.id, nextIndex, cards.length, now, now, now,
    ]]
    cards.forEach((card, position) => statements.push([
      `INSERT INTO recite_cards
        (id, session_id, position, word, list_id, card_type, display_text, translation, answer, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      createCardId(), sessionId, position, card.word, card.listId, card.cardType,
      card.displayText || null, card.translation || null, card.answer,
    ]))
    await db.batch(statements)
    const session = await db.first('SELECT * FROM recite_sessions WHERE id = ?', sessionId)
    return await hydrateSession(current.task, session)
  }

  async function hydrateSession(task, session) {
    const cards = await db.all('SELECT * FROM recite_cards WHERE session_id = ? ORDER BY position', session.id)
    const drafts = await listDrafts(session.id)
    const current = cards.find(card => card.status === 'pending') || null
    return {
      task: await taskPayload({ task, words: [] }),
      session: summaryFromRows(session, cards),
      card: current ? cardResponse(current, false) : null,
      cards: cards.map(card => cardResponse(card, false)),
      drafts: drafts.map(draftResponse),
    }
  }

  async function answerCard(app, sessionId, cardId, input = {}) {
    const session = await db.first('SELECT * FROM recite_sessions WHERE id = ?', String(sessionId))
    if (!session) return { status: 404, body: { error: 'recite session not found' } }
    const card = await db.first('SELECT * FROM recite_cards WHERE id = ? AND session_id = ?', String(cardId), String(sessionId))
    if (!card) return { status: 404, body: { error: 'recite card not found' } }
    if (card.status === 'answered') {
      const cards = await db.all('SELECT * FROM recite_cards WHERE session_id = ? ORDER BY position', sessionId)
      return { status: 200, body: await answerResponse(session, cards, card, true) }
    }
    if (Number(card.position) !== Number(session.cursor)) {
      return { status: 409, body: { error: 'card is not current' } }
    }
    const requestId = String(input.requestId || '').trim()
    if (!requestId) return { status: 400, body: { error: 'missing requestId' } }
    let result
    if (card.card_type === 'meaning') {
      result = input.result === 'known' || input.result === 'unknown' ? input.result : null
      if (!result) return { status: 400, body: { error: 'invalid meaning result' } }
      await applyCardReview(app, card, result, requestId)
    } else if (card.card_type === 'spelling') {
      result = input.result === 'correct' || input.result === 'skipped' ? input.result : null
      if (!result) return { status: 400, body: { error: 'invalid spelling result' } }
      if (result === 'correct' && normalizeText(input.answer) !== normalizeText(card.answer)) {
        return { status: 400, body: { error: 'spelling answer is incorrect' } }
      }
      if (result === 'correct') await applyCardReview(app, card, 'correct', requestId)
    } else if (!CARD_TYPES.has(card.card_type)) {
      return { status: 400, body: { error: 'unknown card type' } }
    }
    const now = Date.now()
    const nextCursor = Number(session.cursor) + 1
    const completed = nextCursor >= Number(session.card_count)
    await db.batch([
      [
        `UPDATE recite_cards SET status = 'answered', result = ?, attempts = ?, request_id = ?, answered_at = ? WHERE id = ? AND status = 'pending'`,
        result, Math.max(Number(card.attempts || 0), Number(input.attempts || 0)), requestId, now, card.id,
      ],
      [
        `UPDATE recite_sessions SET cursor = ?, completed_count = ?, status = ?, completed_at = ?, completion_request_id = ?, updated_at = ? WHERE id = ?`,
        nextCursor, completed ? Number(session.card_count) : nextCursor, completed ? 'completed' : 'active',
        completed ? now : null, completed ? 'complete|' + requestId : null, now, session.id,
      ],
    ])
    const freshSession = await db.first('SELECT * FROM recite_sessions WHERE id = ?', session.id)
    const cards = await db.all('SELECT * FROM recite_cards WHERE session_id = ? ORDER BY position', session.id)
    return { status: 200, body: await answerResponse(freshSession, cards, card, false) }
  }

  /** 某会话还没提交的草稿，按卡片顺序返回；已答过的卡片不再算草稿 */
  async function listDrafts(sessionId) {
    return await db.all(
      `SELECT d.card_id, d.result, d.answer, d.attempts
       FROM recite_card_drafts d JOIN recite_cards c ON c.id = d.card_id
       WHERE d.session_id = ? AND c.status = 'pending'
       ORDER BY c.position`,
      String(sessionId),
    )
  }

  function draftResponse(row) {
    return {
      cardId: row.card_id,
      result: row.result,
      answer: row.answer ?? undefined,
      attempts: Number(row.attempts || 0),
    }
  }

  function draftCounts(rows) {
    const counts = { known: 0, unknown: 0, correct: 0, skipped: 0, total: 0 }
    for (const row of rows) {
      if (row.result === 'known') counts.known++
      else if (row.result === 'unknown') counts.unknown++
      else if (row.result === 'correct') counts.correct++
      else if (row.result === 'skipped') counts.skipped++
      counts.total++
    }
    return counts
  }

  async function draftsPayload(session) {
    const drafts = await listDrafts(session.id)
    const cards = await db.all('SELECT status FROM recite_cards WHERE session_id = ?', session.id)
    return {
      ok: true,
      completed: session.status === 'completed',
      cardCount: cards.length,
      answeredCount: cards.filter(card => card.status === 'answered').length,
      counts: draftCounts(drafts),
      drafts: drafts.map(draftResponse),
    }
  }

  /** 家长端读草稿：换设备打开同一个会话也能看到会 / 不会计数 */
  async function getDrafts(sessionId) {
    const session = await db.first('SELECT * FROM recite_sessions WHERE id = ?', String(sessionId))
    if (!session) return { status: 404, body: { error: 'recite session not found' } }
    return { status: 200, body: await draftsPayload(session) }
  }

  /**
   * 点「会 / 不会」只写草稿：不推进轮次、不累计次数，确认（commit）后才真正落进学习记录。
   * 草稿存在 D1，所以家长从另一台设备打开同一会话也能读到计数并确认。
   */
  async function saveDraft(sessionId, input = {}) {
    const session = await db.first('SELECT * FROM recite_sessions WHERE id = ?', String(sessionId))
    if (!session) return { status: 404, body: { error: 'recite session not found' } }
    if (session.status === 'completed') return { status: 409, body: { error: 'session already completed' } }
    const cardId = String(input?.cardId ?? '').trim()
    if (!cardId) return { status: 400, body: { error: 'missing cardId' } }
    const card = await db.first('SELECT * FROM recite_cards WHERE id = ? AND session_id = ?', cardId, session.id)
    if (!card) return { status: 404, body: { error: 'recite card not found' } }
    if (card.status === 'answered') return { status: 409, body: { error: 'card already answered' } }
    const result = String(input?.result ?? '')
    if (card.card_type === 'meaning') {
      if (result !== 'known' && result !== 'unknown') {
        return { status: 400, body: { error: 'invalid meaning result' } }
      }
    } else if (card.card_type === 'spelling') {
      if (result !== 'correct' && result !== 'skipped') {
        return { status: 400, body: { error: 'invalid spelling result' } }
      }
      if (result === 'correct' && normalizeText(input?.answer) !== normalizeText(card.answer)) {
        return { status: 400, body: { error: 'spelling answer is incorrect' } }
      }
    } else {
      return { status: 400, body: { error: 'unknown card type' } }
    }
    const attempts = Math.max(0, Math.floor(Number(input?.attempts) || 0))
    const answer = String(input?.answer ?? '')
    await db.run(
      `INSERT INTO recite_card_drafts (session_id, card_id, result, answer, attempts, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, card_id) DO UPDATE SET
         result = excluded.result, answer = excluded.answer,
         attempts = excluded.attempts, updated_at = excluded.updated_at`,
      session.id, cardId, result, answer || null, attempts, Date.now(),
    )
    return { status: 200, body: await draftsPayload(session) }
  }

  /**
   * 家长端「确定」后统一落库：按卡片顺序逐张走 answerCard 的校验、幂等和复习算法。
   * 客户端把一次学习的全部判定攒在本地，确认前不写库；重复提交时已答过的卡片
   * 直接返回 alreadyProcessed，不会重复推进轮次或累计次数。
   */
  async function commitSession(app, sessionId, input = {}) {
    const session = await db.first('SELECT * FROM recite_sessions WHERE id = ?', String(sessionId))
    if (!session) return { status: 404, body: { error: 'recite session not found' } }
    const answers = Array.isArray(input?.answers) ? input.answers : []
    if (answers.length === 0) return { status: 400, body: { error: 'missing answers' } }
    if (answers.length > MAX_COMMIT_ANSWERS) {
      return { status: 400, body: { error: 'too many answers', max: MAX_COMMIT_ANSWERS } }
    }
    for (const answer of answers) {
      const cardId = String(answer?.cardId ?? '').trim()
      if (!cardId) return { status: 400, body: { error: 'missing cardId' } }
      const requestId = String(answer?.requestId ?? '').trim()
        || 'recite-commit|' + session.id + '|' + cardId
      const result = await answerCard(app, session.id, cardId, {
        result: answer?.result,
        answer: answer?.answer,
        attempts: answer?.attempts,
        requestId,
      })
      if (result.status !== 200) return result
    }
    const committedIds = answers.map(answer => String(answer?.cardId ?? '').trim()).filter(Boolean)
    if (committedIds.length) {
      await db.run(
        'DELETE FROM recite_card_drafts WHERE session_id = ? AND card_id IN ('
          + committedIds.map(() => '?').join(', ') + ')',
        session.id, ...committedIds,
      )
    }
    const fresh = await db.first('SELECT * FROM recite_sessions WHERE id = ?', session.id)
    const cards = await db.all('SELECT * FROM recite_cards WHERE session_id = ? ORDER BY position', session.id)
    return {
      status: 200,
      body: {
        ok: true,
        completed: fresh.status === 'completed',
        summary: summaryFromRows(fresh, cards),
        cards: cards.map(card => cardResponse(card, true)),
      },
    }
  }

  /** 家长端读取当前待确认会话（含草稿）；不存在进行中的会话时返回 session: null */
  async function activeSession(env, now = Date.now()) {
    const current = await currentTask(env, now)
    if (!current) return { task: null, session: null, cards: [], drafts: [] }
    const active = await db.first(
      "SELECT * FROM recite_sessions WHERE task_id = ? AND status = 'active' ORDER BY session_index LIMIT 1",
      current.task.id,
    )
    if (!active) return { task: await taskPayload(current), session: null, cards: [], drafts: [] }
    return await hydrateSession(current.task, active)
  }

  /** 已保存的背诵记录：按完成时间倒序，带上每张卡片的判定结果 */
  async function history(limit) {
    const asked = Number(limit)
    const size = Number.isFinite(asked) && asked > 0 ? Math.min(Math.floor(asked), 60) : 20
    const sessions = await db.all(
      `SELECT s.*, t.week_start FROM recite_sessions s
       LEFT JOIN recite_tasks t ON t.id = s.task_id
       WHERE s.status = 'completed'
       ORDER BY COALESCE(s.completed_at, s.started_at, s.created_at) DESC LIMIT ?`,
      size,
    )
    const records = []
    for (const session of sessions) {
      const cards = await db.all(
        `SELECT word, list_id, card_type, result, display_text, translation
         FROM recite_cards WHERE session_id = ? AND status = 'answered' ORDER BY position`,
        session.id,
      )
      records.push({
        sessionId: session.id,
        sessionIndex: Number(session.session_index),
        weekStart: session.week_start != null ? Number(session.week_start) : undefined,
        date: Number(session.completed_at || session.started_at || session.created_at),
        cards: cards.map(card => ({
          word: card.word,
          listId: card.list_id,
          cardType: card.card_type,
          result: card.result,
          displayText: card.display_text || undefined,
          translation: card.translation || undefined,
        })),
      })
    }
    return { records }
  }

  return {
    currentTask, preview, saveTask, saveSessionWords, startSession, answerCard, commitSession,
    getDrafts, saveDraft, activeSession, history, getTask, taskPayload, listTasks,
  }
}

async function answerResponse(session, cards, answeredCard, alreadyProcessed) {
  const current = cards.find(card => card.status === 'pending') || null
  return {
    ok: true,
    alreadyProcessed,
    completed: session.status === 'completed',
    card: cardResponse(answeredCard, true),
    nextCard: current ? cardResponse(current, false) : null,
    summary: summaryFromRows(session, cards),
  }
}

function avoidLongSpellingRuns(cards) {
  for (let index = 2; index < cards.length; index++) {
    if (cards[index - 2].cardType !== 'spelling' || cards[index - 1].cardType !== 'spelling'
      || cards[index].cardType !== 'spelling') continue
    const swap = cards.slice(index + 1).findIndex(card => card.cardType === 'meaning')
    if (swap >= 0) {
      const target = index + 1 + swap
      const temp = cards[index]
      cards[index] = cards[target]
      cards[target] = temp
    }
  }
}

async function ensureStarted(app, rows, now) {
  const byList = new Map()
  for (const row of rows) {
    if (!byList.has(row.list_id)) byList.set(row.list_id, [])
    byList.get(row.list_id).push(row.word)
  }
  for (const [listId, words] of byList) {
    const items = await app.listsStore.selectWords(listId, words)
    const before = new Map(items.map(item => [item.word, progressRow(listId, item)]))
    const listName = await app.listsStore.listName(listId)
    for (const item of items) {
      if (item.startedAt) continue
      item.startedAt = now
      item.stage = 0
      item.reviewedAt = []
      pushMark(item, 'start', now)
      await recordStudyEvent(app, { id: listId, name: listName, words: items }, {
        item, listId, listName, action: 'start', at: now, stage: 0,
      })
    }
    await app.listsStore.saveWordProgress(listId, items.filter(item => {
      const prior = before.get(item.word)
      return prior && JSON.stringify(prior) !== JSON.stringify(progressRow(listId, item))
    }))
  }
}

async function applyCardReview(app, card, result, requestId) {
  const items = await app.listsStore.selectWords(card.list_id, [card.word])
  const item = items[0]
  if (!item) throw new Error('学习列表中的词条已不存在')
  const before = progressRow(card.list_id, item)
  const listName = await app.listsStore.listName(card.list_id)
  const list = { id: card.list_id, name: listName, words: [item] }
  const targets = new Set([item.word])
  const action = result === 'known' ? 'done' : result === 'unknown' ? 'again' : 'tally'
  const options = {
    requestIds: new Map([[item.word, requestId]]),
    successKind: result === 'correct' ? 'spelling' : result === 'known' ? 'meaning' : undefined,
    hasRequest: key => app.history.hasRequest(key),
    onEvent: event => recordStudyEvent(app, list, { ...event, listId: card.list_id, listName }),
  }
  await applyReview(list, targets, action, options, app)
  if (result === 'known') {
    const meaningList = { id: card.list_id, name: listName, words: [item] }
    await applyReview(meaningList, targets, 'tally', {
      requestIds: new Map([[item.word, requestId + '|meaning']]),
      successKind: 'meaning',
      hasRequest: key => app.history.hasRequest(key),
      onEvent: event => recordStudyEvent(app, meaningList, { ...event, listId: card.list_id, listName }),
    }, app)
  }
  if (JSON.stringify(before) !== JSON.stringify(progressRow(card.list_id, item))) {
    await app.listsStore.saveWordProgress(card.list_id, [item])
  }
  return enrichItem(item, Date.now(), app.env)
}
