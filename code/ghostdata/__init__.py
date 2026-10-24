"""Ghost Data Still Exists — dataset parsing toolkit.

This package turns the heterogeneous `dataset/` inputs (CSV, SQL snapshots,
JSON exports, seven log dialects, plain-text reports, PDFs, screenshots) into a
single normalized observation index plus compact per-case context bundles.

Only participant-facing data under `dataset/` is read.
"""

from .config import DATASET_DIR, ROOT_DIR, BUILD_DIR
from .model import Record, ObservationStore

__all__ = ["DATASET_DIR", "ROOT_DIR", "BUILD_DIR", "Record", "ObservationStore"]
