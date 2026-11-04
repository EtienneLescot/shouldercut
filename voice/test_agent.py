"""Regression checks for the voice/edit boundary; no paid API calls."""
import asyncio
import unittest
from unittest.mock import patch

from aiohttp import web
from stimm import TranscriptMessage

import agent
from dialogue import Reply


class FakeDialogue:
    async def reply(self, text, history, status):
        if text == 'Mets en pause':
            return Reply('Je mets en pause.', action={'name': 'control_video', 'action': 'pause', 'time': None})
        if text == 'Où en es-tu ?':
            return Reply('Je travaille encore sur le flou.')
        return Reply('Je vais le faire.', text)


class VoiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.requests = []
        self.actions = []
        self.action_reached = asyncio.Event()
        self.reached = asyncio.Event()
        self.release = asyncio.Event()
        self.events = []
        self.speeches = []
        self.fail_edit = False
        self.supervisor = agent.EditingSupervisor(None, FakeDialogue())

        async def emit(kind, **data):
            self.events.append((kind, data))

        async def speak(text, **kwargs):
            self.speeches.append(text)
            await asyncio.Event().wait()

        self.supervisor.emit = emit
        self.supervisor.speak = speak

        async def edit(request):
            data = await request.json()
            self.requests.append(data)
            self.reached.set()
            await self.release.wait()
            if self.fail_edit:
                return web.json_response({"ok": False, "message": "Suivi indisponible"}, status=500)
            return web.json_response({"ok": True, "reply": "**C'est fait.**"})

        async def action(request):
            self.actions.append(await request.json())
            self.action_reached.set()
            return web.json_response({'ok': True, 'reply': 'Vidéo en pause.'})

        app = web.Application()
        app.router.add_post('/api/assistant/action', action)
        app.router.add_post('/api/voice/supervise', edit)
        self.runner = web.AppRunner(app)
        await self.runner.setup()
        site = web.TCPSite(self.runner, '127.0.0.1', 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        self.bridge = patch.object(agent, 'BRIDGE', f'http://127.0.0.1:{port}')
        self.bridge.start()
        self.worker = asyncio.create_task(self.supervisor.run())

    async def asyncTearDown(self):
        self.release.set()
        self.worker.cancel()
        tasks = list(self.supervisor.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(self.worker, *tasks, return_exceptions=True)
        await self.runner.cleanup()
        self.bridge.stop()

    async def turn(self, text, partial=False):
        await self.supervisor.on_transcript(TranscriptMessage(text=text, partial=partial, timestamp=0))

    async def test_interruption_does_not_cancel_edit_and_next_command_keeps_history(self):
        await self.turn('Ajoute un flou', partial=True)
        self.assertTrue(self.supervisor.queue.empty())
        await self.turn('Ajoute un flou')
        await asyncio.wait_for(self.reached.wait(), 2)
        # Cancel every in-flight voice utterance as if the user barged in.
        for task in list(self.supervisor.tasks):
            task.cancel()
        await self.turn('Un peu moins')
        await self.supervisor.dialogue_task
        self.assertEqual(len(self.requests), 1)
        self.release.set()
        await asyncio.wait_for(self.supervisor.queue.join(), 2)
        self.assertEqual([r['message'] for r in self.requests], ['Ajoute un flou', 'Un peu moins'])
        self.assertEqual(self.requests[1]['history'], [
            {'role': 'user', 'text': 'Ajoute un flou'}, {'role': 'agent', 'text': "C'est fait."},
        ])
        self.assertEqual(sum(kind == 'edit_done' for kind, _ in self.events), 2)

    async def test_playback_bypasses_blocked_edit_and_waits_for_final(self):
        await self.turn('Ajoute un flou')
        await asyncio.wait_for(self.reached.wait(), 2)
        self.supervisor.preview('Mets en pause')
        await self.supervisor.preview_task
        self.assertEqual(self.actions, [])
        await self.turn('Mets en pause')
        await self.supervisor.dialogue_task
        await asyncio.wait_for(self.action_reached.wait(), 2)
        self.assertEqual(self.actions[0]['action'], 'pause')
        self.assertEqual(len(self.requests), 1)
        self.assertEqual(self.supervisor.active_command, 'Ajoute un flou')
        self.assertTrue(self.supervisor.queue.empty())

    async def test_missing_credentials_fails_clearly(self):
        with patch.dict(agent.os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, 'ELEVEN_API_KEY'):
                agent.make_tts()

    async def test_partial_response_is_reused_but_never_executes_before_final(self):
        with patch.object(self.supervisor.dialogue, 'reply', wraps=self.supervisor.dialogue.reply) as reply:
            self.supervisor.preview('Rogne une seconde')
            await self.supervisor.preview_task
            self.assertEqual(self.requests, [])
            self.assertEqual(self.speeches, [])
            await self.turn('Rogne une seconde.')
            await self.supervisor.dialogue_task
            await asyncio.wait_for(self.reached.wait(), 1)
            self.assertEqual(reply.call_count, 1)
            self.assertEqual(self.requests[0]['message'], 'Rogne une seconde.')

    async def test_changed_final_discards_speculative_edit(self):
        self.supervisor.preview('Rogne une seconde')
        await self.supervisor.preview_task
        await self.turn('Où en es-tu ?')
        await self.supervisor.dialogue_task
        self.assertEqual(self.requests, [])
        self.assertTrue(self.supervisor.queue.empty())

    async def test_edit_failure_clears_work_and_does_not_claim_success(self):
        self.fail_edit = True
        self.release.set()
        await self.turn('Ajoute un flou')
        await self.supervisor.dialogue_task
        await asyncio.wait_for(self.supervisor.queue.join(), 2)
        errors = [payload for kind, payload in self.events if kind == 'error']
        self.assertEqual(errors[-1]['scope'], 'editing')
        self.assertEqual(errors[-1]['pending'], 0)
        self.assertIsNone(self.supervisor.active_command)
        self.assertFalse(any(kind == 'edit_done' for kind, _ in self.events))

    async def test_conversation_during_edit_does_not_enqueue_another_edit(self):
        await self.turn('Ajoute un flou')
        await asyncio.wait_for(self.reached.wait(), 2)
        await self.turn('Où en es-tu ?')
        await self.supervisor.dialogue_task
        await asyncio.sleep(0)
        self.assertEqual(len(self.requests), 1)
        self.assertTrue(self.supervisor.queue.empty())
        self.assertIn('Je travaille encore sur le flou.', self.speeches)

    async def test_stimm_stream_finishes_for_both_livekit_readers(self):
        from stimm.voice_agent import _SpeechStream
        from livekit.agents.utils.aio.itertools import tee
        stream = _SpeechStream()
        stream.push('Bonjour.'); stream.close()
        async def read(source):
            return [item async for item in source]
        results = await asyncio.wait_for(asyncio.gather(*(read(peer) for peer in tee(stream, 2))), .5)
        self.assertEqual(results, [['Bonjour.'], ['Bonjour.']])

    async def test_new_turn_cancels_only_the_unaccepted_dialogue(self):
        begun = asyncio.Event()
        original = self.supervisor.dialogue.reply
        async def delayed(text, history, status):
            if text == 'Première idée':
                begun.set()
                await asyncio.Event().wait()
            return await original(text, history, status)
        self.supervisor.dialogue.reply = delayed
        await self.turn('Première idée')
        await asyncio.wait_for(begun.wait(), 1)
        previous = self.supervisor.dialogue_task
        await self.turn('Nouvelle idée')
        await self.supervisor.dialogue_task
        await asyncio.wait_for(self.reached.wait(), 1)
        self.assertTrue(previous.cancelled())
        self.assertEqual([request['message'] for request in self.requests], ['Nouvelle idée'])

    async def test_tts_provider_order_and_gemini_without_elevenlabs(self):
        with patch.dict(agent.os.environ, {'ELEVEN_API_KEY': 'test', 'GOOGLE_API_KEY': 'test'}, clear=True):
            engine, name = agent.make_tts()
            self.assertIsInstance(engine, agent.tts.FallbackAdapter)
            self.assertEqual(name, 'ElevenLabs → Gemini')
            await engine.aclose()
        with patch.dict(agent.os.environ, {'GOOGLE_API_KEY': 'test'}, clear=True):
            engine, name = agent.make_tts()
            self.assertEqual(name, 'Gemini')
            await engine.aclose()

    async def test_tts_construction_can_run_off_audio_loop(self):
        with patch.dict(agent.os.environ, {'GOOGLE_API_KEY': 'test'}, clear=True):
            engine, name = await asyncio.to_thread(agent.make_tts)
            self.assertEqual(name, 'Gemini')
            await engine.aclose()


if __name__ == '__main__':
    unittest.main()
