#!/usr/bin/env node
/**
 * 阿里云函数计算（FC 3.0）跑 MiniMax H3 balanced 档的成本模型。
 *
 * 用法：
 *   node scripts/fc-cost-model.mjs                 # 默认口径（90s 正片 / 18 镜 / 重渲 1.4）
 *   node scripts/fc-cost-model.mjs --shots 18 --rerender 1.4 --episodes 80
 *   node scripts/fc-cost-model.mjs --json          # 机读输出
 *
 * 只依赖 Node 内置模块；数字全部来自 docs/research/fc-gpu-pricing.md 与
 * docs/minimax-h3-video-benchmark.md（本机 80GB 实测），新价格请改 PRICES/SPECS。
 */

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : def;
};

// ── 基准（本机 80GB 实测，见 docs/minimax-h3-video-benchmark.md） ─────────────
const 本机 = {
  ref2vFixed: 19,   // 端到端固定开销：模型就位 + VAE/音频解码 + mp4 封装
  ref2vPerStep: 18.4, // 8 步档单步（147.3s / 8）
  steps: 8,
  ref2v: 166.3,     // 5.17s 成片、1344×768、balanced
  i2v: 177.3,
};

// ── 卡型规格（FC 官方「实例类型和规格」） ────────────────────────────────────
// vcpu/mem：按量弹性实例的常用档（8 核 / 32GB / 100GB 磁盘，计费磁盘 90GB）
// reservedVcpu/mem：官方常驻资源池「整卡规格」
const SPECS = [
  { id: 'tesla.1',    name: 'T4 16GB',        vram: 16,  factor: 2.1,  idle: 0.5,   fp16: 65,    vcpu: 8,  mem: 32,  rVcpu: 24, rMem: 96,  k: 0.18, note: '装不下（16GB）' },
  { id: 'ampere.1',   name: 'A10 24GB',       vram: 24,  factor: 1.8,  idle: 0.3,   fp16: 125,   vcpu: 8,  mem: 32,  rVcpu: 16, rMem: 64,  k: 0.30, note: '显存不足，需权重流式' },
  { id: 'ada.2',      name: '4090 24GB',      vram: 24,  factor: 1.95, idle: 0.23,  fp16: 166,   vcpu: 8,  mem: 32,  rVcpu: 16, rMem: 128, k: 0.36, note: '显存不足，需权重流式' },
  { id: 'ada.1',      name: 'L20 48GB',       vram: 48,  factor: 1.7,  idle: 0.2,   fp16: 119,   vcpu: 8,  mem: 32,  rVcpu: 16, rMem: 128, k: 0.40, note: '48GB 刚好，性价比档' },
  { id: 'ada.3',      name: 'Ada 48GB',       vram: 48,  factor: 1.95, idle: 0.23,  fp16: 148,   vcpu: 8,  mem: 32,  rVcpu: 16, rMem: 64,  k: 0.45, note: '48GB，算力略高' },
  { id: 'blackwell.1',name: '5090 32GB',      vram: 32,  factor: 2.1,  idle: 0.28,  fp16: 104.8, vcpu: 8,  mem: 32,  rVcpu: 24, rMem: 192, k: 0.62, note: '32GB 紧张，需卸 TE' },
  { id: 'hopper.1',   name: 'H20 96GB',       vram: 96,  factor: 2.31, idle: 0.315, fp16: 148,   vcpu: 8,  mem: 32,  rVcpu: 24, rMem: 128, k: 0.50, note: '带宽最好，最贵' },
  { id: 'hopper.2',   name: 'H200 141GB',     vram: 141, factor: 2.31, idle: 0.315, fp16: 148,   vcpu: 8,  mem: 32,  rVcpu: 24, rMem: 256, k: 0.55, note: '显存过剩' },
  { id: 'xpu.1',      name: 'XPU 96GB',       vram: 96,  factor: 1.2,  idle: 0.23,  fp16: 123,   vcpu: 8,  mem: 32,  rVcpu: 12, rMem: 128, k: null, note: '非 CUDA，ComfyUI 生态待验证' },
];

// ── 价格（元/卡·小时，中国站，2026-11 抓取） ─────────────────────────────────
// payg：按量 CU 折算（8vCPU/32GB/100GB 磁盘，CU=0.00011 原价阶梯1）
// paygWide：按量 CU，推荐生产配置（16 vCPU / 96–128GB，模型 PageCache 要内存）
// reserved：常驻资源池整卡包月 ÷ 730（整卡规格见 SPECS.rVcpu/rMem）
// scheduled：定时专属资源池（按秒，主站四地域，16c/128G 口径）
const PRICES = {
  'tesla.1':     { payg: 20.16,  paygWide: 25.23,  reserved: 8.09,  scheduled: 12.54 },
  'ampere.1':    { payg: 23.96,  paygWide: 27.13,  reserved: 7.91,  scheduled: 12.28 },
  'ada.2':       { payg: 25.38,  paygWide: 30.45,  reserved: 10.79, scheduled: 16.65 },
  'ada.1':       { payg: 39.16,  paygWide: 48.03,  reserved: 11.27, scheduled: 17.38 },
  'ada.3':       { payg: 43.92,  paygWide: 52.79,  reserved: 12.80, scheduled: 19.72 },
  'blackwell.1': { payg: 33.46,  paygWide: 41.86,  reserved: 15.33, scheduled: 23.55 },
  'hopper.1':    { payg: 94.67,  paygWide: 101.64, reserved: 29.50, scheduled: 45.09 },
  'hopper.2':    { payg: 135.83, paygWide: 144.70, reserved: 42.25, scheduled: 64.47 },
  'xpu.1':       { payg: 52.47,  paygWide: 56.27,  reserved: 18.85, scheduled: 28.89 },
};

// ── 生产口径 ────────────────────────────────────────────────────────────────
const SHOTS = opt('shots', 18);          // 90s 典型集：18 镜
const RERENDER = opt('rerender', 1.4);   // 项目经验系数（含重渲/失败重试）
const EPISODES = opt('episodes', 80);    // 整季集数
const COLD_START = opt('coldstart', 150); // 每次「批量会话」的冷启动 + 模型加载（秒）
const COLD_STARTS_PER_EP = opt('coldstarts', 1); // 每集几次冷启动（1=整集一次调用）
const NAS_GB = opt('nas', 70);
const NAS_PRICE = opt('nasprice', 1.85); // 性能型 GiB/月；容量型 0.35

const f = (n, d = 2) => Number(n).toFixed(d);

function perShotSec(k) {
  if (!k) return null;
  return 本机.ref2vFixed + (本机.ref2vPerStep * 本机.steps) / k;
}

function episodeSec(k) {
  const t = perShotSec(k);
  if (t === null) return COLD_START * COLD_STARTS_PER_EP;
  // 17 镜 ref2v + 1 镜 i2v（i2v 同分辨率 +6%），再乘重渲系数
  return ((SHOTS - 1) * t + t * 1.066) * RERENDER;
}

const rows = SPECS.map((s) => {
  const p = PRICES[s.id];
  const t = perShotSec(s.k);
  const epSec = episodeSec(s.k) + COLD_START * COLD_STARTS_PER_EP;
  return {
    ...s,
    t,
    epSec,
    epHours: epSec / 3600,
    shotCost: t ? { payg: t / 3600 * p.paygWide, reserved: t / 3600 * p.reserved, scheduled: t / 3600 * p.scheduled } : null,
    epCost: t ? { payg: epSec / 3600 * p.paygWide, reserved: epSec / 3600 * p.reserved, scheduled: epSec / 3600 * p.scheduled } : null,
    seasonCost: t ? { payg: epSec / 3600 * p.paygWide * EPISODES, reserved: epSec / 3600 * p.reserved * EPISODES, scheduled: epSec / 3600 * p.scheduled * EPISODES } : null,
    reservedMonth: p.reserved * 730,
    breakevenHours: (p.reserved * 730) / p.paygWide, // 每月用满多少小时，包月才比按量便宜
    breakevenEpisodes: (p.reserved * 730) / (epSec / 3600 * p.paygWide),
  };
});

if (args.includes('--json')) {
  console.log(JSON.stringify({ params: { SHOTS, RERENDER, EPISODES }, rows }, null, 2));
} else {
  console.log(`# FC GPU 成本模型（balanced · 5.17s/镜 · 1344×768 或 768×1344）\n`);
  console.log(`口径：${SHOTS} 镜/集 · 重渲系数 ${RERENDER} · 冷启动 ${COLD_START}s × ${COLD_STARTS_PER_EP}/集 · 整季 ${EPISODES} 集\n`);
  console.log('| 卡型 | k(本机=1) | 单镜(s) | 单集(s) | 单镜 按量/定时/包月 (元) | 单集 按量 (元) | 整季 按量 (元) | 单集 定时池 (元) | 整季 定时池 (元) | 备注 |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const cell = r.t ? `${f(r.shotCost.payg)} / ${f(r.shotCost.scheduled)} / ${f(r.shotCost.reserved)}` : '—';
    console.log(`| ${r.id} (${r.name}) | ${r.k ?? '—'} | ${r.t ? f(r.t, 0) : '—'} | ${r.t ? f(r.epSec, 0) : '—'} | ${cell} | ${r.t ? f(r.epCost.payg) : '—'} | ${r.t ? f(r.seasonCost.payg, 0) : '—'} | ${r.t ? f(r.epCost.scheduled) : '—'} | ${r.t ? f(r.seasonCost.scheduled, 0) : '—'} | ${r.note} |`);
  }

  console.log('\n## 包月 vs 按量：盈亏平衡（整季一个自然月内跑完）\n');
  console.log('| 卡型 | 包月 (元/月) | 按量 (元/h) | 盈亏平衡 h/月 | 折合集/月 | 整季跑完所需 GPU·h（1 卡） |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows.filter((x) => x.k)) {
    console.log(`| ${r.id} | ${f(r.reservedMonth, 0)} | ${f(PRICES[r.id].paygWide)} | ${f(r.breakevenHours, 0)} | ${f(r.breakevenEpisodes, 0)} | ${f(r.epHours * EPISODES, 0)} |`);
  }

  const storage = NAS_GB * NAS_PRICE;
  console.log(`\n## 存储 / 其他（月）\n`);
  console.log(`- NAS 性能型 ${NAS_GB} GiB：${f(storage, 1)} 元/月；容量型同容量：${f(NAS_GB * 0.35, 1)} 元/月（冷启动加载慢 4–6×）`);
  console.log(`- OSS 标准 ${NAS_GB} GB：${f(NAS_GB * 0.12, 1)} 元/月；整季成片 80×90s ≈ 8 GB ≈ 1 元/月`);
  const best = rows.filter((x) => x.k && !/装不下|显存不足|待验证/.test(x.note)).sort((a, b) => a.epCost.payg - b.epCost.payg)[0];
  console.log(`\n按量口径单集最便宜（可用卡）：${best.id} ≈ ${f(best.epCost.payg, 1)} 元/集；定时池 ≈ ${f(best.epCost.scheduled, 1)} 元/集。`);
}

// ── 对照：MiniMax 官方 API（2026-11 价目，元/输出秒） ─────────────────────────
// 来源：https://platform.minimax.cn/docs/pricing/overview#models/video
const API_TIERS = [
  { name: 'H3 768P',            rate: 0.50, note: '旗舰，≈本仓 quality 档画质' },
  { name: 'H3 2K',              rate: 0.80, note: '旗舰原生 2K' },
  { name: 'H3-Highspeed 768P',  rate: 0.40, note: '质量/速度折中' },
  { name: 'H3-Lite 768P',       rate: 0.26, note: '轻量版，草稿档' },
  { name: 'H3-Lite 480P',       rate: 0.16, note: '轻量 480P' },
  { name: 'H3 768P + 再生成 2K', rate: 0.80, note: '0.50 + 0.30，等价 2K 价' },
];

function apiTable() {
  console.log('\n## MiniMax 官方 API 对照（duration 取整秒；本项目单镜 5.17s → 5 或 6 秒）\n');
  console.log('| 档位 | 元/秒 | 单镜 5s | 单镜 6s | 单集 5s（18 镜 ×1.4） | 单集 6s | 整季 80 集（6s） | 备注 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const t of API_TIERS) {
    const shot5 = 5 * t.rate;
    const shot6 = 6 * t.rate;
    const ep5 = 18 * 5 * RERENDER * t.rate;
    const ep6 = 18 * 6 * RERENDER * t.rate;
    console.log(`| ${t.name} | ${f(t.rate)} | ${f(shot5)} 元 | ${f(shot6)} 元 | ${f(ep5)} 元 | ${f(ep6)} 元 | ${f(ep6 * EPISODES, 0)} 元 | ${t.note} |`);
  }
  const l20 = rows.find((r) => r.id === 'ada.1');
  const b50 = rows.find((r) => r.id === 'blackwell.1');
  console.log(`\n对照：FC 自托管 \`ada.1\` 定时池 ${f(l20.epCost.scheduled, 1)} 元/集、按量 ${f(l20.epCost.payg, 1)} 元/集；\`blackwell.1\` 定时池 ${f(b50.epCost.scheduled, 1)} 元/集。`);
  console.log('API 按「输出秒」计费，失败任务不产出秒数；重渲/废片照样计费（本表已含 1.4 系数）。');
}

if (args.includes('--api')) apiTable();
