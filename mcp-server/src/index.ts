/**
 * Entry point for the Mockman MCP server.
 *
 * Vendor-neutral: it speaks the open protocol over the two standard transports
 * and makes no assumptions about which client is on the other end. Claude Code,
 * Codex, Cursor, Windsurf, VS Code, Zed and hand-rolled agents all work.
 *
 *   node dist/index.js                  # stdio (default; every client supports it)
 *   node dist/index.js --http           # Streamable HTTP on 127.0.0.1:8788
 *   node dist/index.js --bridge-port N  # where the extension dials in (default 8787)
 *   node dist/index.js --token SECRET   # require the extension to present a token
 *   node dist/index.js --log-level debug
 */

import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { Bridge } from './bridge.ts';
import { guardStdout, log, setLogLevel, type LogLevel } from './logger.ts';
import { registerTools } from './tools.ts';

const NAME = 'mockman';
const VERSION = '0.1.0';

interface Options {
  http: boolean;
  httpPort: number;
  bridgePort: number;
  token: string | null;
  logLevel: LogLevel;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    http: argv.includes('--http'),
    httpPort: Number(process.env['NETWORK_MOCK_HTTP_PORT'] ?? 8788),
    bridgePort: Number(process.env['NETWORK_MOCK_BRIDGE_PORT'] ?? 8787),
    token: process.env['NETWORK_MOCK_TOKEN'] ?? null,
    logLevel: (process.env['NETWORK_MOCK_LOG_LEVEL'] as LogLevel) ?? 'info',
  };

  for (let i = 0; i < argv.length; i++) {
    const next = argv[i + 1];
    switch (argv[i]) {
      case '--http-port':
        if (next) options.httpPort = Number(next);
        break;
      case '--bridge-port':
        if (next) options.bridgePort = Number(next);
        break;
      case '--token':
        if (next) options.token = next;
        break;
      case '--log-level':
        if (next) options.logLevel = next as LogLevel;
        break;
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // In stdio mode stdout is the protocol channel. Do this before anything else
  // can print: one stray write corrupts the stream and clients fail opaquely.
  guardStdout();
  setLogLevel(options.logLevel);

  const bridge = new Bridge(options.bridgePort, options.token);
  await bridge.start();

  const server = new McpServer({ name: NAME, version: VERSION });
  registerTools(server, bridge);

  let shuttingDown = false;
  const shutdown = (reason: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`shutting down (${reason})`);
    void (async () => {
      try {
        await bridge.stop();
        await server.close();
      } finally {
        process.exit(0);
      }
    })();
  };

  // Clients kill servers in different ways; handle all of them so we never leave
  // an orphaned process holding the bridge port.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.stdin.on('end', () => shutdown('stdin closed'));
  process.stdin.on('close', () => shutdown('stdin closed'));

  if (options.http) {
    await serveHttp(server, options.httpPort);
  } else {
    await server.connect(new StdioServerTransport());
    log.info('ready on stdio');
  }
}

/**
 * Streamable HTTP, for clients configured by `url` rather than `command`, and for
 * attaching several agents at once.
 *
 * Bound to loopback only. The SDK ships Web-standard Request/Response transports,
 * so this adapts node:http to those.
 */
async function serveHttp(server: McpServer, port: number): Promise<void> {
  const { WebStandardStreamableHTTPServerTransport } = await import('@modelcontextprotocol/server');

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  const http = createServer((req, res) => {
    void (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);

        const request = new Request(`http://127.0.0.1:${port}${req.url ?? '/'}`, {
          method: req.method ?? 'POST',
          headers: req.headers as HeadersInit,
          ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
        });

        const response = await transport.handleRequest(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));

        if (response.body) {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        }
        res.end();
      } catch (error) {
        log.error('http request failed', error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    })();
  });

  await new Promise<void>((resolve) => http.listen(port, '127.0.0.1', resolve));
  log.info(`ready on http://127.0.0.1:${port} (Streamable HTTP)`);
}

main().catch((error) => {
  log.error('fatal', error);
  process.exit(1);
});
