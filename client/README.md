# Inkew

## Режимы работы

Сверху по центру — бар режимов:

- **✏️ Рисование** — модель отключена, можно просто рисовать (модель не загружается, экономит трафик на телефоне).
- **🧠 Умный** — модель включена: нарисованный символ распознаётся и заменяется текстом.
- **🎓 Обучение** — сбор датасета: выберите метку справа → нарисуйте символ → в окне отладки (слева внизу) появятся 64 ключевые точки → «✓ Отправить» (уйдёт в датасет и очистит канву) или «✗ Отменить» (просто очистит канву).

## Сбор датасета без бэкэнда (Google Apps Script → Google Sheets)

Примеры из учебного режима отправляются на Google Apps Script Web App и складываются в Google Таблицу:

1. Создайте Google Таблицу → «Расширения» → «Apps Script».
2. Вставьте код из `client/scripts/apps-script-dataset.gs`.
3. «Развернуть» → «Новое развёртывание» → «Веб-приложение», доступ — «все (даже анонимные)».
4. Скопируйте URL развёртывания (`https://script.google.com/macros/s/…/exec`) и вставьте его в константу `DATASET_ENDPOINT` в `client/src/App.jsx`.
5. Выгрузка: «Файл» → «Скачать» → CSV, затем:
   ```bash
   python3 client/scripts/export_dataset.py examples.csv   # допишет в data.jsonl
   ```

Примеры сначала попадают в `localStorage`-очередь и досылаются, когда появится сеть. Если `DATASET_ENDPOINT` пуст — работает локальный режим: `POST /api/symbols` дописывает строку в `client/data.jsonl` (Vite-middleware, только в dev).

### Если doPost «выполняется», а таблица пуста

Клиент сначала шлёт обычный CORS-запрос и показывает текст ошибки из `{ok:false}` прямо в интерфейсе (панель «Метка символа»). Частые причины:

- **Скрипт создан не из таблицы** (standalone-проект на script.google.com) — тогда `getActiveSpreadsheet()` возвращает `null`. Создайте скрипт из самой таблицы («Расширения» → «Apps Script») или укажите `SPREADSHEET_ID` в начале `apps-script-dataset.gs`.
- **Запуск doPost вручную из редактора** — у такого запуска нет тела запроса, это не тест. Тестируйте со страницы Inkew.
- **Обновили код скрипта, но не создали новую версию развёртывания** — «Развернуть» → «Управление развёртываниями» → ✏ → «Новая версия».
- Лог ошибок: редактор Apps Script → «Выполнения» → клик по запуску → лог (`console.error` пишет туда).

## Деплой на GitHub Pages

При пуше в `main` срабатывает workflow `.github/workflows/deploy.yml` (build → deploy). В репозитории GitHub включите: **Settings → Pages → Source: GitHub Actions**. Страница будет доступна на `https://<user>.github.io/inkew/`.

---

# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
