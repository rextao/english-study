import { normalizeText } from './text.js'

export const PASSAGE_KV_KEY = 'study-passages'
const MAX_PASSAGES = 100
const MAX_TITLE_LENGTH = 120
const MAX_CONTENT_LENGTH = 30_000
const MAX_SOURCE_WORDS = 300

const WORD_PATTERN = /^[a-z]+(?:[-'][a-z]+)*$/i
const TOKEN_PATTERN = /[a-z]+(?:[-'][a-z]+)*/gi
const MARK_ACTIONS = new Set(['reading', 'meaning'])

function cleanWord(value) {
  const word = normalizeText(value)
  return WORD_PATTERN.test(word) ? word : ''
}

function cleanSourceWords(value) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(value) ? value : []) {
    const word = cleanWord(raw?.word ?? raw)
    if (!word || seen.has(word)) continue
    seen.add(word)
    const sourceIds = Array.isArray(raw?.sourceIds)
      ? [...new Set(raw.sourceIds.map(item => String(item ?? '').trim()).filter(Boolean))].slice(0, 20)
      : []
    out.push({ word, sourceIds })
    if (out.length >= MAX_SOURCE_WORDS) break
  }
  return out
}

function matchedWords(content, sourceWords) {
  const tokens = new Set((String(content ?? '').match(TOKEN_PATTERN) || []).map(token => token.toLowerCase()))
  return sourceWords.filter(item => tokens.has(item.word.toLowerCase()))
}

function cleanGroups(value, sourceWords) {
  const allowed = new Set(sourceWords.map(item => item.word))
  return (Array.isArray(value) ? value : []).slice(0, 20).map((raw, index) => ({
    id: String(raw?.id || 'group-' + (index + 1)).slice(0, 80),
    name: String(raw?.name || '第 ' + (index + 1) + ' 组').trim().slice(0, 80),
    enabled: raw?.enabled !== false,
    rule: String(raw?.rule || 'stale'),
    days: Number.isFinite(Number(raw?.days)) ? Math.max(1, Math.min(3650, Number(raw.days))) : undefined,
    threshold: Number.isFinite(Number(raw?.threshold)) ? Math.max(0, Math.min(1000, Number(raw.threshold))) : undefined,
    count: Math.max(0, Math.min(300, Number(raw?.count) || 0)),
    libraryId: String(raw?.libraryId || '').trim().slice(0, 80) || undefined,
    listId: String(raw?.listId || '').trim().slice(0, 80) || undefined,
    batchKey: String(raw?.batchKey || '').trim().slice(0, 120) || undefined,
    words: [...new Set((Array.isArray(raw?.words) ? raw.words : []).map(cleanWord).filter(word => allowed.has(word)))].slice(0, 300),
  }))
}

function normalizePassage(raw) {
  const sourceWords = cleanSourceWords(raw?.sourceWords)
  const content = String(raw?.content ?? '').trim().slice(0, MAX_CONTENT_LENGTH)
  return {
    id: String(raw?.id || crypto.randomUUID()),
    title: String(raw?.title || '未命名短文').trim().slice(0, MAX_TITLE_LENGTH) || '未命名短文',
    content,
    createdAt: Number(raw?.createdAt) || Date.now(),
    updatedAt: Number(raw?.updatedAt) || Date.now(),
    sourceWords,
    matchedWords: matchedWords(content, sourceWords),
    groups: cleanGroups(raw?.groups, sourceWords),
    markedActions: Array.isArray(raw?.markedActions) ? [...new Set(raw.markedActions.filter(action => MARK_ACTIONS.has(action)))] : [],
  }
}

export function createPassageStore(kv, history) {
  async function list() {
    const data = await kv.get(PASSAGE_KV_KEY, [])
    return Array.isArray(data) ? data.map(normalizePassage).sort((a, b) => b.updatedAt - a.updatedAt) : []
  }

  async function save(input) {
    const now = Date.now()
    const current = await list()
    const existing = input?.id ? current.find(item => item.id === input.id) : null
    const contentChanged = existing && String(existing.content) !== String(input?.content ?? '').trim()
    const sourceChanged = existing && JSON.stringify(existing.sourceWords) !== JSON.stringify(cleanSourceWords(input?.sourceWords))
    const passage = normalizePassage({
      ...input,
      id: existing?.id || crypto.randomUUID(),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      markedActions: existing && !contentChanged && !sourceChanged ? existing.markedActions : [],
    })
    await kv.set(PASSAGE_KV_KEY, [passage, ...current.filter(item => item.id !== passage.id)].slice(0, MAX_PASSAGES))
    return passage
  }

  async function mark(id, action) {
    if (!MARK_ACTIONS.has(action)) return { error: 'invalid passage mark action' }
    const current = await list()
    const passage = current.find(item => item.id === id)
    if (!passage) return { error: 'passage not found' }
    if (passage.markedActions.includes(action)) return { passage, marked: 0 }

    let marked = 0
    for (const item of passage.matchedWords) {
      const result = await history.record({
        word: item.word,
        item: { word: item.word, sourceIds: item.sourceIds },
        action,
        requestId: 'passage|' + passage.id + '|' + action + '|' + item.word,
        metadata: { source: 'passage', passageId: passage.id },
      })
      if (result.inserted) marked++
    }
    passage.markedActions = [...passage.markedActions, action]
    passage.updatedAt = Date.now()
    await kv.set(PASSAGE_KV_KEY, current.map(item => item.id === passage.id ? passage : item))
    return { passage, marked }
  }

  return { list, save, mark }
}
