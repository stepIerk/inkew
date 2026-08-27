// Копирует wasm-рантайм onnxruntime-web из node_modules в public/ort/,
// чтобы модель работала оффлайн/на проде без обращения к CDN и без риска
// рассинхронизации версий между JS-пакетом и wasm-бинарниками.
//
// Запускается автоматически через "postinstall" в package.json,
// либо вручную: node scripts/copy-onnx-wasm.mjs

import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const srcDir = join(__dirname, '..', 'node_modules', 'onnxruntime-web', 'dist')
const destDir = join(__dirname, '..', 'public', 'ort')

if (!existsSync(srcDir)) {
  console.warn('[copy-onnx-wasm] onnxruntime-web не найден в node_modules — пропускаю. Выполни "npm install" ещё раз.')
  process.exit(0)
}

mkdirSync(destDir, { recursive: true })

const files = readdirSync(srcDir).filter(
  (f) => f.endsWith('.wasm') || f.endsWith('.mjs')
)

for (const file of files) {
  copyFileSync(join(srcDir, file), join(destDir, file))
}

console.log(`[copy-onnx-wasm] Скопировано ${files.length} файлов рантайма в public/ort/`)