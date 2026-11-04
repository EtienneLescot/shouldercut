import json
import unittest

import aiohttp
from aiohttp import web

from dialogue import MetaDialogue, quick_playback


class DialogueTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.message = {'content': 'Je peux couper tes clips.'}
        self.sent = None
        async def respond(request):
            self.sent = await request.json()
            return web.json_response({'choices': [{'message': self.message}]})
        app = web.Application(); app.router.add_post('/chat', respond)
        self.runner = web.AppRunner(app); await self.runner.setup()
        site = web.TCPSite(self.runner, '127.0.0.1', 0); await site.start()
        self.http = aiohttp.ClientSession()
        self.dialogue = MetaDialogue(self.http, url=f'http://127.0.0.1:{site._server.sockets[0].getsockname()[1]}/chat')

    async def asyncTearDown(self):
        await self.http.close(); await self.runner.cleanup()

    async def test_plain_conversation_has_no_edit_and_receives_real_work_status(self):
        result = await self.dialogue.reply('Tu fais quoi ?', [{'role': 'agent', 'text': 'Salut'}], {'montage_en_cours': 'flou'})
        self.assertIsNone(result.command)
        self.assertIn('flou', self.sent['messages'][0]['content'])
        self.assertEqual(self.sent['messages'][1]['role'], 'assistant')

    async def test_explicit_playback_needs_no_model_but_negations_are_not_shortcuts(self):
        result = await self.dialogue.reply('Mets la vidéo à une seconde.', [], {})
        self.assertEqual(result.action['time'], 1)
        self.assertIsNone(self.sent)
        self.assertEqual(quick_playback('Va à 2,5 secondes').action['time'], 2.5)
        for text in ['Ne mets pas en pause', 'Mets en pause puis coupe', 'Si je dis pause', 'Mets la vidéo à une seconde et ajoute un flou']:
            self.assertIsNone(quick_playback(text))

    async def test_explicit_tool_call_preserves_original_words(self):
        self.message = {'tool_calls': [{'function': {'name': 'enqueue_edit', 'arguments': json.dumps({
            'instruction': 'Rogne 1 seconde du premier clip.', 'reply': 'Je raccourcis le début.'})}}]}
        result = await self.dialogue.reply('Rogne une seconde', [], {})
        self.assertEqual(result.command, 'Rogne une seconde')

    async def test_fast_playback_has_no_edit_command(self):
        self.message = {'tool_calls': [{'function': {'name': 'control_video', 'arguments': json.dumps({
            'action': 'seek', 'time': 2.5, 'reply': 'Je montre ce passage.'})}}]}
        result = await self.dialogue.reply('Va à deux secondes et demie', [], {})
        self.assertIsNone(result.command)
        self.assertEqual(result.action['time'], 2.5)

    async def test_invalid_seek_cannot_execute(self):
        self.message = {'tool_calls': [{'function': {'name': 'control_video', 'arguments': json.dumps({
            'action': 'seek', 'time': -1, 'reply': 'Je déplace la lecture.'})}}]}
        with self.assertRaises(ValueError):
            await self.dialogue.reply('Recule', [], {})

    async def test_malformed_tool_never_enters_the_edit_queue(self):
        self.message = {'tool_calls': [{'function': {'name': 'enqueue_edit', 'arguments': '{"reply":null}'}}]}
        with self.assertRaises(ValueError):
            await self.dialogue.reply('Rogne', [], {})


if __name__ == '__main__':
    unittest.main()
