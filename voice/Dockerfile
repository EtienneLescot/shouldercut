# The voice worker: a LiveKit agent that talks to the editor over its API.
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

# uv manages the dependencies, exactly as it does outside the container.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /voice
COPY pyproject.toml ./
COPY uv.lock* ./
RUN uv sync --no-install-project 2>/dev/null || uv sync

COPY . .

EXPOSE 8081
CMD ["uv", "run", "python", "agent.py", "start"]
