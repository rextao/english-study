/**
 * useRecitePreload — 背词首页的发音预取（本地缓存）。
 *
 * 打开页面、还没点「开始学习」时，把本周要背的单词发音逐个拉到本地（IndexedDB），
 * 小朋友点喇叭时不再现场等网络。优先拉下一次要学的那一次（新的一周就是第 1 次），
 * 其余次序按 wordOrder 依次补齐；主动推送的那一次排在最后。
 *
 * 并发 2，不抢正着急的页面请求；发音服务没配好（503）或令牌失效（401 / 403）时
 * 整体停下并把原因交给调试面板，单个词断网只记失败、可单独重试。
 * 已经在本地缓存里的词直接跳过，反复打开页面不会重复下载。
 *
 * 语速要和背词页的默认档位一致，否则预取回来的音频点喇叭时用不上：
 * 单词卡默认正常速，句子卡默认 speakingRate 0.7（见 speech.ts 的 SENTENCE_SPEAKING_RATE），
 * 所以句子按 0.7 拉，缓存键也走 speechCacheKey 带上 @sr0.7。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '../utils/apiBase'
import type { ReciteTask } from './useRecite'
import { SENTENCE_SPEAKING_RATE, speechCacheKey } from '../utils/speech'
import {
  audioCacheKeyOf,
  loadPersistedAudio,
  saveReciteMeta,
  storePersistedAudio,
} from '../utils/reciteCache'

/** 同时只下两个：网络差时也不至于把页面别的请求挤住 */
const CONCURRENCY = 2

export type RecitePreloadStatus = 'idle' | 'loading' | 'done' | 'error'

export interface RecitePreloadState {
  status: RecitePreloadStatus
  /** 本周要缓存的词数（已缓存的也算在里面，进度才能一眼看懂） */
  total: number
  /** 已落地的词数（含原本就缓存好的） */
  done: number
  /** 没拉成功的词，可在调试面板里单独重试 */
  failed: string[]
  /** 出错原因（致命中止 / 部分失败提示） */
  reason: string
}

export interface UseRecitePreloadResult extends RecitePreloadState {
  /** 重新拉取：传 words 只拉这几个（给失败词重试用），不传拉整周 */
  reload: (words?: string[]) => void
}

const IDLE: RecitePreloadState = { status: 'idle', total: 0, done: 0, failed: [], reason: '' }

type FetchOutcome = 'ok' | 'failed' | 'fatal-config' | 'fatal-auth'

/** 一条要预取的发音：text 是实际念的文本，句子带上默认的 speakingRate */
interface PreloadItem {
  text: string
  speakingRate?: number
}

/** 与 speech.ts 的缓存键一致：句子按自带语速另存一份，单词就是文本本身 */
function cacheKeyOf(item: PreloadItem) {
  return speechCacheKey(item.text, 1, item.speakingRate)
}

/**
 * 本周要缓存发音的词：
 *  - 有 wordOrder 时把「下一次要学的那一次」排最前（第 1 次学习就是新一周的第一组），
 *    其余各次按顺序补上，让小朋友等最少的时间就能播到第一张卡；
 *  - 没有顺序信息就用任务词表兜底；
 *  - 主动推送的那一次也属本周，排在最后；
 *  - 句子用背词页的默认语速（0.7）拉，单词用正常速。
 */
function buildPreloadItems(task: ReciteTask | null): PreloadItem[] {
  if (!task) return []
  // 任务词表里存着每个词条的类型和实际念的文本，用来认出哪些是句子
  const sentences = new Set<string>()
  for (const item of task.words ?? []) {
    if (item.type !== 'sentence') continue
    const label = item.displayText?.trim() || item.word
    const key = audioCacheKeyOf(label)
    if (key) sentences.add(key)
  }

  const groups: string[][] = []
  const order = Array.isArray(task.wordOrder) ? task.wordOrder.filter(group => Array.isArray(group)) : []
  if (order.length > 0) {
    const next = task.activeSessionIndex ?? task.completedSessions + 1
    const priority = Math.min(Math.max(next - 1, 0), order.length - 1)
    groups.push(order[priority])
    order.forEach((group, index) => {
      if (index !== priority) groups.push(group)
    })
  } else {
    groups.push((task.words ?? []).map(item => item.type === 'sentence' && item.displayText ? item.displayText : item.word))
  }
  for (const session of task.sessions ?? []) {
    if (session.pushed && session.words?.length) groups.push(session.words)
  }

  const seen = new Set<string>()
  const items: PreloadItem[] = []
  for (const text of groups.flat()) {
    const item: PreloadItem = sentences.has(audioCacheKeyOf(text))
      ? { text, speakingRate: SENTENCE_SPEAKING_RATE }
      : { text }
    const key = cacheKeyOf(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }
  return items
}

async function fetchItemAudio(item: PreloadItem): Promise<FetchOutcome> {
  try {
    const query = item.speakingRate
      ? '?text=' + encodeURIComponent(item.text) + '&speakingRate=' + item.speakingRate
      : '?text=' + encodeURIComponent(item.text)
    const response = await apiFetch('/api/tts' + query)
    if (response.status === 503) return 'fatal-config'
    if (response.status === 401 || response.status === 403) return 'fatal-auth'
    let payload: { audio?: string; mime?: string } | null = null
    try { payload = await response.json() } catch { payload = null }
    if (!response.ok || !payload?.audio) return 'failed'
    await storePersistedAudio(cacheKeyOf(item), payload.audio, payload.mime || 'audio/mpeg')
    return 'ok'
  } catch {
    return 'failed'
  }
}

/** 拉一批词：先在本地排队扣掉已缓存的，剩下的并发 2 逐个下载 */
async function preloadItems(
  items: PreloadItem[],
  report: (state: RecitePreloadState) => void,
): Promise<RecitePreloadState> {
  const total = items.length
  let done = 0
  const failed: string[] = []
  let fatalReason = ''
  let aborted = false

  const pending: PreloadItem[] = []
  for (const item of items) {
    const persisted = await loadPersistedAudio(cacheKeyOf(item))
    if (persisted) done += 1
    else pending.push(item)
  }
  report({ status: 'loading', total, done, failed: [], reason: '' })

  let cursor = 0
  const worker = async () => {
    while (!aborted && cursor < pending.length) {
      const item = pending[cursor]
      cursor += 1
      const outcome = await fetchItemAudio(item)
      if (outcome === 'fatal-config') {
        fatalReason = '发音服务没配置（GOOGLE_TTS_API_KEY 缺失），本次没有拉取'
        aborted = true
        return
      }
      if (outcome === 'fatal-auth') {
        fatalReason = '访问令牌失效了，重新输入令牌后再试'
        aborted = true
        return
      }
      if (outcome === 'failed') failed.push(item.text)
      done += 1
      report({ status: 'loading', total, done, failed: [...failed], reason: '' })
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(pending.length, 1)) }, () => worker()),
  )

  const status: RecitePreloadStatus = aborted ? 'error' : 'done'
  const reason = fatalReason || (failed.length > 0 ? failed.length + ' 个词没拉成功，可单独重试' : '')
  return { status, total, done, failed, reason }
}

/**
 * @param task 本周任务（首页的 homeTask）
 * @param enabled 还没点「开始学习」才拉（点了开始后页面会按需取，别抢网络）
 */
export function useRecitePreload(task: ReciteTask | null, enabled: boolean): UseRecitePreloadResult {
  const [state, setState] = useState<RecitePreloadState>(IDLE)
  const runToken = useRef(0)
  const signatureRef = useRef('')
  const taskRef = useRef(task)
  taskRef.current = task

  const run = useCallback((target: PreloadItem[]) => {
    const token = runToken.current + 1
    runToken.current = token
    if (target.length === 0) {
      setState(IDLE)
      return
    }
    setState({ status: 'loading', total: target.length, done: 0, failed: [], reason: '' })
    void preloadItems(target, next => {
      if (runToken.current !== token) return
      setState(next)
    }).then(result => {
      if (runToken.current !== token) return
      setState(result)
      const current = taskRef.current
      if (!current) return
      void saveReciteMeta({
        taskId: current.id,
        weekStart: current.weekStart,
        weekEnd: current.weekEnd,
        total: result.total,
        done: result.done,
        failed: result.failed,
        status: result.status === 'error' ? 'error' : 'done',
        reason: result.reason,
        cachedAt: Date.now(),
      })
    })
  }, [])

  useEffect(() => {
    if (!enabled || !task) return
    const target = buildPreloadItems(task)
    const signature = task.id + '|' + task.configVersion + '|' + target.map(cacheKeyOf).join('\n')
    if (signature === signatureRef.current) return
    signatureRef.current = signature
    run(target)
    return () => {
      // 点了开始 / 离开页面 / 换了任务：这次拉取作废；签名清掉，下次进来重拉（已缓存的会跳过）
      runToken.current += 1
      signatureRef.current = ''
    }
  }, [task, enabled, run])

  // 点了「开始学习」后预取让位给背词页自己的请求：把「拉取中」的进度收口，
  // 免得调试面板一直停在「拉取中」（已缓存的词下次进首页会跳过）
  useEffect(() => {
    if (enabled) return
    setState(previous => previous.status === 'loading'
      ? { ...previous, status: 'idle', reason: '已开始学习，本周预取先暂停' }
      : previous)
  }, [enabled])

  const reload = useCallback((words?: string[]) => {
    const full = buildPreloadItems(taskRef.current)
    if (!words || words.length === 0) {
      run(full)
      return
    }
    // 只重试失败词时也按整周的词数算进度：把要重试的排到队头，其余照旧（已缓存的会跳过）。
    // 重试的条目照旧从整周清单里取，句子的 0.7 语速才不会丢。
    const priority = new Set(words.map(audioCacheKeyOf))
    const retry = full.filter(item => priority.has(audioCacheKeyOf(item.text)))
    const rest = full.filter(item => !priority.has(audioCacheKeyOf(item.text)))
    run([...retry, ...rest])
  }, [run])

  return { ...state, reload }
}
