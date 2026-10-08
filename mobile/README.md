# 手机端（mobile/）

桌面端（src/）跑在本机、强依赖本地服务 server/dict-server.mjs（127.0.0.1:3456）；
手机端要部署到云端给手机访问，所以做成一个独立的精简 Vite 应用，和桌面端互不干扰。

## 结构

```
mobile/
├── index.html              入口，移动端 viewport / 安全区 / PWA meta
├── vite.config.ts          独立配置：root=mobile/，base 相对路径，产物 mobile/dist
├── tsconfig.json           继承根 tsconfig.app.json，只编译 mobile/src
├── wrangler.toml           Cloudflare Pages 项目配置
├── scripts/deploy.sh       一键构建 + 部署到 Cloudflare Pages
└── src/
    ├── main.tsx            挂载 React
    ├── App.tsx             页面（当前 helloworld）
    ├── index.css           移动端基础样式 / 设计 token
    └── vite-env.d.ts       vite 类型声明
```

## 命令（在仓库根目录执行）

```
npm run dev:mobile       # 本地开发，http://localhost:5174
npm run build:mobile     # 类型检查 + 构建，产物在 mobile/dist
npm run preview:mobile   # 本地预览构建产物
npm run deploy:mobile    # 构建 + 部署到 Cloudflare Pages
```

所有命令复用仓库根的 node_modules，不需要额外装依赖。

## 部署

需要能连外网。首次运行会要求 npx wrangler login 授权一次：

```
npm run deploy:mobile
```

部署成功后访问 https://english-study-mobile.pages.dev 。

## 后续功能迁移思路

桌面端数据都在本地服务和 cache/study-history.sqlite，手机端不可能直接连本机服务，
所以迁移时要先解决「数据从哪来」：要么把后端搬到 Cloudflare（Pages Functions / D1），
要么手机端先做纯静态 / 只读功能。这部分等部署验证通过后再定。
