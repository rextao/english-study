import { useCallback, useEffect, useState } from 'react'
import { Button, Tag } from '../ui'
import { useTtsPrefill } from '../hooks/useTtsPrefill'
import { invalidateApiCache, queryApi } from '../utils/apiCache'
import './AudioRepair.css'

interface MissingAudioItem {
  word: string
  type: 'word' | 'sentence'
  listCount: number
}

interface TtsStatusReply {
  available?: boolean
  configured?: boolean
  voice?: string
}

interface MissingAudioReply {
  items?: MissingAudioItem[]
  tts?: TtsStatusReply
}

/** 设置页的发音补齐：只关注学习列表里还没有 TTS 缓存的词和句子。 */
export function AudioRepair() {
  const [items, setItems] = useState<MissingAudioItem[]>([])
  const [tts, setTts] = useState<TtsStatusReply | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [prefilling, setPrefilling] = useState(false)

  const loadMissing = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const data = await queryApi<MissingAudioReply>('/api/tts/missing', {}, {
        staleTime: 15_000,
        tags: ['missing-tts'],
      })
      setItems(Array.isArray(data.items) ? data.items : [])
      setTts(typeof data.tts === 'object' && data.tts !== null ? data.tts : null)
    } catch (cause) {
      setError(cause instanceof Error && cause.message
        ? cause.message
        : '无法读取缺少发音的词条，请确认云端服务可用。')
    } finally {
      setLoading(false)
    }
  }, [])

  const reloadAfterPrefill = useCallback(() => {
    invalidateApiCache(['missing-tts'])
    void loadMissing()
  }, [loadMissing])
  const prefill = useTtsPrefill(reloadAfterPrefill)

  useEffect(() => { void loadMissing() }, [loadMissing])

  async function prefillAll() {
    if (items.length === 0 || prefilling || prefill.busy) return
    setPrefilling(true)
    setError('')
    const result = await prefill.prefill()
    setPrefilling(false)
    if (!result.ok) {
      setError(result.error)
    } else if (result.queued === 0) {
      invalidateApiCache(['missing-tts'])
      await loadMissing()
    }
  }

  const ttsReady = tts?.configured === true
  const busy = prefilling || prefill.busy

  return (
    <div className='audio-repair'>
      <div className='audio-repair__head'>
        <div>
          <h2 className='settings-section__title'>补充音频</h2>
          <p className='hint'>
            学习列表里的单词和句子如果没有发音缓存，点喇叭时每次都要现合成。
            这里提前批量调用 Google 文字转语音并缓存音频，之后打开页面即可秒开播放。
          </p>
        </div>
        <Button
          type='primary'
          loading={busy}
          disabled={loading || !ttsReady || items.length === 0 || busy}
          onClick={() => { void prefillAll() }}
        >
          {prefill.busy ? '补充中...' : prefill.state.failed > 0 ? '重试失败条目' : '全部补充音频'}
        </Button>
      </div>

      {tts && !ttsReady && (
        <div className='callout callout--warn audio-repair__message'>
          Google 文字转语音还没有配置：Worker 缺少 secret <code>GOOGLE_TTS_API_KEY</code>。
          请先用 <code>npx wrangler secret put GOOGLE_TTS_API_KEY</code> 配置密钥后再来补充音频。
        </div>
      )}

      {(error || prefill.error) && (
        <div className='callout callout--error audio-repair__message' role='alert'>
          {error || prefill.error}
        </div>
      )}

      {!busy && prefill.state.failed > 0 && !error && !prefill.error && (
        <div className='callout callout--error audio-repair__message' role='alert'>
          本次补充有 {prefill.state.failed} 条失败，请稍后重试。
          {prefill.state.errors.length > 0 && (
            <ul>
              {prefill.state.errors.map(item => (
                <li key={item.word + item.message}>{item.word}：{item.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {busy && (
        <div className='callout callout--warn audio-repair__message' role='status' aria-live='polite'>
          <span className='ui-spin' aria-hidden='true' />
          正在补充音频：已处理 {prefill.state.done} / {prefill.state.total || items.length} 条
          {prefill.state.pending > 0 && <>，队列中还有 {prefill.state.pending} 条</>}
          {prefill.state.failed > 0 && <>，失败 {prefill.state.failed} 条</>}
        </div>
      )}

      {loading ? (
        <p className='empty audio-repair__loading'><span className='ui-spin' aria-hidden='true' />正在读取缺少发音的词条...</p>
      ) : items.length === 0 ? (
        <div className='callout callout--success audio-repair__empty'>
          ✓ 当前学习列表里的单词和句子都已经有发音缓存了。
        </div>
      ) : (
        <>
          <div className='audio-repair__summary'>
            <strong>共 {items.length} 条</strong>
            <span>补充操作在后台执行，可以离开当前分区。</span>
            {tts?.voice && <Tag color='default'>音色 {tts.voice}</Tag>}
          </div>
          <ul className='audio-repair__list'>
            {items.map(item => (
              <li className='audio-repair__item' key={item.word}>
                <span className='audio-repair__word'>{item.word}</span>
                <Tag color={item.type === 'sentence' ? 'default' : 'blue'}>
                  {item.type === 'sentence' ? '句子' : '单词'}
                </Tag>
                {item.listCount > 1 && <span className='audio-repair__lists'>{item.listCount} 个列表</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
