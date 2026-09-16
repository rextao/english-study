import { useEffect, useState } from 'react'
import { Button, Checkbox, Input, Tag } from '../ui'
import type { DictionaryEntry, StudyList } from '../types/vocab'
import type { DictionaryStatus } from '../hooks/useDictionary'
import type { StudyStatus } from '../hooks/useStudy'
import { selectedTranslationOptions, translationOptions, translationPosLabel } from '../utils/translations'
import './WordCard.css'

interface WordCardProps {
  entry: DictionaryEntry | null
  status: DictionaryStatus
  sourceIds: string[]
  getLabelById: (id: string) => string
  studyStatus: StudyStatus
  studyListIds: string[]        // lists this word already belongs to
  targetListId: string          // 首页当前选择的目标列表
  lists: StudyList[]            // all available lists
  targetItemExists: boolean     // 当前词已在目标列表中
  existingTranslationIds: string[] // 当前列表里已经保存的中文词义
  existingAllTranslations: boolean // 当前列表里已保存全部中文词义
  /** 列表里已经保存的自定义词义；二次编辑时还原成可删的标签 */
  existingCustomTranslations: string[]
  onCheckStudy: (word: string) => void
  /** 直接加入首页当前选择的列表，并保存选中的中文词义与自定义词义 */
  onAddToList: (translationIds: string[], customTranslations: string[]) => void | Promise<void>
}

const MAX_PICKED_TRANSLATIONS = 12
/** 与服务端 MAX_CUSTOM_TRANSLATIONS 一致：一个词最多 6 条自定义词义 */
const MAX_CUSTOM_TRANSLATIONS = 6
const ERROR_TOAST_DURATION_MS = 6000

function isSentenceText(text: string): boolean {
  const parts = text.trim().split(/\s+/).filter(Boolean)
  return parts.length >= 3 || /[.!?！？。；;]/.test(text)
}

function formatEntryErrors(entry: DictionaryEntry | null): string {
  const visibleErrors = (entry?.errors ?? []).filter((error, index, all) => (
    all.findIndex(item => item.source === error.source && item.code === error.code && item.target === error.target) === index
  ))
  return visibleErrors.map(error => {
    const source = error.source === 'baidu' ? '百度翻译' : '免费词典'
    const target = error.target ? '（' + error.target + '）' : ''
    return source + target + '：' + error.message
  }).join('；')
}

export function WordCard({
  entry, status, sourceIds, getLabelById,
  studyStatus, targetListId, lists,
  targetItemExists, existingTranslationIds, existingAllTranslations, existingCustomTranslations,
  onCheckStudy, onAddToList,
}: WordCardProps) {

  const [adding, setAdding] = useState(false)
  const [selectedTranslationIds, setSelectedTranslationIds] = useState<string[]>([])
  const [showErrorToast, setShowErrorToast] = useState(false)
  const [customs, setCustoms] = useState<string[]>([])
  const [customDraft, setCustomDraft] = useState('')
  const sentence = isSentenceText(entry?.displayText ?? entry?.word ?? '')
  const errorText = formatEntryErrors(entry)
  const spellingSuspect = Boolean(
    entry
    && !/\s/.test(entry.word.trim())
    && sourceIds.length === 0
    && entry.spellingStatus === 'suspect',
  )

  useEffect(() => {
    const options = translationOptions(entry?.translations ?? [])
    const selected = existingAllTranslations
      ? options.slice(0, MAX_PICKED_TRANSLATIONS)
      : existingTranslationIds.length > 0
        ? selectedTranslationOptions(entry?.translations ?? [], existingTranslationIds)
        : sentence && options.length === 1
          ? options
          : []
    setSelectedTranslationIds(selected.slice(0, MAX_PICKED_TRANSLATIONS).map(item => item.id))
  }, [entry?.word, entry?.translations, existingTranslationIds.join('\u0000'), existingAllTranslations, sentence])

  // 自定义词义跟着词条和已保存记录走：换词或外部数据更新时还原成已保存的那一份
  useEffect(() => {
    setCustoms(existingCustomTranslations.slice())
    setCustomDraft('')
  }, [entry?.word, existingCustomTranslations.join('\u0000')])

  useEffect(() => {
    if (!errorText) {
      setShowErrorToast(false)
      return
    }
    setShowErrorToast(true)
    const timer = window.setTimeout(() => setShowErrorToast(false), ERROR_TOAST_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [entry?.word, errorText])

  useEffect(() => {
    if (entry?.word) onCheckStudy(entry.word)
  }, [entry?.word])

  if (status === 'loading') {
    return (
      <div className="word-card word-card--loading">
        <span className="word-card__spinner" />
        <span>查询中...</span>
      </div>
    )
  }
  if (status === 'no-server') {
    return (
      <div className="word-card word-card--warn">
        本地服务未启动，请在项目目录运行 <code>npm run dev:all</code>
      </div>
    )
  }
  if (status === 'error' || (status === 'done' && !entry)) {
    return <div className="word-card word-card--empty">未找到该单词的释义</div>
  }
  if (!entry) return null

  const isChecking = studyStatus === 'checking'
  const targetList = lists.find(list => list.id === targetListId)
  const translationItems = translationOptions(entry.translations ?? [])
  const selectableTranslationItems = translationItems.slice(0, MAX_PICKED_TRANSLATIONS)
  const existingSelectedItems = selectedTranslationOptions(entry.translations ?? [], existingTranslationIds)
  const hasNewCustom = customs.some(text => !existingCustomTranslations.includes(text))
  const targetHasAllTranslations = targetItemExists && !hasNewCustom && (
    existingAllTranslations
    || (selectableTranslationItems.length > 0
      && selectableTranslationItems.every(item => existingSelectedItems.some(selected => selected.id === item.id)))
  )
  const allTranslationsSelected = selectableTranslationItems.length > 0
    && selectableTranslationItems.every(item => selectedTranslationIds.includes(item.id))

  function toggleTranslation(id: string) {
    setSelectedTranslationIds(prev => {
      if (prev.includes(id)) return prev.filter(item => item !== id)
      if (prev.length >= MAX_PICKED_TRANSLATIONS) return prev
      return prev.concat(id)
    })
  }

  function toggleAllTranslations() {
    setSelectedTranslationIds(allTranslationsSelected
      ? []
      : selectableTranslationItems.map(item => item.id))
  }

  function addCustomTranslation() {
    const text = customDraft.trim()
    if (!text || customs.includes(text) || customs.length >= MAX_CUSTOM_TRANSLATIONS) return
    setCustoms(prev => prev.concat(text))
    setCustomDraft('')
  }

  function removeCustomTranslation(index: number) {
    setCustoms(prev => prev.filter((_, i) => i !== index))
  }

  async function handleAdd() {
    if (spellingSuspect) return
    setAdding(true)
    try {
      await onAddToList(selectedTranslationIds, customs)
    } finally {
      setAdding(false)
    }
  }

  return (
    <>
    <div className={spellingSuspect ? 'word-card word-card--spelling-suspect' : 'word-card'}>
      {/* 头部：左边是词，右上角是加入学习的小按钮 */}
      <div className="word-card__header">
        <div className="word-card__title">
          <span className="word-card__word">{entry.displayText || entry.word}</span>
          {!sentence && entry.phonetic && (
            <span className="word-card__phonetic">{entry.phonetic}</span>
          )}
          {entry.source && (
            <Tag
              color={entry.source === 'ecdict' ? 'green' : 'blue'}
              title={entry.source === 'ecdict'
                ? '释义来自本地 ECDICT 词典，查这个词没有联网'
                : '释义来自外部在线词典接口'}
            >
              {entry.source === 'ecdict' ? '本地词典' : '在线词典'}
            </Tag>
          )}
          {spellingSuspect && <Tag color="gold">可能拼写错误</Tag>}
        </div>

        <Button
          size="small"
          type={targetHasAllTranslations ? 'default' : 'primary'}
          loading={adding || isChecking}
          disabled={targetHasAllTranslations || spellingSuspect}
          className={targetHasAllTranslations ? 'word-card__add word-card__add--done' : 'word-card__add'}
          title={spellingSuspect
            ? '本地词典、免费词典和词库均未找到该词，请检查拼写'
            : targetHasAllTranslations
            ? '已在「' + (targetList?.name ?? targetListId) + '」'
            : targetItemExists
              ? '为「' + (targetList?.name ?? targetListId) + '」补充中文词义'
              : '加入「' + (targetList?.name ?? targetListId) + '」'}
          aria-label={spellingSuspect ? '可能拼写错误，无法加入学习列表' : targetHasAllTranslations ? '已在当前学习列表' : targetItemExists ? '补充中文词义' : '加入当前学习列表'}
          onClick={() => { void handleAdd() }}
        >
          {spellingSuspect ? '请检查拼写' : targetHasAllTranslations ? '✓ 已在当前列表' : targetItemExists ? '+ 补充学习' : '+ 学习'}
        </Button>
      </div>

      {spellingSuspect && (
        <p className="word-card__spelling-warning">
          本地词典、免费词典和词库均未找到这个词，请确认拼写后再加入学习。
        </p>
      )}

      {/* 词库标签紧跟在词下面，命中词库才显示；这里只展示，改名统一去词库页 */}
      {sourceIds.length > 0 && (
        <div className="word-card__tags">
          {sourceIds.map((id) => (
            <Tag key={id} color="blue" title="词库标签，改名请去「词库」页">{getLabelById(id)}</Tag>
          ))}
        </div>
      )}

      {entry.translations && entry.translations.length > 0 ? (
        <div className="word-card__translations" aria-label="选择要背的中文词义">
          <div className="word-card__translation-toolbar">
            <span className="hint">选择要背的中文词义</span>
            <Button type="link" size="small" onClick={toggleAllTranslations}>
              {allTranslationsSelected ? '取消全选' : '全选'}
            </Button>
          </div>
          {(() => {
            const groups = new Map<string, ReturnType<typeof translationOptions>>()
            for (const item of translationItems) {
              const key = item.pos ?? ''
              const group = groups.get(key) ?? []
              group.push(item)
              groups.set(key, group)
            }
            return Array.from(groups.entries()).map(([pos, items]) => (
              <div className="word-card__translation-group" key={pos || 'other'}>
                {pos && <span className="word-card__translation-pos">{translationPosLabel(pos)}</span>}
                <div className="word-card__translation-options">
                  {items.map(item => (
                    <Checkbox
                      key={item.id}
                      checked={selectedTranslationIds.includes(item.id)}
                      disabled={!selectedTranslationIds.includes(item.id) && selectedTranslationIds.length >= MAX_PICKED_TRANSLATIONS}
                      className="word-card__translation-option"
                      onChange={() => toggleTranslation(item.id)}
                    >
                      {item.text}
                    </Checkbox>
                  ))}
                </div>
              </div>
            ))
          })()}
        </div>
      ) : entry.translation ? (
        <p className="word-card__translation">{entry.translation}</p>
      ) : (
        <p className="word-card__translation word-card__translation--empty">暂时没有中文词义</p>
      )}

      {!spellingSuspect && (
        <div className="word-card__custom">
          <div className="word-card__translation-toolbar">
            <span className="hint">自定义词义（词典里没有也能自己加，会和勾选的词义一起背诵）</span>
          </div>
          {customs.length > 0 && (
            <div className="word-card__custom-tags">
              {customs.map((text, index) => (
                <Tag
                  key={index}
                  color="green"
                  title="点击移除这条自定义词义"
                  onClick={() => removeCustomTranslation(index)}
                >
                  {text}
                </Tag>
              ))}
            </div>
          )}
          <div className="word-card__custom-input">
            <Input
              size="small"
              value={customDraft}
              placeholder="输入中文词义，回车或点「添加」"
              maxLength={60}
              onChange={e => setCustomDraft(e.target.value)}
              onPressEnter={addCustomTranslation}
            />
            <Button
              size="small"
              disabled={!customDraft.trim() || customs.length >= MAX_CUSTOM_TRANSLATIONS}
              onClick={addCustomTranslation}
            >
              添加
            </Button>
          </div>
        </div>
      )}

    </div>
    {showErrorToast && errorText && (
      <div className="word-card__toast" role="status" aria-live="polite">
        <span>部分数据获取失败：{errorText}</span>
        <Button
          type="text"
          size="small"
          aria-label="关闭提示"
          onClick={() => setShowErrorToast(false)}
        >
          关闭
        </Button>
      </div>
    )}
    </>
  )
}
