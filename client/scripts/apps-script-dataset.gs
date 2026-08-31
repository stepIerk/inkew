/**
 * Код для Google Apps Script — приёмник примеров из учебного режима Inkew.
 *
 * КАК НАСТРОИТЬ (5 минут, без бэкэнда):
 *
 * 1. Создайте Google Таблицу на sheets.new
 * 2. Меню «Расширения» → «Apps Script»
 * 3. Удалите содержимое Code.gs и вставьте весь этот файл
 * 4. «Развернуть» → «Новое развёртывание» → тип «Веб-приложение»:
 *      - «Выполнять от имени»: меня
 *      - «Кто имеет доступ»: все (даже анонимные)
 * 5. Скопируйте URL вида https://script.google.com/macros/s/…/exec
 *    и вставьте его в константу DATASET_ENDPOINT в client/src/App.jsx
 * 6. При каждом изменении скрипта: «Развернуть» → «Управление
 *    развёртываниями» → изменить версию (иначе URL продолжит отдавать старый
 *    код)
 *
 * Данные складываются на лист «data» построчно: каждая строка — один пример.
 * Выгрузка: в таблице «Файл» → «Скачать» → CSV, затем конвертируйте в
 * data.jsonl скриптом client/scripts/export_dataset.py
 */

// Имя листа, куда дописываются примеры
var SHEET_NAME = 'data';

// Если скрипт создан НЕ из таблицы (standalone-проект на script.google.com),
// укажите здесь ID таблицы из её URL: docs.google.com/spreadsheets/d/<ID>/edit
// Если скрипт привязан к таблице — оставьте пустым.
var SPREADSHEET_ID = '';

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      throw new Error(
        'Пустой запрос: ожидался JSON в теле POST. ' +
        'Запуск doPost вручную из редактора не имеет тела запроса — ' +
        'тестируйте запросом со страницы Inkew или через curl.'
      );
    }

    var payload = JSON.parse(e.postData.contents);

    var spreadsheet = SPREADSHEET_ID
      ? SpreadsheetApp.openById(SPREADSHEET_ID)
      : SpreadsheetApp.getActiveSpreadsheet();

    if (!spreadsheet) {
      throw new Error(
        'Скрипт не привязан к таблице (getActiveSpreadsheet() вернул null). ' +
        'Создайте скрипт из самой таблицы: Расширения → Apps Script, ' +
        'либо укажите SPREADSHEET_ID в начале этого файла.'
      );
    }

    var sheet = spreadsheet.getSheetByName(SHEET_NAME);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(SHEET_NAME);
    }

    // Заголовки — только если лист пустой
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        'timestamp',
        'label',
        'strokesCount',
        'features',
        'bbox',
        'userAgent',
      ]);
    }

    sheet.appendRow([
      payload.createdAt || new Date().toISOString(),
      payload.label || '',
      payload.strokesCount || 0,
      JSON.stringify(payload.features || []),
      payload.bbox ? JSON.stringify(payload.bbox) : '',
      payload.userAgent || '',
    ]);

    console.log('Пример сохранён: label=' + payload.label);
    return ContentService.createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    // Лог ошибки виден в редакторе Apps Script: «Выполнения» → посмотреть лог
    console.error('doPost error: ' + String(err));
    return ContentService.createTextOutput(
      JSON.stringify({ ok: false, error: String(err) })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}
