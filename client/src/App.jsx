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

  const [jsonInput, setJsonInput] = useState('')
  const [previewData, setPreviewData] = useState(null)
  const [jsonError, setJsonError] = useState('')
  const [selectedLabel, setSelectedLabel] = useState(null)
  const [savedCount, setSavedCount] = useState(0)
  const [saveError, setSaveError] = useState('')

  // === Состояние модели распознавания ===
  const [modelStatus, setModelStatus] = useState('loading') // 'loading' | 'ready' | 'error'
  const [modelError, setModelError] = useState('')
  const [lastRecognition, setLastRecognition] = useState(null)

  const drawingRef = useRef(null)
  const symbolBufferRef = useRef([])
  const recognitionTimeoutRef = useRef(null)
  const selectedLabelRef = useRef(null)

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

  // Прогреваем модель и classes.json при монтировании, чтобы первое
  // распознавание не тормозило из-за холодной загрузки.
  useEffect(() => {
    let cancelled = false
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
  }, [])

  const isPen = tool === 'pen'

  function getPointerPos(e) {
    const pos = e.target?.getStage?.().getPointerPosition?.()
    if (!pos) return null
    return { x: pos.x, y: pos.y }
  }

  async function saveSymbol(symbolData) {
    try {
      const response = await fetch('/api/symbols', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(symbolData),
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(errData?.error || `Ошибка сервера: ${response.status}`)
      }

      setSavedCount((count) => count + 1)
      setSaveError('')
    } catch (err) {
      setSaveError(err?.message || 'Не удалось сохранить пример')
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

    setTexts((ts) => [
      ...ts,
      {
        id: lineId++,
        char,
        x: bbox.minX - pad,
        y: bbox.minY - pad,
        width: width + pad * 2,
        height: height + pad * 2,
        fontSize,
        color,
      },
    ])
  }

  // Прогоняет распознанный символ через модель и, если модель уверена
  // (см. CONFIDENCE_THRESHOLD / MARGIN_THRESHOLD), заменяет рисунок текстом.
  //
  // Замену делаем только если в этот момент НЕ выбрана метка для ручной
  // разметки — во время сбора датасета удобнее видеть, что именно было
  // нарисовано, а не то, во что модель это превратила. При этом сам
  // прогноз всё равно считается и попадает в debug-панель — так видно,
  // угадывает ли модель твою же новую разметку (полезная проверка на глаз).
  async function runRecognition({ strokeIds, bbox, normalizedPoints, strokesCount, color }) {
    if (modelStatus !== 'ready') return

    try {
      const result = await recognizeSymbol(normalizedPoints, strokesCount, {
        confidenceThreshold: CONFIG.CONFIDENCE_THRESHOLD,
        marginThreshold: CONFIG.MARGIN_THRESHOLD,
        nsLabel: CONFIG.NS_LABEL,
      })

      setLastRecognition(result)

      const isLabelingActive = selectedLabelRef.current != null
      if (!isLabelingActive && result.label !== CONFIG.NS_LABEL) {
        replaceStrokesWithText(strokeIds, bbox, result.label, color)
      }
    } catch (err) {
      console.error('Ошибка распознавания символа:', err)
    }
  }

  function processSymbol() {
    if (symbolBufferRef.current.length === 0) return

    const strokes = [...symbolBufferRef.current]
    symbolBufferRef.current = []

    const bbox = getStrokesBBox(strokes)
    const resampled = resampleStrokes(strokes, CONFIG.POINTS_COUNT)
    const normalized = normalizePoints(resampled)

    // В файл сохраняем strokesCount, features, bbox (положение/размер на
    // канвасе — нужен фронтенду, чтобы потом верно разместить распознанный
    // текст на месте рисунка) и выбранную label.
    const label = selectedLabelRef.current
    const symbolData = {
      strokesCount: strokes.length,
      features: normalized,
      bbox,
      label,
    }

    console.log(`📝 Распознан новый символ (${CONFIG.POINTS_COUNT} точки):`, symbolData)
    console.log(JSON.stringify(symbolData, null, 2))

    setPreviewData(symbolData.features)

    if (label) {
      saveSymbol(symbolData)
    } else {
      setSaveError('Метка не выбрана — пример не будет сохранён')
    }

    // Запускаем ML-распознавание независимо от того, сохраняем ли пример
    // как размеченные данные (см. комментарий в runRecognition()).
    runRecognition({
      strokeIds: strokes.map((s) => s.id),
      bbox,
      normalizedPoints: normalized,
      strokesCount: strokes.length,
      color: strokes[0]?.color ?? penColor,
    })
  }

  function handlePointerDown(e) {
    const pos = getPointerPos(e)
    if (!pos) return

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
          processSymbol()
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
    if (lines.length === 0 && texts.length === 0) return
    setHistory((h) => [...h, { lines, texts }])
    setLines([])
    setTexts([])
  }

  function selectColor(color) {
    if (color === penColor && tool === 'pen') return
    setPenColor(color)
    setTool('pen')
  }

  function handleParseJson() {
    try {
      setJsonError('')
      const parsed = JSON.parse(jsonInput)

      const features = parsed.features ? parsed.features : parsed

      if (!Array.isArray(features)) {
        throw new Error('Данные должны быть массивом или объектом с полем features')
      }
      if (features.length === 0 || typeof features[0].x === 'undefined') {
        throw new Error('Массив не содержит координат {x, y}')
      }

      setPreviewData(features)
    } catch (err) {
      setPreviewData(null)
      setJsonError('Ошибка: неверный JSON формат')
    }
  }

  return (
    <div className="app">
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

      {/* --- ОКНО ПРЕВЬЮ JSON --- */}
      <div className="debug-window">
        <span className="group-label">Отладка (JSON)</span>

        {jsonError && <div className="debug-error">{jsonError}</div>}

        {previewData && (
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
        )}
      </div>

      {/* --- ОКНО РАСПОЗНАВАНИЯ (модель + порог NS) --- */}
      <div className="recognition-window">
        <span className="group-label">Распознавание</span>

        <div className="save-status">
          {modelStatus === 'loading' && 'Модель: загрузка…'}
          {modelStatus === 'ready' && 'Модель: готова ✅'}
          {modelStatus === 'error' && `Модель: ошибка загрузки`}
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

        {selectedLabel && (
          <div className="save-status">
            Активна ручная разметка «{selectedLabel}» — автозамена рисунка текстом отключена
          </div>
        )}
      </div>

      {/* --- ОКНО ВЫБОРА МЕТКИ СИМВОЛА --- */}
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
            : 'Символ не выбран — пример не будет сохранён'}
        </div>
        <div className="save-status">Сохранено в data.jsonl: {savedCount}</div>
        {saveError && <div className="debug-error">{saveError}</div>}
      </div>

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
