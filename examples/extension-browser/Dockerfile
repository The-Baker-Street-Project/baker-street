FROM node:20-bookworm

# Use a shared browser path accessible by all users
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install Playwright's Chromium and all system dependencies
RUN npx -y playwright@1.58.2 install --with-deps chromium

# Install agent-browser CLI globally and download its managed browser
RUN npm install -g agent-browser@0.10.0 && agent-browser install

# Copy and build the MCP server
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ src/
RUN npm run build

# Create non-root user and grant access to browser binaries
RUN groupadd -r pwuser && useradd -r -g pwuser -G audio,video pwuser \
    && mkdir -p /home/pwuser/.agent-browser && chown -R pwuser:pwuser /home/pwuser \
    && chmod -R o+rx /ms-playwright

# Switch to non-root user
USER pwuser
WORKDIR /home/pwuser

# Default: stdio transport (Docker/local use)
# For K8s/HTTP: override command in deployment spec
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/index.js"]
