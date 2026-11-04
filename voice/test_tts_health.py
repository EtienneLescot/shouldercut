import unittest
from unittest.mock import patch
from livekit.agents import APIStatusError
from tts_health import QuotaAwareGeminiTTS, quota_delay, public_voice_error

class QuotaTests(unittest.IsolatedAsyncioTestCase):
    def test_daily_quota_honors_provider_retry_delay_but_not_a_temporary_rate_limit(self):
        error = APIStatusError('quota', status_code=429, body='requests_per_model_per_day {"retryDelay":"51811s"}')
        self.assertEqual(quota_delay(error), 51811)
        self.assertIsNone(quota_delay(APIStatusError('rpm', status_code=429, body='requests_per_minute')))
        self.assertNotIn('51811', public_voice_error(error))

    async def test_cooldown_refuses_before_any_provider_request(self):
        with patch('tts_health.unavailable', return_value=True):
            engine = await __import__('asyncio').to_thread(QuotaAwareGeminiTTS, api_key='test', model='gemini-3.8-flash-lite-tts')
            with self.assertRaises(APIStatusError) as result:
                engine.synthesize('Bonjour')
            self.assertFalse(result.exception.retryable)
            await engine.aclose()
