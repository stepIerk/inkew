import { appendFileSync, closeSync, openSync, readSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Файл-лог с примерами символов: дописывается, никогда не перезаписывается
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_FILE = path.join(__dirname, 'data.jsonl')

function symbolsDataPlugin() {
  return {
    name: 'symbols-data-jsonl',
    configureServer(server) {
      // Добавляем мини-бэкенд для дописывания данных в data.jsonl
      server.middlewares.use('/api/symbols', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }))
          return
        }

        let body = ''
        req.on('data', (chunk) => {
          body += chunk
        })

        req.on('end', () => {
          try {
            const data = JSON.parse(body)
            if (
              typeof data.strokesCount !== 'number' ||
              !Array.isArray(data.features) ||
              typeof data.label !== 'string' ||
              data.label.length === 0
            ) {
              res.statusCode = 400
              res.setHeader('Content-Type', 'application/json')
              res.end(
                JSON.stringify({
                  ok: false,
                  error: 'strokesCount, features и label обязательны',
                }),
              )
              return
            }

            // Дописываем строку в конец файла (файл не перезаписывается).
            // Если файл не заканчивается переводом строки — добавляем его,
            // иначе новая запись склеится с последней строкой и сломает JSONL.
            let record = JSON.stringify(data) + '\n'
            try {
              const stat = statSync(DATA_FILE)
              if (stat.size > 0) {
                const fd = openSync(DATA_FILE, 'r')
                const lastByte = new Uint8Array(1)
                readSync(fd, lastByte, 0, 1, stat.size - 1)
                closeSync(fd)
                if (lastByte[0] !== 0x0a) {
                  record = '\n' + record
                }
              }
            } catch {
              // файла ещё нет — просто создаём записью
            }
            appendFileSync(DATA_FILE, record, 'utf8')

            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, saved: data }))
          } catch (err) {
            res.statusCode = 400
            res.setHeader('Content-Type', 'application/json')
            res.end(
              JSON.stringify({
                ok: false,
                error: `Неверный JSON в запросе: ${err?.message ?? ''}`,
              }),
            )
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Репозиторий разворачивается на GitHub Pages:
  // https://stepierk.github.io/inkew/ — база нужна, чтобы ассеты
  // (JS/CSS/wasm) резолвились относительно подпапки репозитория.
  base: '/inkew/',
  plugins: [react(), symbolsDataPlugin()],
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  assetsInclude: ['**/*.wasm'],
})
