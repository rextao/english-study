/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog Project API Key（vite 从 .dev.vars 取出并构建期注入）；留空则不启用会话回放 */
  readonly VITE_POSTHOG_KEY?: string
  /** PostHog 接入地址，默认 https://us.i.posthog.com */
  readonly VITE_POSTHOG_HOST?: string
}
