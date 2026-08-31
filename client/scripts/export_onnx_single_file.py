#!/usr/bin/env python3
"""
Конвертирует ONNX, сохранённый во «внешнем» формате (веса лежат отдельным
файлом *.onnx.data), в однострочный self-contained .onnx, который
onnxruntime-web умеет загружать в браузере.

Запускать на машине, где есть оба файла (обычно там же, где ноутбук,
которым модель экспортировалась), затем готовый .onnx скопировать в
client/public/symbols.onnx.

Если же вы пере-обучаете/пере-экспортируете модель заново — проще сразу
сделать один файл без внешних данных:
    torch.onnx.export(model, dummy_input, "symbols.onnx")
(по умолчанию PyTorch кладёт все веса внутрь одного файла; внешний формат
появляется только при external_data=True или onnx.save_model(
model, path, save_as_external_data=True)).

Пример:
    python export_onnx_single_file.py /path/to/symbols.onnx
    python export_onnx_single_file.py /path/to/symbols.onnx -o symbols_selfcontained.onnx
"""

import argparse
import os
import sys

import onnx


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("src", help="путь к «внешнему» .onnx (рядом должен лежать *.onnx.data)")
    parser.add_argument(
        "-o", "--out",
        help="выходной файл (по умолчанию: <имя>_selfcontained.onnx рядом с src)",
    )
    args = parser.parse_args()

    src = args.src

    if not os.path.isfile(src):
        print(f"Ошибка: файл модели не найден: {src}")
        return 1

    # Определяем имена внешних файлов, на которые реально ссылается модель
    # (обычно <имя>.onnx.data, но некоторые версии onnx дают случайное имя).
    stub = onnx.load(src, load_external_data=False)
    locations = {
        e.value
        for init in stub.graph.initializer
        if init.data_location == onnx.TensorProto.EXTERNAL
        for e in init.external_data
        if e.key == "location"
    }
    base = os.path.dirname(src) or "."
    missing = [loc for loc in locations if not os.path.isfile(os.path.join(base, loc))]

    if missing:
        print(
            "Ошибка: модель ссылается на внешние файлы весов, которых нет рядом:\n  "
            + "\n  ".join(missing)
            + "\nБез них веса модели не восстановить — пере-экспортируйте модель "
            "(torch.onnx.export без external_data) или найдите эти файлы."
        )
        return 1

    if args.out:
        out = args.out
    elif src.endswith(".onnx"):
        out = src[: -len(".onnx")] + "_selfcontained.onnx"
    else:
        out = src + "_selfcontained.onnx"

    if out == src:
        print("Ошибка: выходной файл должен отличаться от исходного (используйте -o).")
        return 1

    # onnx.load по умолчанию подтягивает внешние данные из найденных файлов
    model = onnx.load(src)
    onnx.save_model(model, out, save_as_external_data=False)

    print(
        f"Готово: {os.path.basename(src)} + {', '.join(sorted(locations) or ['-'])} -> {out}"
    )
    print(
        f"Размер: {os.path.getsize(out)} байт"
        f" (было {os.path.getsize(src)} + ... байт)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())