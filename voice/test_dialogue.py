import json
import unittest

import aiohttp
from aiohttp import web

from dialogue import MetaDialogue, quick_playback


class DialogueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.message = {'content': 'I can cut your clips.'}
        self.sent = None
        # Every request, because _asks_for_an_edit fires a second one
        # whenever no tool was called and it would otherwise hide the first.
        self.requests = []
        async def respond(request):
            self.sent = await request.json()
            self.requests.append(self.sent)
            return web.json_response({'choices': [{'message': self.message}]})
        app = web.Application(); app.router.add_post('/chat', respond)
        self.runner = web.AppRunner(app); await self.runner.setup()
        site = web.TCPSite(self.runner, '127.0.0.1', 0); await site.start()
        self.http = aiohttp.ClientSession()
        self.dialogue = MetaDialogue(self.http, url=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/chat')

    async def asyncTearDown(self):
        await self.http.close(); await self.runner.cleanup()

    async def test_plain_conversation_has_no_edit_and_receives_real_work_status(self):
        result = await self.dialogue.reply('What are you doing?', [{'role': 'agent', 'text': 'Hi'}], {'edit_in_progress': 'blur'})
        self.assertIsNone(result.command)
        self.assertIn('blur', self.requests[0]['messages'][0]['content'])
        self.assertEqual(self.requests[0]['messages'][1]['role'], 'assistant')

    async def test_explicit_playback_needs_no_model_but_negations_are_not_shortcuts(self):
        result = await self.dialogue.reply('Go to one second.', [], {})
        self.assertEqual(result.action['time'], 1)
        self.assertIsNone(self.sent)
        self.assertEqual(quick_playback('Jump to 2.5 seconds').action['time'], 2.5)
        for text in ['Do not pause', 'Pause then cut', 'If I say pause', 'Go to one second and add a blur']:
            self.assertIsNone(quick_playback(text))

    async def test_explicit_tool_call_preserves_original_words(self):
        self.message = {'tool_calls': [{'function': {'name': 'enqueue_edit', 'arguments': json.dumps({
            'instruction': 'Trim 1 second off the first clip.', 'reply': 'Shortening the start.'})}}]}
        result = await self.dialogue.reply('Trim one second', [], {})
        self.assertEqual(result.command, 'Trim one second')

    async def test_fast_playback_has_no_edit_command(self):
        self.message = {'tool_calls': [{'function': {'name': 'control_video', 'arguments': json.dumps({
            'action': 'seek', 'time': 2.5, 'reply': 'Showing that moment.'})}}]}
        result = await self.dialogue.reply('Go to two and a half seconds', [], {})
        self.assertIsNone(result.command)
        self.assertEqual(result.action['time'], 2.5)

    async def test_invalid_seek_cannot_execute(self):
        self.message = {'tool_calls': [{'function': {'name': 'control_video', 'arguments': json.dumps({
            'action': 'seek', 'time': -1, 'reply': 'Moving playback.'})}}]}
        with self.assertRaises(ValueError):
            await self.dialogue.reply('Go back', [], {})

    async def test_malformed_tool_never_enters_the_edit_queue(self):
        self.message = {'tool_calls': [{'function': {'name': 'enqueue_edit', 'arguments': '{"reply":null}'}}]}
        with self.assertRaises(ValueError):
            await self.dialogue.reply('Rogne', [], {})


if __name__ == '__main__':
    unittest.main()
