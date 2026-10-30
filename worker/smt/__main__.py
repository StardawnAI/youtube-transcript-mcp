"""python -m smt — starts the job threads and the HTTP server."""

from __future__ import annotations

import logging
import signal
import sys
import threading

from . import VERSION, config
from .api import serve
from .engine import Engine


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr)
    # One line per file of every model download otherwise.
    for noisy in ("httpx", "httpx2", "huggingface_hub"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    settings = config.load()
    engine = Engine(settings)
    engine.start()
    # The first job should not wait for a model download: fetch and load it now.
    threading.Thread(target=engine.preload, name="asr-preload", daemon=True).start()
    server = serve(engine)
    # shutdown() waits for serve_forever() to return, so it cannot run on the thread serving.
    signal.signal(signal.SIGTERM, lambda *_: (engine.stop(), threading.Thread(target=server.shutdown).start()))
    logging.getLogger("smt").info(
        "smtranscript worker %s on %s:%s, routes %s, ASR %s", VERSION, settings.bind, settings.port,
        ", ".join(settings.routes), settings.asr_model)
    try:
        server.serve_forever()
    finally:
        engine.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
