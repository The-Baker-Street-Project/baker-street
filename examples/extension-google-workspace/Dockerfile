FROM python:3.11-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl git && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv

# Clone the MCP server source
ARG GWS_REPO=https://github.com/garyld1962/google_workspace_mcp.git
ARG GWS_REF=main
RUN git clone --depth 1 --branch "$GWS_REF" "$GWS_REPO" /app/src
WORKDIR /app/src
RUN uv sync --frozen --no-dev

FROM python:3.11-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv
COPY --from=builder /app/src /app

RUN useradd --create-home --uid 1000 app \
    && mkdir -p /app/store_creds \
    && chown -R app:app /app
USER 1000

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["uv", "run", "main.py"]
CMD ["--transport", "streamable-http", "--single-user", "--tool-tier", "core", "--tools", "gmail", "drive", "calendar", "docs"]
