export default function App() {
  return (
    <div className="app">
      <main className="app__card">
        <p className="app__kicker">英语学习 · 手机版</p>
        <h1 className="app__title">Hello World</h1>
        <p className="app__desc">
          这是部署验证页。手机上能正常看到这一页，说明 Cloudflare Pages 已经跑起来了。
        </p>
        <p className="app__meta">当前环境：{import.meta.env.MODE}</p>
      </main>
      <footer className="app__footer">后续功能将从桌面版逐步迁移过来</footer>
    </div>
  )
}
