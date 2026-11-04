"""Remember daily quota cooldowns so a fallback never probes an exhausted model."""
import json
import re
import time
import threading
from pathlib import Path
from livekit.agents import APIStatusError
from livekit.plugins import google
from diagnostics import record

_file = Path(__file__).resolve().parents[1] / '.runtime' / 'tts-cooldowns.json'
_lock = threading.Lock()
try:
    _cooldowns = json.loads(_file.read_text(encoding='utf-8'))
except (OSError, ValueError):
    _cooldowns = {}

def unavailable(model: str) -> bool:
    return float(_cooldowns.get(model, 0)) > time.time()

def quota_delay(error) -> float | None:
    body = str(getattr(error, 'body', '') or error)
    if getattr(error, 'status_code', None) != 429 or not any(value in body for value in
            ('requests_per_model_per_day', 'RequestsPerDayPerProjectPerModel')):
        return None
    match = re.search(r'"retryDelay"\s*:\s*"([\d.]+)s"', body)
    return max(1, float(match.group(1))) if match else 900

class QuotaAwareGeminiTTS(google.beta.GeminiTTS):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.on('error', self._remember_quota)

    def _remember_quota(self, event):
        delay = quota_delay(event.error)
        if delay is None:
            return
        with _lock:
            _cooldowns[self.model] = time.time() + delay
            try:
                _file.parent.mkdir(exist_ok=True)
                temporary = _file.with_suffix('.tmp')
                temporary.write_text(json.dumps(_cooldowns), encoding='utf-8')
                temporary.replace(_file)
            except OSError:
                pass
        record('voice.quota', model=self.model, status='error', code='daily_quota')

    def synthesize(self, text, **kwargs):
        if unavailable(self.model):
            raise APIStatusError('Daily voice quota: model cooling down', status_code=429, retryable=False)
        return super().synthesize(text, **kwargs)

def public_voice_error(error) -> str:
    if getattr(getattr(error, 'error', error), 'status_code', None) == 429:
        return 'Voice has hit its quota. The reply still shows and the video commands still work.'
    return 'Voice is unavailable for a moment. The reply still shows; you can keep typing.'
