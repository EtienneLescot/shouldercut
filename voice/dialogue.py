"""Small Meta conversation model; only explicit editing requests enter the slow queue."""
from dataclasses import dataclass
import json
import os
import time
import re
import unicodedata
from diagnostics import record

import aiohttp


@dataclass(frozen=True)
class Reply:
    text: str
    command: str | None = None
    action: dict | None = None


from pathlib import Path
CONFIG = json.loads((Path(__file__).resolve().parent.parent / 'shared' / 'conversation.json').read_text(encoding='utf-8'))
INSTRUCTIONS = CONFIG['instructions']
TOOLS = CONFIG['tools']
EDIT_TOOL = TOOLS[0]
SHORTCUTS = json.loads((Path(__file__).resolve().parent.parent / 'shared' / 'playback-shortcuts.json').read_text(encoding='utf-8'))

def quick_playback(text: str) -> Reply | None:
    normalized = ''.join(c for c in unicodedata.normalize('NFD', text) if not unicodedata.combining(c)).lower().strip().rstrip('.!?').strip()
    for rule in SHORTCUTS['rules']:
        match = re.fullmatch(rule['pattern'], normalized)
        if not match:
            continue
        position = None
        if rule['action'] == 'seek':
            value = match.group(1)
            position = SHORTCUTS['numbers'][value] if value in SHORTCUTS['numbers'] else float(value.replace(',', '.'))
            if not 0 <= position < 1e7:
                return None
        return Reply(rule['reply'], action={'name': 'control_video', 'action': rule['action'], 'time': position})
    return None


class MetaDialogue:
    def __init__(self, http: aiohttp.ClientSession, *, url: str | None = None) -> None:
        self.http = http
        self.url = url or "https://api.meta.ai/v1/chat/completions"
        self.model = os.getenv("VOICE_DIALOGUE_MODEL") or "muse-spark-1.2"

    async def reply(self, text: str, history: list[dict[str, str]], status: dict) -> Reply:
        started = time.monotonic()
        try:
            result = await self._reply(text, history, status)
            record('dialogue.reply', model=self.model, status='ok', elapsed_ms=round((time.monotonic() - started) * 1000))
            return result
        except Exception as exc:
            record('dialogue.reply', model=self.model, status='error', code=type(exc).__name__, elapsed_ms=round((time.monotonic() - started) * 1000))
            raise

    async def _complete(self, messages: list[dict], key: str | None, started: float) -> dict:
        body = {
            "model": self.model,
            "messages": messages, "tools": TOOLS, "parallel_tool_calls": False,
            # The cap includes invisible reasoning tokens as well as the short
            # spoken reply. 200 occasionally truncates before any visible text.
            "reasoning_effort": "minimal", "max_completion_tokens": 768,
        }
        async with self.http.post(self.url, headers={"Authorization": "Bearer " + (key or "")},
                                  json=body, timeout=aiohttp.ClientTimeout(total=12)) as response:
            if response.status != 200:
                raise RuntimeError(f"The Meta dialogue is not answering (HTTP {response.status}).")
            data = await response.json()
        record('dialogue.model', model=self.model,
               elapsed_ms=round((time.monotonic() - started) * 1000), status='ok')
        return data['choices'][0]['message']

    async def _reply(self, text: str, history: list[dict[str, str]], status: dict) -> Reply:
        instant = quick_playback(text)
        if instant:
            record('dialogue.shortcut', action=instant.action['action'], cached=True)
            return instant
        context_started = time.monotonic()
        if self.url == 'https://api.meta.ai/v1/chat/completions':
            try:
                async with self.http.get(os.getenv('SHOULDERCUT_BRIDGE', 'http://127.0.0.1:5173') + '/api/assistant/context', timeout=aiohttp.ClientTimeout(total=1)) as response:
                    if response.status == 200:
                        actual = await response.json()
                        status = {**actual, **status, 'edit_in_progress':
                                  status.get('edit_in_progress') or actual.get('edit_in_progress')}
            except (aiohttp.ClientError, TimeoutError):
                pass
        record('dialogue.context', elapsed_ms=round((time.monotonic() - context_started) * 1000))
        messages = [{"role": "developer", "content": INSTRUCTIONS + "\nActual status: " + json.dumps(status, ensure_ascii=False)}]
        messages += [{"role": "user" if m['role'] == 'user' else "assistant", "content": m['text']}
                     for m in history[-16:]]
        messages.append({"role": "user", "content": text})
        key = os.getenv("MODEL_API_KEY") or os.getenv("META_API_KEY") or os.getenv("MUSE_API_KEY")
        started = time.monotonic()
        message = await self._complete(messages, key, started)
        calls = message.get('tool_calls') or []
        if calls:
            if len(calls) != 1 or calls[0]['function']['name'] not in {t['function']['name'] for t in TOOLS}:
                raise ValueError("Unexpected conversation tool")
            args = json.loads(calls[0]['function']['arguments'])
            if not isinstance(args.get('reply'), str) or not args['reply'].strip():
                raise ValueError("Incomplete edit instruction")
            # The fast voice chooses whether to enqueue, never rewrites the
            # requested operation. The editing specialist gets the exact words.
            name = calls[0]['function']['name']
            if name == 'enqueue_edit':
                return Reply(args['reply'].strip(), text.strip())
            if name == 'control_video' and (args.get('action') not in ('play', 'pause', 'seek') or
                    (args['action'] == 'seek' and (not isinstance(args.get('time'), (int, float)) or not 0 <= args['time'] < 1e7))):
                raise ValueError('Invalid playback instruction')
            for field in ('subject',) if name == 'preview_subject' else ('query',) if name == 'find_moment' else ():
                if not isinstance(args.get(field), str) or not args[field].strip():
                    raise ValueError('Missing action subject')
            return Reply(args['reply'].strip(), action={'name': name, **args})
        spoken = message.get('content')
        if not isinstance(spoken, str) or not spoken.strip():
            raise ValueError("Empty conversation reply")
        # No tool: either genuine conversation, or an edit the model answered
        # in prose. See server/conversation.ts asksForAnEdit for why the reply
        # text cannot decide this and tool_choice cannot force it.
        if await self._asks_for_an_edit(text, key, started):
            record('dialogue.rescued_edit', model=self.model)
            return Reply(spoken.strip(), text.strip())
        return Reply(spoken.strip())

    async def _asks_for_an_edit(self, text: str, key: str | None, started: float) -> bool:
        """Does this request ask for the video to change? Yes or no is a far
        easier call for the model than picking one tool out of five, and it
        does not depend on how the first reply happened to be phrased."""
        try:
            verdict = await self._complete([
                {"role": "developer", "content":
                 "Answer with a single word: yes or no. Is the request about "
                 "changing the video (cut, reorder, effect, captions, tracked "
                 "cutout, replacement, export, undo)? A greeting, a thank you, a "
                 "question about your abilities or about the state of the "
                 "montage: no. A request for a preview alone: no."},
                {"role": "user", "content": text},
            ], key, started)
        except Exception:
            # A safety net, never a gate: a failure here must not swallow the
            # reply the user is already waiting for.
            return False
        return bool(re.match(r"\W*yes", str(verdict.get('content') or ''), re.IGNORECASE))
