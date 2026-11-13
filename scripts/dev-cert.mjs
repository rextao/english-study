// 本地开发证书：scripts/dev-cert.mjs
//
// 为什么需要它：浏览器只把「安全上下文」（HTTPS 或 localhost）当成可以用麦克风的环境，
// 背词页录音要用 navigator.mediaDevices / MediaRecorder / crypto.randomUUID，全部属于
// 这类 API。vite 用 host: true 监听所有网卡，手机 / 局域网地址走的是 http://<本机IP>:5173，
// 不是安全上下文，于是背词页左下角的录音标识永远是红的（录音开不起来）。
//
// 这里给 .certs/ 生成一张覆盖 localhost 与当前局域网 IP 的开发证书，vite.config.ts 看到
// 这份证书就用 https 起开发服务器（浏览器里访问 https://<IP>:5173 即可录音）。
//
// 优先用 mkcert（证书由本机受信任的根证书签发，浏览器不报警告）；没有 mkcert 时退回
// openssl 自签，浏览器会提示「不安全」，点继续访问即可。生成本地证书不需要 root，
// 也不要在这里自动跑 mkcert -install（那一步会改系统钥匙串、要管理员授权）。
//
// 局域网 IP 变了（换 Wi-Fi / 回家）会自动重新生成；失败只打印原因并以 0 退出，
// dev 服务器会退回原来的 http 照常启动。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const certDir = join(root, '.certs')
const keyPath = join(certDir, 'dev-key.pem')
const certPath = join(certDir, 'dev-cert.pem')
const metaPath = join(certDir, 'hosts.json')

/** 当前这台机器上所有可以访问到开发服务器的名字：回环 + 局域网 IPv4 */
function currentHosts() {
  const names = ['localhost', '127.0.0.1', '::1']
  const local = hostname()
  if (local) names.push(local)
  // macOS 的 hostname 形如 xxx.local，再拼 .local 只会得到 xxx.local.local
  if (local && !local.endsWith('.local')) names.push(`${local}.local`)
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === 'IPv4' && !item.internal) names.push(item.address)
    }
  }
  return [...new Set(names)]
}

function readMeta() {
  try {
    const text = readFileSync(metaPath, 'utf8')
    const parsed = JSON.parse(text)
    return Array.isArray(parsed?.hosts) ? parsed.hosts.map(String) : []
  } catch {
    return []
  }
}

function hasUsableCert(hosts) {
  if (!existsSync(keyPath) || !existsSync(certPath)) return false
  const previous = readMeta()
  // 证书覆盖的名字必须包含当前所有名字：局域网 IP 变了就重签，否则手机访问会报证书错误
  return hosts.every(name => previous.includes(name))
}

function tryMkcert(hosts) {
  try {
    execFileSync('mkcert', ['-key-file', keyPath, '-cert-file', certPath, ...hosts], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    return true
  } catch (error) {
    const message = error?.stderr ? String(error.stderr).trim() : String(error?.message ?? error)
    console.warn(`[dev-cert] mkcert 生成证书失败，改用 openssl 自签：${message}`)
    return false
  }
}

/** openssl 自签：用配置文件写 SAN（macOS 自带的 LibreSSL 不认 -addext） */
function tryOpenSSL(hosts) {
  const dns = []
  const ips = []
  for (const name of hosts) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.includes(':')) ips.push(name)
    else dns.push(name)
  }
  const alt = [
    ...dns.map((name, index) => `DNS.${index + 1}=${name}`),
    ...ips.map((name, index) => `IP.${index + 1}=${name}`),
  ].join('\n')
  const configPath = join(certDir, 'openssl.cnf')
  writeFileSync(configPath, `[req]
distinguished_name=dn
x509_extensions=v3
prompt=no

[dn]
CN=localhost

[v3]
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=@alt

[alt]
${alt}
`)
  try {
    execFileSync('openssl', [
      'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-sha256', '-days', '825',
      '-config', configPath, '-keyout', keyPath, '-out', certPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    return true
  } catch (error) {
    const message = error?.stderr ? String(error.stderr).trim() : String(error?.message ?? error)
    console.warn(`[dev-cert] openssl 自签也失败了，开发服务器继续用 http：${message}`)
    return false
  } finally {
    if (existsSync(configPath)) rmSync(configPath, { force: true })
  }
}

function main() {
  const hosts = currentHosts()
  if (hasUsableCert(hosts)) {
    console.log(`[dev-cert] 证书已覆盖当前地址：${hosts.join(', ')}`)
    return
  }

  mkdirSync(certDir, { recursive: true })
  rmSync(keyPath, { force: true })
  rmSync(certPath, { force: true })

  const ok = tryMkcert(hosts) || tryOpenSSL(hosts)
  if (!ok) return
  writeFileSync(metaPath, JSON.stringify({ hosts, generatedAt: new Date().toISOString() }, null, 2))
  console.log(`[dev-cert] 开发证书已生成（${hosts.join(', ')}），vite 会以 https 启动。`)
}

main()
