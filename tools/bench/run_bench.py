"""Run the ShoulderCut WebGPU bench in headless Chrome and save JSON results.

Prerequisite: Python Playwright available (`python -c "import playwright"`).
The bench page itself is tools/bench/index.html; test videos live in
tools/bench/assets/ (generated locally, git-ignored).
"""

import argparse
import asyncio
import functools
import http.server
import json
import threading
from pathlib import Path

from playwright.async_api import async_playwright

HERE = Path(__file__).resolve().parent
DEFAULT_CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
CHROME_FLAGS = [
    "--headless=new",
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--enable-webgl",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--enable-unsafe-swiftshader",
    "--autoplay-policy=no-user-gesture-required",
]
SCENARIOS = {
    "1080p": "?seconds=5",
    "1080p-vf-rate2": "?seconds=4&rate=2&vf=1",
    "1080p-mask-upload": "?seconds=5&maskUpload=1",
    "2160p": "?src=assets/test-2160p.mp4&seconds=5",
}


def start_server(port: int):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(HERE))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def run_scenario(page, port: int, name: str, query: str, timeout_s: int):
    messages: list[str] = []
    page.on("console", lambda m: messages.append(f"[{m.type}] {m.text}"))
    page.on("pageerror", lambda e: messages.append(f"[pageerror] {e}"))
    page.on("requestfailed", lambda r: messages.append(f"[requestfailed] {r.url}"))
    await page.goto(f"http://127.0.0.1:{port}/index.html{query}", wait_until="commit", timeout=30000)
    await page.wait_for_function("document.title === 'BENCH_DONE'", timeout=timeout_s * 1000)
    payload = await page.evaluate("window.__BENCH")
    out_dir = HERE / "runs" / name
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "result.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
    (out_dir / "console.txt").write_text("\n".join(messages), encoding="utf-8")
    await page.locator("#screen").screenshot(path=str(out_dir / "canvas.png"))
    result = payload.get("result") or {}
    gpu = (result.get("gpuPassMs") or {}).get("totalMeasuredPasses") or {}
    print(
        f"{name}: fps={result.get('fps')} frames={result.get('measuredFrames')} "
        f"js_avg_ms={(result.get('jsSubmit') or {}).get('avgMs')} "
        f"gpu_total_avg_ms={gpu.get('avgMs')} gpu_total_p95_ms={gpu.get('p95Ms')} "
        f"faults={payload.get('faults')}"
    )
    return payload


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--chrome", default=DEFAULT_CHROME)
    parser.add_argument("--port", type=int, default=8793)
    parser.add_argument("--timeout", type=int, default=90)
    parser.add_argument("--only", default="", help="comma-separated scenario names")
    args = parser.parse_args()
    names = [n.strip() for n in args.only.split(",") if n.strip()] or list(SCENARIOS)
    server = start_server(args.port)
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(executable_path=args.chrome, args=CHROME_FLAGS)
            for name in names:
                page = await browser.new_page(viewport={"width": 1020, "height": 820})
                try:
                    await run_scenario(page, args.port, name, SCENARIOS[name], args.timeout)
                finally:
                    await page.close()
            await browser.close()
    finally:
        server.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
