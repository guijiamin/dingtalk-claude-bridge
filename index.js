require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { DWClient, EventAck, TOPIC_ROBOT } = require('dingtalk-stream');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const APP_KEY = process.env.DINGTALK_APP_KEY;
const APP_SECRET = process.env.DINGTALK_APP_SECRET;
const WORK_DIR = process.env.WORK_DIR || require('os').homedir();
const ALLOW_FROM = process.env.ALLOW_FROM ? process.env.ALLOW_FROM.split(',').map(s => s.trim()) : null;
const ADMIN_FROM = process.env.ADMIN_FROM ? process.env.ADMIN_FROM.split(',').map(s => s.trim()) : null;

const DATA_DIR = path.join(process.cwd(), '.data');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');

let accessToken = null;
let tokenExpireTime = 0;
let dingtalkClient = null;

// 会话和工作区管理
const sessions = new Map();
const workspaces = new Map();
const userSessions = new Map(); // userId -> sessionId

// ==================== 数据持久化 ====================

async function initDataDir() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    await fs.mkdir(WORKSPACES_DIR, { recursive: true });
  } catch (err) {
    console.error('[Data] Failed to create data directory:', err.message);
  }
}

async function saveSession(sessionId, session) {
  try {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    await fs.writeFile(filePath, JSON.stringify(session, null, 2));
  } catch (err) {
    console.error('[Data] Failed to save session:', err.message);
  }
}

async function loadSession(sessionId) {
  try {
    const filePath = path.join(SESSIONS_DIR, `${sessionId}.json`);
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return null;
  }
}

async function loadAllSessions() {
  try {
    const files = await fs.readdir(SESSIONS_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const sessionId = file.replace('.json', '');
        const session = await loadSession(sessionId);
        if (session) {
          sessions.set(sessionId, session);
        }
      }
    }
    console.log(`[Data] Loaded ${sessions.size} sessions`);
  } catch (err) {
    console.error('[Data] Failed to load sessions:', err.message);
  }
}

async function saveWorkspace(name, workspace) {
  try {
    const filePath = path.join(WORKSPACES_DIR, `${name}.json`);
    await fs.writeFile(filePath, JSON.stringify(workspace, null, 2));
  } catch (err) {
    console.error('[Data] Failed to save workspace:', err.message);
  }
}

async function loadAllWorkspaces() {
  try {
    const files = await fs.readdir(WORKSPACES_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const name = file.replace('.json', '');
        const filePath = path.join(WORKSPACES_DIR, file);
        const data = await fs.readFile(filePath, 'utf-8');
        workspaces.set(name, JSON.parse(data));
      }
    }
    console.log(`[Data] Loaded ${workspaces.size} workspaces`);
  } catch (err) {
    console.error('[Data] Failed to load workspaces:', err.message);
  }
}

// ==================== 会话管理 ====================

function createSession(userId, conversationId, workDir = WORK_DIR) {
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  const session = {
    id: sessionId,
    userId,
    conversationId,
    workDir,
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  sessions.set(sessionId, session);
  userSessions.set(userId, sessionId);
  saveSession(sessionId, session);
  return session;
}

function getUserSession(userId) {
  const sessionId = userSessions.get(userId);
  if (sessionId) {
    return sessions.get(sessionId);
  }
  return null;
}

function setUserSession(userId, sessionId) {
  userSessions.set(userId, sessionId);
}

// ==================== 命令系统 ====================

const commands = {
  async new(userId, conversationId, args) {
    const session = createSession(userId, conversationId);
    return `✅ 新会话已创建\n会话 ID: ${session.id.substring(0, 12)}...`;
  },

  async list(userId) {
    const userSessionIds = [];
    for (const [uid, sid] of userSessions.entries()) {
      if (uid === userId) {
        userSessionIds.push(sid);
      }
    }
    
    if (sessions.size === 0) {
      return '📭 暂无会话';
    }

    let result = '📋 会话列表:\n\n';
    let index = 1;
    for (const [id, session] of sessions.entries()) {
      const current = userSessions.get(userId) === id ? ' (当前)' : '';
      const msgCount = session.messages.length;
      result += `${index}. ${id.substring(0, 12)}... (${msgCount} 条消息)${current}\n`;
      index++;
    }
    return result;
  },

  async switch(userId, args) {
    if (!args[0]) {
      return '❌ 请提供会话 ID 或编号\n使用 /list 查看可用会话';
    }

    const target = args[0];
    let targetSession = null;

    // 尝试按编号查找
    const num = parseInt(target);
    if (!isNaN(num)) {
      const sessionArray = Array.from(sessions.entries());
      if (num > 0 && num <= sessionArray.length) {
        targetSession = sessionArray[num - 1][1];
      }
    }

    // 尝试按 ID 查找
    if (!targetSession) {
      for (const [id, session] of sessions.entries()) {
        if (id.startsWith(target)) {
          targetSession = session;
          break;
        }
      }
    }

    if (!targetSession) {
      return '❌ 未找到指定会话';
    }

    setUserSession(userId, targetSession.id);
    return `✅ 已切换到会话 ${targetSession.id.substring(0, 12)}...`;
  },

  async dir(userId, args) {
    const session = getUserSession(userId);
    if (!session) {
      return '❌ 请先创建会话（使用 /new）';
    }

    if (!args[0]) {
      return `📁 当前工作目录: ${session.workDir}`;
    }

    const newDir = args.join(' ');
    try {
      const stat = await fs.stat(newDir);
      if (!stat.isDirectory()) {
        return '❌ 路径不是目录';
      }
      session.workDir = newDir;
      session.messages = []; // 重置会话
      await saveSession(session.id, session);
      return `✅ 工作目录已切换: ${newDir}`;
    } catch (err) {
      return `❌ 目录不存在: ${newDir}`;
    }
  },

  async status(userId) {
    const session = getUserSession(userId);
    if (!session) {
      return '📭 当前无活跃会话\n使用 /new 创建新会话';
    }

    return `📊 状态信息\n\n` +
      `会话 ID: ${session.id.substring(0, 12)}...\n` +
      `工作目录: ${session.workDir}\n` +
      `消息数: ${session.messages.length}\n` +
      `创建时间: ${new Date(session.createdAt).toLocaleString('zh-CN')}`;
  },

  async ws(userId, args) {
    const subCmd = args[0];

    if (!subCmd || subCmd === 'list') {
      if (workspaces.size === 0) {
        return '📭 暂无工作区\n使用 /ws save <名称> 保存当前工作区';
      }
      let result = '📋 工作区列表:\n\n';
      for (const [name, ws] of workspaces.entries()) {
        result += `- ${name}: ${ws.path}\n`;
      }
      return result;
    }

    if (subCmd === 'save') {
      const name = args[1];
      if (!name) {
        return '❌ 请提供工作区名称\n用法: /ws save <名称>';
      }
      const session = getUserSession(userId);
      const wsPath = session ? session.workDir : WORK_DIR;
      workspaces.set(name, { path: wsPath, createdAt: new Date().toISOString() });
      await saveWorkspace(name, workspaces.get(name));
      return `✅ 工作区已保存: ${name} -> ${wsPath}`;
    }

    if (subCmd === 'use') {
      const name = args[1];
      if (!name) {
        return '❌ 请提供工作区名称\n用法: /ws use <名称>';
      }
      const ws = workspaces.get(name);
      if (!ws) {
        return `❌ 工作区不存在: ${name}`;
      }
      const session = getUserSession(userId);
      if (!session) {
        return '❌ 请先创建会话（使用 /new）';
      }
      try {
        const stat = await fs.stat(ws.path);
        if (!stat.isDirectory()) {
          return '❌ 工作区路径不是目录';
        }
        session.workDir = ws.path;
        session.messages = [];
        await saveSession(session.id, session);
        return `✅ 已切换到工作区: ${name} -> ${ws.path}`;
      } catch (err) {
        return `❌ 工作区路径不存在: ${ws.path}`;
      }
    }

    if (subCmd === 'remove') {
      const name = args[1];
      if (!name) {
        return '❌ 请提供工作区名称\n用法: /ws remove <名称>';
      }
      if (!workspaces.has(name)) {
        return `❌ 工作区不存在: ${name}`;
      }
      workspaces.delete(name);
      try {
        await fs.unlink(path.join(WORKSPACES_DIR, `${name}.json`));
      } catch (err) {}
      return `✅ 工作区已删除: ${name}`;
    }

    return '❓ 未知工作区命令\n可用命令: /ws list, /ws save <名称>, /ws use <名称>, /ws remove <名称>';
  },

  async help() {
    return `📖 可用命令\n\n` +
      `/new - 创建新会话\n` +
      `/list - 列出所有会话\n` +
      `/switch <ID或编号> - 切换会话\n` +
      `/dir [路径] - 查看/切换工作目录\n` +
      `/status - 查看当前状态\n` +
      `/ws list - 列出工作区\n` +
      `/ws save <名称> - 保存工作区\n` +
      `/ws use <名称> - 使用工作区\n` +
      `/ws remove <名称> - 删除工作区\n` +
      `/help - 显示此帮助`;
  }
};

async function handleCommand(userId, conversationId, text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase().replace('/', '');
  const args = parts.slice(1);

  if (commands[cmd]) {
    try {
      return await commands[cmd](userId, conversationId, args);
    } catch (err) {
      return `❌ 命令执行失败: ${err.message}`;
    }
  }
  return null; // 不是命令
}

// ==================== 访问控制 ====================

function isAllowed(senderId) {
  if (!ALLOW_FROM) return true;
  return ALLOW_FROM.includes(senderId);
}

function isAdmin(senderId) {
  if (!ADMIN_FROM) return false;
  return ADMIN_FROM.includes(senderId);
}

// ==================== DingTalk Access Token ====================

async function getAccessToken() {
  if (accessToken && tokenExpireTime > Date.now()) {
    return accessToken;
  }

  console.log('[DingTalk] Getting access token...');

  const endpoints = [
    'https://api.dingtalk.com/v1.0/oauth2/clientAccessToken',
    'https://oapi.dingtalk.com/gettoken'
  ];

  for (const endpoint of endpoints) {
    try {
      let response;
      if (endpoint.includes('oapi')) {
        response = await axios.get(endpoint, {
          params: { appkey: APP_KEY, appsecret: APP_SECRET }
        });
        if (response.data.errcode === 0) {
          accessToken = response.data.access_token;
          tokenExpireTime = Date.now() + (response.data.expires_in - 300) * 1000;
          console.log('[DingTalk] ✓ Token obtained via oapi');
          return accessToken;
        }
      } else {
        response = await axios.post(endpoint, {
          clientId: APP_KEY,
          clientSecret: APP_SECRET,
          grantType: 'client_credentials'
        }, {
          headers: { 'Content-Type': 'application/json' }
        });
        if (response.data.accessToken) {
          accessToken = response.data.accessToken;
          tokenExpireTime = Date.now() + (response.data.expireIn - 300) * 1000;
          console.log('[DingTalk] ✓ Token obtained via v1.0 API');
          return accessToken;
        }
      }
    } catch (error) {
      console.log('[DingTalk] Endpoint failed:', endpoint, error.response?.status || error.message);
    }
  }

  throw new Error('Failed to get access token from all endpoints');
}

// ==================== DingTalk Stream ====================

function initDingTalkStream() {
  const client = new DWClient({
    clientId: APP_KEY,
    clientSecret: APP_SECRET,
    keepAlive: true,
    debug: true
  });

  client.registerAllEventListener(async (message) => {
    try {
      console.log('[DingTalk] Received event message:', JSON.stringify(message).substring(0, 500));
      handleDingTalkMessage(message);
      return { status: EventAck.SUCCESS };
    } catch (error) {
      console.error('[DingTalk] Event handler error:', error);
      return { status: EventAck.SUCCESS };
    }
  });

  client.registerCallbackListener(TOPIC_ROBOT, async (message) => {
    try {
      console.log('[DingTalk] Received robot callback:', JSON.stringify(message).substring(0, 500));
      await handleDingTalkMessage(message);
      client.socketCallBackResponse(message.headers.messageId, { status: 'SUCCESS' });
    } catch (error) {
      console.error('[DingTalk] Callback handler error:', error);
      client.socketCallBackResponse(message.headers.messageId, { status: 'SUCCESS' });
    }
  });

  client.on('connected', () => {
    console.log('[DingTalk] ✓ Stream connected!');
    console.log('[DingTalk] Subscriptions:', JSON.stringify(client.getConfig().subscriptions));
    dingtalkClient = client;
  });

  client.on('disconnect', () => {
    console.log('[DingTalk] Disconnected');
    dingtalkClient = null;
  });

  dingtalkClient = client;
  
  client.connect().catch(err => {
    console.error('[DingTalk] Connection error:', err);
  });

  return client;
}

// ==================== Handle Message ====================

async function handleDingTalkMessage(msg) {
  try {
    const data = msg.data ? JSON.parse(msg.data) : {};
    const headers = msg.headers || {};
    
    const conversationId = data.conversationId || data.chatId || headers.chatId;
    const senderId = data.senderId || data.senderStaffId || headers.senderStaffId;
    const senderNick = data.senderNick || 'User';
    const msgType = data.msgtype || data.msgType;
    const sessionWebhook = data.sessionWebhook;
    const msgId = data.msgId;
    
    let text = '';
    if (msgType === 'text') {
      text = data.text?.content || '';
    } else if (data.content) {
      text = typeof data.content === 'string' ? data.content : data.content.content || '';
    }

    text = text.trim();
    if (!text) {
      console.log('[DingTalk] No text content, skipping');
      return;
    }

    console.log(`[DingTalk] From ${senderNick} (${senderId}): ${text}`);

    // 访问控制
    if (!isAllowed(senderId)) {
      console.log('[DingTalk] User not allowed:', senderId);
      return;
    }

    // 检查是否是命令
    if (text.startsWith('/')) {
      const cmdResponse = await handleCommand(senderId, conversationId, text);
      if (cmdResponse) {
        // 检查是否需要管理员权限
        const cmd = text.trim().split(/\s+/)[0].toLowerCase().replace('/', '');
        const adminCommands = ['ws', 'dir'];
        if (adminCommands.includes(cmd) && !isAdmin(senderId)) {
          await replyToDingTalk(sessionWebhook, '❌ 此命令需要管理员权限');
          return;
        }
        await replyToDingTalk(sessionWebhook, cmdResponse);
        return;
      }
    }

    // 获取或创建会话
    let session = getUserSession(senderId);
    if (!session) {
      session = createSession(senderId, conversationId);
    }

    session.messages.push({ role: 'user', content: text });
    session.updatedAt = new Date().toISOString();
    await saveSession(session.id, session);

    // 获取 Claude 回复
    console.log('[DingTalk] Generating response...');
    const fullResponse = await getClaudeResponse(session.messages, session.workDir);
    console.log(`[Claude] Response:`, fullResponse.substring(0, 100) + '...');

    const responseText = fullResponse.trim() || '(no content)';

    session.messages.push({ role: 'assistant', content: responseText });
    session.updatedAt = new Date().toISOString();
    await saveSession(session.id, session);

    // 发送最终回复，包含引用效果
    if (sessionWebhook) {
      const finalMsg = `> ${senderNick}: ${text}\n\n${responseText.substring(0, 2000)}`;
      await replyToDingTalk(sessionWebhook, finalMsg, null, true);
    }

  } catch (error) {
    console.error('[DingTalk] Handle error:', error);
  }
}

// ==================== Reply ====================

function getSmartEmoji(text) {
  const lowerText = text.toLowerCase().trim();
  
  // 问候类
  if (/^(你好|hi|hello|hey|早上好|晚上好|下午好|早上好呀|哈喽)/.test(lowerText)) {
    return '👋';
  }
  
  // 感谢类
  if (/^(谢谢|感谢|thanks|thank you|thx)/.test(lowerText)) {
    return '😊';
  }
  
  // 问题类
  if (/(为什么|怎么|如何|什么|哪里|谁|多少|吗|呢|？|\?)/.test(lowerText)) {
    return '🤔';
  }
  
  // 命令类
  if (/^\/(new|list|switch|dir|status|ws|help)/.test(lowerText)) {
    return '⚙️';
  }
  
  // 代码类
  if (/(代码|code|function|class|def|import|write|写个|帮我写)/.test(lowerText)) {
    return '💻';
  }
  
  // 默认
  return '👍';
}

async function replyToDingTalk(sessionWebhook, message, msgId = null, isMarkdown = false) {
  try {
    if (!sessionWebhook) {
      console.error('[DingTalk] No session webhook available, cannot send reply');
      return;
    }

    console.log('[DingTalk] Sending reply via session webhook');
    
    const payload = isMarkdown 
      ? { msgtype: 'markdown', markdown: { title: '回复', text: message } }
      : { msgtype: 'text', text: { content: message } };

    await axios.post(
      sessionWebhook,
      payload,
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
    console.log('[DingTalk] ✓ Reply sent');
  } catch (error) {
    console.error('[DingTalk] Reply error:', error.response?.data || error.message);
  }
}

// ==================== Claude Code CLI ====================

async function getClaudeResponse(messages, workDir = WORK_DIR) {
  // 将消息历史转换为对话文本
  const prompt = messages.map(m => `${m.role}: ${m.content}`).join('\n\n');

  console.log('[Claude] Calling Claude Code CLI...');
  console.log('[Claude] Work directory:', workDir);

  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    
    // 使用 claude 命令，传入 prompt
    const claude = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
      cwd: workDir,
      env: { ...process.env, CLAUDE_CODE_SILENT: 'true' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let output = '';
    let errorOutput = '';

    claude.stdout.on('data', (data) => {
      output += data.toString();
    });

    claude.stderr.on('data', (data) => {
      errorOutput += data.toString();
    });

    claude.on('close', (code) => {
      if (code === 0) {
        console.log('[Claude] Response received, length:', output.length);
        resolve(output.trim());
      } else {
        console.error('[Claude] CLI exited with code:', code);
        console.error('[Claude] Error output:', errorOutput);
        reject(new Error(`Claude CLI exited with code ${code}: ${errorOutput}`));
      }
    });

    claude.on('error', (error) => {
      console.error('[Claude] CLI error:', error.message);
      reject(error);
    });
  });
}

// ==================== HTTP Server ====================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    sessions: sessions.size,
    workspaces: workspaces.size,
    wsConnected: dingtalkClient?.connected || false
  });
});

app.post('/test', async (req, res) => {
  try {
    const { text } = req.body || { text: 'test' };
    const response = await getClaudeResponse([{ role: 'user', content: text || '你好' }]);
    res.json({ success: true, response });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

// ==================== Start ====================

const server = app.listen(PORT, async () => {
  console.log('\n========================================');
  console.log('  DingTalk Claude Bridge');
  console.log('========================================');
  console.log('  Server running on port:', PORT);
  console.log('  APP_KEY: ' + (APP_KEY ? '✓' : '✗'));
  console.log('  APP_SECRET: ' + (APP_SECRET ? '✓' : '✗'));
  console.log('  WORK_DIR: ' + WORK_DIR);
  console.log('  ALLOW_FROM: ' + (ALLOW_FROM ? ALLOW_FROM.join(', ') : 'all'));
  console.log('  ADMIN_FROM: ' + (ADMIN_FROM ? ADMIN_FROM.join(', ') : 'none'));
  console.log('========================================\n');

  await initDataDir();
  await loadAllSessions();
  await loadAllWorkspaces();

  if (APP_KEY && APP_SECRET) {
    initDingTalkStream();
  }
});

server.on('error', (err) => {
  console.error('Server error:', err);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  if (dingtalkClient) {
    dingtalkClient.disconnect();
  }
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  if (dingtalkClient) {
    dingtalkClient.disconnect();
  }
  server.close(() => {
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

console.log('Process PID:', process.pid);

// 保持事件循环活跃
const keepAlive = setInterval(() => {}, 60000);
