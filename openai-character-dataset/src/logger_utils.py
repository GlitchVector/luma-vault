"""Small logging setup: readable console lines, an optional timestamped file in ``logs/``.

A redaction filter masks anything that looks like an API key before it reaches either
handler, so a stray exception message cannot leak the secret into a log file.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from pathlib import Path

_KEY_PATTERN = re.compile(r"sk-[A-Za-z0-9_\-]{8,}")


class RedactKeys(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        redacted = _KEY_PATTERN.sub("sk-***", message)
        if redacted != message:
            record.msg = redacted
            record.args = ()
        return True


def setup_logging(log_dir: Path | None, *, name: str = "ari-dataset", verbose: bool = False) -> logging.Logger:
    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG if verbose else logging.INFO)
    logger.handlers.clear()
    logger.propagate = False

    console = logging.StreamHandler()
    console.setFormatter(logging.Formatter("%(asctime)s  %(levelname)-7s %(message)s", datefmt="%H:%M:%S"))
    console.addFilter(RedactKeys())
    logger.addHandler(console)

    if log_dir is not None:
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / f"{name}-{datetime.now():%Y%m%d-%H%M%S}.log"
        file_handler = logging.FileHandler(log_file, encoding="utf-8")
        file_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(message)s"))
        file_handler.addFilter(RedactKeys())
        logger.addHandler(file_handler)
        logger.debug("log file: %s", log_file)

    return logger
