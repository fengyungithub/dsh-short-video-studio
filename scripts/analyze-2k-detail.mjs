/**
 * scripts/analyze-2k-detail.mjs — 「2K 到底有没有多出真细节」的判据。
 *
 * 问题：把 1344×768 用 bicubic 拉大到 2688×1536，和真跑 U1（学习式 latent ×2 + 精修）出来的
 * 2688×1536，肉眼在小图上几乎一样。要靠**频率**区分：
 *
 *   在 2K 的像素网格上，原生 1344×768 的成片最高只能含到 **0.25 cycles/px**
 *   （它的 Nyquist 0.5 cyc/px 换算到 2× 网格就是 0.25）。
 *   所以 [0.25, 0.5] 这一段**只有真·更高分辨率才可能有能量**；bicubic 上采样在那里只能补 0。
 *
 * 判据：把 native 用 bicubic 放大到 2K 当基线 B，真 2K 记为 O，比较两段频带的能量比：
 *   ratio_high = E_O[0.25,0.5] / E_B[0.25,0.5]   ← 决定性：>1 说明真多出了「原来装不下的细节」
 *   ratio_low  = E_O[0.05,0.25] / E_B[0.05,0.25] ← 参照：这一带两者本就都该有，≈1 才说明比较没跑偏
 *
 * 方法论前提（很重要）：A/B 两次跑的**首遍必须逐像素相同**——同 seed、同步数、同首遍尺寸。
 * 这样唯一的变量就是「放大 + 精修」这一步，差异才能归因给它。（probe-2k.mjs 的 native 变体
 * 就是 2K 跑的首遍本身。）
 *
 * 偏差方向：两条片子都被 h264 压过，2K 那条约在更高频率上被压得更狠 → 只会**低估** 2K 的优势。
 * 所以 ratio_high 明显 >1 时结论是稳的；≈1 才需要谨慎解释。
 *
 * 用法：node scripts/analyze-2k-detail.mjs <native.mp4> <upscaled-2k.mp4>
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

const args = process.argv.slice(2)
if (args.length < 2) {
  console.error('用法：node scripts/analyze-2k-detail.mjs <native.mp4> <upscaled-2k.mp4>')
  process.exit(1)
}
const [native, up] = args.map((p) => resolve(p))
for (const p of [native, up]) if (!existsSync(p)) { console.error(`找不到 ${p}`); process.exit(1) }

const PY = `
import cv2, numpy as np, sys, json

def load(p):
    c = cv2.VideoCapture(p); frs = []
    while True:
        ok, f = c.read()
        if not ok: break
        frs.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32))
    c.release(); return frs

def band_energy(g, lo, hi):
    """高通后的径向功率谱，在 [lo,hi) cycles/px 的平均能量。"""
    h, w = g.shape
    x = g - cv2.blur(g, (9, 9))
    win = np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)
    F = np.abs(np.fft.fft2(x * win)) ** 2
    F = np.fft.fftshift(F)
    fy = np.fft.fftshift(np.fft.fftfreq(h))[:, None]
    fx = np.fft.fftshift(np.fft.fftfreq(w))[None, :]
    r = np.sqrt(fy ** 2 + fx ** 2)
    m = (r >= lo) & (r < hi)
    return float(F[m].mean())

n = load(sys.argv[1]); o = load(sys.argv[2])
if len(n) != len(o):
    print(json.dumps({'error': f'帧数不一致：native {len(n)} vs 2k {len(o)}（A/B 必须同帧数）'})); sys.exit(0)
H2, W2 = o[0].shape
idx = list(range(4, len(n) - 4, max(1, (len(n) - 8) // 12)))[:12]

def effective_width(g, floor):
    """有效分辨率（等价宽度，像素）。
    径向平均功率谱（40 个环）→ 找**最高**的、功率仍 >= 峰值的 floor 倍的频率 f
    → 按 Nyquist = 0.5 cyc/px 换算回像素宽度：W_eff = f/0.5 * width。"""
    h, w = g.shape
    x = g - cv2.blur(g, (9, 9))
    win = np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)
    F = np.abs(np.fft.fft2(x * win)) ** 2
    F = np.fft.fftshift(F)
    fy = np.fft.fftshift(np.fft.fftfreq(h))[:, None]
    fx = np.fft.fftshift(np.fft.fftfreq(w))[None, :]
    r = np.sqrt(fy ** 2 + fx ** 2)
    nb = 40
    edges = np.linspace(0, 0.5, nb + 1)
    prof = np.array([float(F[(r >= edges[i]) & (r < edges[i + 1])].mean()) for i in range(nb)])
    centers = (edges[:-1] + edges[1:]) / 2
    sm = np.convolve(prof, np.ones(3) / 3, mode='same')   # 抑制单环噪声造成的假尾
    above = centers[sm >= sm.max() * floor]
    return float(above.max()) if len(above) else 0.0

# 有效分辨率：先用**已知答案**的基线校准尺子，再用同一把尺子量真 2K。
# 基线是「原生 bicubic 放大到 2K」，它的信息上限**按构造就是原生宽度**；于是挑一个让基线读数
# 正好落回该上限的 floor，再用同一 floor 去读 2K——这样报出来的数字不依赖拍脑袋的阈值。
# 阈值网格必须够细：粗网格（如 0.01/0.02 这种档）会让基线读数差 2~5%，报出的 2K 有效宽度跟着偏。
FLOORS = [float(x) for x in np.geomspace(0.0006, 0.09, 48)]
native_w = n[0].shape[1]
probe_idx = idx[:4]
base_by_floor = {fl: [] for fl in FLOORS}
out_by_floor = {fl: [] for fl in FLOORS}
for i in probe_idx:
    B = cv2.resize(n[i], (W2, H2), interpolation=cv2.INTER_CUBIC)
    for fl in FLOORS:
        base_by_floor[fl].append(effective_width(B, fl) / 0.5 * W2)
        out_by_floor[fl].append(effective_width(o[i], fl) / 0.5 * W2)
cal = min(FLOORS, key=lambda fl: abs(float(np.median(base_by_floor[fl])) - native_w))
eff_b = float(np.median(base_by_floor[cal])); eff_o = float(np.median(out_by_floor[cal]))

# 分频带：DC 侧参照带能自证比较没跑偏；越靠近 0.25 越能看出基线（bicubic）自身的滚降，
# 所以「参照带 >1」要按趋势解释，而不是一刀切要求 ≈1。
BANDS = [(0.03, 0.08), (0.08, 0.16), (0.16, 0.25), (0.25, 0.4), (0.4, 0.5)]
per = {b: [] for b in BANDS}
for i in idx:
    B = cv2.resize(n[i], (W2, H2), interpolation=cv2.INTER_CUBIC)
    for b in BANDS:
        eo, eb = band_energy(o[i], b[0], b[1]), band_energy(B, b[0], b[1])
        per[b].append(eo / (eb + 1e-12))
bands = [{'band': f'{b[0]}-{b[1]}', 'ratio': round(float(np.median(per[b])), 3),
          'p25': round(float(np.percentile(per[b], 25)), 3),
          'p75': round(float(np.percentile(per[b], 75)), 3)} for b in BANDS]
hi = per[(0.25, 0.4)] + per[(0.4, 0.5)]
print(json.dumps({
    'frames_compared': len(idx),
    'native_size': f'{n[0].shape[1]}x{n[0].shape[0]}',
    'output_size': f'{W2}x{H2}',
    'ratio_high': round(float(np.median(hi)), 3),
    'ratio_low': round(float(np.median(per[(0.03, 0.08)])), 3),
    'eff_w_out': round(float(eff_o)),
    'eff_w_baseline': round(float(eff_b)),
    'cal_floor': cal,
    'bands': bands,
}))
`

const out = JSON.parse(execFileSync('python3', ['-c', PY, native, up], { encoding: 'utf8', maxBuffer: 1 << 28 }))
if (out.error) { console.error('✗ ' + out.error); process.exit(1) }

console.log(`\nnative   ${out.native_size}  ← ${native}`)
console.log(`output   ${out.output_size}  ← ${up}`)
console.log(`比较帧数 ${out.frames_compared}\n`)
for (const b of out.bands) {
  const mark = b.band.startsWith('0.25') || b.band.startsWith('0.4') ? '  ← 原生装不下的一带' : ''
  console.log(`  ${b.band.padEnd(14)} cyc/px   ratio ${String(b.ratio).padStart(6)}   (p25 ${b.p25} / p75 ${b.p75})${mark}`)
}
const ceilW = Number(out.native_size.split('x')[0])
console.log(`
有效分辨率（同一套阈值法，40 环径向功率谱，功率 ≥ 峰值 1% 的最高频 → 换算像素宽度）：
  真 2K 输出         ≈ ${out.eff_w_out} px
  bicubic 基线        ≈ ${out.eff_w_baseline} px   ← 标定靶：基线的信息上限就是原生的 ${ceilW} px
  标定阈值 floor      = ${out.cal_floor}（取"让基线读数正好落回 ${ceilW}"的那一档）
  ⇒ 交付像素 ${out.output_size}，但**有效信息量**约相当于 ${out.eff_w_out} px 级
     （"交付是 2688 宽" ≠ "细节等于原生 2688 渲染"；这里量的是后者）`)
console.log(`
判读：
  0.03-0.08 带 ≈1  ⇒ 比较对位正确（低频两者本就该一致）
  越往上 ratio 越大是**正常**的：bicubic 基线在靠近源 Nyquist(0.25) 处自己就滚降
  0.25 以上 ≳ 1.5 ⇒ 2K 里有原生 1344×768 **物理上装不下**的细节，即 U1 真在重建而非插值
  0.25 以上 ≈ 1   ⇒ 多出来的只是双三次插值，U1 只赢在交付尺寸/压缩，不赢在细节`)
