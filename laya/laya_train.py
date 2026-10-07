"""laya-train with a device fix.

laya 0.3.29 `finetune()` runs the pre-training eval/calibration pass before the model is
moved to the training device, so on mps/cuda it fails with "Passed CPU tensor to MPS op".
This wrapper moves the model to the resolved device as soon as it is loaded, then defers
to the stock `laya-train` CLI. Same flags. Drop it once upstream is fixed.
"""
from __future__ import annotations
import sys
import laya.train as _train

_orig_load = _train.load_checkpoint

def _load_on_device(*args, **kwargs):
    out = _orig_load(*args, **kwargs)
    model, rest = out[0], out[1:]
    # `device` is only known inside finetune(); mirror its resolution from argv.
    dev = "auto"
    for i, a in enumerate(sys.argv):
        if a == "--device" and i + 1 < len(sys.argv):
            dev = sys.argv[i + 1]
        elif a.startswith("--device="):
            dev = a.split("=", 1)[1]
    model.to(_train.resolve_device(dev))
    return (model, *rest)

_train.load_checkpoint = _load_on_device

from laya.train_cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
