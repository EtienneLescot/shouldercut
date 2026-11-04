"""Meta streaming STT -> imported Stimm -> Muse editing supervisor -> neural TTS.

The supervisor runs independently of speech playback: interrupting the voice
does not cancel an edit. Commands are serialized, with conversational history.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from uuid import uuid4
from pathlib import Path

import aiohttp
from dotenv import load_dotenv
from livekit import agents, rtc
from livekit.agents import AgentServer, AgentSession, JobContext, llm, tts, APIConnectOptions, SessionConnectOptions
from livekit.plugins import elevenlabs, google, meta, silero
from stimm import Supervisor, TranscriptMessage, VoiceAgent
from dialogue import MetaDialogue
from diagnostics import record, trace_id
from tts_health import QuotaAwareGeminiTTS, unavailable, public_voice_error

load_dotenv(Path(__file__).resolve().parents[1] / ".env")
if os.getenv("SHOULDERCUT_VOICE_ENV"):
    load_dotenv(os.environ["SHOULDERCUT_VOICE_ENV"])
logger = logging.getLogger("shouldercut.voice")
TOPIC = "shouldercut.voice"
BRIDGE = os.getenv("SHOULDERCUT_BRIDGE") or "http://127.0.0.1:5173"


def spoken_text(text: str) -> str:
    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", text)
    return " ".join(re.sub(r"[*`#>]", "", text).split())[:600]


def make_tts() -> tuple[tts.TTS, str]:
    engines: list[tts.TTS] = []
    names: list[str] = []
    key = os.getenv("ELEVEN_API_KEY") or os.getenv("ELEVENLABS_API_KEY")
    if key:
        engines.append(elevenlabs.TTS(
            api_key=key,
            model=os.getenv("TTS_MODEL") or "eleven_flash_v2_5",
            voice_id=os.getenv("TTS_VOICE") or "EXAVITQu4vr4xnSDxMaL",
            language="en",
        ))
        names.append("ElevenLabs")
    google_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
    if google_key:
        models = list(dict.fromkeys([os.getenv('GEMINI_TTS_MODEL') or 'gemini-3.8-flash-lite-tts',
                                    os.getenv('GEMINI_TTS_FALLBACK_MODEL') or 'gemini-3.8-flash-tts']))
        models.sort(key=unavailable)
        for model in models:
            engines.append(QuotaAwareGeminiTTS(
                api_key=google_key, model=model, voice_name=os.getenv('GEMINI_TTS_VOICE') or 'Kore'))
        names.append("Gemini")
    if not engines:
        raise RuntimeError("Configure ELEVEN_API_KEY (ElevenLabs) or GOOGLE_API_KEY (Gemini) in .env; see .env.example")
    engine = engines[0] if len(engines) == 1 else tts.FallbackAdapter(engines, max_retry_per_tts=0)
    return engine, " → ".join(names)


class EditingSupervisor(Supervisor):
    def __init__(self, room: rtc.Room, dialogue: MetaDialogue) -> None:
        super().__init__()
        self.live_room = room
        self.queue: asyncio.Queue[tuple[str, float, str | None]] = asyncio.Queue()
        self.history: list[dict[str, str]] = []
        self.edit_history: list[dict[str, str]] = []
        self.dialogue = dialogue
        self.dialogue_task: asyncio.Task | None = None
        self.preview_task: asyncio.Task | None = None
        self.preview_key: tuple | None = None
        self.preview_trace_id: str | None = None
        self.active_command: str | None = None
        self.tasks: set[asyncio.Task] = set()

    async def speak(self, text: str, **kwargs):
        # Text delivery must not depend on the speech provider's quota.
        await self.emit('transcript', role='agent', text=text)
        return await super().speak(text, **kwargs)

    async def emit(self, kind: str, **data) -> None:
        if kind in ('dialogue', 'action_done', 'edit_done'):
            record('voice.' + kind, **data)
        elif kind == 'error':
            record('voice.error', status='error', code=data.get('scope', 'pipeline'))
        await self.live_room.local_participant.publish_data(
            json.dumps({"type": kind, **data}, ensure_ascii=False), reliable=True, topic=TOPIC,
        )

    def schedule(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        task.add_done_callback(self._task_done)
        return task

    @staticmethod
    def _task_done(task: asyncio.Task) -> None:
        if not task.cancelled() and (error := task.exception()):
            logger.error("Voice task failed: %s", error, exc_info=error)

    async def on_transcript(self, msg: TranscriptMessage) -> None:
        if msg.partial or not msg.text.strip():
            return
        token = trace_id.set(trace_id.get() or self.trace_for(msg.text))
        try:
            record('voice.turn', status='accepted')
            await self.emit("transcript", role="user", text=msg.text)
            if self.dialogue_task and not self.dialogue_task.done():
                self.dialogue_task.cancel()
            self.dialogue_task = self.schedule(self.respond(msg.text))
        finally:
            trace_id.reset(token)

    def dialogue_key(self, text: str) -> tuple:
        return (tuple(re.findall(r"\w+", text.casefold())), self.active_command, self.queue.qsize())

    def trace_for(self, text: str) -> str:
        return self.preview_trace_id if self.preview_key == self.dialogue_key(text) and self.preview_trace_id else uuid4().hex

    def preview(self, text: str) -> None:
        """Prepare a stable partial, but never speak or edit before its final.

        Only the same final words can consume the result. A changed ending
        invalidates it, so speculative work cannot commit a partial command.
        """
        key = self.dialogue_key(text)
        if len(key[0]) < 3 or key == self.preview_key:
            return
        if self.preview_task and not self.preview_task.done():
            self.preview_task.cancel()
        self.preview_key = key
        self.preview_trace_id = uuid4().hex
        speculative_trace = self.preview_trace_id
        async def prepare():
            trace_id.set(speculative_trace)
            await asyncio.sleep(.3)
            return await self.dialogue.reply(text, self.history, {
                "montage_en_cours": self.active_command, "commandes_en_attente": self.queue.qsize(),
            })
        self.preview_task = self.schedule(prepare())

    async def respond(self, text: str) -> None:
        started = time.monotonic()
        try:
            preview = self.preview_task if self.preview_key == self.dialogue_key(text) else None
            if not preview and self.preview_task and not self.preview_task.done():
                self.preview_task.cancel()
            self.preview_key = None
            self.preview_task = None
            if preview and not preview.cancelled() and not (preview.done() and preview.exception()):
                decision = await preview
            else:
                decision = await self.dialogue.reply(text, self.history, {
                    "montage_en_cours": self.active_command, "commandes_en_attente": self.queue.qsize(),
                })
        except Exception as exc:
            await self.emit("error", message=str(exc))
            self.schedule(self.speak("I did not catch that. Could you say it again?"))
            return
        self.history.extend([{"role": "user", "text": text}, {"role": "agent", "text": decision.text}])
        if decision.action:
            self.schedule(self.execute_action(decision.action))
        if decision.command:
            self.queue.put_nowait((text, time.monotonic(), trace_id.get()))
        await self.emit("dialogue", elapsed_ms=round((time.monotonic() - started) * 1000), cached=bool(preview), editing=bool(decision.command), action=decision.action.get("name") if decision.action else None)
        self.schedule(self.speak(decision.text))

    async def execute_action(self, action: dict) -> None:
        started = time.monotonic()
        await self.emit('action_started')
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=150)) as http:
                async with http.post(BRIDGE + '/api/assistant/action', json=action,
                                     headers={'X-ShoulderCut-Trace': trace_id.get() or ''}) as response:
                    data = await response.json()
                    if response.status != 200 or not data.get('ok'):
                        raise RuntimeError(data.get('message', 'The action failed.'))
            reply = data['reply']
            self.history.append({'role': 'agent', 'text': reply})
            await self.emit('action_done', elapsed_ms=round((time.monotonic()-started)*1000))
            # Playback acknowledgements already describe the action; avoid two
            # competing TTS utterances for a sub-second operation.
            if action['name'] in ('preview_subject', 'find_moment'):
                self.schedule(self.speak(reply))
        except Exception as exc:
            await self.emit('error', message=str(exc), scope='action')
            self.history.append({'role': 'agent', 'text': 'Action not confirmed: '+str(exc)})
            self.schedule(self.speak('I could not finish that action. '+str(exc)))

    async def run(self) -> None:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=280)) as http:
            while True:
                text, queued_at, turn_id = await self.queue.get()
                token = trace_id.set(turn_id)
                record('editor.queue', queue_ms=round((time.monotonic() - queued_at) * 1000))
                self.active_command = text
                started = time.monotonic()
                try:
                    await self.emit("editing", text=text)
                    async with http.post(BRIDGE + "/api/voice/supervise", json={
                        "message": text, "history": self.edit_history[-24:],
                    }, headers={'X-ShoulderCut-Trace': turn_id or ''}) as response:
                        data = await response.json()
                        if response.status != 200 or not data.get("ok"):
                            raise RuntimeError(data.get("message", "The edit failed."))
                    reply = spoken_text(data.get("reply") or "C'est fait.")
                    self.edit_history.extend([{"role": "user", "text": text}, {"role": "agent", "text": reply}])
                    self.history.append({"role": "agent", "text": reply})
                    await self.emit("edit_done", elapsed_ms=round((time.monotonic() - started) * 1000), pending=self.queue.qsize())
                except Exception as exc:
                    logger.exception("Supervisor failed")
                    await self.emit("error", message=str(exc), scope="editing", pending=self.queue.qsize())
                    reply = "The edit failed. The details are on screen."
                    self.history.append({"role": "agent", "text": "The edit is not confirmed: " + str(exc)})
                finally:
                    self.active_command = None
                    self.queue.task_done()
                self.schedule(self.speak(reply))
                trace_id.reset(token)


class ShoulderCutVoice(VoiceAgent):
    telemetry_supervisor: EditingSupervisor | None = None

    async def on_user_turn_completed(self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage) -> None:
        # Submit a complete conversational turn, never each partial ASR segment.
        text = new_message.text_content or ''
        token = trace_id.set(self.telemetry_supervisor.trace_for(text) if self.telemetry_supervisor else uuid4().hex)
        try:
            # Relay mode has no LiveKit LLM and therefore doesn't commit user
            # messages to conversation_item_added. Capture its real turn metrics here.
            record('voice.user_metrics', messageId=new_message.id, **{
                name + '_ms': round(value * 1000) for name, value in new_message.metrics.items()
                if name in ('transcription_delay', 'end_of_turn_delay') and isinstance(value, (float, int))})
            self.session.interrupt()
            await self.publish_transcript(text, partial=False)
        finally:
            trace_id.reset(token)


# This is a single-user local demo worker. Background GPU/CPU workloads must
# not make LiveKit refuse every dispatch because the host is busy.
server = AgentServer(num_idle_processes=1, load_fnc=lambda _: 0.0, host="127.0.0.1", port=8081)


@server.rtc_session(agent_name="shouldercut")
async def entrypoint(ctx: JobContext) -> None:
    started = time.monotonic()
    await ctx.connect()
    try:
        await ctx.wait_for_participant()
    except RuntimeError as exc:
        if 'room disconnected while waiting for participant' not in str(exc):
            raise
        record('voice.join', status='cancelled')
        return
    # SSL trust-store loading and ONNX setup are synchronous. Keep both off
    # the audio event loop; certificate verification remains enabled.
    (engine, provider), vad = await asyncio.gather(
        asyncio.to_thread(make_tts), asyncio.to_thread(silero.VAD.load))
    record('voice.initialize', elapsed_ms=round((time.monotonic() - started) * 1000), provider=provider)
    dialogue_http = aiohttp.ClientSession()
    supervisor = EditingSupervisor(ctx.room, MetaDialogue(dialogue_http))
    agent = ShoulderCutVoice(
        mode="relay",
        instructions="You are the ShoulderCut editing assistant. Speak English.",
        stt=meta.STT(language_bias=["English"], keywords=[
            "ShoulderCut", "X-wing", "WGSL", "trim", "crop", "cut", "reframe", "captions", "undo",
        ]),
        vad=vad, tts=engine,
    )
    session = AgentSession(conn_options=SessionConnectOptions(tts_conn_options=APIConnectOptions(max_retry=0)),
                           turn_handling={"turn_detection": "stt", "endpointing": {"min_delay": .2},
                                         "interruption": {"mode": "vad", "min_duration": .2}})
    supervisor.attach(agent)
    agent.telemetry_supervisor = supervisor

    @session.on("user_input_transcribed")
    def partial(ev):
        if ev.transcript:
            supervisor.schedule(supervisor.emit("partial", text=ev.transcript))
            if not ev.is_final:
                supervisor.preview(ev.transcript)

    @session.on("conversation_item_added")
    def said(ev):
        if isinstance(ev.item, llm.ChatMessage):
            metrics = {name + '_ms': round(value * 1000) for name, value in ev.item.metrics.items()
                       if name in ('transcription_delay', 'end_of_turn_delay', 'on_user_turn_completed_delay',
                                   'tts_node_ttfb', 'e2e_latency', 'playback_latency', 'llm_node_ttft')
                       and isinstance(value, (float, int))}
            record('voice.turn_metrics', sessionId=ctx.room.name, messageId=ev.item.id, role=ev.item.role, **metrics)

    @session.on("agent_state_changed")
    def state(ev):
        supervisor.schedule(supervisor.emit("state", state=ev.new_state))

    @session.on("error")
    def failed(ev):
        record('voice.pipeline', status='error', code=type(ev.error).__name__)
        if getattr(ev.error, 'recoverable', False):
            return
        supervisor.schedule(supervisor.emit('error', message=public_voice_error(ev.error)))

    @engine.on('metrics_collected')
    def tts_metrics(metrics):
        record('voice.tts', provider=provider, model=engine.model,
               ttfb_ms=round(metrics.ttfb * 1000), elapsed_ms=round(metrics.duration * 1000),
               status='cancelled' if metrics.cancelled else 'ok')

    @ctx.room.on("data_received")
    def context(packet):
        if packet.topic == "shouldercut.context":
            try:
                history = json.loads(packet.data).get("history", [])
                if isinstance(history, list):
                    supervisor.history = [m for m in history[-24:] if isinstance(m, dict)
                                          and m.get("role") in ("user", "agent") and isinstance(m.get("text"), str)]
                    supervisor.edit_history = supervisor.history.copy()
            except (ValueError, AttributeError):
                logger.warning("Invalid voice context")

    if isinstance(engine, tts.FallbackAdapter):
        @engine.on("tts_availability_changed")
        def availability(ev):
            supervisor.schedule(supervisor.emit("provider", provider=ev.tts.label, available=ev.available))

    worker = asyncio.create_task(supervisor.run())

    async def shutdown():
        worker.cancel()
        for task in list(supervisor.tasks):
            task.cancel()
        await asyncio.gather(worker, *supervisor.tasks, return_exceptions=True)
        await dialogue_http.close()
        await engine.aclose()

    ctx.add_shutdown_callback(shutdown)
    await session.start(agent=agent, room=ctx.room)
    await supervisor.emit("ready", provider=provider, dialogue_model=supervisor.dialogue.model)
    await supervisor.speak("Hey! What are we making with this video?")


if __name__ == "__main__":
    for required in ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"):
        if not os.getenv(required):
            raise RuntimeError(f"Configure {required} for your LiveKit Cloud project in .env")
    if not any(os.getenv(key) for key in ('ELEVEN_API_KEY', 'ELEVENLABS_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY')):
        raise RuntimeError('Configure ELEVEN_API_KEY or GOOGLE_API_KEY in .env')
    agents.cli.run_app(server)
