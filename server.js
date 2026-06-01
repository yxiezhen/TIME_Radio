const express = require('express');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');
require('dotenv').config();
const cors = require('cors');

const app = express();
app.use(cors());
const PORT = process.env.PORT || 3456;
const DB_PATH = path.join(__dirname, 'broadcasts.db');

// LLM 配置：MiMo 开放平台 + DeepSeek 兜底
const MIMO_API_KEY = process.env.MIMO_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || '';

// MiMo (api.xiaomimimo.com)
const MIMO_BASE = 'https://api.xiaomimimo.com/v1';
const MIMO_CHAT_URL = MIMO_BASE + '/chat/completions';
const MIMO_MODEL = 'mimo-v2.5';
const MIMO_TTS_MODEL = 'mimo-v2.5-tts';

// DeepSeek 备用
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

let db;

// ===== DATABASE =====
async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
    console.log('📂 已加载现有数据库');
  } else {
    db = new SQL.Database();
    console.log('🆕 创建新数据库');
  }
  db.run(`CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    episode_id TEXT NOT NULL,
    title TEXT NOT NULL,
    focus TEXT,
    content TEXT NOT NULL,
    play_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(year, episode_id)
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_ep_year ON episodes(year)');
  saveDb();
}

function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function listEpisodes(year) {
  const stmt = db.prepare('SELECT episode_id, title, focus, play_count FROM episodes WHERE year = ? ORDER BY episode_id');
  stmt.bind([year]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getEpisode(year, eid) {
  const stmt = db.prepare('SELECT * FROM episodes WHERE year = ? AND episode_id = ?');
  stmt.bind([year, eid]);
  if (stmt.step()) {
    const r = stmt.getAsObject();
    stmt.free();
    return { ...r, content: JSON.parse(r.content || '{}') };
  }
  stmt.free();
  return null;
}

function saveEpisode(year, eid, title, focus, content) {
  db.run('INSERT OR REPLACE INTO episodes (year, episode_id, title, focus, content) VALUES (?,?,?,?,?)',
    [year, eid, title, focus, JSON.stringify(content)]);
  saveDb();
}

function incPlay(year, eid) {
  db.run('UPDATE episodes SET play_count = play_count + 1 WHERE year = ? AND episode_id = ?', [year, eid]);
  saveDb();
}

function getAllYears() {
  const stmt = db.prepare('SELECT year, COUNT(*) as count, SUM(play_count) as plays FROM episodes GROUP BY year ORDER BY year');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// ===== MUSIC SEARCH (Netease) =====
const MUSIC_SEARCH = 'https://music.163.com/api/search/get/web';

async function searchMusic(keyword) {
  try {
    const res = await fetch(MUSIC_SEARCH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://music.163.com/'
      },
      body: `s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=5`
    });
    const data = await res.json();
    const songs = data?.result?.songs || [];
    return songs.slice(0, 3).map(s => ({
      id: s.id,
      name: s.name,
      artist: (s.artists || []).map(a => a.name).join('/'),
      album: s.album?.name || '',
      picUrl: s.album?.picUrl || '',
      playUrl: `/api/music/proxy?id=${s.id}`
    }));
  } catch (err) {
    console.error('音乐搜索失败:', err.message);
    return [];
  }
}

// ===== LLM =====
async function callAI(prompt, modelType) {
  // Try MiMo first
  if (MIMO_API_KEY) {
    const headers = {
      'Content-Type': 'application/json',
      'api-key': MIMO_API_KEY  // MiMo 使用 api-key 头
    };
    
    try {
      const res = await fetch(MIMO_CHAT_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: MIMO_MODEL,
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: '生成' }
          ],
          temperature: 0.92,
          max_tokens: 3500
        })
      });
      if (!res.ok) throw new Error(`MiMo ${res.status}: ${(await res.text()).slice(0,200)}`);
      const data = await res.json();
      return data.choices[0].message.content;
    } catch (err) {
      console.warn('MiMo failed, falling back to DeepSeek:', err.message);
    }
  }
  
  // Fallback to DeepSeek
  const res = await fetch(DEEPSEEK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: '生成' }
      ],
      temperature: 0.92,
      max_tokens: 3500
    })
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0,200)}`);
  return (await res.json()).choices[0].message.content;
}

// ===== GENERATE =====
const genQueue = new Map();

async function generateEpisodes(year) {
  const prompt = `你是一个怀旧广播电台制作人。请为${year}年的中国制作3个不同主题的广播节目。

听众是中国老年人，内容以中国为主、兼顾国际。

三个主题：
A. 大事件聚焦 — ${year}年中国及全球最重要的政治、科技大事（5条新闻，各含月日地点）
B. 文化浪潮 — ${year}年中国流行文化、音乐、影视（4条，含歌名歌手，优先中国歌曲）
C. 人间百态 — ${year}年中国社会生活、民生趣闻（4条，含月日地点）

要求：
- 每条新闻必须有具体月日地点
- 优先选用中国的事件、中国歌手和中国歌曲
- 主持人开场白要亲切怀旧，像真人电台

音乐介绍要包含歌名（用《》标注）和歌手名，便于搜索播放。

只输出一个JSON数组，不要其他文字：
[{"episode_id":"a","title":"4-8字标题","focus":"一句话主题","host":"开场白150-200字","news":["3月20日北京：事件","7月15日上海：事件","9月1日：事件","10月：事件","12月：事件"],"music":"《歌名》歌手名 - 介绍60-100字","closing":"收尾30-50字","fullScript":"完整稿200-300字"},{"episode_id":"b","title":"4-8字标题","focus":"一句话主题","host":"开场白","news":["新闻1","新闻2","新闻3","新闻4"],"music":"《歌名》歌手名 - 介绍","closing":"收尾","fullScript":"完整稿"},{"episode_id":"c","title":"4-8字标题","focus":"一句话主题","host":"开场白","news":["新闻1","新闻2","新闻3","新闻4"],"music":"《歌名》歌手名 - 介绍","closing":"收尾","fullScript":"完整稿"}]`;

  try {
    const content = await callAI(prompt, 'chat');
    
    // Extract JSON: find first [ and last ]
    const si = content.indexOf('[');
    const ei = content.lastIndexOf(']');
    if (si === -1 || ei === -1 || ei <= si) throw new Error('JSON数组未找到');
    
    let jsonStr = content.substring(si, ei + 1);
    
    // Try to fix common JSON issues
    let episodes;
    try {
      episodes = JSON.parse(jsonStr);
    } catch (e) {
      // Try fixing: remove trailing commas before ] or }
      jsonStr = jsonStr.replace(/,([\s]*[\]}])/g, '$1');
      // Try fixing: unescape quotes inside strings
      jsonStr = jsonStr.replace(/\\([^"\\/bfnrtu])/g, '$1');
      try {
        episodes = JSON.parse(jsonStr);
      } catch (e2) {
        console.warn('JSON fix attempt failed, trying line-by-line extract');
        // Last resort: extract by matching object patterns
        const objs = jsonStr.match(/\{[^{}]*"episode_id"[^{}]*\}/g);
        if (objs && objs.length >= 2) {
          episodes = objs.map(o => JSON.parse(o));
        } else {
          throw e2;
        }
      }
    }
    if (!Array.isArray(episodes) || episodes.length < 2) throw new Error('格式不对');
    
    for (const ep of episodes) {
      const content = {
        host: ep.host, news: ep.news || [], music: ep.music || '',
        closing: ep.closing || '', fullScript: ep.fullScript || '',
        musicSearch: null
      };
      
      // Try to search music on Netease
      if (ep.music) {
        // Extract song name - try multiple formats
        let keyword = '';
        // Format 1: 《歌名》
        const m1 = ep.music.match(/[《]([^》]+)[》]\s*([^\s,，]{2,8})?/);
        if (m1) keyword = m1[1] + (m1[2] ? ' ' + m1[2] : '');
        // Format 2: 歌名 - 歌手 or 歌名-歌手
        if (!keyword) {
          const m2 = ep.music.match(/([^\s,，]{2,20})\s*[-–—]\s*([^\s,，]{2,8})/);
          if (m2) keyword = m2[1] + ' ' + m2[2];
        }
        // Format 3: pick first Chinese name-like string (5+ chars)
        if (!keyword) {
          const m3 = ep.music.match(/([\u4e00-\u9fff]{2,8})[歌由唱演]/);
          if (m3) keyword = m3[1];
        }
        
        if (keyword) {
          const results = await searchMusic(keyword);
          if (results.length > 0) {
            content.musicSearch = results[0];
            console.log(`  ♪ ${year}/${ep.episode_id}: ${results[0].name} - ${results[0].artist}`);
          } else {
            // Try searching just the song name
            const simpleName = keyword.split(/[\s,，]/)[0];
            if (simpleName) {
              const retry = await searchMusic(simpleName);
              if (retry.length > 0) {
                content.musicSearch = retry[0];
              }
            }
          }
        }
      }
      
      saveEpisode(year, ep.episode_id, ep.title, ep.focus, content);
    }
    console.log(`✓ ${year} 年 3期广播已生成`);
    return episodes;
  } catch (err) {
    console.error(`✗ ${year}: ${err.message}`);
    throw err;
  }
}

// ===== ROUTES =====
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/broadcast', async (req, res) => {
  const year = parseInt(req.query.year);
  if (isNaN(year) || year < 1950 || year > 2025) return res.status(400).json({ error: '年份需在1950-2025之间' });

  // Specific episode
  if (req.query.episode) {
    const ep = getEpisode(year, req.query.episode);
    if (ep) { incPlay(year, req.query.episode); return res.json({ year, episode: ep, cached: true }); }
    return res.status(404).json({ error: '不存在' });
  }

  // Force regenerate?
  const force = req.query.force === '1';
  
  // Check cache
  const eps = listEpisodes(year);
  if (eps.length >= 3 && !force) return res.json({ year, episodes: eps, cached: true });
  
  // If force, delete old episodes
  if (force) {
    db.run('DELETE FROM episodes WHERE year = ?', [year]);
    saveDb();
    console.log(`  ⟳ 强制重新生成 ${year}`);
  }

  // Dedup
  if (genQueue.has(year)) {
    try { await genQueue.get(year); return res.json({ year, episodes: listEpisodes(year), cached: true }); }
    catch { genQueue.delete(year); }
  }

  const p = generateEpisodes(year);
  genQueue.set(year, p);
  try {
    await p;
    res.json({ year, episodes: listEpisodes(year), cached: false });
  } catch (err) {
    res.status(500).json({ error: '生成失败：' + err.message });
  } finally { genQueue.delete(year); }
});

app.get('/api/episode', (req, res) => {
  const y = parseInt(req.query.year), id = req.query.id;
  if (isNaN(y) || !id) return res.status(400).json({ error: '缺参数' });
  const ep = getEpisode(y, id);
  if (!ep) return res.status(404).json({ error: '未找到' });
  res.json({ year: y, episode: ep });
});

app.get('/api/status', (req, res) => {
  const y = parseInt(req.query.year);
  if (isNaN(y)) return res.status(400).json({ error: '缺少年份' });
  res.json({ year: y, episodes: listEpisodes(y).length, generating: genQueue.has(y) });
});

app.get('/api/years', (req, res) => {
  const years = getAllYears();
  const total = years.reduce((s, y) => s + y.count, 0);
  const plays = years.reduce((s, y) => s + y.plays, 0);
  res.json({ years, totalEpisodes: total, totalPlays: plays });
});

// ===== MUSIC API ROUTE =====
app.get('/api/music/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: '缺搜索词' });
  const results = await searchMusic(q);
  res.json({ results });
});

app.get('/api/music/proxy', async (req, res) => {
  const id = parseInt(req.query.id);
  if (!id) return res.status(400).json({ error: '缺歌曲ID' });
  try {
    const neteaseRes = await fetch(`http://music.163.com/song/media/outer/url?id=${id}.mp3`);
    if (!neteaseRes.ok) return res.status(502).json({ error: '音乐源不可达' });
    res.set('Content-Type', 'audio/mpeg');
    res.set('Access-Control-Allow-Origin', '*');
    const audioBuf = Buffer.from(await neteaseRes.arrayBuffer());
    res.send(audioBuf);
  } catch (err) {
    res.status(502).json({ error: '代理失败' });
  }
});

// ===== TTS =====

app.post('/api/tts', express.json(), async (req, res) => {
  const text = req.body.text;
  if (!text) return res.status(400).json({ error: '缺文字' });

  // Try MiMo TTS (via chat/completions with audio)
  if (MIMO_API_KEY) {
    try {
      const ttsRes = await fetch(MIMO_CHAT_URL, {
        method: 'POST',
        headers: {
          'api-key': MIMO_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: MIMO_TTS_MODEL,
          messages: [
            { role: 'user', content: '用自然的语气朗读' },
            { role: 'assistant', content: text }
          ],
          audio: { format: 'wav', voice: 'mimo_default' }
        })
      });

      if (ttsRes.ok) {
        const data = await ttsRes.json();
        const audioB64 = data.choices?.[0]?.message?.audio?.data;
        if (audioB64) {
          const audioBuffer = Buffer.from(audioB64, 'base64');
          res.set('Content-Type', 'audio/wav');
          res.set('Content-Length', audioBuffer.length);
          return res.send(audioBuffer);
        }
      }
      console.warn('MiMo TTS failed:', ttsRes.status);
    } catch (err) {
      console.warn('MiMo TTS error:', err.message);
    }
  }

  // Fallback: Speaches TTS
  let speachesKey = process.env.STT_WRAPPER_API_KEY;
  if (!speachesKey) {
    try {
      const envFile = fs.readFileSync('/home/yao/.openclaw/workspace/services/speaches-runtime/config/speaches.env', 'utf-8');
      const match = envFile.split('\n').find(l => l.startsWith('API_KEY='));
      if (match) speachesKey = match.split('=', 2)[1].trim();
    } catch(e) { /* */ }
  }

  if (!speachesKey) {
    return res.status(503).json({ error: 'TTS 不可用（请配置 MiMo API Key）' });
  }

  try {
    const ttsRes = await fetch('http://100.102.252.78:27177/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + speachesKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'speaches-ai/piper-zh_CN-huayan-medium',
        voice: 'default',
        input: text,
        response_format: 'mp3',
        speed: 1.0
      })
    });

    if (!ttsRes.ok) {
      const err = await ttsRes.text();
      return res.status(502).json({ error: 'TTS 服务错误' });
    }

    const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length);
    res.send(audioBuffer);
  } catch (err) {
    console.error('TTS failed:', err.message);
    res.status(502).json({ error: 'TTS 不可达' });
  }
});

// ===== START =====
async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`\n🕰️  RADIO TIME MACHINE`);
    console.log(`📻  http://0.0.0.0:${PORT}`);
    
    if (MIMO_API_KEY) {
      console.log(`🧠  AI: MiMo V2.5 (xiaomimimo.com)`);
      console.log(`🎙️  TTS: MiMo V2.5 TTS`);
    } else {
      console.log(`🧠  AI: DeepSeek (备用)`);
      console.log(`🎙️  TTS: 浏览器语音`);
    }
    
    const ys = getAllYears();
    const t = ys.reduce((s, y) => s + y.count, 0);
    console.log(`🗄️  ${t} 期节目, 覆盖 ${ys.length} 个年份`);
  });
}
start().catch(e => { console.error('启动失败:', e); process.exit(1); });
