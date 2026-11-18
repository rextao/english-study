/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog Project API Key（vite 从 .dev.vars 取出并构建期注入）；留空则不启用会话回放 */
  readonly VITE_POSTHOG_KEY?: string
  /** PostHog 接入地址，默认 https://us.i.posthog.com */
  readonly VITE_POSTHOG_HOST?: string
}

/** 构建期注入的版本信息（见 vite.config.ts 的 define），设置页标题右侧显示 */
declare const __BUILD_INFO__: {
  /** 短 commit；构建环境没有 git 信息时为 unknown */
  commit: string
  /** 构建时工作区有未提交改动：这样的产物不对应任何一个提交 */
  dirty: boolean
  /** 构建时间，形如 2026-11-18 14:05 */
  builtAt: string
}
