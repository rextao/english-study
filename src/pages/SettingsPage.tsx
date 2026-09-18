import { useState } from 'react'
import type { UpdateLabelResult } from '../hooks/useVocabLibraries'
import type { VocabLibraryInfo } from '../types/vocab'
import { useDictSources } from '../hooks/useDictSources'
import { LibrariesPage } from './LibrariesPage'
import { PageHeader } from '../components/PageHeader'
import { Button, Input, Tag } from '../ui'
import './SettingsPage.css'

interface SettingsPageProps {
  libraries: VocabLibraryInfo[]
  getLabelById: (id: string) => string
  hasCustomLabel: (id: string) => boolean
  onRename: (id: string, label: string) => Promise<UpdateLabelResult>
  onReset: (id: string) => void
  getPrintLabelById: (id: string) => string
  hasCustomPrintLabel: (id: string) => boolean
  onRenamePrintLabel: (id: string, label: string) => Promise<UpdateLabelResult>
  onResetPrintLabel: (id: string) => void
  offline: boolean
}

export function SettingsPage(props: SettingsPageProps) {
  const { sources, chain, saving, error, saveKeys, clearKeys } = useDictSources()
  const [apiKeyDraft, setApiKeyDraft] = useState('')
  const [appIdDraft, setAppIdDraft] = useState('')

  const [section, setSection] = useState<'chain' | 'libraries'>('libraries')

  const baidu = chain.find(step => step.id === 'baidu')

  async function handleSaveKeys() {
    const patch: { baiduApiKey?: string; baiduAppId?: string } = {}
    if (apiKeyDraft.trim()) patch.baiduApiKey = apiKeyDraft.trim()
    if (appIdDraft.trim()) patch.baiduAppId = appIdDraft.trim()
    if (!patch.baiduApiKey && !patch.baiduAppId) return
    if (await saveKeys(patch)) {
      setApiKeyDraft('')
      setAppIdDraft('')
    }
  }

  async function handleClearKeys() {
    if (await clearKeys(['baiduApiKey', 'baiduAppId'])) {
      setApiKeyDraft('')
      setAppIdDraft('')
    }
  }

  return (
    <div className="page settings-page">
      <PageHeader title="设置" subtitle="词库标签和查词链路都在这里配置" />

      <div className="settings-tabs" role="tablist" aria-label="设置分区">
        <button
          type="button"
          role="tab"
          aria-selected={section === 'libraries'}
          className={'settings-tabs__btn' + (section === 'libraries' ? ' settings-tabs__btn--active' : '')}
          onClick={() => setSection('libraries')}
        >
          词库配置
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'chain'}
          className={'settings-tabs__btn' + (section === 'chain' ? ' settings-tabs__btn--active' : '')}
          onClick={() => setSection('chain')}
        >
          查询链路
        </button>
      </div>

      {section === 'chain' ? (
      <section className="settings-section">
        <div className="settings-section__head">
          <p className="hint">查词时按下面的顺序依次尝试：①② 命中就直接返回，一个网络请求都不发；③④ 是同一轮外部请求里互补的两步——dictionaryapi 取音标和英文释义，百度翻译取中文，前者成功也不会跳过后者。灰色的步骤查词时会被跳过。</p>
        </div>
        {sources === null ? (
          <div className="callout callout--warn">
            无法读取查词链路状态，请确认本地服务已启动（<code>npm run dev:all</code>）。
          </div>
        ) : (
          <ol className="chain">
            {chain.map((step, index) => (
              <li
                key={step.id}
                className={'chain-step' + (step.available ? '' : ' chain-step--off')}
              >
                <span className="chain-step__index" aria-hidden="true">{index + 1}</span>
                <div className="chain-step__main">
                  <div className="chain-step__head">
                    <span className="chain-step__name">{step.name}</span>
                    {step.available
                      ? <Tag color="green">已启用</Tag>
                      : <Tag color="default">跳过</Tag>}
                    {step.id === 'cache' && sources.cache.total > 0 && (
                      <span className="chain-step__stat">
                        已缓存 {sources.cache.complete}/{sources.cache.total} 条
                      </span>
                    )}
                    {step.id === 'ecdict' && step.available && sources.local.count > 0 && (
                      <span className="chain-step__stat">
                        {sources.local.count.toLocaleString('zh-CN')} 词条
                      </span>
                    )}
                  </div>
                  <p className="chain-step__desc">{step.desc}</p>
                  {!step.available && step.reason && (
                    <p className="chain-step__reason">{step.reason}</p>
                  )}

                  {step.id === 'baidu' && (
                    <div className="key-form">
                      <div className="key-form__row">
                        <label className="field-label key-form__label" htmlFor="baidu-api-key">API Key</label>
                        <Input
                          id="baidu-api-key"
                          size="small"
                          value={apiKeyDraft}
                          placeholder={
                            baidu?.hasKey
                              ? '已配置 ' + baidu.keyHint + '，输入新的覆盖'
                              : '粘贴百度翻译 API Key'
                          }
                          onChange={e => setApiKeyDraft(e.target.value)}
                          onPressEnter={handleSaveKeys}
                          spellCheck={false}
                        />
                      </div>
                      <div className="key-form__row">
                        <label className="field-label key-form__label" htmlFor="baidu-app-id">App ID</label>
                        <Input
                          id="baidu-app-id"
                          size="small"
                          value={appIdDraft}
                          placeholder={
                            baidu?.hasAppId
                              ? '已配置 ' + baidu.appIdHint + '，输入新的覆盖'
                              : '粘贴百度翻译 App ID'
                          }
                          onChange={e => setAppIdDraft(e.target.value)}
                          onPressEnter={handleSaveKeys}
                          spellCheck={false}
                        />
                      </div>
                      <div className="key-form__actions">
                        <Button
                          type="primary"
                          size="small"
                          loading={saving}
                          disabled={!apiKeyDraft.trim() && !appIdDraft.trim()}
                          onClick={() => { void handleSaveKeys() }}
                        >
                          保存
                        </Button>
                        {(baidu?.hasKey || baidu?.hasAppId) && (
                          <Button size="small" disabled={saving} onClick={() => { void handleClearKeys() }}>
                            清除并回落环境变量
                          </Button>
                        )}
                      </div>
                      <p className="hint key-form__hint">
                        密钥存在本机 cache/dict-keys.json（不进 git）；也可以写在 .env.local 的
                        BAIDU_TRANSLATE_API_KEY / BAIDU_TRANSLATE_APP_ID 里，页面配置优先。「清除」只删掉这里配的，自动回落到环境变量。
                      </p>
                      {error && <div className="callout callout--error key-form__error">{error}</div>}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
      ) : (
        <section className="settings-section">
          <div className="settings-section__head">
            <p className="hint">显示标签用于页面展示；打印标签用于卡片右上角，未设置时沿用显示标签。</p>
          </div>
          <LibrariesPage embedded {...props} />
        </section>
      )}
    </div>
  )
}
