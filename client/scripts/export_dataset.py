#!/usr/bin/env python3
"""Конвертирует CSV из Google Sheets (экспорт примеров Inkew) в data.jsonl.

Использование:
    python3 export_dataset.py examples.csv            # допишет в data.jsonl
    python3 export_dataset.py examples.csv -o my.jsonl

CSV получается так: откройте Google Таблицу с примерами →
«Файл» → «Скачать» → «CSV». Ожидаемые колонки (создаёт
apps-script-dataset.gs): timestamp, label, strokesCount, features, bbox, userAgent.
"""
import argparse
import csv
import json
import sys


def main() -> int:
    parser = argparse.ArgumentParser(
        description="CSV из Google Sheets → data.jsonl для обучения"
    )
    parser.add_argument("input", help="CSV-файл, экспортированный из Google Sheets")
    parser.add_argument(
        "-o", "--output", default="data.jsonl",
        help="файл jsonl (строки ДОПИСЫВАЮТСЯ в конец, по умолчанию data.jsonl)",
    )
    args = parser.parse_args()

    written = 0
    skipped = 0
    try:
        with open(args.input, newline="", encoding="utf-8-sig") as csv_file, open(
            args.output, "a", encoding="utf-8"
        ) as out:
            for row in csv.DictReader(csv_file):
                label = (row.get("label") or "").strip()
                if not label:
                    skipped += 1
                    continue

                try:
                    record = {
                        "strokesCount": int(float(row.get("strokesCount") or 0)),
                        "features": json.loads(row.get("features") or "[]"),
                        "label": label,
                        "createdAt": (row.get("timestamp") or "").strip() or None,
                    }
                except (ValueError, json.JSONDecodeError) as err:
                    print(f"Пропускаю строку с битыми данными: {err}", file=sys.stderr)
                    skipped += 1
                    continue

                bbox_raw = (row.get("bbox") or "").strip()
                if bbox_raw:
                    try:
                        record["bbox"] = json.loads(bbox_raw)
                    except json.JSONDecodeError:
                        record["bbox"] = None

                out.write(json.dumps(record, ensure_ascii=False) + "\n")
                written += 1
    except FileNotFoundError as err:
        print(f"Файл не найден: {err}", file=sys.stderr)
        return 1

    print(f"Записано примеров: {written}, пропущено: {skipped} → {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
