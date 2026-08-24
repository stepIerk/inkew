import { useEffect, useRef, useState } from 'react'
import { Layer, Line as KonvaLine, Rect, Stage, Circle } from 'react-konva'
import './App.css'

// === ГЛОБАЛЬНЫЕ НАСТРОЙКИ СЕГМЕНТАЦИИ И РАСПОЗНАВАНИЯ ===
const CONFIG = {
  RECOGNITION_TIMEOUT_MS: 450, // Предельное время (в мс) ожидания до завершения символа
  MARGIN_X: 10,                // Допустимый отступ по оси X (в px) для объединения штрихов в один символ
  MARGIN_Y: 40,                // Допустимый отступ по оси Y (в px). (Сделан больше, чтобы не разрывать знак "=")
  POINTS_COUNT: 64,            // Количество ключевых точек для ML-модели
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
  const [history, setHistory] = useState([])
  const [tool, setTool] = useState('pen') 
  const [penColor, setPenColor] = useState('#000000')
  const [brushSize, setBrushSize] = useState(6)
  
  const [jsonInput, setJsonInput] = useState('')
  const [previewData, setPreviewData] = useState(null)
  const [jsonError, setJsonError] = useState('')

  const drawingRef = useRef(null)
  const symbolBufferRef = useRef([])
  const recognitionTimeoutRef = useRef(null)

  const isPen = tool === 'pen'

  function getPointerPos(e) {
    const pos = e.target?.getStage?.().getPointerPosition?.()
    if (!pos) return null
    return { x: pos.x, y: pos.y }
  }

  function processSymbol() {
    if (symbolBufferRef.current.length === 0) return
    
    const strokes = [...symbolBufferRef.current]
    symbolBufferRef.current = [] 
    
    const resampled = resampleStrokes(strokes, CONFIG.POINTS_COUNT)
    const normalized = normalizePoints(resampled)

    const symbolData = {
      timestamp: Date.now(),
      strokesCount: strokes.length,
      features: normalized, 
    }

    console.log(`📝 Распознан новый символ (${CONFIG.POINTS_COUNT} точки):`, symbolData)

    setPreviewData(symbolData.features)
    console.log(JSON.stringify(symbolData, null, 2))
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
      setHistory((h) => [...h, lines])
      
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
    if (lines.length === 0) return
    const prev = history[history.length - 1] ?? []
    setLines(prev)
    setHistory((h) => h.slice(0, -1))
  }

  function clearCanvas() {
    if (lines.length === 0) return
    setHistory((h) => [...h, lines])
    setLines([])
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
            disabled={lines.length === 0}
          >
            ↩ Отменить
          </button>
          <button
            type="button"
            className="action-btn danger"
            onClick={clearCanvas}
            disabled={lines.length === 0}
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
      </Stage>
    </div>
  )
}

export default App