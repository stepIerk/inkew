#!/usr/bin/env python3
"""
Восстанавливает рабочий self-contained ONNX из неполного (external-data) ONNX
и сохранённого state_dict-файла PyTorch (*.pt), БЕЗ установки torch.

Сценарий: при экспорте модели BatchNorm-слои были «вшиты» в свёртки (fused),
а веса уехали во внешний файл symbols.onnx.data, который потерялся. Здесь:
  1) извлекаем все тензоры из symbols.pt (zip+pickle, torch не нужен);
  2) сворачиваем BatchNorm в свёртки по стандартной формуле eval-режима:
        std = sqrt(running_var + eps)
        w'  = bn.weight / std * conv.weight        (поканально)
        b'  = (conv.bias - running_mean) / std * bn.weight + bn.bias
  3) проверяем результат: fused-bias свёрток conv.0/conv.3 должен совпасть с
     inline-bias-ами, которые УЖЕ лежат в текущем ONNX (совпало — значит, eps
     угадан верно и математика правильная);
  4) вшиваем все веса в граф и сохраняем один цельный .onnx.

Запуск:
    python rebuild_onnx_from_pt.py symbols.pt symbols.onnx -o symbols_fixed.onnx
Если fused-bias не совпал с inline-значениями, попробуйте -e 1e-4 / 1e-6
(обычно всегда 1e-5 — значение по умолчанию BatchNorm в PyTorch).
"""

import argparse
import collections
import io
import os
import pickle
import sys
import zipfile

import numpy as np
import onnx
from onnx import numpy_helper

DTYPES = {
    "FloatStorage": np.float32,
    "DoubleStorage": np.float64,
    "HalfStorage": np.float16,
    "LongStorage": np.int64,
}


class _StorageType:
    def __init__(self, name):
        self.dtype = DTYPES[name]


class _PTUnpickler(pickle.Unpickler):
    """Читает data.pkl без torch: эмуляция torch._utils / torch.*Storage."""

    def __init__(self, f, zf):
        super().__init__(f)
        self.zf = zf

    def find_class(self, module, name):
        if module == "collections" and name == "OrderedDict":
            return collections.OrderedDict
        if module == "torch._utils" and name == "_rebuild_tensor_v2":
            return self._rtv2
        if module == "torch" and name in DTYPES:
            return _StorageType(name)
        raise pickle.UnpicklingError(f"неожиданный объект в data.pkl: {module}.{name}")

    def persistent_load(self, persid):
        # persid := ('storage', StorageType, '<id>', 'cpu', numel)
        kind, stype, sid, loc, numel = persid
        return np.frombuffer(self.zf.read(f"symbols/data/{sid}"), dtype=stype.dtype)

    def _rtv2(self, storage, storage_offset, size, stride, requires_grad,
              backward_hooks, *argv):
        dtype = storage.dtype
        n = int(np.prod(size))
        start = storage_offset * dtype.itemsize
        return np.frombuffer(
            storage.tobytes()[start : start + n * dtype.itemsize],
            dtype=dtype,
        ).reshape(size)


def load_state_dict(pt_path):
    """Возвращает OrderedDict имя -> np.ndarray по данным из zip-архива .pt."""
    with zipfile.ZipFile(pt_path) as zf:
        raw = zf.read("symbols/data.pkl")
        return _PTUnpickler(io.BytesIO(raw), zf).load()


def fuse_conv_bn(conv_w, conv_b, bn_w, bn_b, bn_mean, bn_var, eps):
    """eval-режим fusion BatchNorm в свёртку (как torch.nn.utils.fusion)."""
    std = np.sqrt(bn_var + eps)
    scale = bn_w / std
    fw = conv_w * scale.reshape(-1, 1, 1)
    fb = (conv_b - bn_mean) * scale + bn_b
    return fw, fb


def build_weights(sd, eps):
    """Возвращает имя initializer -> np.ndarray (после fusion BN)."""
    out = {}
    for stem, bn in (("conv.0", "conv.1"), ("conv.3", "conv.4"),
                     ("conv.8", "conv.9"), ("conv.11", "conv.12"),
                     ("conv.16", "conv.17")):
        w, b = fuse_conv_bn(
            sd[f"{stem}.weight"],
            sd.get(f"{stem}.bias",
                   np.zeros(sd[f"{stem}.weight"].shape[0], dtype=np.float32)),
            sd[f"{bn}.weight"],
            sd[f"{bn}.bias"],
            sd[f"{bn}.running_mean"],
            sd[f"{bn}.running_var"],
            eps,
        )
        out[f"{stem}.weight"] = w.astype(np.float32)
        out[f"{stem}.bias"] = b.astype(np.float32)
    for stem in ("classifier.0", "classifier.3"):
        out[f"{stem}.weight"] = sd[f"{stem}.weight"].astype(np.float32)
        out[f"{stem}.bias"] = sd[f"{stem}.bias"].astype(np.float32)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pt", help="*.pt (state_dict, zip-формат torch.save)")
    ap.add_argument("onnx_path", help="текущий (неполный) symbols.onnx")
    ap.add_argument("-o", "--out", required=True, help="итоговый .onnx")
    ap.add_argument("-e", "--eps", type=float, default=1e-5, help="BatchNorm eps")
    args = ap.parse_args()

    sd = load_state_dict(args.pt)
    print(f"state_dict: {len(sd)} тензоров")
    for k, v in sd.items():
        print(f"  {k:32s} {v.shape} {v.dtype}")

    model = onnx.load(args.onnx_path, load_external_data=False)

    # --- проверка формулы на inline-bias-ах текущего ONNX ---
    inline = {i.name: numpy_helper.to_array(i) for i in model.graph.initializer
              if i.data_location != onnx.TensorProto.EXTERNAL}
    _, b_fused_0 = fuse_conv_bn(
        sd["conv.0.weight"], sd.get("conv.0.bias"),
        sd["conv.1.weight"], sd["conv.1.bias"],
        sd["conv.1.running_mean"], sd["conv.1.running_var"], args.eps)
    _, b_fused_3 = fuse_conv_bn(
        sd["conv.3.weight"], sd.get("conv.3.bias"),
        sd["conv.4.weight"], sd["conv.4.bias"],
        sd["conv.4.running_mean"], sd["conv.4.running_var"], args.eps)
    d0 = float(np.max(np.abs(b_fused_0.astype(np.float32) - inline["conv.0.bias"])))
    d3 = float(np.max(np.abs(b_fused_3.astype(np.float32) - inline["conv.3.bias"])))
    print(f"\nПроверка fusion при eps={args.eps}:")
    print(f"  |fused(conv.0) - onnx conv.0.bias| max = {d0:.3e}")
    print(f"  |fused(conv.3) - onnx conv.3.bias| max = {d3:.3e}")
    if max(d0, d3) > 1e-3:
        print("ВНИМАНИЕ: большое расхождение — вероятно, неверный eps. "
              "Попробуйте --eps 1e-4 или 1e-6.")

    # --- вшиваем веса ---
    wmap = build_weights(sd, args.eps)
    replaced = 0
    for init in model.graph.initializer:
        if init.name in wmap:
            arr = np.ascontiguousarray(wmap[init.name])
            init.CopyFrom(numpy_helper.from_array(arr, name=init.name))
            replaced += 1
    print(f"\nВшито весов: {replaced} тензоров")

    onnx.checker.check_model(model)
    onnx.save_model(model, args.out, save_as_external_data=False)
    print(f"Готово: {args.out} ({os.path.getsize(args.out)} байт)")


if __name__ == "__main__":
    sys.exit(main())