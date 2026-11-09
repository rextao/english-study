import { apiFetch } from '../utils/apiBase'
import { invalidateApiCache, queryApi } from '../utils/apiCache'

export interface ReciteTaskWord {
  word: string
  listId: string
  position: number
  type: 'word' | 'sentence'
  displayText?: string
  translation?: string
  sourceType: 'selected' | 'achievement'
  sourceGroup?: string
  sourceLastAt?: number
  spellingEnabled: boolean
}

export interface ReciteTask {
  id: string
  weekStart: number
  weekEnd: number
  perSessionCount: number
  sessionCount: number
  capacity: number
  configVersion: number
  status: string
  /** 已完成的会话数，学习页用来显示 X/Y 进度 */
  completedSessions: number
  /** 进行中的会话序号，没有进行中的会话时为 null */
  activeSessionIndex: number | null
  words: ReciteTaskWord[]
  /** 每次学习的单词出现顺序（下标 = 第几次 - 1），与背词页的卡片顺序一致 */
  wordOrder?: string[][]
}

export interface RecitePreview {
  weekStart: number
  weekEnd: number
  perSessionCount: number
  sessionCount: number
  capacity: number
  selectedCount: number
  ignoredCount: number
  autoFilledCount: number
  gap: number
  words: ReciteTaskWord[]
  ignored: ReciteTaskWord[]
  autoFilled: ReciteTaskWord[]
  invalid: Array<{ word: string; listId: string }>
}

export interface ReciteCard {
  id: string
  position: number
  word: string
  listId: string
  cardType: 'meaning' | 'spelling'
  displayText?: string
  translation?: string
  answer?: string
  status: 'pending' | 'answered'
  result?: string
  attempts: number
}

export interface ReciteSummary {
  sessionId: string
  sessionIndex: number
  status: 'active' | 'completed'
  startedAt?: number
  cursor: number
  cardCount: number
  completedCount: number
  completedCards: number
  knownCount: number
  unknownCount: number
  spellingCorrect: number
  spellingSkipped: number
}

export interface ReciteDraft {
  cardId: string
  result: 'known' | 'unknown' | 'correct' | 'skipped'
  answer?: string
  attempts: number
}

export interface ReciteDraftCounts {
  known: number
  unknown: number
  correct: number
  skipped: number
  total: number
}

export interface ReciteDraftPayload {
  ok: boolean
  completed: boolean
  cardCount: number
  answeredCount: number
  counts: ReciteDraftCounts
  drafts: ReciteDraft[]
}

export interface ReciteSessionPayload {
  task: ReciteTask | null
  session: ReciteSummary | null
  card: ReciteCard | null
  cards?: ReciteCard[]
  /** 已经点过会 / 不会但还没确认的草稿，存在 Server，换设备也能接着判定 */
  drafts?: ReciteDraft[]
  complete?: boolean
  empty?: boolean
}

export interface ReciteAnswerResponse {
  ok: boolean
  alreadyProcessed?: boolean
  completed: boolean
  card: ReciteCard
  nextCard: ReciteCard | null
  summary: ReciteSummary
}

export interface ReciteCommitAnswer {
  cardId: string
  result: 'known' | 'unknown' | 'correct' | 'skipped'
  answer?: string
  attempts?: number
  requestId?: string
}

export interface ReciteCommitResponse {
  ok: boolean
  completed: boolean
  summary: ReciteSummary
  cards: ReciteCard[]
}

export interface ReciteHistoryCard {
  word: string
  listId: string
  cardType: 'meaning' | 'spelling'
  result: string
  displayText?: string
  translation?: string
}

export interface ReciteHistoryRecord {
  sessionId: string
  sessionIndex: number
  /** 这次学习属于哪一周（周一 0 点），任务列表页的家长确认弹窗按周过滤
   *  老数据关联不到任务时可能缺失 */
  weekStart?: number
  date: number
  cards: ReciteHistoryCard[]
}

interface ApiError { error?: string }

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T & ApiError | null
  if (!response.ok) throw new Error(body?.error || '背词请求失败')
  return body as T
}

export interface ReciteTaskInput {
  weekStart?: number
  perSessionCount: number
  sessionCount: number
  selections: Array<{ listId: string; word: string; sourceGroup?: string }>
  /** 改单行时其他次数已用的词：自动填充会避开它们 */
  excludeWords?: string[]
}

/**
 * 读取一周的背词任务；不传 weekStart 读本周。
 * 配置弹窗和学习页复习计划里的任务标记共用同一份共享读缓存。
 */
export async function fetchReciteTask(weekStart?: number): Promise<ReciteTask | null> {
  const url = weekStart == null
    ? '/api/recite/task'
    : '/api/recite/task?weekStart=' + encodeURIComponent(String(weekStart))
  const data = await queryApi<{ task: ReciteTask | null }>(url, {}, {
    staleTime: 15_000,
    tags: ['recite-task'],
  })
  return data.task
}

/**
 * 列出全部背词任务：背词配置二级页按周展示、学习页月历标记已配置的周。
 * 与单周读取共用同一份共享读缓存，保存任务后会整体作废重拉。
 */
export async function fetchReciteTasks(): Promise<ReciteTask[]> {
  const data = await queryApi<{ tasks: ReciteTask[] }>('/api/recite/tasks', {}, {
    staleTime: 15_000,
    tags: ['recite-task'],
  })
  return Array.isArray(data.tasks) ? data.tasks : []
}

/** 预览任务：按容量裁剪选词并给出自动填充建议，不落盘 */
export async function previewReciteTask(input: ReciteTaskInput): Promise<{ ok: boolean } & RecitePreview> {
  const response = await apiFetch('/api/recite/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return await readJson<{ ok: boolean } & RecitePreview>(response)
}

/**
 * 保存任务；成功后作废任务与会话缓存。
 * 带 session（1-based）时只替换这一次学习的单词，整周任务已经开始也能改没开始的那一次。
 */
export async function saveReciteTask(input: ReciteTaskInput & { spellingWords: string[]; session?: number }): Promise<ReciteTask> {
  const response = await apiFetch('/api/recite/task', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = await readJson<{ ok: boolean; task: ReciteTask }>(response)
  invalidateApiCache(['recite-task', 'recite-session'])
  return data.task
}

/** 家长端：读当前待确认会话（不会创建新会话），含服务端草稿 */
export async function fetchReciteActiveSession(): Promise<ReciteSessionPayload> {
  const response = await apiFetch('/api/recite/sessions/active')
  return await readJson<ReciteSessionPayload>(response)
}

/** 家长端：已保存的背诵记录，按完成时间倒序 */
export async function fetchReciteHistory(limit = 20): Promise<{ records: ReciteHistoryRecord[] }> {
  const response = await apiFetch('/api/recite/history?limit=' + encodeURIComponent(String(limit)))
  return await readJson<{ records: ReciteHistoryRecord[] }>(response)
}

export async function startReciteSession(): Promise<ReciteSessionPayload> {
  const response = await apiFetch('/api/recite/sessions/start', { method: 'POST' })
  return await readJson<ReciteSessionPayload>(response)
}

/**
 * 点「会 / 不会」时先存草稿：只写 recite_card_drafts，不推进轮次。
 * 家长在另一台设备上打开同一会话，也能读到这份计数再确认。
 */
export async function saveReciteDraft(
  sessionId: string,
  draft: { cardId: string; result: 'known' | 'unknown' | 'correct' | 'skipped'; answer?: string; attempts?: number },
): Promise<ReciteDraftPayload> {
  const response = await apiFetch('/api/recite/sessions/' + encodeURIComponent(sessionId) + '/drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft),
  })
  return await readJson<ReciteDraftPayload>(response)
}

/**
 * 家长端「确定」后统一提交：把本地攒下的全部卡片判定一次写进 Server。
 * 每次学习的卡片数可能超过单请求上限，调用方按 30 张一批循环提交。
 */
export async function commitReciteSession(
  sessionId: string,
  answers: ReciteCommitAnswer[],
): Promise<ReciteCommitResponse> {
  const response = await apiFetch('/api/recite/sessions/' + encodeURIComponent(sessionId) + '/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  })
  const data = await readJson<ReciteCommitResponse>(response)
  invalidateApiCache(['recite-task', 'recite-session', 'study-plan', 'achievements', 'history'])
  return data
}

export interface ReciteRecordingSummary {
  id: string
  /** uploading = 分片还没传齐，ready = 可播放 */
  status?: 'uploading' | 'ready'
  createdAt: number
  durationMs: number
  mime: string
  size: number
  /** 这段录音分了几片（上传时用） */
  partCount?: number
  /** 属于第几次学习；老数据 / 未关联会话时缺失 */
  sessionIndex?: number
  sessionId?: string
  /** 所在周的周一 0 点 */
  weekStart?: number
}

/** 课堂录音列表：服务端只保留最近 15 天 */
export async function fetchReciteRecordings(limit = 20): Promise<ReciteRecordingSummary[]> {
  const response = await apiFetch('/api/recite/recordings?limit=' + encodeURIComponent(String(limit)))
  const data = await readJson<{ recordings: ReciteRecordingSummary[] }>(response)
  return Array.isArray(data.recordings) ? data.recordings : []
}

/** 统一删除若干条录音（音频分片一起删），返回实际删掉的条数 */
export async function deleteReciteRecordings(ids: string[]): Promise<number> {
  const response = await apiFetch('/api/recite/recordings', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  })
  const data = await readJson<{ deleted: number }>(response)
  return Number(data.deleted) || 0
}

/**
 * 录音分三步上传：先建记录，再逐片传，最后 complete。
 * 分片上传的意义是某一片失败只重传那一片，不会因为一次超时把整段录音丢掉。
 */
export async function createReciteRecording(input: {
  sessionId?: string
  mime: string
  durationMs: number
  sizeBytes: number
  partCount: number
}): Promise<{ id: string; partCount: number }> {
  const response = await apiFetch('/api/recite/recordings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const data = await readJson<{ recording: ReciteRecordingSummary }>(response)
  return { id: data.recording.id, partCount: data.recording.partCount || input.partCount }
}

/** 上传一片（同序号重复上传会覆盖，可安全重试） */
export async function uploadReciteRecordingPart(
  id: string,
  index: number,
  audio: string,
): Promise<void> {
  const response = await apiFetch(
    '/api/recite/recordings/' + encodeURIComponent(id) + '/parts/' + index,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio }),
    },
  )
  await readJson<{ ok: boolean }>(response)
}

/** 分片齐了再调用：服务端校验片数，齐了才让这条录音出现在列表里 */
export async function completeReciteRecording(id: string): Promise<ReciteRecordingSummary> {
  const response = await apiFetch('/api/recite/recordings/' + encodeURIComponent(id) + '/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const data = await readJson<{ recording: ReciteRecordingSummary }>(response)
  return data.recording
}

/** 取一条录音的整段音频（base64）；接口同源带 Bearer，页面再转 Blob URL 播放 */
export async function fetchReciteRecordingAudio(id: string): Promise<{ audio: string; mime: string }> {
  const response = await apiFetch('/api/recite/recordings/' + encodeURIComponent(id) + '/audio')
  return await readJson<{ audio: string; mime: string }>(response)
}

export async function answerReciteCard(
  sessionId: string,
  cardId: string,
  input: { result: 'known' | 'unknown' | 'correct' | 'skipped'; answer?: string; attempts?: number; requestId: string },
): Promise<ReciteAnswerResponse> {
  const path = input.result === 'correct' || input.result === 'skipped' ? 'spelling' : 'result'
  const response = await apiFetch('/api/recite/sessions/' + encodeURIComponent(sessionId) + '/cards/' + encodeURIComponent(cardId) + '/' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  return await readJson<ReciteAnswerResponse>(response)
}
