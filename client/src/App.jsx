import { useEffect, useRef, useState } from 'react'
import { Layer, Line as KonvaLine, Rect, Stage, Circle, Text as KonvaText } from 'react-konva'
import './App.css'
import { loadModel, loadClasses, recognizeSymbol } from './lib/symbolRecognizer'

// === ГЛОБАЛЬНЫЕ НАСТРОЙКИ СЕГМЕНТАЦИИ И РАСПОЗНАВАНИЯ ===
const CONFIG = {
  RECOGNITION_TIMEOUT_MS: 450, // Предельное время (в мс) ожидания до завершения символа
  MARGIN_X: 10,                // Допустимый отступ по оси X (в px) для объединения штрихов в один символ
  MARGIN_Y: 40,                // Допустимый отступ по оси Y (в px). (Сделан больше, чтобы не разрывать знак "=")
  POINTS_COUNT: 64,            // Количество ключевых точек для ML-модели
  LABELS_LIST: ['0', '1', '2', '3', 'NS'], // Символы для выбора метки (сбор датасета)

  // Пороги распознавания — совпадают с "14. Порог NS" в ноутбуке.
  CONFIDENCE_THRESHOLD: 0.8,   // минимальная уверенность top-1, чтобы принять предсказание
  MARGIN_THRESHOLD: 0.2,       // минимальный разрыв между top-1 и top-2
  NS_LABEL: 'NS',

  // Как вписывать распознанный текст в bbox исходного рисунка.
  TEXT_SIZE_FACTOR: 1.0,       // fontSize = max(bboxWidth, bboxHeight) * TEXT_SIZE_FACTOR
  TEXT_PADDING_RATIO: 0.12,    // доп. отступ вокруг bbox (доля от размера символа)
}

const COLORS = [
  '#000000',
  '#e03131',
  '#ff8a3d', // Акцентный оранжевый
  '#F26419', // Глубокий оранжевый
  '#f5b400',
  '#40c057',
  '#1098ad',
  '#1b7ef5',
  '#7048e8',
  '#ffffff',
]

let lineId = 0

// === РЕЖИМЫ РАБОТЫ ===
const MODES = [
  { id: 'normal', label: '✏️ Рисование' }, // модель отключена — просто рисуем
  { id: 'smart', label: '🧠 Умный' },      // модель включена — штрихи заменяются текстом
  { id: 'train', label: '🎓 Обучение' },   // сбор датасета: метка → рисунок → подтверждение
]

// === КУДА ОТПРАВЛЯТЬ ПРИМЕРЫ ИЗ УЧЕБНОГО РЕЖИМА ===
// Google Apps Script Web App → Google Sheets (без бэкэнда — страница может
// жить на GitHub Pages). Как настроить и получить URL: см. инструкции в
// client/scripts/apps-script-dataset.js и client/README.md.
// Пустая строка = локальная разработка: POST /api/symbols — Vite-middleware
// дописывает строку в client/data.jsonl.
const DATASET_ENDPOINT = 'https://script.google.com/macros/s/AKfycbwahEITPFx4uGpS_5NpANnBWZaYOacuW2h2bjTkEpN2PtWs0FLK9gyX_rr6i0QgMff9Pw/exec'
//https://docs.google.com/spreadsheets/d/1P1kb8aPGgxlozL_KDCqOImTNqQquh7DjbkKOZdJHrGM/edit
// Ключ localStorage-очереди: примеры, не ушедшие в сеть (нет интернета на
// телефоне), досылаются при следующем открытии страницы.
const DATASET_QUEUE_KEY = 'inkew:dataset-queue'

// === ХЕЛПЕРЫ ДЛЯ ПОДГОТОВКИ ДАННЫХ ===

function getStrokesBBox(strokes) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const stroke of strokes) {
    for (let i = 0; i < stroke.points.length; i += 2) {
      const x = stroke.points[i]
      const y = stroke.points[i + 1]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  return { minX, maxX, minY, maxY }
}

function resampleStrokes(strokes, n = 64) {
  let allPoints = []

  strokes.forEach((stroke) => {
    let pts = stroke.points
    let strokeArr = []
    for (let i = 0; i < pts.length; i += 2) {
      strokeArr.push({ x: pts[i], y: pts[i + 1] })
    }
    if (strokeArr.length > 0) {
      allPoints.push(strokeArr)
    }
  })

  if (allPoints.length === 0) return Array(n).fill({ x: 0, y: 0 })

  let totalLength = 0
  allPoints.forEach((arr) => {
    for (let i = 1; i < arr.length; i++) {
      totalLength += Math.hypot(arr[i].x - arr[i - 1].x, arr[i].y - arr[i - 1].y)
    }
  })

  if (totalLength === 0) {
    return Array(n).fill(allPoints[0][0])
  }

  let interval = totalLength / (n - 1)
  let resampled = []
  resampled.push(allPoints[0][0])

  let currentDistance = 0
  let nextDistance = interval

  for (let s = 0; s < allPoints.length; s++) {
    let path = allPoints[s]
    for (let i = 1; i < path.length; i++) {
      let p1 = path[i - 1]
      let p2 = path[i]
      let d = Math.hypot(p2.x - p1.x, p2.y - p1.y)

      while (currentDistance + d >= nextDistance) {
        let ratio = d === 0 ? 0 : (nextDistance - currentDistance) / d
        let qx = p1.x + ratio * (p2.x - p1.x)
        let qy = p1.y + ratio * (p2.y - p1.y)
        resampled.push({ x: qx, y: qy })
        nextDistance += interval
      }
      currentDistance += d
    }
  }

  while (resampled.length < n) {
    let lastPath = allPoints[allPoints.length - 1]
    resampled.push(lastPath[lastPath.length - 1])
  }

  return resampled.slice(0, n)
}

function normalizePoints(points) {
  if (!points || points.length === 0) return points
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity

  points.forEach(p => {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  })

  let width = maxX - minX
  let height = maxY - minY
  let cx = minX + width / 2
  let cy = minY + height / 2

  let scale = Math.max(width, height) / 2
  if (scale === 0) scale = 1

  return points.map(p => ({
    x: (p.x - cx) / scale,
    y: (p.y - cy) / scale
  }))
}

function getWindowSize() {
  return { width: window.innerWidth, height: window.innerHeight }
}

// Измерение ширины глифа тем же способом, что и в Konva (canvas measureText).
// Нужна, чтобы текстовый бокс всегда был не уже самого символа: при
// фиксированной width, если ни один символ строки не влезает в бокс, Konva
// не добавляет строку в textArr вовсе (см. Text.js::_setTextData) и текст
// просто не рисуется — именно из-за этого «исчезала» тонкая «1» и узкий «0».
const measureCtx = document
  .createElement('canvas')
  .getContext('2d')

function measureCharWidth(char, fontSize, fontFamily = 'sans-serif') {
  if (!measureCtx) return fontSize * 0.6
  measureCtx.font = `${fontSize}px ${fontFamily}`
  return measureCtx.measureText(char).width
}

// === Отправка примеров в датасет (модульные функции — не зависят от React) ===
// Пример всегда попадает в localStorage-очередь и сразу пытается уйти в сеть.
// Если сеть недоступна (телефон в метро и т.п.) — пример остаётся в очереди
// и досылается при следующем открытии страницы.

function readQueue() {
  try {
    const raw = localStorage.getItem(DATASET_QUEUE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeQueue(queue) {
  try {
    localStorage.setItem(DATASET_QUEUE_KEY, JSON.stringify(queue))
  } catch (err) {
    console.error('Не удалось записать очередь примеров:', err)
  }
}

// Добавляет пример в очередь. Возвращает новый размер очереди.
function enqueueToQueue(data) {
  const queue = readQueue()
  queue.push({ ...data, createdAt: new Date().toISOString() })
  writeQueue(queue)
  return queue.length
}

async function sendExample(data) {
  if (DATASET_ENDPOINT) {
    const body = JSON.stringify(data)

    // Шаг 1: обычный CORS-запрос. Apps Script при доступе «все (даже
    // анонимные)» отдаёт читаемый JSON-ответ — если doPost вернул ошибку,
    // мы увидим её текст в интерфейсе, а не гадаем по пустой таблице.
    try {
      const res = await fetch(DATASET_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body,
      })
      const result = await res.json().catch(() => null)
      if (result && result.ok === false) {
        throw new Error(`Apps Script: ${result.error || 'неизвестная ошибка'}`)
      }
      return
    } catch (err) {
      // Шаг 2: если CORS заблокировал запрос (TypeError от браузера) —
      // отправляем непрозрачным no-cors запросом (доставка без чтения ответа).
      if (err instanceof TypeError) {
        await fetch(DATASET_ENDPOINT, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body,
        })
        return
      }
      throw err
    }
  }

  // Локальная разработка (DATASET_ENDPOINT пуст): Vite-middleware дописывает
  // строку в data.jsonl. Когда endpoint задан, этот путь не используется.
  const response = await fetch('/api/symbols', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}))
    throw new Error(errData?.error || `Ошибка сервера: ${response.status}`)
  }
}

// Пытается отправить все накопленные примеры.
// Возвращает { delivered, remaining } — сколько ушло и сколько осталось.
async function flushQueueToNetwork() {
  const queue = readQueue()
  if (queue.length === 0) return { delivered: 0, remaining: 0 }

  const remaining = []
  let delivered = 0
  for (const item of queue) {
    try {
      await sendExample(item)
      delivered += 1
    } catch (err) {
      console.error('Не удалось отправить пример, остаётся в очереди:', err)
      remaining.push(item)
    }
  }

  if (delivered > 0) {
    writeQueue(remaining)
  }
  return { delivered, remaining: remaining.length }
}

function App() {
  const [size, setSize] = useState(getWindowSize)
  useEffect(() => {
    const onResize = () => setSize(getWindowSize())
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const [lines, setLines] = useState([])
  const [texts, setTexts] = useState([])       // распознанные символы, отрисованные как Konva.Text
  const [history, setHistory] = useState([])   // снапшоты { lines, texts } для undo
  const [tool, setTool] = useState('pen')
  const [penColor, setPenColor] = useState('#000000')
  const [brushSize, setBrushSize] = useState(6)

  const [previewData, setPreviewData] = useState(null) // точки символа для debug-окна (учебный режим)
  const [selectedLabel, setSelectedLabel] = useState(null)
  const [savedCount, setSavedCount] = useState(0)
  const [queuedCount, setQueuedCount] = useState(() => readQueue().length)
  const [saveError, setSaveError] = useState('')

  // === Режим работы: 'normal' | 'smart' | 'train' ===
  const [mode, setMode] = useState('normal')

  // === Пример, ожидающий подтверждения в учебном режиме ===
  // Рисование блокируется, пока пользователь не нажмёт «Отправить» или «Отменить».
  const [pendingExample, setPendingExample] = useState(null)

  // === Состояние модели распознавания ===
  // 'idle' — ещё не загружалась (ленивая загрузка при входе в smart/train)
  const [modelStatus, setModelStatus] = useState('idle') // 'idle' | 'loading' | 'ready' | 'error'
  const [modelError, setModelError] = useState('')
  const [lastRecognition, setLastRecognition] = useState(null)

  const drawingRef = useRef(null)
  const symbolBufferRef = useRef([])
  const recognitionTimeoutRef = useRef(null)
  const selectedLabelRef = useRef(null)
  const pendingExampleRef = useRef(null)

  // Зеркалим mode/pendingExample в ref, чтобы обработчики указателя и
  // асинхронные колбэки всегда видели актуальные значения.
  const modeRef = useRef(mode)
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { pendingExampleRef.current = pendingExample }, [pendingExample])

  // Зеркалим lines/texts в ref, чтобы асинхронное распознавание (которое
  // завершается спустя RECOGNITION_TIMEOUT_MS + время инференса) всегда
  // видело актуальное состояние канваса, а не значение на момент запуска.
  const linesRef = useRef([])
  const textsRef = useRef([])
  useEffect(() => { linesRef.current = lines }, [lines])
  useEffect(() => { textsRef.current = texts }, [texts])

  // Держим актуальную выбранную метку в ref, чтобы распознавание всегда
  // использовало последний выбранный символ (даже если он сменился за 450 мс таймаута)
  useEffect(() => {
    selectedLabelRef.current = selectedLabel
  }, [selectedLabel])

  // Модель грузим лениво: только при первом входе в smart/train — чтобы в
  // обычном режиме (особенно с телефона) не качать ~28 МБ wasm зря.
  const modelLoadingRef = useRef(false)
  useEffect(() => {
    if (mode !== 'smart' && mode !== 'train') return undefined
    if (modelLoadingRef.current) return undefined
    modelLoadingRef.current = true

    let cancelled = false
    setModelStatus('loading')
    Promise.all([loadModel(), loadClasses()])
      .then(() => {
        if (!cancelled) setModelStatus('ready')
      })
      .catch((err) => {
        console.error('Не удалось загрузить модель распознавания:', err)
        if (!cancelled) {
          setModelStatus('error')
          setModelError(err?.message || 'Неизвестная ошибка загрузки модели')
        }
      })
    return () => { cancelled = true }
  }, [mode])

  // При старте досылаем примеры, накопленные во время прошлых сессий без
  // интернета. Текущий размер очереди уже учтён в начальном queuedCount.
  useEffect(() => {
    let cancelled = false
    flushQueueToNetwork()
      .then(({ delivered, remaining }) => {
        if (cancelled) return
        if (delivered > 0) {
          setSavedCount((count) => count + delivered)
        }
        setQueuedCount(remaining)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Смена режима: сбрасываем незавершённые процессы (ожидающий таймаут
  // распознавания, пример на подтверждении, буфер штрихов). Метка актуальна
  // только в учебном режиме — в остальных сбрасываем её. Сброс делаем в
  // обработчике клика (а не в эффекте), чтобы не гонять лишние рендеры.
  function applyMode(next) {
    if (next === modeRef.current) return
    if (recognitionTimeoutRef.current) {
      clearTimeout(recognitionTimeoutRef.current)
      recognitionTimeoutRef.current = null
    }
    symbolBufferRef.current = []
    setPendingExample(null)
    setPreviewData(null)
    if (next !== 'train') {
      setSelectedLabel(null)
    }
    setMode(next)
  }

  const isPen = tool === 'pen'

  function getPointerPos(e) {
    const pos = e.target?.getStage?.().getPointerPosition?.()
    if (!pos) return null
    return { x: pos.x, y: pos.y }
  }

  // === Отправка примеров в датасет ===
  // Сама работа с очередью — в модульных функциях (readQueue / enqueueToQueue /
  // flushQueueToNetwork), здесь только синхронизация с состоянием интерфейса.

  async function flushQueue() {
    const { delivered, remaining } = await flushQueueToNetwork()
    if (delivered > 0) {
      setSavedCount((count) => count + delivered)
    }
    setQueuedCount(remaining)
  }

  async function submitExample(data) {
    setQueuedCount(enqueueToQueue(data))
    setSaveError('')
    try {
      await flushQueue()
    } catch (err) {
      setSaveError(err?.message || 'Не удалось отправить пример — он сохранён в очереди')
    }
  }

  // Заменяет штрихи (по их id) распознанным текстом, вписанным в bbox
  // исходного рисунка. Сохраняет снапшот для undo.
  function replaceStrokesWithText(strokeIds, bbox, char, color) {
    setHistory((h) => [...h, { lines: linesRef.current, texts: textsRef.current }])

    setLines((ls) => ls.filter((l) => !strokeIds.includes(l.id)))

    const width = bbox.maxX - bbox.minX
    const height = bbox.maxY - bbox.minY
    const size = Math.max(width, height, 1)
    const pad = size * CONFIG.TEXT_PADDING_RATIO
    const fontSize = size * CONFIG.TEXT_SIZE_FACTOR

    // Бокс должен вмещать сам глиф: для тонкой «1» (ширина bbox ≈ 0) или
    // узкого «0» ширины bbox + паддинги недостаточно, и Konva не отрисует
    // текст (см. комментарий к measureCharWidth). Расширяем бокс до ширины
    // глифа, сохраняя центр исходного bbox, чтобы символ встал на место рисунка.
    const charWidth = measureCharWidth(char, fontSize)
    const boxWidth = Math.max(width + pad * 2, charWidth + pad * 2)
    const centerX = bbox.minX + width / 2

    setTexts((ts) => [
      ...ts,
      {
        id: lineId++,
        char,
        x: centerX - boxWidth / 2,
        y: bbox.minY - pad,
        width: boxWidth,
        height: height + pad * 2,
        fontSize,
        color,
      },
    ])
  }

  // Прогоняет распознанный символ через модель. В умном режиме при высокой
  // уверенности (CONFIDENCE_THRESHOLD / MARGIN_THRESHOLD) заменяет рисунок
  // текстом. В учебном режиме прогноз — только подсказка в панели
  // распознавания (видно, угадывает ли модель размечаемые примеры).
  async function runRecognition({ strokeIds, bbox, normalizedPoints, strokesCount, color }) {
    if (modelStatus !== 'ready') return

    try {
      const result = await recognizeSymbol(normalizedPoints, strokesCount, {
        confidenceThreshold: CONFIG.CONFIDENCE_THRESHOLD,
        marginThreshold: CONFIG.MARGIN_THRESHOLD,
        nsLabel: CONFIG.NS_LABEL,
      })

      setLastRecognition(result)

      // Автозамена рисунка текстом — только в умном режиме
      if (modeRef.current === 'smart' && result.label !== CONFIG.NS_LABEL) {
        replaceStrokesWithText(strokeIds, bbox, result.label, color)
      }
    } catch (err) {
      console.error('Ошибка распознавания символа:', err)
    }
  }

  // Завершает символ: считает bbox/features и либо ставит пример на
  // подтверждение (учебный режим), либо запускает распознавание (умный).
  // Возвращает true, если в учебном режиме создан пример на подтверждении
  // (рисование блокируется до подтверждения/отмены).
  function processSymbol() {
    if (symbolBufferRef.current.length === 0) return false

    const strokes = [...symbolBufferRef.current]
    symbolBufferRef.current = []

    const bbox = getStrokesBBox(strokes)
    const resampled = resampleStrokes(strokes, CONFIG.POINTS_COUNT)
    const normalized = normalizePoints(resampled)

    // В датасет сохраняем strokesCount, features, bbox (положение/размер на
    // канвасе — нужен фронтенду, чтобы потом верно разместить распознанный
    // текст на месте рисунка) и выбранную label.
    const symbolData = {
      strokesCount: strokes.length,
      features: normalized,
      bbox,
      label: selectedLabelRef.current,
    }

    console.log(`📝 Распознан новый символ (${CONFIG.POINTS_COUNT} точки):`, symbolData)
    console.log(JSON.stringify(symbolData, null, 2))

    // Учебный режим: пример ждёт подтверждения — штрихи остаются на канве,
    // точки рисуются в debug-окне, отправка только по кнопке «Отправить».
    if (modeRef.current === 'train') {
      setPreviewData(symbolData.features)
      setSaveError('')
      setPendingExample({
        symbolData,
        color: strokes[0]?.color ?? penColor,
      })
      return true
    }

    // Обычный режим: модель отключена, распознавание не запускаем.
    if (modeRef.current === 'normal') {
      setPreviewData(null)
      return false
    }

    // Умный режим: распознаём и заменяем рисунок текстом.
    setPreviewData(null)
    runRecognition({
      strokeIds: strokes.map((s) => s.id),
      bbox,
      normalizedPoints: normalized,
      strokesCount: strokes.length,
      color: strokes[0]?.color ?? penColor,
    })
    return false
  }

  function handlePointerDown(e) {
    const pos = getPointerPos(e)
    if (!pos) return

    // Учебный режим: пока пример ждёт подтверждения, рисование заблокировано
    if (modeRef.current === 'train' && pendingExampleRef.current) return

    if (isPen) {
      if (recognitionTimeoutRef.current) {
        clearTimeout(recognitionTimeoutRef.current)
      }

      // Логика пространственной сегментации
      if (symbolBufferRef.current.length > 0) {
        const bbox = getStrokesBBox(symbolBufferRef.current)

        const isOutsideX = pos.x < bbox.minX - CONFIG.MARGIN_X || pos.x > bbox.maxX + CONFIG.MARGIN_X;
        const isOutsideY = pos.y < bbox.minY - CONFIG.MARGIN_Y || pos.y > bbox.maxY + CONFIG.MARGIN_Y;

        // Если пользователь начал писать за пределами безопасной зоны Bounding Box — это новый символ
        if (isOutsideX || isOutsideY) {
          const becamePending = processSymbol()
          // В учебном режиме пример ушёл на подтверждение — дальше рисовать нельзя
          if (becamePending) return
        }
      }
    }

    const stroke = {
      id: lineId++,
      tool,
      color: isPen ? penColor : '#ffffff',
      strokeWidth: isPen ? brushSize : brushSize * 3,
      points: [pos.x, pos.y],
      globalCompositeOperation: isPen ? 'source-over' : 'destination-out',
    }
    drawingRef.current = stroke
    setLines((ls) => [...ls, stroke])
  }

  function handlePointerMove(e) {
    if (!drawingRef.current) return
    const pos = getPointerPos(e)
    if (!pos) return
    const stroke = drawingRef.current
    stroke.points = [...stroke.points, pos.x, pos.y]
    setLines((ls) => ls.map((l) => (l.id === stroke.id ? { ...stroke } : l)))
  }

  function handlePointerUp() {
    if (drawingRef.current) {
      setHistory((h) => [...h, { lines: linesRef.current, texts: textsRef.current }])

      if (isPen) {
        const finishedStroke = JSON.parse(JSON.stringify(drawingRef.current))
        symbolBufferRef.current.push(finishedStroke)

        recognitionTimeoutRef.current = setTimeout(() => {
          processSymbol()
        }, CONFIG.RECOGNITION_TIMEOUT_MS)
      }
    }
    drawingRef.current = null
  }

  function undo() {
    if (lines.length === 0 && texts.length === 0) return
    const prev = history[history.length - 1] ?? { lines: [], texts: [] }
    setLines(prev.lines)
    setTexts(prev.texts)
    setHistory((h) => h.slice(0, -1))
  }

  function clearCanvas() {
    // Очистка также отменяет пример, ожидающий подтверждения (учебный режим)
    setPendingExample(null)
    symbolBufferRef.current = []
    setPreviewData(null)
    if (lines.length === 0 && texts.length === 0) return
    setHistory((h) => [...h, { lines, texts }])
    setLines([])
    setTexts([])
  }

  // Учебный режим: отправить пример в датасет и очистить канву
  function confirmExample() {
    const pending = pendingExampleRef.current
    if (!pending) return

    const label = selectedLabelRef.current ?? pending.symbolData.label
    if (!label) {
      setSaveError('Сначала выберите метку символа')
      return
    }

    setPendingExample(null)
    clearWorkspace()
    submitExample({
      ...pending.symbolData,
      label,
      userAgent: navigator.userAgent,
    })
  }

  // Учебный режим: отменить пример — очистить канву без отправки
  function cancelExample() {
    setPendingExample(null)
    setSaveError('')
    clearWorkspace()
  }

  // Полная очистка рабочей области (после подтверждения/отмены примера)
  function clearWorkspace() {
    symbolBufferRef.current = []
    setPreviewData(null)
    setHistory([])
    setLines([])
    setTexts([])
  }

  function selectColor(color) {
    if (color === penColor && tool === 'pen') return
    setPenColor(color)
    setTool('pen')
  }

  return (
    <div className="app">
      {/* --- БАР РЕЖИМОВ --- */}
      <div className="mode-bar">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`mode-btn ${mode === m.id ? 'active' : ''}`}
            onClick={() => applyMode(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <aside className="toolbar">
        <h1 className="brand">Inkew</h1>

        <div className="tool-group">
          <span className="group-label">Инструмент</span>
          <button
            type="button"
            className={`tool-btn ${tool === 'pen' ? 'active' : ''}`}
            onClick={() => setTool('pen')}
          >
            ✏️ Перо
          </button>
          <button
            type="button"
            className={`tool-btn ${tool === 'eraser' ? 'active' : ''}`}
            onClick={() => setTool('eraser')}
          >
            🧽 Ластик
          </button>
        </div>

        <div className="tool-group">
          <span className="group-label">Цвет чернил</span>
          <div className="swatches">
            {COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`swatch ${penColor === color && tool === 'pen' ? 'selected' : ''}`}
                style={{ backgroundColor: color }}
                onClick={() => selectColor(color)}
                aria-label={`Цвет ${color}`}
              />
            ))}
          </div>
        </div>

        <div className="tool-group">
          <span className="group-label">Толщина: {brushSize}</span>
          <input
            type="range"
            min="1"
            max="40"
            value={brushSize}
            onChange={(e) => setBrushSize(Number(e.target.value))}
          />
        </div>

        <div className="tool-group actions">
          <button
            type="button"
            className="action-btn"
            onClick={undo}
            disabled={lines.length === 0 && texts.length === 0}
          >
            ↩ Отменить
          </button>
          <button
            type="button"
            className="action-btn danger"
            onClick={clearCanvas}
            disabled={lines.length === 0 && texts.length === 0}
          >
            🗑 Очистить
          </button>
        </div>
      </aside>

      {/* --- ОКНО ОТЛАДКИ С ТОЧКАМИ (только учебный режим) --- */}
      {mode === 'train' && (
        <div className="debug-window">
          <span className="group-label">Отладка (точки символа)</span>

          {previewData ? (
            <div className="debug-canvas-container">
              <Stage width={150} height={150}>
                <Layer>
                  {/* Фон превью-окна */}
                  <Rect x={0} y={0} width={150} height={150} fill="#f4f4f4" cornerRadius={6} />

                  {/* Бледно-серая линия соединяющая точки */}
                  <KonvaLine
                    points={previewData.flatMap(p => [(p.x * 60) + 75, (p.y * 60) + 75])}
                    stroke="#c2c2c2"
                    strokeWidth={1.5}
                    tension={0}
                  />

                  {/* Отрисовка точек */}
                  {previewData.map((p, i) => {
                    const x = (p.x * 60) + 75;
                    const y = (p.y * 60) + 75;

                    const isFirst = i === 0;
                    const isLast = i === previewData.length - 1;
                    const color = isFirst ? '#40c057' : isLast ? '#e03131' : '#F26419';
                    const radius = isFirst || isLast ? 3.5 : 1.5;

                    return (
                      <Circle key={i} x={x} y={y} radius={radius} fill={color} />
                    );
                  })}
                </Layer>
              </Stage>
            </div>
          ) : (
            <div className="save-status">
              Нарисуйте символ — здесь появятся {CONFIG.POINTS_COUNT} ключевых точек
            </div>
          )}

          {pendingExample ? (
            <>
              <div className="save-status">
                Пример готов: «{selectedLabel ?? 'метка не выбрана'}». Отправить в датасет?
              </div>
              <div className="confirm-row">
                <button
                  type="button"
                  className="action-btn confirm-btn"
                  onClick={confirmExample}
                  disabled={!selectedLabel}
                >
                  ✓ Отправить
                </button>
                <button
                  type="button"
                  className="action-btn danger"
                  onClick={cancelExample}
                >
                  ✗ Отменить
                </button>
              </div>
            </>
          ) : (
            <div className="save-status">
              Выберите метку справа, нарисуйте символ и подтвердите отправку
            </div>
          )}
        </div>
      )}

      {/* --- ПРАВАЯ КОЛОНКА (скрыта в обычном режиме) --- */}
      {mode !== 'normal' && (
        <div className="right-column">
          {/* --- ОКНО РАСПОЗНАВАНИЯ (модель + порог NS) --- */}
          <div className="recognition-window">
            <span className="group-label">Распознавание</span>

            <div className="save-status">
              {modelStatus === 'idle' && 'Модель: отключена'}
              {modelStatus === 'loading' && 'Модель: загрузка…'}
              {modelStatus === 'ready' && 'Модель: готова ✅'}
              {modelStatus === 'error' && 'Модель: ошибка загрузки'}
            </div>
            {modelStatus === 'error' && <div className="debug-error">{modelError}</div>}

            {lastRecognition && (
              <div className="recognition-details">
                <div className="save-status">
                  Итог: <b>{lastRecognition.label === CONFIG.NS_LABEL ? 'не распознано (NS)' : `«${lastRecognition.label}»`}</b>
                </div>
                <div className="save-status">
                  top-1: «{lastRecognition.top1}» — {(lastRecognition.confidence * 100).toFixed(1)}%
                </div>
                <div className="save-status">
                  top-2: «{lastRecognition.top2}» — {(lastRecognition.top2Confidence * 100).toFixed(1)}%
                </div>
                <div className="save-status">
                  margin: {(lastRecognition.margin * 100).toFixed(1)}%
                </div>
              </div>
            )}

            {mode === 'train' && (
              <div className="save-status">
                Прогноз модели — подсказка: отправку примера вы подтверждаете сами
              </div>
            )}
          </div>

          {/* --- ОКНО ВЫБОРА МЕТКИ СИМВОЛА (только учебный режим) --- */}
          {mode === 'train' && (
            <div className="labels-window">
              <span className="group-label">Метка символа (сбор датасета)</span>

              <div className="labels-grid">
                {CONFIG.LABELS_LIST.map((label) => (
                  <button
                    key={label}
                    type="button"
                    className={`label-btn ${selectedLabel === label ? 'active' : ''}`}
                    title="Нажмите ещё раз, чтобы снять выбор"
                    onClick={() =>
                      setSelectedLabel((current) => (current === label ? null : label))
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="save-status">
                {selectedLabel
                  ? `Выбрано: «${selectedLabel}»`
                  : 'Выберите метку перед рисованием'}
              </div>
              <div className="save-status">
                Отправлено: {savedCount}
                {queuedCount > 0 ? ` · ждут отправки: ${queuedCount}` : ''}
              </div>
              {saveError && <div className="debug-error">{saveError}</div>}
            </div>
          )}
        </div>
      )}

      <Stage
        className="stage"
        width={size.width}
        height={size.height}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        style={{ cursor: tool === 'eraser' ? 'pointer' : 'crosshair' }}
      >
        <Layer listening={false}>
          <Rect x={0} y={0} width={size.width} height={size.height} fill="#ffffff" />
        </Layer>
        <Layer listening={false}>
          {lines.map((line) => (
            <KonvaLine
              key={line.id}
              points={line.points}
              stroke={line.color}
              strokeWidth={line.strokeWidth}
              tension={0.5}
              lineCap="round"
              lineJoin="round"
              globalCompositeOperation={line.globalCompositeOperation}
            />
          ))}
        </Layer>
        <Layer listening={false}>
          {texts.map((t) => (
            <KonvaText
              key={t.id}
              text={t.char}
              x={t.x}
              y={t.y}
              width={t.width}
              height={t.height}
              fontSize={t.fontSize}
              fontFamily="sans-serif"
              wrap="none"
              fill={t.color}
              align="center"
              verticalAlign="middle"
            />
          ))}
        </Layer>
      </Stage>
    </div>
  )
}

export default App
