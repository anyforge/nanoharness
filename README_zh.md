# NanoHarness

> 像 Hermes 一样智慧、可自我进化的纯浏览器扩展智能体。
>
> [English](README.md)

<p align="center">
  <img src="icons/icon.svg" width="128" alt="NanoHarness logo" />
</p>

**NanoHarness** 是一个纯 Chrome 扩展的 AI 智能体 harness：具备智能体循环、浏览器自动化、工作区文件系统、技能系统、**记忆与自我进化**，并可作为 **MCP server** 暴露给第三方智能体调用。全部能力都在浏览器扩展内完成，无需本地 Node 服务。

---

## ✨ 核心特性

### 🧠 智能体智慧：像 Hermes 一样记忆与自我进化

NanoHarness 不只是「会调工具」，它像 Hermes 一样**越用越懂你、越用越会干活**：

- **双通道记忆**：自动记住「你是谁」（偏好、习惯）和「环境约定/坑」，跨会话保留，不再让你重复说明。
- **技能沉淀（自我进化）**：完成一个可复用的任务后，主动把它存成「技能」；下次直接调用。技能越攒越多，agent 越来越擅长你的具体任务。
- **上下文自动压缩**：长对话自动摘要，防止上下文超限——长任务不会「失忆」。
- **该问才问**：低风险自己拍板；有真实权衡时才用选项向你确认，不烦你。

### 🌐 浏览器自动化

通过 CDP 直接操控浏览器：打开/切换标签、读取页面内容、点击、填表、截图等 20+ 个浏览器工具。智能体可以真实地「看」和「操作」你的浏览器。

### ⏺️ 操作录制

把你网页上的点击、输入、滚动、悬停等操作录制成一个可复用的「技能」。下次在对话里说一句话，就能自动重放整个流程。

### 🔌 暴露给第三方 MCP

把扩展能力暴露成标准 **MCP server**（Streamable HTTP），Claude Desktop、Cursor 等任何 MCP client 都能调用你的浏览器、工作区文件与技能。

### 🛠️ 技能与 MCP 可配置

在设置页自行增删改技能、配置远程 MCP server（HTTP/SSE）。支持 OpenAI 兼容与 Anthropic 两种大模型协议，可接 DeepSeek / OpenAI / Claude / Moonshot / GLM / Qwen 等。

---

## 🎬 演示

两个 GIF 走同一套流程：问「你是谁」→「打开 bing」→ 逐个浏览设置页 tab（含 token 用量）。

**中文：**

![NanoHarness 演示 — 中文](docs/overview-zh.gif)

**English:**

![NanoHarness demo — English](docs/overview-en.gif)

## 📦 安装

1. 克隆仓库：`git clone https://github.com/anyforge/nanoharness.git`
2. 打开 Chrome，访问 `chrome://extensions`
3. 右上角开启「开发者模式」
4. 点「加载已解压的扩展程序」，选择本仓库根目录
5. 点工具栏的 NanoHarness 图标打开侧栏

## 🚀 快速开始

1. 打开侧栏 → ⚙ 设置 → **大模型**，填 Base URL / API Key / 模型（可点预设一键填入），保存。
2. 回到对话，直接说你想做什么，例如「打开这个网页并提取要点」。
3. 想把自己的操作变成技能：点录制按钮 → 正常操作网页 → 停止 → 保存为技能。

---

## ⚠️ 免责声明

NanoHarness 是一个自动化工具。它会真实地操作浏览器、调用外部大模型与 MCP 服务。**请勿在你不理解后果的场景下使用它**——例如涉及账号、支付、隐私数据或生产环境时。你对自己使用本工具所执行的任何操作、产生的任何结果负责。作者按「现状」提供本软件，不对其正确性、可用性或任何直接/间接损失承担责任。

## 📄 许可证

[AGPL-3.0](LICENSE) © [anyforge](https://github.com/anyforge)
