# NanoHarness MCP Relay

Expose the **NanoHarness extension** (a pure Chrome extension that can't listen on ports) as an **MCP server** for other agents (Claude / Cursor / any MCP client) to call.

> [中文文档 / Chinese](README_zh.md)

## Topology

```
External MCP client (Claude / Cursor / …)
        │  Streamable HTTP (POST http://host:PORT/mcp)  or  stdio (local)
        ▼
   relay.mjs (this script, listens on HTTP + WS ports)
        │  WebSocket (NanoHarness connects outbound)
        ▼
NanoHarness extension (runs browser / workspace file / skill tools)
```

## Why a relay is needed

A pure Chrome extension is forbidden by the browser security model from **listening on TCP ports** or spawning subprocesses, so NanoHarness can't "open a port and wait" on its own. The relay is a standalone Node process that listens on the port and bridges MCP requests to the extension over WebSocket. NanoHarness itself stays a pure extension with no local service.

## Usage (remote: share a URL)

1. Install dependencies (once):

   ```bash
   cd mcp-relay
   npm install
   ```

2. Start the relay (HTTP & WS share port 8787 by default; keep it running):

   ```bash
   node relay.mjs --port 8787                  # no token
   RELAY_TOKEN=xxx node relay.mjs --port 8787  # with token (recommended)
   ```

3. Open the extension → Settings → **MCP Server** tab:
   - Enable = **On**
   - Relay address = `ws://localhost:8787` (same machine; for a remote relay use `ws://server-ip:8787` or `wss://domain`)
   - Enter `xxx` as the token (if enabled in step 2)
   - Save

4. Copy the connection config and paste it into Claude Desktop / Cursor's `mcpServers`:

   ```json
   {
     "mcpServers": {
       "nanoharness": {
         "type": "streamable_http",
         "url": "http://your-ip:8787/mcp"
       }
     }
   }
   ```

   With a token, add the Authorization header:

   ```json
   {
     "mcpServers": {
       "nanoharness": {
         "type": "streamable_http",
         "url": "http://your-ip:8787/mcp",
         "headers": { "Authorization": "Bearer xxx" }
       }
     }
   }
   ```

   Replace `your-ip` with an IP or domain of the relay machine that the other party can reach.

## Usage (local stdio: Claude Desktop spawns the relay)

Claude Desktop on the same machine can also use stdio (command form), no need to run the relay manually:

```json
{
  "mcpServers": {
    "nanoharness": {
      "command": "node",
      "args": ["/path/to/nanoharness/mcp-relay/relay.mjs", "--port", "8787"],
      "env": { "RELAY_TOKEN": "xxx" }
    }
  }
}
```

(Remove `env` if no token; replace `/path/to/...` with the real absolute path.) The client spawns the relay on startup and the extension connects automatically.

## About remote access and 0.0.0.0

- The relay listens on **all interfaces** by default (equivalent to 0.0.0.0), so remote access already works — no need to change anything.
- What determines remote access is: ① both the Relay address in the extension and the URL you share use a **reachable address** of the relay machine; ② the firewall allows the relay port.
- `0.0.0.0` means "listen on all interfaces", not a "connect target"; the connect target is either localhost or a specific IP / domain.

## Notes

- The relay is a **standalone process** (not part of NanoHarness); NanoHarness remains a pure extension with no local service.
- The relay can run locally (dev/test) or on any machine (remote), as long as NanoHarness can open an outbound WS to it.
- Which tools to expose is configured in the extension's "MCP Server" page; empty = expose browser + files + skills by default. Internal meta tools (`ask_user` / `memory_*` / `mcp_*` / `search_sessions`) are never exposed.
