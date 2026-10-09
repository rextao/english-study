/**
 * SetupScreen.tsx — 同步配置页
 *
 * 第一次打开（或点「重新配置」）时显示。只要填一个访问令牌，
 * 存到 localStorage 后就切到主界面拉取快照（同步地址固定用当前站点 origin）。
 */
import { useState, type FormEvent } from 'react'
import type { SyncConfig } from '../lib/snapshot'

interface Props {
  /** 重新配置时回填旧配置；首次配置传 null */
  initial: SyncConfig | null
  onSaved: (config: SyncConfig) => void
}

export default function SetupScreen({ initial, onSaved }: Props) {
  const [token, setToken] = useState(initial?.token ?? '')
  const [error, setError] = useState('')

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    const trimmedToken = token.trim()
    if (!trimmedToken) {
      setError('请填写同步令牌')
      return
    }
    setError('')
    onSaved({ token: trimmedToken })
  }

  return (
    <form className="setup" onSubmit={handleSubmit}>
      <p className="app__kicker">英语学习 · 手机版</p>
      <h1 className="app__title">{initial ? '重新配置同步' : '配置同步'}</h1>
      <p className="app__desc">
        手机端页面与云端同步服务同源部署，只需填写访问令牌即可从云端拉取整库快照（只读）。
      </p>

      <div className="field">
        <label className="field__label" htmlFor="sync-token">令牌</label>
        <input
          id="sync-token"
          className="field__input"
          type="password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="访问令牌"
          value={token}
          onChange={event => setToken(event.target.value)}
        />
      </div>

      {error ? <p className="field__error">{error}</p> : null}

      <button className="btn btn--primary" type="submit">
        {initial ? '保存并重新同步' : '保存并同步'}
      </button>
    </form>
  )
}
