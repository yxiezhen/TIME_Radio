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

// LLM 配置:MiMo 开放平台 + DeepSeek 兜底
const MIMO_API_KEY = process.env.MIMO_API_KEY;
const DEEPSEEK_KEY = process.env.DEEPSEEK_KEY || '';
const MUSIC_U = process.env.MUSIC_U || '';
const NETEASE_CSRF = process.env.NETEASE_CSRF || '';
const UNBLOCK_URL = process.env.UNBLOCK_URL || 'http://unblock-music:3002';

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

async function getYearSongs(year) {
  // Step 1: Ask AI what songs were popular in China this year
  var prompt = `列出${year}年中国大陆、港澳台最流行的5首歌曲，每行格式：歌名 - 歌手。只输出歌名和歌手，不要序号和说明文字。`;
  
  try {
    var aiText = '';
    // Try DeepSeek
    try {
      var r1 = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + DEEPSEEK_KEY },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 300 })
      });
      if (r1.ok) aiText = (await r1.json()).choices[0].message.content;
    } catch(e) {}
    
    // Fallback to MiMo
    if (!aiText && MIMO_API_KEY) {
      try {
        var r2 = await fetch(MIMO_CHAT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'api-key': MIMO_API_KEY },
          body: JSON.stringify({ model: MIMO_MODEL, messages: [{ role: 'user', content: prompt }], temperature: 0.3, max_tokens: 300 })
        });
        if (r2.ok) aiText = (await r2.json()).choices[0].message.content;
      } catch(e) {}
    }
    
    if (!aiText) return [];
    
    // Step 2: Parse song names and search each on Netease
    var lines = aiText.split('\n').filter(function(l) { return l.trim(); });
    var found = [];
    
    for (var line of lines) {
      // Parse "歌名 - 歌手" format
      line = line.replace(/^[\d\s.、\)】]+/, '').trim();
      var parts = line.split(/[-–—]/);
      var songName = (parts[0] || '').trim();
      var artist = (parts[1] || '').trim();
      if (!songName) continue;
      
      // Search on Netease
      try {
        var keyword = songName + (artist ? ' ' + artist : '');
        var sRes = await fetch(MUSIC_SEARCH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://music.163.com/' },
          body: 's=' + encodeURIComponent(keyword) + '&type=1&offset=0&limit=3'
        });
        var sData = await sRes.json();
        var songs = sData?.result?.songs || [];
        if (songs.length > 0) {
          var s = songs[0];
          var a = (s.artists || []).map(function(x) { return x.name; }).join('/');
          found.push({ id: s.id, name: s.name, artist: a, playUrl: '/api/music/proxy?id=' + s.id });
        }
      } catch(e) { continue; }
      
      if (found.length >= 5) break;
    }
    
    if (found.length > 0) {
      console.log('  🎵 ' + year + '年金曲: ' + found.map(function(f) { return f.name + ' - ' + f.artist; }).join(', '));
    }
    return found;
  } catch(e) { return []; }
}

async function searchMusic(keyword) {
  try {
    const res = await fetch(MUSIC_SEARCH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://music.163.com/'
      },
      body: `s=${encodeURIComponent(keyword)}&type=1&offset=0&limit=20`
    });
    const data = await res.json();
    const songs = data?.result?.songs || [];
    
    return songs.slice(0, 3).map(function(s) {
      const artist = (s.artists || []).map(function(a) { return a.name; }).join('/');
      return {
        id: s.id,
        name: s.name,
        artist: artist,
        album: s.album?.name || '',
        picUrl: s.album?.picUrl || '',
        playUrl: `/api/music/proxy?id=${s.id}`
      };
    });
  } catch (err) {
    console.error('音乐搜索失败:', err.message);
    return [];
  }
}

// ===== LLM =====
async function callAI(prompt, modelType) {
  // Try DeepSeek first (more stable JSON output)
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: '生成' }
        ],
        temperature: 0.9,
        max_tokens: 3500
      })
    });
    if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${(await res.text()).slice(0,200)}`);
    return (await res.json()).choices[0].message.content;
  } catch (err) {
    console.warn('DeepSeek failed, falling back to MiMo:', err.message);
  }

  // Fallback to MiMo
  if (MIMO_API_KEY) {
    try {
      const res = await fetch(MIMO_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': MIMO_API_KEY },
        body: JSON.stringify({
          model: MIMO_MODEL,
          messages: [{ role: 'user', content: prompt + '\n\n请直接输出JSON,开始:' }],
          temperature: 0.9,
          max_tokens: 3500
        })
      });
      if (!res.ok) throw new Error(`MiMo ${res.status}: ${(await res.text()).slice(0,200)}`);
      return (await res.json()).choices[0].message.content;
    } catch (err) {
      console.warn('MiMo also failed:', err.message);
    }
  }
  
  throw new Error('所有AI模型不可用');
}

// ===== GENERATE =====
const genQueue = new Map();

function extractMusicKeyword(musicStr) {
  if (!musicStr) return '';
  let keyword = '';
  const m1 = musicStr.match(/[《]([^》]+)[》]\s*([^\s,,]{2,8})?/);
  if (m1) keyword = m1[1] + (m1[2] ? ' ' + m1[2] : '');
  if (!keyword) {
    const m2 = musicStr.match(/([^\s,,]{2,20})\s*[---]\s*([^\s,,]{2,8})/);
    if (m2) keyword = m2[1] + ' ' + m2[2];
  }
  if (!keyword) {
    const m3 = musicStr.match(/([\u4e00-\u9fff]{2,8})[歌由唱演]/);
    if (m3) keyword = m3[1];
  }
  return keyword.split(/[\s,,]/)[0] || keyword;
}

async function generateEpisodes(year) {
  // Step 1: Get real songs from this year first
  const yearSongs = await getYearSongs(year);
  var songListStr = '';
  if (yearSongs.length >= 3) {
    songListStr = '\n\n该年可用的歌曲有：' + yearSongs.map(function(s) { return '《' + s.name + '》' + s.artist; }).join('、');
  }
  
  const angles = ['怀旧回忆', '大历史', '小人物故事', '时代变迁', '流行文化', '科技发展', '社会变革', '音乐记忆', '体育激情'];
  const angle = angles[Math.floor(Math.random() * angles.length)];

  const prompt = `为${year}年的中国制作3个不同主题的广播节目(JSON数组)。角度:${angle}。

A. 大事件聚焦 - 最重要政治科技大事(5条)
B. 文化浪潮 - 流行文化音乐影视(4条)
C. 人间百态 - 社会生活民生趣闻(4条)

每条新闻必须有具体月日和地点。音乐介绍含《歌名》和歌手名(用《》标注)。每期一个host开场白。${songListStr}

JSON:
[{"episode_id":"a","title":"标题","focus":"一句话","host":"开场白150-200字","news":["事件1","事件2","事件3","事件4","事件5"],"music":"歌名歌手介绍","closing":"收尾","fullScript":"完整稿"},{"episode_id":"b","title":"标题","focus":"一句话","host":"开场白","news":["新闻1","新闻2","新闻3","新闻4"],"music":"音乐介绍","closing":"收尾","fullScript":"完整稿"},{"episode_id":"c","title":"标题","focus":"一句话","host":"开场白","news":["新闻1","新闻2","新闻3","新闻4"],"music":"音乐介绍","closing":"收尾","fullScript":"完整稿"}]`;

  try {
    // Try up to 2 times
    let episodes = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      const content = await callAI(prompt, 'chat');

      // Strip markdown code blocks if present
      let clean = content.replace(/```json\n?|```\n?/g, '').trim();

      // Extract JSON: find first [ and last ]
      const si = clean.indexOf('[');
      const ei = clean.lastIndexOf(']');
      if (si === -1 || ei === -1 || ei <= si) {
        if (attempt < 1) { console.warn(`  ⟳ ${year} JSON未找到,重试...`); continue; }
        throw new Error('JSON数组未找到');
      }

      let jsonStr = clean.substring(si, ei + 1);

      // Normalize MiMo's object-style news to strings
      jsonStr = jsonStr.replace(/\{"date":"([^"]+)","location":"([^"]*)","summary":"([^"]+)"\}/g, '$1 $2:$3');

      // Aggressive JSON repair
      episodes = tryParseJSON(jsonStr);
      if (!episodes) {
        episodes = extractJsonObjects(jsonStr);
      }

      if (episodes && Array.isArray(episodes) && episodes.length >= 2) {
        break;  // Success!
      }
      if (attempt < 1) console.warn(`  ⟳ ${year} 格式不对,重试...`);
    }

    if (!episodes || !Array.isArray(episodes) || episodes.length < 2) throw new Error('格式不对');

    // Normalize news arrays (MiMo sometimes returns objects instead of strings)
    episodes = episodes.map(function(ep) {
      if (ep.news && Array.isArray(ep.news)) {
        ep.news = ep.news.map(function(n) {
          if (typeof n === 'object' && n !== null) {
            return [n.date, n.location, n.summary].filter(Boolean).join(' ');
          }
          return String(n);
        });
      }
      return ep;
    });

    function tryParseJSON(str) {
      // Attempt 1: direct parse
      try { return JSON.parse(str); } catch(e) {}
      // Attempt 2: fix trailing commas
      try { return JSON.parse(str.replace(/,([\s]*[\]}])/g, '$1')); } catch(e) {}
      // Attempt 3: fix unescaped quotes inside strings
      try {
        const fixed = str.replace(/\\([^"\\/bfnrtu])/g, '$1')
          .replace(/\\"/g, '"')
          .replace(/([^\\])""([^,\]}])/g, '$1\\"$2');
        return JSON.parse(fixed);
      } catch(e) {}
      // Attempt 4: escape common Chinese special chars that break JSON
      try {
        const fixed = str.replace(/\u201c|\u201d/g, '\"').replace(/\u2018|\u2019/g, "'");
        return JSON.parse(fixed);
      } catch(e) {}
      return null;
    }

    function extractJsonObjects(str) {
      const results = [];
      const re = /\{[^{}]*\}/g;
      let match;
      while ((match = re.exec(str)) !== null) {
        try {
          let objStr = match[0];
          // Convert MiMo's object-style news back to strings
          objStr = objStr.replace(/\{"date":"([^"]+)","location":"([^"]*)","summary":"([^"]+)"\}/g, '$1 $2:$3');
          const obj = JSON.parse(objStr);
          if (obj.episode_id && obj.title && obj.host) {
            // Normalize news: ensure they're strings
            if (obj.news && Array.isArray(obj.news)) {
              obj.news = obj.news.map(function(n) {
                if (typeof n === 'object' && n !== null) {
                  return [n.date, n.location, n.summary].filter(Boolean).join(' ');
                }
                return String(n);
              });
            }
            results.push(obj);
          }
        } catch(e) {}
      }
      return results.length >= 2 ? results : null;
    }

    for (const ep of episodes) {
      const content = {
        host: ep.host, news: ep.news || [], music: ep.music || '',
        closing: ep.closing || '', fullScript: ep.fullScript || '',
        musicSearch: null
      };
      
      // Try to match with pre-fetched year songs
      if (ep.music && yearSongs.length > 0) {
        // Extract song name from music description
        var nameMatch = ep.music.match(/[《]([^》]+)[》]/);
        var songName = nameMatch ? nameMatch[1] : '';
        if (songName) {
          var matched = yearSongs.find(function(s) { return s.name.indexOf(songName) !== -1 || songName.indexOf(s.name) !== -1; });
          if (matched) {
            content.musicSearch = matched;
            console.log(`  ♪ ${year}/${ep.episode_id}: ${matched.name} - ${matched.artist}`);
          }
        }
      }
      
      // Fallback: try keyword search if no match
      if (!content.musicSearch && ep.music) {
        var keyword = extractMusicKeyword(ep.music);
        if (keyword) {
          try {
            var results = await searchMusic(keyword);
            if (results.length > 0) content.musicSearch = results[0];
          } catch(e) {}
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

  // Always generate fresh content
  const eps = listEpisodes(year);

  // If already generating this year, wait for result
  if (genQueue.has(year)) {
    try { await genQueue.get(year); return res.json({ year, episodes: listEpisodes(year), cached: true }); }
    catch { genQueue.delete(year); }
  }

  const p = generateEpisodes(year);
  genQueue.set(year, p);
  try {
    await p;
    const newEps = listEpisodes(year);
    if (newEps.length >= 3) {
      // Generation successful - if this was a force, old data was already replaced
      return res.json({ year, episodes: newEps, cached: false });
    }
    throw new Error('生成结果不完整');
  } catch (err) {
    // If force-regenerate failed, the old data was NOT deleted (we changed that)
    // so the user still sees the old cached version
    if (force) {
      const oldEps = listEpisodes(year);
      if (oldEps.length >= 3) {
        console.log(`  ⟳ ${year} 重新生成失败,保留旧数据`);
        return res.json({ year, episodes: oldEps, cached: true });
      }
    }
    res.status(500).json({ error: '生成失败:' + err.message });
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
  const songName = req.query.q || '';

  // Try 1: Netease outer URL (free songs)
  if (id) {
    for (const proto of ['http', 'https']) {
      try {
        const neteaseRes = await fetch(`${proto}://music.163.com/song/media/outer/url?id=${id}.mp3`);
        const buf = Buffer.from(await neteaseRes.arrayBuffer());
        if (buf.length > 1000 && !buf.slice(0, 20).includes('<')) {
          res.set('Content-Type', 'audio/mpeg');
          res.set('Access-Control-Allow-Origin', '*');
          return res.send(buf);
        }
      } catch (e) { /* try next */ }
    }
  }

  // Try 2: Search song name on alternative source
  if (songName) {
    try {
      // QQ Music search -> get song mid -> try to play
      const searchUrl = 'https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?format=json&key=' + encodeURIComponent(songName);
      const qqRes = await fetch(searchUrl, { headers: { 'Referer': 'https://y.qq.com/' } });
      const qqData = await qqRes.json();
      const songs = qqData?.data?.song?.itemlist || [];
      if (songs.length > 0) {
        // Try direct play URL (might work for some songs)
        const playUrl = 'https://isure.stream.qqmusic.qq.com/' + songs[0].mid + '.m4a';
        const altRes = await fetch(playUrl);
        if (altRes.ok) {
          const buf = Buffer.from(await altRes.arrayBuffer());
          if (buf.length > 10000) {
            res.set('Content-Type', 'audio/mp4');
            res.set('Access-Control-Allow-Origin', '*');
            return res.send(buf);
          }
        }
      }
    } catch (e) { /* fall through */ }
  }

  // Try 3: Netease VIP API with cookie
  if (id && MUSIC_U && NETEASE_CSRF) {
    try {
      const cookieStr = `MUSIC_U=${MUSIC_U}; __csrf=${NETEASE_CSRF}`;
      const vipRes = await fetch('https://music.163.com/api/song/enhance/player/url', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Referer': 'https://music.163.com/',
          'Cookie': cookieStr
        },
        body: `ids=[${id}]&br=320000`
      });
      const vipData = await vipRes.json();
      const realUrl = vipData?.data?.[0]?.url;
      if (realUrl) {
        const vipBufRes = await fetch(realUrl);
        if (vipBufRes.ok) {
          const buf = Buffer.from(await vipBufRes.arrayBuffer());
          if (buf.length > 10000) {
            res.set('Content-Type', 'audio/mpeg');
            res.set('Access-Control-Allow-Origin', '*');
            return res.send(buf);
          }
        }
      }
    } catch (e) {
      console.error('VIP API 失败:', e.message);
    }
  }

  // Try 4: UnblockNeteaseMusic (no VIP needed)
  if (id) {
    try {
      const unblockRes = await fetch(`${UNBLOCK_URL}/match?id=${id}&source=unm`);
      const unblockData = await unblockRes.json();
      if (unblockData?.code === 200 && unblockData?.data?.url) {
        const unblockBufRes = await fetch(unblockData.data.url);
        if (unblockBufRes.ok) {
          const buf = Buffer.from(await unblockBufRes.arrayBuffer());
          if (buf.length > 10000) {
            res.set('Content-Type', 'audio/mpeg');
            res.set('Access-Control-Allow-Origin', '*');
            return res.send(buf);
          }
        }
      }
    } catch (e) {
      console.error('Unblock 失败:', e.message);
    }
  }

  res.status(403).json({ error: 'vip', message: '该歌曲需要VIP或暂不可用' });
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
    return res.status(503).json({ error: 'TTS 不可用(请配置 MiMo API Key)' });
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
      console.log(`🧠  AI: DeepSeek (MiMo 备用)`);
      console.log(`🎙️  TTS: MiMo V2.5`);
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
