# DingTalk Claude Bridge

将钉钉消息桥接到 Claude Code CLI，实现通过钉钉与 Claude 对话。

---

## 功能

- 钉钉 Stream 模式接收消息（无需公网 IP）
- 调用 Claude Code CLI 获取回复
- 会话持久化存储（JSON 文件）
- 多会话管理（/new, /list, /switch）
- 工作目录切换（/dir）
- 多工作区支持（/ws）
- 访问控制（ALLOW_FROM）
- 管理员权限（ADMIN_FROM）
- 健康检查接口

---

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

编辑 `.env` 文件，填入你的配置：

```env
# DingTalk Stream 模式
DINGTALK_APP_KEY=your_app_key_here
DINGTALK_APP_SECRET=your_app_secret_here

# Server
PORT=3000

# 工作目录（可选）
WORK_DIR=/path/to/your/project

# 访问控制（可选，逗号分隔的用户 ID）
# ALLOW_FROM=user1,user2

# 管理员（可选，逗号分隔的用户 ID）
# ADMIN_FROM=user1
```

### 3. 安装 Claude Code CLI

```bash
npm install -g @anthropic-ai/claude-code
```

### 4. 钉钉应用配置

1. 登录 [钉钉开发者后台](https://open-dev.dingtalk.com/)
2. 创建企业内部应用
3. 获取 `AppKey` 和 `AppSecret`
4. 在应用中启用机器人功能
5. 配置权限：消息接收（Stream 模式）

### 5. 启动服务

```bash
npm start
```

服务启动后会建立 WebSocket 连接接收钉钉消息。

---

## 使用方式

### 私聊机器人

直接给机器人发消息即可对话。

### 群聊机器人

1. 在群里添加机器人
2. @机器人 发消息

---

## 命令系统

| 命令 | 说明 |
|------|------|
| `/new` | 创建新会话 |
| `/list` | 列出所有会话 |
| `/switch <ID或编号>` | 切换会话 |
| `/dir [路径]` | 查看/切换工作目录 |
| `/status` | 查看当前状态 |
| `/ws list` | 列出工作区 |
| `/ws save <名称>` | 保存工作区 |
| `/ws use <名称>` | 使用工作区 |
| `/ws remove <名称>` | 删除工作区 |
| `/help` | 显示帮助 |

---

## 对话示例

```
你: 帮我写个快速排序
机器人: 当然可以！以下是用 JavaScript 实现的快速排序...

你: 再加个优化版本
机器人: 好的，这是优化后的版本...
```

---

## 高级配置

### 会话持久化

会话数据保存在 `.data/sessions/` 目录下，重启服务后自动加载。

### 工作区管理

工作区配置保存在 `.data/workspaces/` 目录下，支持快速切换不同项目目录。

### 访问控制

设置 `ALLOW_FROM` 环境变量，限制只有指定用户可以使用机器人。

### 管理员权限

设置 `ADMIN_FROM` 环境变量，限制只有管理员可以使用 `/dir`、`/ws` 等管理命令。

### 健康检查

```bash
curl http://localhost:3000/health
```

---

## 故障排查

**Q: 服务启动后退出？**
A: 检查 `.env` 配置是否正确，钉钉 AppKey/AppSecret 是否有效。

**Q: 收不到钉钉消息？**
A: 确认钉钉应用已启用机器人功能，Stream 模式已配置。

**Q: Claude 不回复？**
A: 检查 `claude` 命令是否可用，运行 `claude --version` 验证。

---

## 开发

### 启动开发模式

```bash
npm run dev
```

使用 nodemon 自动重启。

---

## License

ISC
