const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ========== 配置 ==========
const PORT = process.env.PORT || 3456;
const USE_TUNNEL = process.argv.includes('--tunnel');
const TUNNEL_SUBDOMAIN = process.argv.includes('--subdomain')
  ? process.argv[process.argv.indexOf('--subdomain') + 1]
  : undefined;

function getLanIps() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}
const DB_PATH = path.join(__dirname, 'writings.db');
const HTML_PATH = path.join(__dirname, '30天写作挑战.html');

// ========== 数据库 ==========
let db;

function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function initDb() {
  // 如果数据库文件已存在，从文件加载
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS writings (
      id          TEXT PRIMARY KEY,
      author      TEXT NOT NULL,
      day         INTEGER NOT NULL,
      theme       TEXT DEFAULT '',
      title       TEXT DEFAULT '',
      content     TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    )
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_writings_author ON writings(author)');
  db.run('CREATE INDEX IF NOT EXISTS idx_writings_day ON writings(day)');
  db.run('CREATE INDEX IF NOT EXISTS idx_writings_created ON writings(created_at)');

  saveDb();
}

// 辅助：将 sql.js 查询结果转为对象数组
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

// ========== Express 初始化 ==========
const app = express();
app.use(express.json({ limit: '1mb' }));

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ========== 静态文件 ==========
app.get('/', (req, res) => {
  if (!fs.existsSync(HTML_PATH)) {
    return res.status(404).send('HTML 文件未找到，请将 30天写作挑战.html 放在同目录下');
  }
  res.sendFile(HTML_PATH);
});

// 健康检查（云部署用）
app.get('/health', (req, res) => {
  res.json({ status: 'ok', db: !!db, time: Date.now() });
});

// ========== API 路由 ==========

// GET /api/writings —— 所有用户投稿
app.get('/api/writings', (req, res) => {
  try {
    const writings = queryAll(
      'SELECT id, author, day, theme, title, content, created_at AS createdAt, updated_at AS updatedAt FROM writings ORDER BY created_at DESC'
    );
    res.json(writings);
  } catch (err) {
    console.error('查询失败:', err.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/writings/:id —— 单篇
app.get('/api/writings/:id', (req, res) => {
  try {
    const w = queryOne(
      'SELECT id, author, day, theme, title, content, created_at AS createdAt, updated_at AS updatedAt FROM writings WHERE id = ?',
      [req.params.id]
    );
    if (!w) return res.status(404).json({ error: '未找到' });
    res.json(w);
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// POST /api/writings —— 新建或更新
app.post('/api/writings', (req, res) => {
  try {
    const { id, author, day, theme, title, content, createdAt } = req.body;
    if (!author || !content) {
      return res.status(400).json({ error: '作者和正文不能为空' });
    }

    const now = Date.now();
    const writingId = id || ('uw_' + now);
    const created = createdAt || now;

    // 检查是否存在
    const existing = queryOne('SELECT id FROM writings WHERE id = ?', [writingId]);

    if (existing) {
      run(
        'UPDATE writings SET author=?, day=?, theme=?, title=?, content=?, updated_at=? WHERE id=?',
        [author, day || 1, theme || '', title || '', content, now, writingId]
      );
    } else {
      run(
        'INSERT INTO writings (id, author, day, theme, title, content, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [writingId, author, day || 1, theme || '', title || '', content, created, now]
      );
    }

    const saved = queryOne(
      'SELECT id, author, day, theme, title, content, created_at AS createdAt, updated_at AS updatedAt FROM writings WHERE id = ?',
      [writingId]
    );
    res.json({ ok: true, writing: saved });
  } catch (err) {
    console.error('保存失败:', err.message);
    res.status(500).json({ error: '服务器错误' });
  }
});

// DELETE /api/writings/:id
app.delete('/api/writings/:id', (req, res) => {
  try {
    const existing = queryOne('SELECT id FROM writings WHERE id = ?', [req.params.id]);
    if (!existing) return res.status(404).json({ error: '未找到' });
    run('DELETE FROM writings WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  try {
    const total = queryOne('SELECT COUNT(*) AS count FROM writings');
    const authors = queryOne('SELECT COUNT(DISTINCT author) AS count FROM writings');
    const days = queryOne('SELECT COUNT(DISTINCT day) AS count FROM writings');
    res.json({ totalWritings: total.count, totalAuthors: authors.count, totalDays: days.count });
  } catch (err) {
    res.status(500).json({ error: '服务器错误' });
  }
});

// ========== 404 ==========
app.use((req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// ========== 启动 ==========
async function start() {
  const SQL = await initSqlJs();
  global.SQL = SQL;
  initDb();

  const server = app.listen(PORT, '0.0.0.0', () => {
    const lanIps = getLanIps();
    console.log('');
    console.log('  ✨ 30天写作挑战 后端已启动 ✨');
    console.log('  ────────────────────────────');
    console.log(`  💻 本机:  http://localhost:${PORT}`);
    lanIps.forEach(ip => {
      console.log(`  📱 同WiFi: http://${ip}:${PORT}`);
    });
    console.log(`  📦 API:   http://localhost:${PORT}/api/writings`);
    console.log(`  🗄️  数据库: ${DB_PATH}`);
    console.log('  ────────────────────────────');
    if (USE_TUNNEL) {
      console.log('  🌐 正在创建公网隧道（手机4G/5G也能访问）...');
    } else {
      console.log('  提示: node server.js --tunnel  开启公网访问');
      console.log('');
    }
  });

  // ===== 公网隧道（手机不同网络也能访问） =====
  if (USE_TUNNEL) {
    try {
      const localtunnel = require('localtunnel');
      const tunnel = await localtunnel({
        port: PORT,
        subdomain: TUNNEL_SUBDOMAIN,
      });
      console.log('');
      console.log('  🌐 公网地址（手机4G/5G打开）:');
      console.log(`  ────────────────────────────`);
      console.log(`  📱  ${tunnel.url}`);
      console.log(`  ────────────────────────────`);
      console.log('  任何网络都能访问！');
      console.log('');

      tunnel.on('close', () => {
        console.log('隧道已断开，重启服务以重新连接');
      });
    } catch (err) {
      console.log('');
      console.log('  ⚠️  公网隧道创建失败，请确认网络连接正常');
      console.log(`  错误: ${err.message}`);
      console.log('  备用方案: 手机连同一WiFi亦可访问');
      console.log('');
    }
  }
}

start().catch(err => {
  console.error('启动失败:', err);
  process.exit(1);
});
