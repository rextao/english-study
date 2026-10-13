import { useState } from 'react'
import { Button, Input } from '../ui'
import './TokenGate.css'

interface TokenGateProps {
  /** 用户提交令牌（可能为空串 = 想清除重填） */
  onSubmit: (token: string) => void
  /** localStorage 里已存过令牌（401 后重新弹窗时提示） */
  hasExistingToken: boolean
}

/**
 * 访问令牌门：云端 API 需要 Bearer 鉴权，首次打开（或令牌失效）时填一次。
 * 令牌只存本机 localStorage，随每个 /api 请求带上。
 */
export function TokenGate({ onSubmit, hasExistingToken }: TokenGateProps) {
  const [value, setValue] = useState('')

  return (
    <div className="token-gate">
      <form
        className="token-gate__card"
        onSubmit={event => {
          event.preventDefault()
          onSubmit(value.trim())
        }}
      >
        <h1 className="token-gate__title">英语学习</h1>
        <p className="token-gate__desc">
          {hasExistingToken
            ? '访问令牌已失效或不正确，请重新输入。'
            : '本站数据为私有部署，首次使用请输入访问令牌。'}
        </p>
        <Input
          value={value}
          placeholder="访问令牌"
          onChange={event => setValue(event.target.value)}
          onPressEnter={() => onSubmit(value.trim())}
          spellCheck={false}
          autoComplete="off"
        />
        <Button
          type="primary"
          htmlType="submit"
          disabled={!value.trim()}
          block
        >
          进入
        </Button>
        {hasExistingToken && (
          <Button
            size="small"
            onClick={() => onSubmit('')}
          >
            清除已保存的令牌
          </Button>
        )}
      </form>
    </div>
  )
}
