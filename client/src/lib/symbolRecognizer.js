import * as ort from 'onnxruntime-web'

ort.env.wasm.numThreads = 1

// BASE_URL учитывает base из vite.config.js (например, '/inkew/' на GitHub
// Pages): абсолютные пути вида '/symbols.onnx' ломаются на сайтах, живущих
// в подпапке домена, — fetch уходил в корень и получал 404.
const BASE_URL = import.meta.env.BASE_URL || '/'
const MODEL_URL = `${BASE_URL}symbols.onnx`
// Когда torch.onnx.export / onnx.save_model сохраняют модель во «внешнем» формате,
// веса лежат отдельным файлом рядом: symbols.onnx.data. Если такого файла нет —
// модель однострочная, и всё работает как раньше.
const DATA_URL = `${MODEL_URL}.data`
const CLASSES_URL = `${BASE_URL}classes.json`

let sessionPromise = null
let classesPromise = null

/** fetch файла; возвращает ArrayBuffer либо null (404 / сетевая ошибка). */
async function tryFetchBuffer(url) {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.arrayBuffer()
  } catch {
    return null
  }
}

/**
 * Ленивая инициализация ONNX-сессии. Вызывать заранее (например, при
 * монтировании App), чтобы к моменту первого распознавания модель уже
 * была прогрета — сам вызов recognizeSymbol() тоже безопасен без
 * предварительного вызова, просто первый вызов будет чуть медленнее.
 */
export function loadModel() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const modelBuffer = await tryFetchBuffer(MODEL_URL)
      if (!modelBuffer) {
        throw new Error(`Не удалось загрузить модель: ${MODEL_URL}`)
      }

      const options = {
        executionProviders: ['webgl', 'wasm'],
      }

      try {
        // Самый частый случай — модель уже однострочная (self-contained).
        return await ort.InferenceSession.create(modelBuffer, options)
      } catch (err) {
        const msg = err?.message ?? ''
        const externalDataProblem = /external data|MountedFiles|deserialize tensor|\.data"/i.test(msg)
        if (!externalDataProblem) throw err

        // Внешний формат: веса лежат рядом в symbols.onnx.data, но в браузере
        // onnxruntime-web не подхватывает их по URL (в отличие от Node.js) —
        // отдаём файл в память через опцию externalData.
        const externalDataBuffer = await tryFetchBuffer(DATA_URL)
        if (externalDataBuffer) {
          return await ort.InferenceSession.create(modelBuffer, {
            ...options,
            externalData: [{ path: 'symbols.onnx.data', data: externalDataBuffer }],
          })
        }

        throw new Error(
          `Модель "${MODEL_URL}" сохранена во внешнем формате: веса лежат в отдельном файле "${DATA_URL}", но он не найден. ` +
            'Положите symbols.onnx.data рядом с моделью в public/ или пере-экспортируйте модель в один файл.',
          { cause: err },
        )
      }
    })()
  }
  return sessionPromise
}

export function loadClasses() {
  if (!classesPromise) {
    classesPromise = fetch(CLASSES_URL).then((res) => {
      if (!res.ok) {
        throw new Error(`Не удалось загрузить ${CLASSES_URL}: ${res.status}`)
      }
      return res.json()
    })
  }
  return classesPromise
}

function sortDictToArray(dict) {
  return Object.entries(dict)
    .map(([idx, label]) => [Number(idx), label])
    .sort((a, b) => a[0] - b[0])
    .map(([, label]) => label)
}

// classes.json ноутбук сохраняет в виде:
//   { "classes": ["0","1","2","NS"], "idx_to_class": {"0": "0", ...}, ... }
// (индекс выхода модели -> label). Приводим к плотному массиву:
// indexToLabel[i] совпадает с idx_to_class[i] из ноутбука.
function normalizeClasses(raw) {
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.classes)) return raw.classes
  if (raw && raw.idx_to_class) return sortDictToArray(raw.idx_to_class)
  return sortDictToArray(raw)
}

function softmax(logits) {
  const max = Math.max(...logits)
  const exps = logits.map((v) => Math.exp(v - max))
  const sum = exps.reduce((a, b) => a + b, 0)
  return exps.map((v) => v / sum)
}

/**
 * Собирает плоский input-тензор [1, numPoints*2 + 1], в точности как
 * sample_to_input() в ноутбуке:
 *   [x0, y0, x1, y1, ..., x(n-1), y(n-1), strokeFeature]
 * где strokeFeature = clamp(strokesCount, 1, 8) / 8.
 *
 * points — уже нормализованные точки (после normalizePoints() в App.jsx),
 * т.е. центр bbox в (0,0), масштаб — по большей стороне.
 */
export function buildInputTensor(points, strokesCount, numPoints = 64) {
  const data = new Float32Array(numPoints * 2 + 1)

  for (let i = 0; i < numPoints; i++) {
    const p = points[i] ?? { x: 0, y: 0 }
    data[i * 2] = p.x
    data[i * 2 + 1] = p.y
  }

  const strokeFeature = Math.min(Math.max(strokesCount, 1), 8) / 8
  data[numPoints * 2] = strokeFeature

  return new ort.Tensor('float32', data, [1, numPoints * 2 + 1])
}

/**
 * Та же логика, что в ноутбуке (секция "14. Порог NS" / predict_with_ns):
 * top-1 принимается только если его уверенность выше confidenceThreshold
 * И разрыв (margin) с top-2 не меньше marginThreshold. Иначе результат — NS.
 */
export function applyNsThreshold(probs, labels, {
  confidenceThreshold = 0.8,
  marginThreshold = 0.2,
  nsLabel = 'NS',
} = {}) {
  const order = probs
    .map((p, i) => [p, i])
    .sort((a, b) => b[0] - a[0])

  const [p1, idx1] = order[0]
  const [p2, idx2] = order[1] ?? order[0]

  const top1Label = labels[idx1]
  const top2Label = labels[idx2]
  const margin = p1 - p2

  let predicted = top1Label
  if (predicted !== nsLabel) {
    if (p1 < confidenceThreshold || margin < marginThreshold) {
      predicted = nsLabel
    }
  }

  return {
    label: predicted,
    top1: top1Label,
    confidence: p1,
    top2: top2Label,
    top2Confidence: p2,
    margin,
  }
}

/**
 * Полный пайплайн распознавания одного символа.
 *
 * @param {{x:number,y:number}[]} points — нормализованные точки (длина = numPoints)
 * @param {number} strokesCount — сколько отдельных штрихов образуют символ
 * @param {object} [options]
 * @param {number} [options.numPoints=64]
 * @param {number} [options.confidenceThreshold=0.8]
 * @param {number} [options.marginThreshold=0.2]
 * @param {string} [options.nsLabel='NS']
 * @returns {Promise<{label:string, top1:string, confidence:number, top2:string, top2Confidence:number, margin:number}>}
 */
export async function recognizeSymbol(points, strokesCount, options = {}) {
  const [session, rawClasses] = await Promise.all([loadModel(), loadClasses()])
  const labels = normalizeClasses(rawClasses)

  const inputTensor = buildInputTensor(points, strokesCount, options.numPoints ?? 64)

  const inputName = session.inputNames[0]
  const outputName = session.outputNames[0]

  const results = await session.run({ [inputName]: inputTensor })
  const logits = Array.from(results[outputName].data)
  const probs = softmax(logits)

  return applyNsThreshold(probs, labels, options)
}