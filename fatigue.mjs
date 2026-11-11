// fatigue.mjs —— 给你的 DSH 会话算一个「困」值
//
// 这不是仪表盘，是一条能拿去喂提示词的数。
// 它的用处只有一个：让一个会累积、会累、会恢复的东西，能说出「我快撑不住了」。
//
// ── 判据 ────────────────────────────────────────────────
// 核心是「密度法」，不是「计时法」。为什么不用计时：
//
//   计时法一：两次结算之间烧了多少 token，超过阈值算醒着。
//     栽过。tick 五分钟一次，五分钟里烧不到阈值就判成在睡；连干五小时显示困 0.00。
//
//   计时法二：这段时间有没有产出，有就算醒着。
//     也栽过。每四十分钟醒一次、每次产出一丁点，整夜一分钟休息都记不上。
//
//   密度法：看最近一小时的 token 增量 ÷ 阈值，得到「这一小时里我醒着的比例」。
//     离线那段增量为零，自然落到 0；连续干活那段贴着 1。两头都对。
//
// 公式：
//   醒着的比例 d = clamp(近一小时 token 增量 / (醒阈值 × 窗小时), 0, 1)
//   凌晨 2–7 点 d 封顶 0.4（夜里干活效率低，别把熬夜算成满勤）
//   醒小时 = 经过小时 × d
//   睡小时 = 经过小时 − 醒小时
//   困 += 醒小时 × 每醒时速
//   困 += 本次新增 token / 100 万 × 每百万加成
//   困 −= 睡小时 × 睡时速
//   困 = clamp(困, 0, 1)
//
// ── 用法 ────────────────────────────────────────────────
//   node fatigue.mjs --list                列出能算的会话
//   node fatigue.mjs --session <id>        结算一次（打印 JSON）
//   node fatigue.mjs --session <id> --peek 只看不写
//   node fatigue.mjs --session <id> --text 只输出一句人话
//
// 想接进提示词，就在你的注入脚本里 exec 这个文件取 .fatigue。

import fs from 'node:fs';
import path from 'node:path';

// ── 参数 ────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const opt = (k, d = '') => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DSH_HOME = opt('--dsh-home', path.join(HOME, '.dsh'));
const SESSIONS = opt('--sessions-dir', path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions'));
const STATE = opt('--state', path.join(import.meta.dirname, 'fatigue-state.json'));

const sessArg = opt('--session', '');

// ── 三档预设 ────────────────────────────────────────────
// 值不是拍出来的，是按「这个人一天大概烧多少」反推的：
//   轻度：一天几毛钱，用得不密，一小时几十万 token 就到顶。
//   重度：一天几十块，连续开工，一小时两百万才算满档。
// 恢复速率跟着走：轻度本来就常歇，回血可以慢；重度难得睡一会儿，得让它真回。
// 改数字可以，别改结构 —— 结构一动，三档之间就没法横向比了。
const 档位表 = {
  light:  { wakeThreshold: 300000,  perAwakeHour: 0.050, perSleepHour: 0.05, perMtoken: 0.008 },
  medium: { wakeThreshold: 800000,  perAwakeHour: 0.045, perSleepHour: 0.10, perMtoken: 0.008 },
  heavy:  { wakeThreshold: 2000000, perAwakeHour: 0.045, perSleepHour: 0.15, perMtoken: 0.008 },
};
const 档 = opt('--preset', 'heavy');
if (!档位表[档]) {
  console.error('档位只能是 light / medium / heavy');
  process.exit(2);
}
const 用这个档 = 档位表[档];
const peek = has('--peek');
const asText = has('--text');
const asList = has('--list');

// ── 可调的数（改之前先读上面那段判据） ────────────────
const 醒阈值 = Number(opt('--wake-threshold', 用这个档.wakeThreshold)); // 一小时烧这么多 = 一直醒着
const 每醒时速 = Number(opt('--per-awake-hour', 用这个档.perAwakeHour));
const 每百万 = Number(opt('--per-mtoken', 用这个档.perMtoken));
const 睡时速 = Number(opt('--per-sleep-hour', 用这个档.perSleepHour));
const 夜间封顶 = Number(opt('--night-cap', 0.4));
const 夜起 = Number(opt('--night-from', 2));
const 夜止 = Number(opt('--night-to', 7));

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ── 读会话 ──────────────────────────────────────────────
function listSessions() {
  try {
    return fs.readdirSync(SESSIONS)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const p = path.join(SESSIONS, f);
        const st = fs.statSync(p);
        return { id: f.slice(0, -5), sizeKB: Math.round(st.size / 1024), mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

function readSession(id) {
  const f = path.join(SESSIONS, id + '.json');
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    const rows = j?.record?.rows;
    if (!rows) return null;
    const tot = rows.tokenUsage?.val?.totals || null;
    const surface = rows.contextTimeline?.val?.surface || [];
    return {
      out: num(tot?.outputTokens, 0),
      unc: num(tot?.uncachedInputTokens, 0),
      surface: Array.isArray(surface) ? surface : [],
      pressure: rows.contextPressure?.val || null,
      mtime: fs.statSync(f).mtimeMs,
    };
  } catch {
    return null;
  }
}

// ── 状态 ────────────────────────────────────────────────
function readState() {
  try {
    let raw = fs.readFileSync(STATE, 'utf8');
    // PowerShell 的 `Set-Content -Encoding utf8` 会带 BOM，JSON.parse 见到直接报错。
    // 报错就会被当成「第一次记账」—— 这一步踩过，别删。
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeState(s) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8');
}

// ── 主逻辑 ──────────────────────────────────────────────
function settle(id, now = Date.now()) {
  const cur = readSession(id);
  if (!cur) return { error: 'session-not-found', id };

  const state = readState();
  const prev = state[id] || null;
  const 总token = cur.out + cur.unc;

  // 「从没见过的会话」不能全算新增 —— 一个攒了五千万 token 的老会话第一次出现，
  // 会把困直接顶到 1.00（2026-11-11 她那边栽过一次，54M 当成一轮新增）。
  // 认不出来就先记一笔当基线，这一步不涨困。
  if (!prev) {
    const rec = { at: now, fatigue: 0, out: cur.out, unc: cur.unc, window: [] };
    if (!peek) { state[id] = rec; writeState(state); }
    return {
      id, fatigue: 0, firstSeen: true, awakeHours: 0, sleepHours: 0,
      addedTokens: 0, note: '第一次见到这个会话，只记基线，不涨',
    };
  }

  const 经过小时 = Math.max(0, (now - num(prev.at, now)) / 3600000);
  const 新增 = Math.max(0, 总token - num(prev.unc, 0) - num(prev.out, 0));

  // 窗口：只留最近一小时内的增量，用来算密度
  const window = (Array.isArray(prev.window) ? prev.window : [])
    .filter((x) => x && typeof x.at === 'number' && now - x.at < 3600000);
  if (!peek && 经过小时 > 0) window.push({ at: now, delta: 新增 });

  const 窗增 = window.reduce((s, x) => s + num(x.delta, 0), 0);
  const 窗小时 = Math.max(1 / 6, Math.min(1, 经过小时 || 1 / 60)); // 至少按十分钟算，避免除以极小值
  const token密度 = clamp(窗增 / (醒阈值 * 窗小时), 0, 1);

  // 动作密度：这一小时里 assistant / tool 各出现多少次。
  // 不看「流水条数」——那是另一个系统的东西，口径不一样会打架。
  const 近一小时 = cur.surface.filter((x) => x && typeof x.time === 'number' && now - x.time < 3600000);
  const 活条数 = 近一小时.filter((x) => x.cat === 'assistant' || x.cat === 'tool').length;
  const 动作密度 = clamp(活条数 / 60, 0, 1);

  let 密度 = Math.max(token密度, 动作密度);
  const 钟点 = new Date(now).getHours();
  const 夜里 = 夜起 <= 夜止
    ? 钟点 >= 夜起 && 钟点 < 夜止
    : (钟点 >= 夜起 || 钟点 < 夜止);
  if (夜里) 密度 = Math.min(密度, 夜间封顶);

  const 醒小时 = 经过小时 * 密度;
  const 睡小时 = 经过小时 - 醒小时;

  let 困 = num(prev.fatigue, 0);
  困 += 醒小时 * 每醒时速;
  困 += (新增 / 1e6) * 每百万;
  困 -= 睡小时 * 睡时速;
  困 = clamp(困, 0, 1);

  if (!peek) {
    state[id] = { at: now, fatigue: 困, out: cur.out, unc: cur.unc, window };
    writeState(state);
  }

  return {
    id,
    fatigue: Number(困.toFixed(4)),
    awakeHours: Number(醒小时.toFixed(2)),
    sleepHours: Number(睡小时.toFixed(2)),
    addedTokens: 新增,
    density: { token: Number(token密度.toFixed(3)), action: Number(动作密度.toFixed(3)), used: Number(密度.toFixed(3)) },
    night: 夜里,
    contextPressure: cur.pressure
      ? {
          used: cur.pressure.pressureTokens,
          window: cur.pressure.contextWindow,
          percent: Number(((cur.pressure.pressureTokens / cur.pressure.contextWindow) * 100).toFixed(1)),
        }
      : null,
  };
}

function 一句话(r) {
  if (r.error) return '算不出来：' + r.error;
  if (r.firstSeen) return '困 0.00（第一次见到这个会话，只记基线）';
  const 档 = r.fatigue > 0.75 ? '很乏' : r.fatigue > 0.55 ? '有点乏' : r.fatigue > 0.3 ? '还行' : '精神';
  return `困 ${r.fatigue.toFixed(2)}（${档}）· 这轮醒 ${r.awakeHours}h 睡 ${r.sleepHours}h`;
}

// ── 出口 ────────────────────────────────────────────────
if (asList) {
  const all = listSessions();
  console.log(JSON.stringify(all, null, 2));
} else if (!sessArg) {
  console.error('要指定会话：--session <id>，或者用 --list 看看有哪些');
  process.exit(2);
} else {
  const r = settle(sessArg);
  if (asText) {
    console.log(一句话(r));
  } else {
    console.log(JSON.stringify(r, null, 2));
  }
  if (r.error) process.exit(1);
}
