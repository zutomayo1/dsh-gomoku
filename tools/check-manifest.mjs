#!/usr/bin/env node
/**
 * 按 DSH 自己的规则校验两个包的"插件列表元数据"（图标 + 标题 + 描述）。
 *
 * 为什么需要它：插件列表里那一格图标**不是**一张静态图片，也不是一条路由。DSH 的
 * app-boot 在读每个插件的元数据时，把 `package.json` 的顶层 `icon` 字段**读成 bytes
 * 再内联成 data URL**（`data:image/svg+xml;base64,...`），客户端直接 `<img src>` 拿它。
 * 既然清单是数据、图标是 base64，那么这条路上任何一步出错都**不会有构建报错**，
 * 只会安静地退化成通用占位图。所以这些约束必须被测出来：
 *
 *   1. `icon` 必须是**相对路径**（绝对路径、`data:`、任何带 scheme 的写法都会被拒）
 *   2. 扩展名必须是 .svg / .png / .jpg / .jpeg / .webp
 *   3. realpath 之后必须仍在清单所在目录内（相对安装目录的符号链接也要能通过）
 *   4. 必须是普通文件，且 **≤ 256 KiB**（原始字节）
 *   5. `<包>/package.json` 必须能从 exports 里解析出来 —— 否则标题、描述、图标**一起**消失
 *   6. 本地化文件必须是 `<包>/locale/<语言>.json`，且从 exports 导出，形状为
 *      `{ "meta": { "title": ..., "description": ... } }`
 *
 * 校验方式是从 `app-boot` 的 `iconOf` / `readPluginMeta` / `dictionariesOf` 抄下来的，
 * 不是凭印象写的。
 *
 * 用法：node tools/check-manifest.mjs
 */
import { readFileSync, existsSync, statSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = ['dsh-gomoku-host', 'dsh-gomoku-client'];

// —— 抄自 app-boot 的常量 ——
const MAX_ICON_BYTES = 256 * 1024;
const ICON_MEDIA_TYPES = new Map([
	['.svg', 'image/svg+xml'],
	['.png', 'image/png'],
	['.jpg', 'image/jpeg'],
	['.jpeg', 'image/jpeg'],
	['.webp', 'image/webp'],
]);
/** app-boot 用的语言 id 正则（LANGUAGE_ID）。 */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

let checks = 0;
let failures = 0;
function check(label, ok, detail) {
	checks++;
	console.log(`${ok ? '  ✔' : '  ✘'} ${label}${detail === undefined ? '' : `  — ${detail}`}`);
	if (!ok) failures++;
}

/** 等价于 app-boot 的 iconOf。抛错即代表宿主会拒绝这个图标。 */
function iconOf(icon, packageDir) {
	if (isAbsolute(icon) || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon)) {
		throw new Error('icon must be a relative file path');
	}
	const mediaType = ICON_MEDIA_TYPES.get(extname(icon).toLowerCase());
	if (mediaType === undefined) throw new Error('icon must be SVG, PNG, JPEG, or WebP');
	const directory = realpathSync(packageDir);
	const file = realpathSync(resolve(directory, icon));
	const local = relative(directory, file);
	if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) {
		throw new Error('icon must remain inside its manifest directory');
	}
	const stat = statSync(file);
	if (!stat.isFile()) throw new Error('icon must be a regular file');
	if (stat.size > MAX_ICON_BYTES) throw new Error('icon exceeds 256 KiB');
	const bytes = readFileSync(file);
	if (bytes.length > MAX_ICON_BYTES) throw new Error('icon exceeds 256 KiB');
	return { mediaType, bytes, file };
}

console.log(`检查目录：${ROOT}\n`);

for (const name of PACKAGES) {
	const dir = join(ROOT, name);
	console.log(`${name}`);
	const manifestPath = join(dir, 'package.json');
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

	check('package.json 有非空 description', typeof manifest.description === 'string' && manifest.description.trim() !== '');
	check('exports 导出了 ./package.json（元数据读取的前提）', Object.keys(manifest.exports ?? {}).includes('./package.json'));

	// 1-4：图标
	let icon = null;
	try {
		icon = iconOf(manifest.icon ?? '', dir);
		check(`icon = ${JSON.stringify(manifest.icon)} 通过 iconOf（相对路径 / 扩展名 / 目录内 / ≤256KiB）`, true);
		check(`解析为 ${icon.mediaType}，${icon.bytes.length} 字节`, icon.bytes.length > 0);
	} catch (error) {
		check('icon 通过 iconOf', false, String(error.message));
	}
	if (icon !== null) {
		const text = icon.bytes.toString('utf8');
		check('图标里没有 <script>（它是 data URL，在 <img> 里执行不了）', !/<script/i.test(text));
		check(
			'图标不引用外部资源（除 xmlns 外没有 http(s)://）',
			!/https?:\/\/(?!www\.w3\.org\/2000\/svg)/i.test(text),
			(text.match(/https?:\/\/[^\s"']+/gi) ?? []).join(' '),
		);
	}

	// 5：图标文件也在 files 里（npm 打包时不会漏）
	if (typeof manifest.icon === 'string') {
		const iconRel = manifest.icon.replace(/^\.\//, '');
		check('icon 列在 files 里（发布时不会漏）', (manifest.files ?? []).includes(iconRel), iconRel);
	}

	// 6：本地化
	const localeDir = join(dir, 'locale');
	const hasLocale = existsSync(localeDir);
	const exportsLocale = Object.keys(manifest.exports ?? {}).includes('./locale/*.json');
	if (!hasLocale) {
		check('没有 locale/ 目录（标题与描述会用 package.json 兜底）', true);
	} else {
		check('有 locale/ 时必须导出 ./locale/*.json，否则整份字典都读不到', exportsLocale);
		check('locale/*.json 列在 files 里', (manifest.files ?? []).includes('locale/*.json'));
		const files = readdirSync(localeDir).filter((f) => f.endsWith('.json'));
		check('locale/ 里有 en.json（英文是字典的锚点）', files.includes('en.json'));
		for (const file of files) {
			const language = file.slice(0, -5);
			check(`locale/${file} 的文件名是合法语言 id`, LANGUAGE_ID.test(language), language);
			const parsed = JSON.parse(readFileSync(join(localeDir, file), 'utf8'));
			const meta = parsed.meta;
			check(`locale/${file} 有 meta.title（非空字符串）`, typeof meta?.title === 'string' && meta.title.trim() !== '');
			check(`locale/${file} 有 meta.description（非空字符串）`, typeof meta?.description === 'string' && meta.description.trim() !== '');
		}
	}
	console.log('');
}

// 两个半侧的图标必须一致：同一件东西，不该有两个看着像没关系的样子
const icons = PACKAGES.map((n) => readFileSync(join(ROOT, n, 'icon.svg'), 'utf8'));
check('两个包的 icon.svg 完全一致（同一件东西，一个标志）', icons[0] === icons[1]);

console.log(`\n${checks} 项检查，${failures} 项失败。`);
if (failures > 0) process.exitCode = 1;
