# rook

本地模型网关。对外只暴露一套 OpenAI 兼容接口，对内挂多种后端：**本地命令（CLI）、中转站、反代**。给 SillyTavern 用。

零依赖（Node 20.3+），一个 `node server.js` 起来，Web 控制台配完即用。

```
酒馆  ──OpenAI 兼容──▶  rook  ──▶  claude / gemini / codex（子进程）
                              ├──▶  任意 OpenAI 兼容中转
                              └──▶  原样透传的反向代理
```

## 起

双击 `start.bat`，或者：

```bash
cd rook
node server.js
```

`start.bat` 会自己找 Node（PATH → WorkBuddy 内置 → 默认安装位置）、查版本、从 `config.json` 读端口、延迟两秒打开控制台。设 `ROOK_NO_BROWSER=1` 可跳过开浏览器。

终端会打印四个东西：Web UI 地址、Base URL、API Key、Admin Key。

打开 Web UI（默认 http://127.0.0.1:8790/），首次要填 Admin Key。

> 端口 8765 常被占用，默认改成了 8790。要换就改 `config.json` 的 `port`，或在控制台设置里改。

`config.json` 里自带一条 **Local echo (demo)** 上游：本地跑 `test/echo-cli.mjs`，会原样回一段带字符数的文本。先用它把酒馆接通（验证 Base URL / Key / 模型拉取这套流程），通了再换成真正的上游，然后把它停用或删掉。

## 出网

只发给你自己配的上游地址。没有遥测、没有版本检查、页面不加载任何 CDN。

上游在墙外时：设置里填代理地址（如 `http://127.0.0.1:7897`），再给那条上游打开「走代理」。本机地址（`127.0.0.1` / `localhost`）永远直连，不会被代理截走。

## 三个概念

**上游（provider）** —— 一个后端。类型决定它怎么说话：

| type | 用途 | 典型配置 |
|---|---|---|
| `cli` | 跑本地命令，stdin 喂对话，stdout 收回答 | `command: claude`，`args: [-p, --model, {{model}}, --output-format, stream-json, --verbose]` |
| `openai` | 任何 OpenAI 兼容端点（官方、中转、new-api、one-api…） | `baseUrl: https://xxx/v1` + `apiKey` |
| `proxy` | 字节级透传，不改请求体（除了 model 字段） | 上游不是 OpenAI 格式、或不想被改写时 |

**模型** —— 每条上游下挂模型。`id` 是上游真实模型名，`alias` 是对外名；只填 alias 也行。酒馆里看到的是 alias。

**思考强度** —— 五档 `off / low / medium / high / max`，一个统一词汇，各上游各自翻译：

- `reasoning_effort` → `body.reasoning_effort`
- `openrouter_reasoning` → `body.reasoning.effort`
- `qwen_enable` → `body.enable_thinking` + `thinking_budget`
- `gemini_budget` → `generationConfig.thinkingConfig.thinkingBudget`
- `custom` → 自己写 JSON 模板，占位符 `{{level}} {{budget}} {{on}}`

酒馆不认思考强度这个概念，所以强度是网关侧决定的：每个模型一个默认档，在「接入」页直接下拉切换，立刻生效，不用重启。单次请求也能用 `thinking_level` / `reasoning_effort` / `x-rook-thinking` 覆盖。

## 接酒馆

1. API 连接 → Chat Completion → `Custom (OpenAI-compatible)`
2. Custom Endpoint：`http://127.0.0.1:8790/v1`
3. Custom API Key：控制台里那串 `sk-rook-...`
4. 拉模型列表，选一个

酒馆从局域网访问时，把 `host` 改成 `0.0.0.0` 并把 Endpoint 换成本机内网 IP。

## CLI 上游怎么填

`args` 里每行一个参数，支持占位符，**解析成空字符串的参数会被丢掉**（方便写 `--effort {{level}}`，off 时自动不出现）：

| 占位符 | 值 |
|---|---|
| `{{model}}` | 上游模型 id |
| `{{level}}` | off/low/medium/high/max |
| `{{budget}}` | 该档位对应的 token 预算 |
| `{{on}}` | true / false |

对话走 **stdin**，不进命令行（避免引号地狱和长度限制）。`inputFormat` 决定怎么拼：

- `transcript`（默认）——`<system>…</system>` + `User: …` / `Assistant: …`
- `last` —— 只发最后一条用户消息
- `json` —— `{system, messages}` 的 JSON
- `template` —— 自己写 `promptTemplate`，可用 `{{system}} {{prompt}}`

`parser` 决定怎么读 stdout：

- `raw` —— 原样当文本流（逐块转发，不按行缓冲）
- `claude-stream` —— Claude Code `--output-format stream-json`（按 message id 做增量，`result` 兜底）
- `json-lines` —— 每行一个 JSON，取 `delta` / `text` / `content` / `response`
- `json-object` —— 整个 stdout 是一个 JSON 对象

单个模型可以覆盖 provider 的 `parser`（同一个可执行文件有多种输出模式时有用）：

```json
{ "id": "claude", "alias": "sonnet", "parser": "claude-stream" }
```

Claude Code 是唯一验证过真实行为的（`claude-stream` 用假 CLI 测过完整解析）。其他 CLI 请用「测试」按钮先验一次。

CLI 每次请求起一个进程，慢、有额度限制、并发差。适合单人用，不适合群聊。

## HTTP 接口

| 路由 | 说明 |
|---|---|
| `GET /v1/models` | 模型目录（openai 格式） |
| `POST /v1/chat/completions` | 支持 `stream`，SSE 带 `delta.reasoning_content` |
| `POST /v1/completions` | legacy，转成单轮 chat |
| `GET /health` | 存活 + 模型数 |
| `GET/PUT /admin/api/...` | 控制台用，需 `x-admin-key` |
| `GET /admin/api/logs/stream` | 实时日志（SSE） |

请求先拉到第一个事件再写 200，所以上游报错会以正常的 JSON 错误返回给酒馆，而不是一条断掉的流。

上游返回的**非标准字段**（`modelVersion`、`system_fingerprint`、安全评级、delta 里的额外键）会原样合并进响应，不丢。`modelVersion` 还会额外写进请求日志，方便看真实模型版本。

## 加一种上游

不用改服务端。往 `src/adapters/` 丢一个文件：

```js
export const type = 'myrelay';
export const label = '我的中转';
export const fields = [{ key: 'baseUrl', label: 'Base URL' }];  // 驱动 UI 表单
export const managesTimeout = true;   // 可选：自己管超时（CLI 子进程就是这么做的）

export async function listModels(provider) { /* -> [{id}] */ }

export async function* chat(ctx) {
  // ctx: { provider, model, messages, params, level, signal, log }
  // yield { delta }, { reasoning }, { toolCalls }, { usage }, { finish }
}

export async function passthrough(ctx) { /* 可选：原样转发，返回 fetch Response */ }
```

`src/adapters/index.js` 启动时自动扫目录，`_` 开头的是共用工具。UI 的类型下拉会立刻出现这一项。

## 结构

```
server.js              HTTP 路由 / 静态 / 管理 API
src/config.js          config.json 读写、模型目录、alias 解析
src/engine.js          模型 → 上游 → 适配器，统一事件流
src/thinking.js        思考强度翻译层
src/log.js             环形日志 + SSE
src/adapters/          可插拔上游
public/                控制台（无框架、无构建）
test/                  smoke + 单测
tools/shot.mjs         CDP 无头截图（调试 UI 用）
```

## 测试

```bash
node test/thinking.mjs      # 思考强度映射（纯单测，16 项）
node test/smoke.mjs         # 端到端，起一个 mock 上游（66 项）
node tools/ui-test.mjs <baseUrl> <adminKey>   # 真浏览器点控制台（18 项）
```

smoke 覆盖的东西：四种 parser、120k 字符 prompt、5 并发、中转的 SSE 与 usage、
上游 401/429/超时、tool_calls 拼装、反代透传、
请求中断时子进程被杀、重复别名、空配置、路径穿越、无 key 时的 Origin 策略。

两个测试脚本都只动 `smoke-*` / `ui-test` 这些临时 provider，跑完自动还原，
不碰你自己的配置。

## 还没做

- 多个上游之间自动 failover（现在一个模型只绑一条上游）
- token 精确计数（CLI 上游按字符估）
- 多用户 / 配额
- 图片、音频内容块只透传不转换

## 安全

先说清楚这是个什么东西：**它把本机命令包装成 HTTP 接口**。所以安全边界不在代码里，在 key 上。谁拿到 Admin Key，谁就能配一条 `command: powershell` 的上游——等于拿到 shell。评估任何加固之前，先认这一条。

**已经做的**

- 零依赖。没有供应链面，没有需要定期升级的包。
- 默认只监听 `127.0.0.1`。
- 管理接口：`x-admin-key`（常量时间比较）+ **同源校验**。浏览器不能伪造 Origin，所以跨站请求和 DNS rebinding 都过不去。
- `/v1/*`：要 API Key。**key 为空时只放行 loopback Origin**——恶意网页在浏览器里调不动，酒馆（`127.0.0.1:8000`）照常。
- CLI 的 prompt 走 stdin，不进 argv；空占位符参数自动丢弃。没有 shell 拼接。
- 静态文件做路径归一 + `PUBLIC` 前缀校验（带分隔符边界，`public-x` 这种同前缀目录也进不去）。
- 日志流改走 request header 鉴权，key 不再出现在 URL；`?key=` 进页面后立刻从地址栏抹掉。
- 日志行和终端输出会对 `sk-…`、`Bearer …`、`ghp_…`、`AIza…` 打码后再落地。
- `config.json` 和 `*.log` 在 `.gitignore` 里。

**还剩的风险，你自己认**

1. **Admin Key = RCE 凭证。** 别复用、别贴到聊天窗口、别让控制台页面出现在别人的屏幕上。
2. **`host: 0.0.0.0` 等于把登录页和 `/v1` 摊到整个网段。** 开了就是接受"同网段有人能爆破 key"。只在确实需要酒馆跨机访问时开。
3. **启动横幅会打印完整密钥。** 终端里看没问题；`> boot.log` 这种重定向会往磁盘上留一份明文。别把它提交、别共享。
4. **`config.json` 明文存上游 key。** 靠 OS 文件权限保护，没加密。
5. **日志会记命令行。** 如果你把上游 key 写在 `args` 里（`--api-key sk-...`），打码规则能兜住 `sk-` 这类形态，但兜不住自定义格式的密钥。放 `env` 里更安全。
6. **没有速率限制、没有审计留存。** 不防"自己有 key 的人"。
7. **`/v1` 的 CORS 回显 Origin。** 这是为了酒馆能跨端口调用。有 key 时安全，无 key 时靠 Origin 校验兜底——但 Origin 校验只防浏览器，防不了本机其他进程。

**一句话判据**：单独一台机器、只绑 127.0.0.1、密钥不外传 → 可以放心用。多用户、公网、共享机器 → 别用，或者至少把 `cli` 类上游全部删掉。

