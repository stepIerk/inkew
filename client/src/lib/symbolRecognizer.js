import * as ort from 'onnxruntime-web'

ort.env.wasm.numThreads = 1

const MODEL_URL = '/symbols.onnx'
const CLASSES_URL = '/classes.json'

let sessionPromise = null
let classesPromise = null

/**
 * Ленивая инициализация ONNX-сессии. Вызывать заранее (например, при
 * монтировании App), чтобы к моменту первого распознавания модель уже
 * была прогрета — сам вызов recognizeSymbol() тоже безопасен без
 * предварительного вызова, просто первый вызов будет чуть медленнее.
 */
export function loadModel() {
  if (!sessionPromise) {
    sessionPromise = ort.InferenceSession.create(MODEL_URL, {
      executionProviders: ['webgl', 'wasm'],
    })
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

// classes.json, сохранённый ноутбуком — это словарь {"0": "0", "1": "1", "2": "NS", ...}
// (индекс выхода модели -> label). Приводим к плотному массиву:
// indexToLabel[i] совпадает с idx_to_class[i] из ноутбука.
function normalizeClasses(raw) {
  if (Array.isArray(raw)) return raw
  return Object.entries(raw)
    .map(([idx, label]) => [Number(idx), label])
    .sort((a, b) => a[0] - b[0])
    .map(([, label]) => label)
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