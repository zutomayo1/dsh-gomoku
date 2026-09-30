/**
 * 生成单文件、零导入的 `lib/index.js`（Host 半侧）。
 *
 * ## 为什么必须单文件零导入
 *
 * 本插件以**符号链接**装进 profile。相对导入（`./engine.js`）经 symlink 解析后
 * 落在 profile 包表之外，会被 DSH 的模块解析拦截层拒绝——表现为插件在
 * `install_bundle` 时可用（直接 import file:// URL，绕过拦截层），**启动时激活
 * 失败并挡住整个 Web 启动**。
 *
 * 这台机器上长期稳定的插件（`dsh-plugin-account-balance`）正是单文件、零导入的
 * 形态。本脚本用同样的形态交付。
 *
 * ## 但源码仍然分成三个正常的 ES 模块
 *
 * `src/engine.js`（规则）、`src/ai.js`（棋力）、`src/host.js`（服务与路由）之间
 * 用正常的 `import ... from './x.js'` 互相引用——这样它们各自都能被 node 直接
 * 单测。构建脚本负责把这些**相对导入行剥掉**再拼接，于是源码可读、产物可用。
 *
 * ## 用法
 *
 *     node tools/build.mjs
 *
 * 产物：`lib/index.js`（单文件、零静态导入）。
 * **不要手工编辑产物**——改 `src/` 下的源码然后重新构建。
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = join(ROOT, 'lib', 'index.js');

/**
 * 按依赖顺序内联：规则内核 → 棋力内核 → 宿主半侧。
 *
 * `internal: true` 的模块只被兄弟模块使用，它们的 `export` 要剥掉（内联后同一
 * 作用域里的普通声明）；**宿主半侧必须保留 `export`**——那正是产物对外的
 * `apply` / `name` / `inject` / `GOMOKU_PATH`。
 */
const SOURCES = [
  { file: 'src/engine.js', label: '规则内核', internal: true },
  { file: 'src/ai.js', label: '棋力内核', internal: true },
  { file: 'src/host.js', label: '宿主半侧', internal: false },
];

/**
 * 去掉 `export ` 前缀，让被内联的声明成为文件内的普通声明。
 * @param {string} text - 源码。
 * @returns {string} 去掉导出关键字后的源码。
 */
function stripExports(text) {
  return text.replace(/^export\s+(const|function|class|let|var)\s/gm, '$1 ');
}

/**
 * 剥掉**相对**导入行（`import ... from './x.js';`）。
 *
 * 内联之后这些名字已经在同一文件作用域里，留着会变成重复声明，而且产物必须零导入。
 * 支持跨行写法。剥不掉的（比如裸包名导入）会留给下面的断言报错——因为裸包名导入
 * 在符号链接环境里本来就是不允许的。
 * @param {string} text - 源码。
 * @returns {string} 剥掉相对导入后的源码。
 */
function stripRelativeImports(text) {
  // 单行：import { a, b } from './x.js';
  // 跨行：import {\n a,\n b\n} from './x.js';
  return text.replace(/^import\s+(?:[^;]*?)\s+from\s+['"]\.\/[^'"]+['"];?[ \t]*$/gm, '');
}

/**
 * 校验内联后的代码里没有残留的导入语句。
 * @param {string} text - 源码。
 * @param {string} label - 用于报错的位置说明。
 * @returns {void}
 */
function assertNoImports(text, label) {
  const matches = text.match(/^\s*import\s.+$/gm) ?? [];
  if (matches.length > 0) {
    throw new Error(`${label} 含 ${matches.length} 处导入，无法内联：\n${matches.join('\n')}`);
  }
}

const chunks = [];
for (const source of SOURCES) {
  const text = await readFile(join(ROOT, source.file), 'utf8');
  const stripped = stripRelativeImports(text);
  assertNoImports(stripped, source.file);
  chunks.push({ ...source, text: stripped });
}

const body = chunks
  .map((chunk) => {
    const text = chunk.internal ? stripExports(chunk.text) : chunk.text;
    return `// #region ${chunk.label}（内联自 ${chunk.file}）\n\n${text.trim()}\n\n// #endregion`;
  })
  .join('\n\n');

const banner = `/**
 * 五子棋插件（Host 半侧）——**单文件、零导入**。
 *
 * ⚠️ 本文件由 \`tools/build.mjs\` 从 src/engine.js + src/ai.js + src/host.js 生成，
 * 请勿手工编辑。
 *
 * 为什么必须如此：本插件以符号链接装进 profile，相对导入会经 symlink 落到
 * profile 包表之外而被解析拦截层拒绝；而"取不到服务就 return"又会让 fiber
 * 立即 active 却什么都没注册，被宿主判为 did not activate 并挡住整个 Web 启动。
 * 因此本文件：零静态导入、依赖经 \`ctx.inject\` 在就绪后注册。
 *
 * 本包**刻意不含 \`dsh.client\`**：实测（A/B/C 对照）只要 package.json 里出现该
 * 字段，宿主半侧就不会激活（工具与路由全部 404）。浏览器半侧因此拆到独立的
 * \`dsh-gomoku-client\` 包里。
 */

${body}
`;

await writeFile(OUT, banner, 'utf8');

const written = await readFile(OUT, 'utf8');
const staticImports = written.match(/^\s*import\s/gm) ?? [];
const relativeImports = written.match(/from\s+['"]\.\//g) ?? [];

console.log(`已生成 ${OUT}`);
console.log(`  字节数            : ${Buffer.byteLength(written, 'utf8')}`);
console.log(`  静态 import       : ${staticImports.length}（必须为 0）`);
console.log(`  相对导入          : ${relativeImports.length}（必须为 0）`);

if (staticImports.length !== 0 || relativeImports.length !== 0) {
  throw new Error('生成结果仍含导入，失败');
}
