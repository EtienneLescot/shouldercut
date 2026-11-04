"""Bounded, asynchronous local latency journal. No transcript or credentials."""
import atexit
import os
import contextvars
import json
import logging
import sys
from logging.handlers import QueueHandler, QueueListener, RotatingFileHandler
from pathlib import Path
from queue import SimpleQueue
from datetime import datetime, timezone

trace_id = contextvars.ContextVar('ux_trace_id', default=None)
_logger = None
_allowed = {'traceId', 'sessionId', 'role', 'messageId', 'model', 'provider', 'action',
            'status', 'code', 'cached', 'elapsed_ms', 'queue_ms', 'transcription_delay_ms',
            'end_of_turn_delay_ms', 'tts_node_ttfb_ms', 'e2e_latency_ms', 'ttfb_ms',
            'on_user_turn_completed_delay_ms', 'playback_latency_ms', 'llm_node_ttft_ms',
            'pending', 'editing', 'http_status'}

ACCESS_HEADER = 'X-ShoulderCut-Key'

def bridge_headers(trace=None):
    """Headers for every call to the local editor API.

    The editor gates all of its routes once SHOULDERCUT_ACCESS_KEY is set,
    which is what makes it safe to put on a tunnel. The voice agent is not a
    browser: it has no cookie to be handed, so it presents the key itself.
    With no key set this is the trace header it always was.
    """
    headers = {'X-ShoulderCut-Trace': trace or trace_id.get() or ''}
    key = (os.getenv('SHOULDERCUT_ACCESS_KEY') or '').strip()
    if key:
        headers[ACCESS_HEADER] = key
    return headers

def record(stage, **fields):
    global _logger
    if 'unittest' in sys.modules:
        return
    try:
        if _logger is None:
            folder = Path(__file__).resolve().parents[1] / '.runtime'
            folder.mkdir(exist_ok=True)
            handler = RotatingFileHandler(folder / 'ux-voice.jsonl', maxBytes=10_000_000,
                                          backupCount=1, encoding='utf-8')
            handler.setFormatter(logging.Formatter('%(message)s'))
            queue = SimpleQueue()
            listener = QueueListener(queue, handler)
            listener.start()
            atexit.register(listener.stop)
            _logger = logging.getLogger('shouldercut.latency')
            _logger.propagate = False
            _logger.setLevel(logging.INFO)
            _logger.addHandler(QueueHandler(queue))
        safe = {k: v for k, v in fields.items() if k in _allowed and isinstance(v, (str, int, float, bool, type(None)))}
        _logger.info(json.dumps({'timestamp': datetime.now(timezone.utc).isoformat(),
            'component': 'voice', 'traceId': trace_id.get(), 'stage': stage, **safe}))
    except Exception:
        pass  # Observability must not interrupt the audio path.
