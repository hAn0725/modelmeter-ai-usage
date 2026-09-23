// 图标生成脚本：把 resources/modelmeter-icon.svg 矢量导出为 PNG（多尺寸）。
// 用法: node scripts/generate-icons.mjs
// 输出: resources/modelmeter-icon.png（256×256，Marketplace 用）
//       以及可选 --verify 目录（32/64/128/256 供人工检查）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { Resvg } = require('@resvg/resvg-js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = readFileSync(path.join(root, 'resources', 'modelmeter-icon.svg'), 'utf8');

function render(size) {
	const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
	return resvg.render().asPng();
}

// Marketplace / VSIX 主图标（256×256）
writeFileSync(path.join(root, 'resources', 'modelmeter-icon.png'), render(256));

// 可选：验证集（不进入发布物约定路径，仅用于视觉检查）
const verifyDir = process.argv[2];
if (verifyDir) {
	mkdirSync(verifyDir, { recursive: true });
	for (const size of [32, 64, 128, 256]) {
		writeFileSync(path.join(verifyDir, `modelmeter-icon-${size}.png`), render(size));
	}
	console.log('verify renders written to ' + verifyDir);
}
console.log('wrote resources/modelmeter-icon.png (256x256)');
