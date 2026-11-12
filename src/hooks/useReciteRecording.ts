import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MAX_RECORDING_BYTES, flushQueuedRecordings, uploadRecordingSegment } from '../utils/reciteRecordingUpload'
import {
  dropQueuedRecordingSegment,
  pruneQueuedRecordingSegments,
  queueRecordingSegment,
} from '../utils/reciteRecordingQueue'

/**
 * useReciteRecording — 背词页的课堂录音。
 *
 * 家长的开关在首页左下角（默认开启）；开始学习后自动用 MediaRecorder 录音。
 * 录音一旦停下（学完、关页面、切后台、离开页面），先把整段字节存到本地 IndexedDB，
 * 再分片上传：POST 建记录（带幂等键）→ PUT 一片一片传 → POST complete。
 * 传完才删本地副本；没传完 / 传失败就留在本机，下次进背词页自动补传（见 flushQueuedRecordings）。
 * 浏览器不支持、没给麦克风权限、上传失败都不影响背单词，只把原因写在页面上（页面左下角的录音标识）。
 *
 * 每段录音都带会话 id、片段序号和录制时间：补传后仍能落回同一次学习，并按时间顺序拼回整段。
 *
 * 为什么还要 prime()：Safari 只认用户手势里的 getUserMedia。点「开始学习」到会话
 * 建好之间隔了一次网络请求，等会话回来再要麦克风就常常被拒（表现为「有时候没开录音」），
 * 所以在点击当下先把麦克风流预取到手，正式开录直接用它。
 */

/** Safari 只给 audio/mp4，Chrome 用 webm/opus；按顺序挑第一个能用的 */
const MIME_CANDIDATES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
/** 语音不需要高码率：24kbps 听得清（6MB ≈ 33 分钟），也不会一分钟录出几 MB */
const AUDIO_BITS_PER_SECOND = 24000
/** 录满自动停：不让小朋友开着页面录一小时把上限撞穿 */
const MAX_RECORD_MS = 30 * 60 * 1000
/** 多久没声音就停下这一段（小朋友发呆 / 家长离开了，不漫无目的地录） */
const SILENCE_MS = 60 * 1000
/** 静音检测的采样间隔：密一点，避免说话时刚好采到停顿 */
const SILENCE_POLL_MS = 250
/** 音量阈值（归一化 RMS）：高于它算「有声音」，底下是环境底噪 */
const SILENCE_RMS = 0.02
/** 录音开关的偏好：家长关掉后下次进来还是关的，默认开启 */
const PREF_KEY = 'es-recite-record'

export function canRecord(): boolean {
  return typeof window !== 'undefined'
    && typeof window.MediaRecorder !== 'undefined'
    && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
}

export function readRecordPref(): boolean {
  try { return localStorage.getItem(PREF_KEY) !== 'off' } catch { return true }
}

export function writeRecordPref(enabled: boolean) {
  try { localStorage.setItem(PREF_KEY, enabled ? 'on' : 'off') } catch { /* 隐私模式下只影响本次会话 */ }
}

function pickMime(): string {
  for (const type of MIME_CANDIDATES) {
    try { if (MediaRecorder.isTypeSupported(type)) return type } catch { /* 忽略不认识的支持查询 */ }
  }
  return ''
}

/** 会话内片段序号存在本地：刷新 / 关页面再进来接着往后数，顺序不会重叠 */
const SEGMENT_KEY_PREFIX = 'es-recite-seg:'
/** localStorage 不可用时的内存计数器（本次页面生命周期内仍然单调） */
const segmentCounters = new Map<string, number>()

function nextSegmentIndex(sessionId: string): number {
  try {
    const key = SEGMENT_KEY_PREFIX + sessionId
    const next = Number(localStorage.getItem(key) ?? '0') + 1
    localStorage.setItem(key, String(next))
    return next - 1
  } catch {
    const next = segmentCounters.get(sessionId) ?? 0
    segmentCounters.set(sessionId, next + 1)
    return next
  }
}

function recordErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const text = raw.toLowerCase()
  if (text.includes('permission') || text.includes('denied') || text.includes('not allowed')) {
    return '没法录音：浏览器没给麦克风权限，允许之后再进背词页就会自动录'
  }
  if (text.includes('notfound') || text.includes('no device') || text.includes('device not found')) {
    return '没法录音：没找到麦克风'
  }
  if (text.includes('secure') || text.includes('https')) return '没法录音：页面不是 HTTPS，浏览器不允许用麦克风'
  return '没法录音：' + (raw || '未知错误')
}


interface ReciteRecordingOptions {
  /** 家长在首页的开关 */
  enabled: boolean
  /** 正在背词才录：会话 active、还没进完成页、并且还有没判过的卡片（完成页刷新进来就不开录） */
  active: boolean
  sessionId?: string | null
}

export function useReciteRecording({ enabled, active, sessionId }: ReciteRecordingOptions) {
  const supported = useMemo(canRecord, [])
  const [recording, setRecording] = useState(false)
  // 正在要麦克风 / 建 MediaRecorder：标识上显示「正在开启录音」
  const [starting, setStarting] = useState(false)
  // 开录就失败（没权限 / 没麦克风 / 浏览器拦截）：标识变红并给一个可点的重试
  const [startFailed, setStartFailed] = useState(false)
  const [error, setError] = useState('')
  // 用户手势里预取的麦克风流，正式开录时直接用
  const primed = useRef<MediaStream | null>(null)
  const primePending = useRef<Promise<void> | null>(null)
  const primeSeq = useRef(0)
  const primeTimer = useRef(0)
  // 重试计数：左下角红色标识点一下就从这次手势里重新要麦克风
  const [attempt, setAttempt] = useState(0)
  // 切后台 / 关页面时先把这一段停下，回到前台再重新开录（每次停下就是一段独立录音）
  const [resumeTick, setResumeTick] = useState(0)
  const stoppedByHide = useRef(false)
  // 因为长时间没声音停下的：下一次点页面 / 按键自动重新开录
  const [silencePaused, setSilencePaused] = useState(false)

  /** 放开预取的流（含定时器）：不释放会一直占着麦克风，iOS 上还能看到常驻的录音小圆点 */
  const releasePrimed = useCallback(() => {
    primeSeq.current += 1
    primePending.current = null
    if (primeTimer.current) {
      window.clearTimeout(primeTimer.current)
      primeTimer.current = 0
    }
    const stream = primed.current
    primed.current = null
    if (stream) stream.getTracks().forEach(track => track.stop())
  }, [])

  /** 点「开始学习」时先要一次麦克风：请求必须落在用户手势里，Safari 才认 */
  const prime = useCallback(() => {
    if (!enabled || !supported || primed.current || primePending.current) return
    const seq = primeSeq.current
    const pending = navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      // 期间被释放过 / 已经有流了：别攥着麦克风不放
      if (seq !== primeSeq.current || primed.current) {
        stream.getTracks().forEach(track => track.stop())
        return
      }
      primed.current = stream
      // 会话迟迟没回来就别一直攥着麦克风，正式开录时再要一次就好
      if (primeTimer.current) window.clearTimeout(primeTimer.current)
      primeTimer.current = window.setTimeout(releasePrimed, 20_000)
    }).catch(() => {
      // 这里不报错：正式开录时会再试一次，失败原因由那次写进 error
    })
    primePending.current = pending
    void pending.then(() => {
      if (primePending.current === pending) primePending.current = null
    })
  }, [enabled, supported, releasePrimed])

  /** 标识上的重试：清掉旧原因，重走一遍开启流程（同样发生在点击手势里） */
  const retry = useCallback(() => {
    setError('')
    setStartFailed(false)
    setAttempt(value => value + 1)
    prime()
  }, [prime])

  // 离开页面 / 家长关掉开关：预取的流不能留着
  useEffect(() => () => releasePrimed(), [releasePrimed])
  useEffect(() => { if (!enabled) releasePrimed() }, [enabled, releasePrimed])

  /**
   * 刷新 / 直接进背词流时没有经过「开始学习」那一下点击，自动开录的 getUserMedia
   * 不在手势里（Safari 会拒）。所以开录失败后挂一个一次性监听：接下来随便点哪里
   * （点卡片、点「会 / 不会」都算），就借这次手势再要一次麦克风。
   */
  useEffect(() => {
    if (!supported || !enabled || !active || !startFailed) return
    const handler = () => retry()
    window.addEventListener('pointerdown', handler, { once: true, capture: true })
    return () => window.removeEventListener('pointerdown', handler, { capture: true })
  }, [supported, enabled, active, startFailed, retry])

  useEffect(() => {
    if (!enabled || !active || !sessionId || !supported) return
    let recorder: MediaRecorder | null = null
    let stream: MediaStream | null = null
    let chunks: Blob[] = []
    let buffered = 0
    let finished = false
    let disposed = false
    let stopTimer = 0
    const session = sessionId
    /** 这一段真正开始录的时间与序号：在 recorder.start() 那一刻才定，避免开录失败也占掉序号 */
    let segmentStartedAt = 0
    let segmentIndex = -1
    /** 静音检测（无声音 1 分钟就停）用的上下文与采样器 */
    let audioCtx: AudioContext | null = null
    let analyser: AnalyserNode | null = null
    let silenceTimer = 0
    let lastSoundAt = 0

    /** 停掉静音检测并释放 AudioContext（录音停下了就不必再测） */
    const stopSilenceWatch = () => {
      if (silenceTimer) {
        window.clearInterval(silenceTimer)
        silenceTimer = 0
      }
      analyser = null
      if (audioCtx) {
        const context = audioCtx
        audioCtx = null
        void context.close().catch(() => { /* 已经关了 */ })
      }
    }

    /**
     * 录完这一段：先存本地、再上传，传完才删本地副本。
     * 关页面 / 断网 / 上传失败时副本还在，下次进背词页自动补传。
     */
    const finish = () => {
      if (finished) return
      finished = true
      if (stopTimer) {
        window.clearTimeout(stopTimer)
        stopTimer = 0
      }
      stopSilenceWatch()
      const type = recorder?.mimeType || 'audio/mp4'
      const blob = new Blob(chunks, { type })
      chunks = []
      setRecording(false)
      if (blob.size === 0) return
      if (blob.size > MAX_RECORDING_BYTES) {
        setError('这段录音太长了（超过 16MB），没有保存')
        return
      }
      const recordedAt = segmentStartedAt || Date.now()
      const segment = {
        key: crypto.randomUUID(),
        sessionId: session,
        mime: type,
        durationMs: Math.max(0, Date.now() - recordedAt),
        recordedAt,
        // 没有序号也照存：没法排序时最多是「不合并」，不会丢音频
        segmentIndex: segmentIndex < 0 ? 0 : segmentIndex,
        size: blob.size,
      }
      void (async () => {
        const buffer = await blob.arrayBuffer()
        const bytes = new Uint8Array(buffer)
        const queued = await queueRecordingSegment({ ...segment, bytes: buffer, queuedAt: Date.now() })
        if (queued) void pruneQueuedRecordingSegments()
        try {
          await uploadRecordingSegment({ ...segment, clientKey: segment.key, bytes })
          if (queued) await dropQueuedRecordingSegment(segment.key)
          // 传成功顺便把之前没传完的也补一遍（失败时不再重试一遍，避免白耗流量）
          void flushQueuedRecordings()
        } catch (uploadError) {
          const message = uploadError instanceof Error ? uploadError.message : ''
          if (queued && message.includes('学习记录不存在')) {
            // 这次学习已经被重新配置掉：这份音频永远传不上去，删掉本地副本
            await dropQueuedRecordingSegment(segment.key)
            return
          }
          setError(queued
            ? '录音还没传上去，已存在本机，下次打开背词页会自动补传'
            : '录音上传失败：' + (message || '网络异常'))
        }
      })()
    }

    /** 主动停：录满 30 分钟 / 超过大小上限 / 离开页面都走这里，停下后自动上传 */
    const stopRecorder = () => {
      const current = recorder
      if (!current) {
        finish()
        return
      }
      if (current.state === 'inactive') finish()
      else {
        try {
          current.stop()
        } catch {
          finish()
        }
      }
    }

    /**
     * 静音检测：每秒钟量一次音量，连续 1 分钟没声音就停下这一段（照常落本地 + 上传），
     * 等下次点页面 / 按键再开新的一段。
     */
    const startSilenceWatch = (mediaStream: MediaStream) => {
      try {
        const Ctor = window.AudioContext
          ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!Ctor) return
        audioCtx = new Ctor()
        const source = audioCtx.createMediaStreamSource(mediaStream)
        analyser = audioCtx.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
        // 接一个静音增益到 destination：保证音频图真的在跑（不加会静音，不会有任何回声）
        const mute = audioCtx.createGain()
        mute.gain.value = 0
        analyser.connect(mute)
        mute.connect(audioCtx.destination)
        // 没在手势里创建的 AudioContext 可能是 suspended，先试一次恢复（失败也不影响录音）
        if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => { /* 忽略 */ })
        lastSoundAt = Date.now()
        silenceTimer = window.setInterval(() => {
          const sampler = analyser
          if (!sampler) return
          // AudioContext 没跑起来（Safari 没手势不让 resume）时量到的全是 0，这时宁可不停，也不误杀正常录音
          if (!audioCtx || audioCtx.state !== 'running') return
          const samples = new Uint8Array(sampler.fftSize)
          sampler.getByteTimeDomainData(samples)
          let sum = 0
          for (const value of samples) {
            const level = (value - 128) / 128
            sum += level * level
          }
          const rms = Math.sqrt(sum / samples.length)
          if (rms >= SILENCE_RMS) {
            lastSoundAt = Date.now()
            return
          }
          if (Date.now() - lastSoundAt < SILENCE_MS) return
          // 一直没声音：停下这一段，等孩子下次操作页面再重新开录
          setSilencePaused(true)
          stopRecorder()
        }, SILENCE_POLL_MS)
      } catch {
        // 静音检测不可用（老浏览器 / AudioContext 被限制）：退化成只按原有规则停，不影响录音
        stopSilenceWatch()
      }
    }

    setStarting(true)
    void (async () => {
      try {
        // 预取的授权请求还没回来就先等它：不等就会在没手势的时候再要一次，Safari 直接拒
        if (primePending.current) await primePending.current
        // 预取到的流直接拿来录（Google Chrome / Safari 都适用），没有就现要一次
        const primedStream = primed.current
        primed.current = null
        if (primeTimer.current) {
          window.clearTimeout(primeTimer.current)
          primeTimer.current = 0
        }
        const nextStream = primedStream ?? await navigator.mediaDevices.getUserMedia({ audio: true })
        if (disposed) {
          nextStream.getTracks().forEach(track => track.stop())
          return
        }
        stream = nextStream
        const mime = pickMime()
        recorder = mime
          ? new MediaRecorder(nextStream, { mimeType: mime, audioBitsPerSecond: AUDIO_BITS_PER_SECOND })
          : new MediaRecorder(nextStream)
        recorder.ondataavailable = event => {
          if (!event.data || event.data.size === 0) return
          chunks.push(event.data)
          buffered += event.data.size
          // 到了上限就收尾，别等录完才发现传不上去
          if (buffered >= MAX_RECORDING_BYTES) stopRecorder()
        }
        recorder.onstop = finish
        segmentIndex = nextSegmentIndex(session)
        segmentStartedAt = Date.now()
        // 每 10 秒切一块：长录音不用等到最后才拿到数据
        recorder.start(10_000)
        startSilenceWatch(nextStream)
        setSilencePaused(false)
        setRecording(true)
        setStarting(false)
        setStartFailed(false)
        setError('')
        stopTimer = window.setTimeout(stopRecorder, MAX_RECORD_MS)
      } catch (recordError) {
        setStarting(false)
        setStartFailed(true)
        setError(recordErrorMessage(recordError))
      }
    })()

    /**
     * 切后台 / 关页面 / 进 bfcache：先把这一段停下并落盘，别等系统把页面杀掉。
     * 回到前台（或从 bfcache 回来）再重新开一段——每段都带序号与录制时间，顺序不会乱。
     */
    const pauseForHide = () => {
      if (document.visibilityState !== 'hidden') return
      stoppedByHide.current = true
      stopRecorder()
    }
    const resumeAfterHide = () => {
      if (document.visibilityState !== 'visible' || !stoppedByHide.current) return
      stoppedByHide.current = false
      setResumeTick(value => value + 1)
    }
    const onPageHide = () => {
      stoppedByHide.current = true
      stopRecorder()
    }
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted || !stoppedByHide.current) return
      stoppedByHide.current = false
      setResumeTick(value => value + 1)
    }
    document.addEventListener('visibilitychange', pauseForHide)
    document.addEventListener('visibilitychange', resumeAfterHide)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)

    return () => {
      disposed = true
      setStarting(false)
      document.removeEventListener('visibilitychange', pauseForHide)
      document.removeEventListener('visibilitychange', resumeAfterHide)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      stopRecorder()
      stopSilenceWatch()
      if (stream) {
        stream.getTracks().forEach(track => track.stop())
        stream = null
      }
    }
  }, [enabled, active, sessionId, supported, attempt, resumeTick])

  /**
   * 因为长时间没声音而停下后：下一次点页面 / 按键盘就把录音重新开起来。
   * 重新要麦克风发生在这次点击手势里，Safari 才给；开完就是新的一段（带新序号）。
   */
  useEffect(() => {
    if (!silencePaused || !supported || !enabled || !active) return
    const restart = () => {
      setSilencePaused(false)
      prime()
      setResumeTick(value => value + 1)
    }
    window.addEventListener('pointerdown', restart, { once: true, capture: true })
    window.addEventListener('keydown', restart, { once: true, capture: true })
    return () => {
      window.removeEventListener('pointerdown', restart, { capture: true })
      window.removeEventListener('keydown', restart, { capture: true })
    }
  }, [silencePaused, supported, enabled, active, prime])

  return { supported, recording, starting, startFailed, error, prime, retry }
}
