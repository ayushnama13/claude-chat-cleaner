const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = 7788;
const HOST = '127.0.0.1';

function getClaudeHome() {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

function validateParam(param) {
  if (!param || typeof param !== 'string' || !/^[A-Za-z0-9._-]+$/.test(param)) {
    throw new Error('Invalid parameter format');
  }
  return param;
}

function safePath(base, targetPath) {
  const resolved = path.resolve(base, targetPath);
  const resolvedBase = path.resolve(base);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

function isSessionLive(id, claudeHome) {
  validateParam(id);
  // Check 1: sessions/*.json
  const sessionsDir = path.join(claudeHome, 'sessions');
  try {
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const filePath = path.join(sessionsDir, file);
            const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const sessionId = data.sessionId || data.id || path.basename(file, '.json');
            if (sessionId === id && typeof data.pid === 'number') {
              if (isPidAlive(data.pid)) return true;
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {}

  // Check 2: daemon/roster.json workers
  const rosterPath = path.join(claudeHome, 'daemon', 'roster.json');
  try {
    if (fs.existsSync(rosterPath)) {
      const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
      if (roster && roster.workers) {
        const shortId = id.substring(0, 8);
        for (const [key, worker] of Object.entries(roster.workers)) {
          if (key === shortId || worker.sessionId === id || worker.id === id) {
            if (worker && typeof worker.pid === 'number') {
              if (isPidAlive(worker.pid)) return true;
            }
          }
        }
      }
    }
  } catch (e) {}

  return false;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function apiGetProjects(req, res) {
  const claudeHome = getClaudeHome();
  const projectsDir = path.join(claudeHome, 'projects');
  const result = [];
  try {
    if (fs.existsSync(projectsDir)) {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirName = entry.name;
          const projPath = path.join(projectsDir, dirName);
          let count = 0;
          let totalBytes = 0;
          try {
            const files = fs.readdirSync(projPath);
            for (const file of files) {
              if (file.endsWith('.jsonl')) {
                count++;
                const stat = fs.statSync(path.join(projPath, file));
                totalBytes += stat.size;
              }
            }
          } catch (e) {}

          let label = dirName;
          try {
            label = decodeURIComponent(dirName);
          } catch (e) {}

          result.push({
            dir: dirName,
            label,
            count,
            totalBytes
          });
        }
      }
    }
  } catch (e) {}
  sendJson(res, 200, result);
}

function apiGetChats(req, res, query) {
  const claudeHome = getClaudeHome();
  const projectsDir = path.join(claudeHome, 'projects');
  const projectParam = query.project || 'ALL';
  const chats = [];

  try {
    if (fs.existsSync(projectsDir)) {
      const projDirs = projectParam === 'ALL'
        ? fs.readdirSync(projectsDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
        : [validateParam(projectParam)];

      for (const proj of projDirs) {
        const projPath = path.join(projectsDir, proj);
        if (!fs.existsSync(projPath)) continue;
        const files = fs.readdirSync(projPath);
        for (const file of files) {
          if (!file.endsWith('.jsonl')) continue;
          const id = path.basename(file, '.jsonl');
          try {
            validateParam(id);
            const filePath = path.join(projPath, file);
            const stat = fs.statSync(filePath);
            const mtime = stat.mtimeMs;
            const bytes = stat.size;

            let firstMessage = '(empty)';
            try {
              const HEAD = 256 * 1024;
              const fdh = fs.openSync(filePath, 'r');
              const hbuf = Buffer.alloc(Math.min(HEAD, bytes));
              fs.readSync(fdh, hbuf, 0, hbuf.length, 0);
              fs.closeSync(fdh);
              const lines = hbuf.toString('utf8').split('\n');
              if (bytes > HEAD) lines.pop();
              for (const line of lines) {
                if (!line.trim()) continue;
                try {
                  const obj = JSON.parse(line);
                  const msgType = obj.type || obj.message?.role;
                  if (msgType === 'user' || obj.message?.role === 'user') {
                    const msgContent = obj.message?.content || obj.content;
                    let text = '';
                    if (typeof msgContent === 'string') {
                      text = msgContent;
                    } else if (Array.isArray(msgContent)) {
                      for (const block of msgContent) {
                        if (block.type === 'text' && block.text) {
                          text += block.text + ' ';
                        }
                      }
                    }
                    text = text.trim();
                    if (text) {
                      firstMessage = text.length > 80 ? text.substring(0, 80) + '...' : text;
                      break;
                    }
                  }
                } catch (e) {}
              }
            } catch (e) {}

            const live = isSessionLive(id, claudeHome);

            chats.push({
              project: proj,
              id,
              mtime,
              bytes,
              firstMessage,
              live
            });
          } catch (e) {}
        }
      }
    }
  } catch (e) {}

  chats.sort((a, b) => b.mtime - a.mtime);
  sendJson(res, 200, chats);
}

function apiGetChat(req, res, query) {
  const claudeHome = getClaudeHome();
  const project = validateParam(query.project);
  const id = validateParam(query.id);

  const projectsDir = path.join(claudeHome, 'projects');
  const filePath = safePath(projectsDir, path.join(project, id + '.jsonl'));

  if (!fs.existsSync(filePath)) {
    return sendError(res, 404, 'Chat not found');
  }

  const stat = fs.statSync(filePath);
  const MAX_SIZE = 5 * 1024 * 1024; // 5MB
  let truncated = false;

  let content = '';
  try {
    if (stat.size > MAX_SIZE) {
      truncated = true;
      const buffer = Buffer.alloc(MAX_SIZE);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, MAX_SIZE, 0);
      fs.closeSync(fd);
      content = buffer.toString('utf8');
    } else {
      content = fs.readFileSync(filePath, 'utf8');
    }
  } catch (e) {
    return sendError(res, 500, 'Error reading chat file');
  }

  const lines = content.split('\n');
  const messages = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      const type = obj.type || obj.message?.role || 'unknown';
      let role = 'unknown';
      if (type === 'user' || obj.message?.role === 'user') role = 'user';
      else if (type === 'assistant' || obj.message?.role === 'assistant') role = 'assistant';
      else if (type === 'tool_result' || type === 'tool') role = 'tool';
      else role = type;

      const msgContent = obj.message?.content || obj.content;

      if (typeof msgContent === 'string') {
        messages.push({ role, text: msgContent });
      } else if (Array.isArray(msgContent)) {
        for (const block of msgContent) {
          if (block.type === 'text') {
            messages.push({ role, text: block.text || '' });
          } else if (block.type === 'tool_use') {
            const inputStr = typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2);
            messages.push({ role: 'assistant', text: `TOOL ${block.name || 'unknown'}: ${inputStr}` });
          } else if (block.type === 'tool_result') {
            const resContent = typeof block.content === 'string' ? block.content : JSON.stringify(block.content, null, 2);
            messages.push({ role: 'tool_result', text: resContent });
          } else {
            messages.push({ role, text: JSON.stringify(block) });
          }
        }
      } else if (msgContent) {
        messages.push({ role, text: JSON.stringify(msgContent) });
      } else if (obj.text) {
        messages.push({ role, text: obj.text });
      }
    } catch (e) {}
  }

  sendJson(res, 200, { messages, truncated, size: stat.size });
}

function apiDeleteChats(req, res, body) {
  const claudeHome = getClaudeHome();
  const items = body.items;
  if (!Array.isArray(items)) {
    return sendError(res, 400, 'Invalid request body, items array required');
  }

  const timestamp = Date.now();
  const trashBatchDir = path.join(claudeHome, '.trash', String(timestamp));
  const results = [];
  const manifestItems = [];

  for (const item of items) {
    try {
      const proj = validateParam(item.project);
      const id = validateParam(item.id);
      if (isSessionLive(id, claudeHome)) {
        return sendJson(res, 400, { success: false, error: `Cannot delete live session ${id}`, results });
      }
    } catch (e) {
      return sendJson(res, 400, { success: false, error: e.message, results });
    }
  }

  const rosterPath = path.join(claudeHome, 'daemon', 'roster.json');
  let rosterData = null;
  let rosterExisted = false;
  try {
    if (fs.existsSync(rosterPath)) {
      rosterExisted = true;
      rosterData = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
    }
  } catch (e) {}

  fs.mkdirSync(trashBatchDir, { recursive: true });
  if (rosterExisted && rosterData) {
    fs.writeFileSync(path.join(trashBatchDir, 'roster_backup.json'), JSON.stringify(rosterData, null, 2));
  }

  const projectsDir = path.join(claudeHome, 'projects');
  const sessionEnvDir = path.join(claudeHome, 'session-env');
  const fileHistoryDir = path.join(claudeHome, 'file-history');
  const jobsDir = path.join(claudeHome, 'jobs');

  for (const item of items) {
   try {
    const proj = item.project;
    const id = item.id;
    const itemTrashDir = path.join(trashBatchDir, proj, id);
    fs.mkdirSync(itemTrashDir, { recursive: true });

    const pathsMoved = {};

    const jsonlPath = safePath(projectsDir, path.join(proj, id + '.jsonl'));
    if (fs.existsSync(jsonlPath)) {
      const dest = path.join(itemTrashDir, id + '.jsonl');
      fs.renameSync(jsonlPath, dest);
      pathsMoved.jsonl = dest;
    }

    const chatFolder = safePath(projectsDir, path.join(proj, id));
    if (fs.existsSync(chatFolder) && fs.statSync(chatFolder).isDirectory()) {
      const dest = path.join(itemTrashDir, id);
      fs.renameSync(chatFolder, dest);
      pathsMoved.chatFolder = dest;
    }

    const sePath = safePath(sessionEnvDir, id);
    if (fs.existsSync(sePath)) {
      const dest = path.join(itemTrashDir, 'session-env');
      fs.renameSync(sePath, dest);
      pathsMoved.sessionEnv = dest;
    }

    const fhPath = safePath(fileHistoryDir, id);
    if (fs.existsSync(fhPath)) {
      const dest = path.join(itemTrashDir, 'file-history');
      fs.renameSync(fhPath, dest);
      pathsMoved.fileHistory = dest;
    }

    const shortId = id.substring(0, 8);
    const jobPath = safePath(jobsDir, shortId);
    if (fs.existsSync(jobPath)) {
      const dest = path.join(itemTrashDir, 'jobs');
      fs.renameSync(jobPath, dest);
      pathsMoved.jobDir = dest;
    }

    let rosterWorkerKey = shortId;
    let rosterWorkerData = null;
    if (rosterData && rosterData.workers && rosterData.workers[shortId]) {
      rosterWorkerData = rosterData.workers[shortId];
      delete rosterData.workers[shortId];
    }

    manifestItems.push({
      project: proj,
      id,
      pathsMoved,
      rosterWorkerKey,
      rosterWorkerData
    });

    results.push({ project: proj, id, success: true });
   } catch (e) {
    results.push({ project: item.project, id: item.id, success: false, error: e.message });
   }
  }

  if (rosterExisted && rosterData) {
    try {
      fs.writeFileSync(rosterPath, JSON.stringify(rosterData, null, 2));
    } catch (e) {}
  }

  const manifest = { timestamp, items: manifestItems };
  fs.writeFileSync(path.join(trashBatchDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  sendJson(res, 200, { success: true, results });
}

function apiGetTrash(req, res) {
  const claudeHome = getClaudeHome();
  const trashDir = path.join(claudeHome, '.trash');
  const batches = [];

  try {
    if (fs.existsSync(trashDir)) {
      const batchDirs = fs.readdirSync(trashDir, { withFileTypes: true });
      for (const entry of batchDirs) {
        if (entry.isDirectory()) {
          const batchId = entry.name;
          const batchPath = path.join(trashDir, batchId);
          const manifestPath = path.join(batchPath, 'manifest.json');
          try {
            if (fs.existsSync(manifestPath)) {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
              const totalBytes = getDirSize(batchPath);
              batches.push({
                batch: batchId,
                timestamp: manifest.timestamp || Number(batchId),
                itemsCount: manifest.items ? manifest.items.length : 0,
                totalBytes
              });
            }
          } catch (e) {}
        }
      }
    }
  } catch (e) {}

  batches.sort((a, b) => b.timestamp - a.timestamp);
  sendJson(res, 200, batches);
}

function getDirSize(dirPath) {
  let size = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        size += stat.size;
      }
    }
  } catch (e) {}
  return size;
}

function apiRestoreBatch(req, res, body) {
  const claudeHome = getClaudeHome();
  const batch = validateParam(body.batch);
  const trashDir = path.join(claudeHome, '.trash');
  const batchPath = safePath(trashDir, batch);
  const manifestPath = path.join(batchPath, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    return sendError(res, 404, 'Trash batch not found');
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const projectsDir = path.join(claudeHome, 'projects');
    const sessionEnvDir = path.join(claudeHome, 'session-env');
    const fileHistoryDir = path.join(claudeHome, 'file-history');
    const jobsDir = path.join(claudeHome, 'jobs');

    if (manifest.items) {
      for (const item of manifest.items) {
        const { project, id, pathsMoved, rosterWorkerKey, rosterWorkerData } = item;

        if (pathsMoved.jsonl && fs.existsSync(pathsMoved.jsonl)) {
          const dest = safePath(projectsDir, path.join(project, id + '.jsonl'));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(pathsMoved.jsonl, dest);
        }
        if (pathsMoved.chatFolder && fs.existsSync(pathsMoved.chatFolder)) {
          const dest = safePath(projectsDir, path.join(project, id));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(pathsMoved.chatFolder, dest);
        }
        if (pathsMoved.sessionEnv && fs.existsSync(pathsMoved.sessionEnv)) {
          const dest = safePath(sessionEnvDir, id);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(pathsMoved.sessionEnv, dest);
        }
        if (pathsMoved.fileHistory && fs.existsSync(pathsMoved.fileHistory)) {
          const dest = safePath(fileHistoryDir, id);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(pathsMoved.fileHistory, dest);
        }
        if (pathsMoved.jobDir && fs.existsSync(pathsMoved.jobDir)) {
          const shortId = id.substring(0, 8);
          const dest = safePath(jobsDir, shortId);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.renameSync(pathsMoved.jobDir, dest);
        }

        if (rosterWorkerKey && rosterWorkerData) {
          const rosterPath = path.join(claudeHome, 'daemon', 'roster.json');
          try {
            let roster = { workers: {} };
            if (fs.existsSync(rosterPath)) {
              roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8'));
            }
            if (!roster.workers) roster.workers = {};
            roster.workers[rosterWorkerKey] = rosterWorkerData;
            fs.mkdirSync(path.dirname(rosterPath), { recursive: true });
            fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
          } catch (e) {}
        }
      }
    }

    fs.rmSync(batchPath, { recursive: true, force: true });
    sendJson(res, 200, { success: true });
  } catch (e) {
    sendError(res, 500, 'Error restoring batch: ' + e.message);
  }
}

function apiPurgeTrash(req, res) {
  const claudeHome = getClaudeHome();
  const trashDir = path.join(claudeHome, '.trash');
  try {
    if (fs.existsSync(trashDir)) {
      fs.rmSync(trashDir, { recursive: true, force: true });
    }
    sendJson(res, 200, { success: true });
  } catch (e) {
    sendError(res, 500, 'Error purging trash: ' + e.message);
  }
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = parsedUrl.pathname;
  const query = Object.fromEntries(parsedUrl.searchParams.entries());

  const hostOk = [`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host);
  if (!hostOk) { res.writeHead(403); return res.end('Forbidden host'); }
  if (req.method === 'POST') {
    const origin = req.headers.origin;
    const originOk = !origin || origin === `http://127.0.0.1:${PORT}` || origin === `http://localhost:${PORT}`;
    const typeOk = (req.headers['content-type'] || '').startsWith('application/json') && req.headers['x-cleaner'] === '1';
    if (!originOk || !typeOk) { res.writeHead(403); return res.end('Forbidden'); }
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const indexPath = path.join(__dirname, 'index.html');
    fs.readFile(indexPath, 'utf8', (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('index.html not found');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      }
    });
  } else if (req.method === 'GET' && pathname === '/api/projects') {
    apiGetProjects(req, res);
  } else if (req.method === 'GET' && pathname === '/api/chats') {
    apiGetChats(req, res, query);
  } else if (req.method === 'GET' && pathname === '/api/chat') {
    try {
      apiGetChat(req, res, query);
    } catch (e) {
      sendError(res, 400, e.message);
    }
  } else if (req.method === 'GET' && pathname === '/api/trash') {
    apiGetTrash(req, res);
  } else if (req.method === 'POST' && pathname === '/api/delete') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', () => {
      try {
        const body = JSON.parse(bodyStr);
        apiDeleteChats(req, res, body);
      } catch (e) {
        sendError(res, 400, 'Invalid JSON body');
      }
    });
  } else if (req.method === 'POST' && pathname === '/api/restore') {
    let bodyStr = '';
    req.on('data', chunk => { bodyStr += chunk; });
    req.on('end', () => {
      try {
        const body = JSON.parse(bodyStr);
        apiRestoreBatch(req, res, body);
      } catch (e) {
        sendError(res, 400, 'Invalid JSON body');
      }
    });
  } else if (req.method === 'POST' && pathname === '/api/purge') {
    apiPurgeTrash(req, res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude chat cleaner running at http://${HOST}:${PORT}`);
});
