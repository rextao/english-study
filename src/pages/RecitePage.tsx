import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '../ui'
import './RecitePage.css'

/** 背单词卡片上要用的字段；从学习计划的词条映射而来，选词策略以后再设计 */
export interface ReciteWord {
  word: string
  /** 句子的展示文本；单词没有 */
  displayText?: string
  type?: 'word' | 'sentence'
  /** 加入学习列表时保存的音标快照 */
  phonetic?: string
  /** 加入学习列表时保存的中文词义快照 */
  translation?: string
}

interface RecitePageProps {
  words: ReciteWord[]
  /** 一轮背完 / 没有可背的词时回查词首页 */
  onExit: () => void
  /** 一个词都没有时引导去英语学习页 */
  onGoStudy?: () => void
  /** 朗读当前词；不传时喇叭按钮只播放按压动画（语音输出等能力后续再接） */
  onSpeak?: (word: ReciteWord) => void
}

/** 一张卡的判定结果；还没点过会 / 不会就是 null */
type Mark = 'known' | 'unknown'

/** 句子全屏自适应字号：从最大号起每次减 2px，直到整张卡片装得下可视区 */
const MAX_FONT_SIZE = 168
const MIN_FONT_SIZE = 30
const FONT_STEP = 2

/** 右上角环形进度的几何参数：viewBox 76x76、圆心 38,38，从 12 点钟方向开始描 */
const RING_R_OUTER = 34
const RING_R_INNER = 26.5
const RING_C_OUTER = 2 * Math.PI * RING_R_OUTER
const RING_C_INNER = 2 * Math.PI * RING_R_INNER

/** 「不会」上的叉 */
const crossIcon = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M7 7l10 10M17 7L7 17" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
  </svg>
)

/** 「会」上的对勾 */
const checkIcon = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4.5 12.5l4.5 4.5L19.5 6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** 中间的喇叭 */
const speakerIcon = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 9v6h4l5 4V5L8 9H4z" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M15.8 8.8a5 5 0 0 1 0 6.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    <path d="M18.4 6.2a8.5 8.5 0 0 1 0 11.6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
)

/** 卡片左边：往回看上一个 */
const chevronLeft = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M14.5 5.5L8 12l6.5 6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** 卡片右边：接着看下一个 */
const chevronRight = (
  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M9.5 5.5L16 12l-6.5 6.5" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/**
 * 右上角环形进度：外环 = 任务进度（当前第几个 / 总数），
 * 内环（绿）= 已判词中「会」的比例；环心给 x/y，环下小字给会 / 不会计数。
 */
function RingProgress({ position, total, known, unknown }: {
  position: number
  total: number
  known: number
  unknown: number
}) {
  const judged = known + unknown
  const taskRatio = total > 0 ? position / total : 0
  const knownRatio = judged > 0 ? known / judged : 0
  const label = '第 ' + position + ' / ' + total + ' 个，会 ' + known + ' 个，不会 ' + unknown + ' 个'
  return (
    <div className="recite__ring-wrap">
      <div className="recite__ring" role="img" aria-label={label}>
        <svg viewBox="0 0 76 76" aria-hidden="true">
          <g transform="rotate(-90 38 38)">
            <circle cx="38" cy="38" r={RING_R_OUTER} fill="none" stroke="#ececef" strokeWidth="5" />
            <circle
              cx="38" cy="38" r={RING_R_OUTER} fill="none" stroke="#2563eb" strokeWidth="5"
              strokeLinecap="round" strokeDasharray={RING_C_OUTER} strokeDashoffset={RING_C_OUTER * (1 - taskRatio)}
            />
            <circle cx="38" cy="38" r={RING_R_INNER} fill="none" stroke="#ececef" strokeWidth="4.5" />
            <circle
              cx="38" cy="38" r={RING_R_INNER} fill="none" stroke="#067a4d" strokeWidth="4.5"
              strokeLinecap="round" strokeDasharray={RING_C_INNER} strokeDashoffset={RING_C_INNER * (1 - knownRatio)}
            />
          </g>
        </svg>
        <span className="recite__ring-num">{position}<span className="recite__ring-sep">/</span>{total}</span>
      </div>
      <span className="recite__ring-cap">会 {known} · 不会 {unknown}</span>
    </div>
  )
}

/**
 * 横屏背单词：给小朋友的全屏背诵页。不渲染顶部导航，也没有退出按钮——
 * 只能从查词首页的入口（或 #/recite 地址）进来，一轮背完或一个词都没有时才出现「返回首页」。
 * 卡片只露英文（单词或句子），中文词义与音标先不显示；句子字号按可视区自适应到尽可能大。
 * 左下「不会」右下「会」是主流程：判完自动翻到下一张；卡片左右的箭头是回看用的，
 * 当前这张没点过会 / 不会时，右边的箭头不让往下翻。右上角环形进度同时表示任务进度与
 * 「会」的比例。会 / 不会目前只在本地推进卡片，选词与语音输出以后再接。
 */
export function RecitePage({ words, onExit, onGoStudy, onSpeak }: RecitePageProps) {
  const [index, setIndex] = useState(0)
  /** 按卡片位置记判定，翻回去重判直接覆盖，同一个词出现多次也不会算重 */
  const [results, setResults] = useState<(Mark | null)[]>(() => Array(words.length).fill(null))
  const [finished, setFinished] = useState(false)

  const slotRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const wordRef = useRef<HTMLDivElement>(null)

  const total = words.length
  const current = total > 0 ? words[Math.min(index, total - 1)] : undefined
  const currentJudged = index < results.length && results[index] != null
  const knownCount = results.filter(item => item === 'known').length
  const unknownCount = results.filter(item => item === 'unknown').length

  // 不会的词去重后给结算页列出来
  const unknownWords: string[] = []
  const seenWords = new Set<string>()
  results.forEach((result, i) => {
    if (result !== 'unknown') return
    const word = words[i].word
    if (!seenWords.has(word)) { seenWords.add(word); unknownWords.push(word) }
  })

  /** 判一个词，按位置记下会 / 不会，最后一个词判完进结算页 */
  const mark = useCallback((result: Mark) => {
    if (finished || !current) return
    setResults(list => {
      const next = list.slice()
      next[index] = result
      return next
    })
    if (index + 1 >= total) setFinished(true)
    else setIndex(next => next + 1)
  }, [current, finished, index, total])

  /** 卡片左边的翻页：往回看上一张，第一张时按不了 */
  const goPrev = useCallback(() => {
    if (finished) return
    setIndex(prev => Math.max(0, prev - 1))
  }, [finished])

  /** 卡片右边的翻页：当前这张点过会 / 不会才让往下翻；翻过最后一张算这一轮结束 */
  const goNext = useCallback(() => {
    if (finished || !currentJudged) return
    if (index + 1 >= total) setFinished(true)
    else setIndex(prev => prev + 1)
  }, [finished, currentJudged, index, total])

  /** 中间的喇叭：读一遍当前词 */
  const speak = useCallback(() => {
    if (current) onSpeak?.(current)
  }, [current, onSpeak])

  /** 量一遍卡片可用的位置，把字号同步缩到整张卡片正好装得下为止（直接改内联样式，重绘前完成所以不闪屏） */
  const fitText = useCallback(() => {
    const slot = slotRef.current
    const card = cardRef.current
    const word = wordRef.current
    if (!slot || !card || !word) return
    const availW = slot.clientWidth
    const availH = slot.clientHeight
    if (availW <= 0 || availH <= 0) return
    let size = MAX_FONT_SIZE
    word.style.fontSize = size + 'px'
    while (size > MIN_FONT_SIZE && (card.offsetWidth > availW || card.offsetHeight > availH)) {
      size -= FONT_STEP
      word.style.fontSize = size + 'px'
    }
  }, [])

  // 换词（卡片按 key 重建）或总数变化时重算一次字号
  useLayoutEffect(() => {
    fitText()
  }, [fitText, index, total])

  // 可视区尺寸变了（转屏、窗口缩放）也重算；ResizeObserver 不可用时回落到 window resize
  useEffect(() => {
    const slot = slotRef.current
    if (!slot) return
    if (typeof ResizeObserver === 'undefined') {
      const onResize = () => fitText()
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }
    const observer = new ResizeObserver(() => fitText())
    observer.observe(slot)
    return () => observer.disconnect()
  }, [fitText])

  // 外接键盘 / 桌面调试：← 上一个、→ 下一个、空格朗读
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); goPrev() }
      else if (event.key === 'ArrowRight') { event.preventDefault(); goNext() }
      else if (event.key === ' ') { event.preventDefault(); speak() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [goPrev, goNext, speak])

  const restart = useCallback(() => {
    setIndex(0)
    setResults(() => Array(total).fill(null))
    setFinished(false)
  }, [total])

  const displayTextOf = (item: ReciteWord) =>
    item.type === 'sentence' && item.displayText?.trim() ? item.displayText.trim() : item.word

  // 学习计划里还没有词：引导去英语学习挑词
  if (total === 0) {
    return (
      <div className="recite">
        <main className="recite__main">
          <div className="recite__card recite__card--panel">
            <div className="recite__empty-emoji" aria-hidden="true">📖</div>
            <div className="recite__empty-title">还没有可以背的单词</div>
            <p className="recite__empty-desc">
              先在「英语学习」里把词加入学习计划，这里就会用它们出卡片。
            </p>
            <div className="recite__empty-ops">
              {onGoStudy && (
                <Button type="primary" size="large" onClick={onGoStudy}>去英语学习</Button>
              )}
              <Button size="large" onClick={onExit}>返回首页</Button>
            </div>
          </div>
        </main>
      </div>
    )
  }

  // 一轮背完：会 / 不会各自几个，不会的词列出来方便再带着读
  if (finished) {
    return (
      <div className="recite">
        <main className="recite__main">
          <div className="recite__card recite__card--panel">
            <div className="recite__done-title">
              这一轮背完啦{unknownCount === 0 ? '，全部都会' : ''}！
            </div>
            <div className="recite__done-stats">
              <div className="recite__done-stat recite__done-stat--yes">
                <b>{knownCount}</b>
                <span>会</span>
              </div>
              <div className="recite__done-stat recite__done-stat--no">
                <b>{unknownCount}</b>
                <span>不会</span>
              </div>
            </div>
            {unknownWords.length > 0 && (
              <div className="recite__done-unknown">
                <div className="recite__done-unknown-label">这些词还不会，再多读几遍：</div>
                <div className="recite__done-unknown-words">{unknownWords.join(' · ')}</div>
              </div>
            )}
            <div className="recite__done-ops">
              <Button type="primary" size="large" onClick={restart}>再来一轮</Button>
              <Button size="large" onClick={onExit}>返回首页</Button>
            </div>
          </div>
        </main>
      </div>
    )
  }

  const displayText = current ? displayTextOf(current) : ''

  return (
    <div className="recite">
      <div className="recite__corner">
        <RingProgress position={index + 1} total={total} known={knownCount} unknown={unknownCount} />
      </div>

      <div className="recite__rotate-hint" aria-hidden="true">把平板横过来，背着更舒服～</div>

      <main className="recite__main">
        <div className="recite__word-area">
          <button
            type="button"
            className="recite__nav recite__nav--prev"
            aria-label="上一个"
            disabled={index === 0}
            onClick={goPrev}
          >
            {chevronLeft}
          </button>
          <div className="recite__card-slot" ref={slotRef}>
            <div className="recite__card" key={index} ref={cardRef}>
              <div className="recite__word" ref={wordRef}>{displayText}</div>
            </div>
          </div>
          <button
            type="button"
            className="recite__nav recite__nav--next"
            aria-label={currentJudged ? '下一个' : '下一个，请先点会或不会'}
            disabled={!currentJudged}
            onClick={goNext}
          >
            {chevronRight}
          </button>
        </div>

        <button
          type="button"
          className="recite__speak"
          aria-label={'朗读 ' + displayText}
          title="读一遍"
          onClick={speak}
        >
          <span className="recite__speak-ring">{speakerIcon}</span>
          <span className="recite__speak-label">读一遍</span>
        </button>
      </main>

      <footer className="recite__bar">
        <button
          type="button"
          className="recite__mark recite__mark--no"
          aria-label="不会"
          onClick={() => mark('unknown')}
        >
          {crossIcon}
          <span>不会</span>
        </button>
        <button
          type="button"
          className="recite__mark recite__mark--yes"
          aria-label="会"
          onClick={() => mark('known')}
        >
          {checkIcon}
          <span>会</span>
        </button>
      </footer>
    </div>
  )
}
