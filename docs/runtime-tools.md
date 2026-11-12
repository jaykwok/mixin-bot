# 运行设置与可选工具

Pi 1.5.2 接入只运行 Durable。修改以下配置前停止服务，使用升级事务完成数据版本校验，再启动服务。未配置辅助模型和 MCP 时，这些工具不注册。从更早的版本切换时这些配置不迁移，在新部署中按本页重新设置。

## 原生运行设置

`data/runtime/pi/settings.json` 使用 `format: 1`；模型选择字段 `defaultProvider / defaultModel / defaultThinkingLevel / modelThinkingLevels` 仍由 Pi 管理。以下是默认运行策略，可省略使用默认值：

```json
{
  "format": 1,
  "durable": {
    "retry": { "enabled": true, "maxRetries": 3, "baseDelayMs": 1000, "maxAgentDelayMs": 5000 },
    "stream": { "timeoutMs": 120000, "maxRetries": 0, "maxRetryDelayMs": 5000 },
    "compaction": { "enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000 },
    "progress": { "partialIntervalMs": 100, "outputIntervalMs": 20, "persistWithinMs": 1000 },
    "contextRetentionMs": 600000
  }
}
```

`retry.maxRetries` 是第一次之外的重试次数，最多 10；`stream.maxRetries` 必须为 0，使每次重试都由 Durable 重新发起并再次经过请求门。`timeoutMs` 是每次请求的期限，范围 1–600,000 毫秒；它不是用户消息的总处理期限。取消与未处理的控制命令继续阻止后续请求。

`compaction.modelOverrides` 的键为 `provider/modelId`，值只能含 `reserveTokens / keepRecentTokens`。`backgroundTokens` 可选，语义由 Durable 管理。`stream.cacheRetention` 可设 `none / short / long`；未设时沿用 Pi 的 provider 默认和 `PI_CACHE_RETENTION`，环境变量具体优先级由相应 provider 实现。

`progress` 管运行中的进度：`partialIntervalMs` 是模型正在生成的回答两次提交之间的最短间隔，`outputIntervalMs` 是工具运行输出两次提交之间的最短间隔，范围都是 0–10,000 毫秒；服务内的看门狗和 `/status` 立即看到这些进度。`persistWithinMs`（0–60,000 毫秒）是这些进度最迟写入会话库的时间，阶段结束时（模型答完、工具返回）立即写入；服务异常退出时最多丢失这段时间的流式进度，已完成的回答和工具结果不受影响。控制台从会话库读取，运行中的进度最多晚这么久显示。

`contextRetentionMs` 范围 0–600,000 毫秒，是官方任务上下文缓存的闲置保留时间；0 在任务闲置后释放。它减少历史条目读取，但增加内存占用，且不限制活跃成员数量。多成员大历史部署可设 0。运维端直接调用 `Conversation.context()` 的查询仍需读历史，不能用它的耗时代表任务缓存效果。

## 文档分流与图片生成

可选 `data/config/auxiliary.json`：

```json
{
  "format": 1,
  "classifier": { "provider": "your-provider", "modelId": "your-classifier" },
  "image": { "provider": "your-provider", "modelId": "your-image-model" },
  "maxConcurrent": 2,
  "classifierRetries": 1
}
```

引用必须来自已经配置的官方模型目录，型别分别为 `classifier`、`image`；可只启用其中一种。带图分类还要求模型声明支持图片输入。凭证使用该 provider 的官方解析方式，例如 OpenAI classifier 要求 API key；ChatGPT 登录不自动提供这种权限。

`document_route` 返回 `text / ocr / layout` 与置信度，帮助选择文档处理路线；它不执行 OCR，也不替代现有文档工具。`generate_image` 调用官方图片模型，把生成图片保存在调用成员自己的 `tmp/codemode/`，返回受控路径和图片块。发送图片仍由现有 `send_image` 工具完成。两个辅助工具可直接调用，也可经 codemode 调用；原始 `models` 全局保持关闭。

这些操作产生模型费用，均为 unsafe，恢复时不自动重放。分类仅对官方判定的瞬时错误重试，范围 0–3 次；图片生成不自动重试。全服务共享并发上限 1–4，等待队列最多 32，每次模型请求期限两分钟。提供方返回的用量放在工具结果上（分类的多次尝试相加），由 Durable 记到该工具名下，统计按工具分列；经 codemode 调用时只记在子调用上，不重复计入。取消、超时或强杀后没有返回结果的请求不入账，统计里的 token 因此可能少于提供方实际计费。文本输入最多 32,768 字符，参考图片最多四张。

## MCP 外部工具

可选 `data/config/mcp.json`，采用各 MCP 客户端通用的 `mcpServers` 写法：按名称列出服务器，本机程序写 `command`、`args`、`env`，HTTP 服务写 `url`、`headers`、`oauth`。在这之上只接受管理员明确允许的工具：每个服务器必须用 `tools` 列出允许成员调用的工具名，没有列出的不提供给模型。最多启用八个服务器，每个最多 64 个工具。例如：

```json
{
  "mcpServers": {
    "documents": {
      "url": "https://your-server.example/mcp",
      "headers": { "Authorization": "Bearer ${DOCUMENTS_TOKEN}" },
      "description": "产品文档库",
      "tools": ["search_documents"]
    },
    "localdocs": {
      "command": "C:\\Tools\\mcp-server.exe",
      "args": [],
      "env": { "APP_MODE": "readonly" },
      "tools": ["search_documents"]
    }
  }
}
```

两种服务器都可以写的字段：

| 字段 | 说明 |
| --- | --- |
| `tools` | 必填，允许成员调用的工具名 |
| `description` | 一句话说明这个服务器提供什么，模型查找工具时看得到 |
| `timeout` | 一次工具调用的时限，秒，1 到 600；默认 120 |
| `enabled` | 写 `false` 保留这一项但不启用 |

服务器名称以小写字母开头，只用小写字母、数字、`_` 和 `-`，最多 32 个字符；两个名称不能只差 `-` 和 `_`。模型看到的工具名是 `mcp__<服务器>__<工具>`，同一服务器的工具归在 `mcp__<服务器>` 下。

**HTTP 服务**：`url` 必须是 HTTPS，本机回环地址可以用 HTTP，不能带账号、口令。`headers` 的每个值都要用 `${变量名}` 引用运行服务时已有的环境变量（可以和固定文字拼在一起，如 `"Bearer ${DOCUMENTS_TOKEN}"`），凭证不写进配置文件；变量没有设置时服务启动失败并指出变量名。调用传递 `X-Mixin-Chat`（`direct` 或 `group`）和 URL 编码的 `X-Mixin-Member`，群聊另带 URL 编码的 `X-Mixin-Group`，单聊不带这个头；管理员配置的同名头会被覆盖。每次使用独立成员会话。外部服务需要自行验证身份和实施数据权限；这些头不能替代外部服务的鉴权。

**本机程序**：`command` 必须是该主机上的绝对路径，参数不经 shell 展开，不接受 `cwd`。子进程只继承必要的 PATH/系统/临时目录变量和显式配置的 `env`（值里可以用 `${变量名}` 引用服务的环境变量），另带 `MIXIN_CHAT_KIND / MIXIN_GROUP_ID / MIXIN_MEMBER_PHONE`（单聊时 `MIXIN_CHAT_KIND` 为 `direct`）；工作目录是成员 tmp。进程监督负责取消、stdin 关闭和父进程死亡后的后代回收。MCP roots 表达共享资料只读与成员 tmp 的使用约定，**不构成 OS 文件系统隔离**；stdio 程序仍具有服务用户权限，只配置可信程序。

**HTTP OAuth**：在服务器上加 `"oauth": { "callbackPort": 43127, "clientId": "registered-client" }`。`callbackPort` 必填，登录时在本机这个端口接收回调，回调地址是 `http://127.0.0.1:<端口>/callback`；省略 `clientId` 时采用官方动态注册流程；保密客户端用 `"clientSecret": "${变量名}"` 引用环境变量；还可以写 `scope`（要申请的权限，空格分隔）和 `clientName`（动态注册时的客户端名称）。停机后执行 `bun run mcp login documents`，按输出链接在浏览器授权；回调仅监听 `127.0.0.1`，登录期限两分钟，可取消。凭证按服务器名称和精确 URL 保存在 `data/runtime/mcp/`；备份应按秘密配置保护。服务启动不自动打开登录流程。

发现只读取工具目录；每次调用重查参数与结果 schema，目录变化会拒绝执行并要求管理员复核重启。工具经 codemode 按需发现，保持 unsafe、不自动重试、成员身份和取消边界，不能调用 model-only 的 `send_*`。结果文字超过 20 KB 时模型看到开头和结尾，完整文字和图片按成员归属落盘，纳入现有 `/clear` 和保留清理。单条传输最多 8 MiB，活跃会话最多八个。

## 只读历史诊断

```sh
bun run history context <群号>|--direct <成员号码> [条目编号] [--group-id|--storage-segment]
bun run history timings <群号>|--direct <成员号码> [--group-id|--storage-segment]
```

诊断使用数据库的一致只读快照，在快照上打开暂停的 Harness，不创建分叉或模型请求。允许源库正在写 WAL，不写入源会话、配置或费用；SQLite 自身的读锁与共享内存由 SQLite 管理。空间库不超过 256 MiB 时快照放在内存中；更大的空间库用 `VACUUM INTO` 复制到 `data/state/reclamation/snapshots/` 私有目录（与数据在同一卷，不占服务容器的 64 MiB `/tmp`），诊断结束即删除，数据备份不包含该目录。复制需要与空间库相当的空闲磁盘空间。

响应和普通工具使用官方 `durationMs`，任务用 `startedAt / endedAt`；任务跨度包含等待、重试和恢复，不能当作单次模型耗时。记录缺少耗时字段时返回未知值和缺失数量，不补零。原始历史顺序保持不变；官方请求上下文仅在 system 之前都是 user 消息时把它前移，压缩后的历史仍需按实际上下文判断。
