# NanoHarness MCP Relay

把 **NanoHarness 扩展**（纯 Chrome 扩展，无法监听端口）暴露成一个 **MCP server**，供其他智能体（Claude / Cursor / 任何 MCP client）调用。

> [English](README.md)

## 拓扑

```
外部 MCP client（Claude / Cursor / …）
        │  Streamable HTTP（POST http://host:PORT/mcp）  或  stdio（本机）
        ▼
   relay.mjs（本脚本，监听 HTTP + WS 端口）
        │  WebSocket（NanoHarness 出站连进来）
        ▼
NanoHarness 扩展（执行浏览器操控 / 工作区文件 / 技能工具）
```

## 为什么需要 relay

纯 Chrome 扩展被浏览器安全模型**禁止监听 TCP 端口**，也无法 spawn 子进程，所以 NanoHarness 自己「开不了端口等别人连」。relay 是一个独立 Node 进程，替它监听端口、把 MCP 请求通过 WebSocket 桥接给扩展。NanoHarness 本体保持纯扩展、无本地服务。

## 用法（远程：把 URL 给别人连）

1. 装依赖（一次性）：

   ```bash
   cd mcp-relay
   npm install
   ```

2. 启动 relay（默认 HTTP 与 WS 共用 8787 端口，可改；常驻）：

   ```bash
   node relay.mjs --port 8787                  # 无 token
   RELAY_TOKEN=xxx node relay.mjs --port 8787  # 有 token（推荐）
   ```

3. 打开 NanoHarness 扩展 → 设置 → **MCP 暴露** tab：
   - 启用 = **开**
   - Relay 地址 = `ws://localhost:8787`（relay 与浏览器同机；远程 relay 填 `ws://服务器IP:8787` 或 `wss://域名`）
   - Token 填 `xxx`（若第 2 步开了 token）
   - 保存

4. 把「连接配置」（url 形式）复制给对方，填进 Claude Desktop / Cursor 的 `mcpServers`：

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

   有 token 时带 Authorization 头：

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

   `your-ip` 换成 relay 所在机器的、对方能访问到的 IP 或域名。

## 用法（本机 stdio：Claude Desktop 直接拉起 relay）

同一台机器上的 Claude Desktop 也可以走 stdio（command 方式），无需手动跑 relay：

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

（无 token 删掉 `env`；`/path/to/...` 换成实际绝对路径。）客户端启动时自动 spawn relay，扩展自动连上。

## 关于「远程连接」与 0.0.0.0

- relay 的 HTTP/WS 服务默认**监听所有网卡**（等价 0.0.0.0），远程本来就连得进来——不需要改任何「0.0.0.0」。
- 决定「能不能远程」的是两件事：① 扩展里 Relay 地址与复制给别人的 url 都填 relay 所在机器的**可达地址**；② 防火墙放行 relay 端口。
- `0.0.0.0` 是「监听所有网卡」的语义，不是「连接目标」；连接目标要么 localhost，要么具体 IP / 域名。

## 说明

- relay 是**独立进程**（不是 NanoHarness 本体），NanoHarness 保持纯扩展、无本地服务。
- relay 可跑在本地（开发测试）或任何机器上（远程暴露），只要 NanoHarness 能出站 WS 连到它。
- 暴露哪些工具在扩展「MCP 暴露」页勾选；留空 = 默认暴露浏览器 + 文件 + 技能。内部元工具（`ask_user` / `memory_*` / `mcp_*` / `search_sessions`）不对外暴露。
