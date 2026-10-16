import { access, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const requiredFiles = [
  'AGENTS.md',
  'README.md',
  'docs/README.md',
  'docs/architecture.md',
  'docs/frontend.md',
  'docs/backend.md',
  'docs/decisions/README.md',
  'docs/handoff.md',
  'src/App.tsx',
  'src/hooks/useTabRoute.ts',
  'worker/src/routes.js',
  'worker/schema.sql',
];
const absolutePathPattern = /(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/;
const textFiles = ['AGENTS.md', 'README.md', ...(await collectMarkdown('docs'))];
const missing = [];
const absolutePathReferences = [];

for (const file of requiredFiles) {
  try {
    await access(join(root, file));
  } catch {
    missing.push(file);
  }
}

for (const file of textFiles) {
  const content = await readFile(join(root, file), 'utf8');
  if (absolutePathPattern.test(content)) absolutePathReferences.push(file);
}

if (missing.length > 0 || absolutePathReferences.length > 0) {
  if (missing.length > 0) {
    console.error(`文档检查失败：缺少路径\n${missing.map((file) => `- ${file}`).join('\n')}`);
  }
  if (absolutePathReferences.length > 0) {
    console.error(`文档检查失败：包含本机绝对路径\n${absolutePathReferences.map((file) => `- ${file}`).join('\n')}`);
  }
  process.exitCode = 1;
} else {
  console.log(`文档检查通过：已检查 ${textFiles.length} 个 Markdown 文件和 ${requiredFiles.length} 个关键路径。`);
}

async function collectMarkdown(directory) {
  const result = [];
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await collectMarkdown(file));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(relative(root, file));
  }
  return result;
}
