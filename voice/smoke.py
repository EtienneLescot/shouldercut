"""Real Cloud round trip with a synthetic microphone, not the user's live mic.

Requires the running demo and an open editor. The command really executes.
Run: uv run python smoke.py "Trim the first second off the first clip."
"""
import asyncio
import json
import sys
import time
from array import array

import aiohttp
from livekit import rtc
from livekit.agents.utils import http_context

from agent import BRIDGE, TOPIC, make_tts
from diagnostics import record


async def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "Pause the video."
    expect_action = '--action' in sys.argv
    expect_edit = '--conversation' not in sys.argv and not expect_action
    async with http_context.open(), aiohttp.ClientSession() as http:
        engine, provider = make_tts()
        pcm = bytearray()
        async with engine.synthesize(command) as stream:
            async for event in stream:
                pcm.extend(event.frame.data)
        rate = engine.sample_rate
        await engine.aclose()
        async with http.get(BRIDGE + '/api/voice/token') as response:
            token = await response.json()
            if response.status != 200:
                raise RuntimeError(token.get('message'))
        room = rtc.Room()
        ready, greeting, edited, confirmed = (asyncio.Event() for _ in range(4))
        start_speech = asyncio.Event()
        action_done = asyncio.Event()
        audible_response = asyncio.Event()
        greeting_speaking = False
        action_ms = None
        tasks = []
        audio_samples = 0
        peak = 0
        sent_at = 0.0
        heard_at = 0.0
        failure = None
        route_is_edit = None
        dialogue_ms = None
        response_started = None

        @room.on('data_received')
        def data(packet):
            nonlocal heard_at, failure, route_is_edit, dialogue_ms, action_ms, greeting_speaking
            if packet.topic != TOPIC:
                return
            event = json.loads(packet.data)
            print(json.dumps(event, ensure_ascii=False), flush=True)
            if event['type'] == 'ready':
                ready.set()
            if event['type'] == 'transcript':
                if event.get('role') == 'user':
                    heard_at = time.monotonic()
                elif start_speech.is_set() and edited.is_set():
                    confirmed.set()
            if event['type'] == 'action_done':
                action_ms = event['elapsed_ms']
                action_done.set()
            if event['type'] == 'edit_done':
                edited.set()
            if event['type'] == 'dialogue':
                route_is_edit = bool(event['editing'])
                dialogue_ms = event['elapsed_ms']
                if not route_is_edit:
                    edited.set()
            if event['type'] == 'state' and not start_speech.is_set():
                if event.get('state') == 'speaking':
                    greeting_speaking = True
                elif event.get('state') == 'listening' and greeting_speaking:
                    greeting.set()
            if event['type'] == 'error':
                failure = event.get('message', 'Voice pipeline failed')
                edited.set()
                confirmed.set()
                audible_response.set()
                greeting.set()

        async def consume(track):
            nonlocal audio_samples, peak, response_started
            stream = rtc.AudioStream(track)
            try:
                async for event in stream:
                    audio_samples += event.frame.samples_per_channel
                    samples = array('h', bytes(event.frame.data))
                    peak = max(peak, max(map(abs, samples), default=0))
                    if heard_at and response_started is None and max(map(abs, samples), default=0) > 10:
                        response_started = time.monotonic()
                        audible_response.set()
            finally:
                await stream.aclose()

        @room.on('track_subscribed')
        def track(track, publication, participant):
            print(json.dumps({'subscribed_track': track.name, 'kind': track.kind}), flush=True)
            if track.kind == rtc.TrackKind.KIND_AUDIO:
                tasks.append(asyncio.create_task(consume(track)))

        @room.on('track_subscription_failed')
        def subscription_failed(track_sid, participant, error):
            print(json.dumps({'subscription_error': str(error)}), flush=True)

        await room.connect(token['url'], token['token'])
        source = rtc.AudioSource(rate, 1)
        microphone = rtc.LocalAudioTrack.create_audio_track('smoke-command', source)
        await room.local_participant.publish_track(microphone, rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_MICROPHONE))

        async def feed():
            offset = 0
            width = rate // 50 * 2
            clock = time.monotonic()
            index = 0
            while True:
                chunk = bytes(width)
                if start_speech.is_set() and offset < len(pcm):
                    chunk = bytes(pcm[offset:offset + width]).ljust(width, b'\0')
                    offset += width
                await source.capture_frame(rtc.AudioFrame(chunk, rate, 1, width // 2))
                index += 1
                await asyncio.sleep(max(0, clock + index * .02 - time.monotonic()))

        tasks.append(asyncio.create_task(feed()))
        try:
            await asyncio.wait_for(ready.wait(), 40)
            print(json.dumps({'remote_tracks': [len(p.track_publications) for p in room.remote_participants.values()]}), flush=True)
            await asyncio.wait_for(greeting.wait(), 20)
            assert failure is None, failure
            sent_at = time.monotonic()
            start_speech.set()
            await asyncio.wait_for(edited.wait(), 120)
            await asyncio.wait_for(confirmed.wait(), 20)
            await asyncio.wait_for(audible_response.wait(), 20)
            if expect_action:
                await asyncio.wait_for(action_done.wait(), 30)
            assert failure is None, failure
            assert route_is_edit == expect_edit, 'Conversation was routed to the wrong path'
            assert audio_samples > 0 and peak > 0, 'No audible agent output received'
            assert heard_at > 0, 'No user transcript returned'
            record('validation.voice', provider=provider, status='ok',
                   transcription_delay_ms=round((heard_at - sent_at - len(pcm) / (rate * 2)) * 1000),
                   e2e_latency_ms=round((response_started - sent_at - len(pcm) / (rate * 2)) * 1000))
            print(json.dumps({'ok': True, 'provider': provider, 'received_audio_samples': audio_samples,
                              'peak': peak, 'speech_to_transcript_s': round(heard_at - sent_at, 2),
                              'speech_duration_s': round(len(pcm) / (rate * 2), 2),
                              'speech_end_to_transcript_s': round(heard_at - sent_at - len(pcm) / (rate * 2), 2),
                              'dialogue_ms': dialogue_ms, 'action_ms': action_ms, 'editing': route_is_edit,
                              'turn_to_audio_s': round(response_started - heard_at, 2) if response_started else None}, ensure_ascii=False))
        finally:
            print(json.dumps({'received_audio_samples': audio_samples, 'peak': peak}), flush=True)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await source.aclose()
            await room.disconnect()


if __name__ == '__main__':
    asyncio.run(main())
