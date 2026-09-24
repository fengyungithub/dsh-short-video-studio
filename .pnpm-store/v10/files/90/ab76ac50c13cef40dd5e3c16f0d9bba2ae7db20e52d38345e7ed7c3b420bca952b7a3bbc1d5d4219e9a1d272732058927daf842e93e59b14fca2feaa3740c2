/**
 * scripts/analyze-hires.mjs — 两阶段放大产物的画质判据（决定「调哪个参数」的依据）。
 *
 * 为什么需要它：光看「锐度更高」无法区分**真细节**与**颗粒/噪声**。本脚本给出四个能区分二者的判据：
 *
 *  1) 空间锐度（Laplacian 均值）：整体细节能量。高＝更锐，但也可能是噪声。
 *  2) 平坦区空间高频：平坦区里不该有细节。偏高说明「在没结构的地方也加料」。
 *  3) **平坦区时间闪烁**（决定性）：静止平坦区里，真细节逐帧稳定、噪声逐帧乱跳。
 *     这是区分「恢复的纹理」与「注入的颗粒」最直接的判据——只有噪声会让静止区域闪烁。
 *  4) 锐度帧间波动 / 时间帧间差：视频可用性。抖动大的成片观感会「沙沙」响。
 *
 * 另外报告分时段锐度，用于定位「后段变软」这类时间上的不均匀。
 *
 * 用法：node scripts/analyze-hires.mjs <video.mp4> [更多视频...]
 *       node scripts/analyze-hires.mjs --all          # 自动收集 e2e-out/hires/*.mp4
 */

import { readdirSync, existsSync } from 'node:fs'
import { resolve, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIRS = [resolve(ROOT, 'e2e-out/hires'), resolve(ROOT, 'e2e-out/2k')]

const argv = process.argv.slice(2)
const all = argv.includes('--all') || argv.length === 0
const files = all
  ? DIRS.flatMap((d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.mp4')).map((f) => resolve(d, f)) : []))
  : argv.map((f) => resolve(f))

if (!files.length) {
  console.error('没有可分析的视频。用法：node scripts/analyze-hires.mjs <video.mp4> | --all')
  process.exit(1)
}

// 用本机 python3 + cv2/numpy 做像素分析（这些依赖本机已具备）
const PY = `
import cv2, numpy as np, sys, json

def load(p):
    c = cv2.VideoCapture(p); frs = []
    while True:
        ok, f = c.read()
        if not ok: break
        frs.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32))
    c.release(); return frs

def lap(g): return cv2.Laplacian(g, cv2.CV_32F).var()

def blockiness(g):
    dx = np.abs(np.diff(g, axis=1)); dy = np.abs(np.diff(g, axis=0))
    return (dx[:, 7::8].mean() + dy[7::8, :].mean()) / (dx.mean() + dy.mean())

def flat_hf(g, k=9):
    """平坦区（局部方差最低 20%）的空间高频能量：不应有细节的地方有多少高频。"""
    m = cv2.blur(g, (k, k)); v = cv2.blur((g - m) ** 2, (k, k))
    flat = v <= np.percentile(v, 20)
    return float(np.abs(g - m)[flat].mean())

def temporal_flat_flicker(frs):
    """静止平坦区的时间闪烁（决定性判据）。
    对时间均值图找平坦区，再看这些像素的**时间标准差**：
    真纹理稳定（低），噪声逐帧跳（高）。"""
    st = np.stack(frs, 0)
    mean = st.mean(0)
    # 均值图的局部梯度 → 平坦掩码
    gx = cv2.Sobel(mean, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(mean, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.sqrt(gx * gx + gy * gy)
    flat = grad <= np.percentile(grad, 40)
    tstd = st.std(0)
    return float(tstd[flat].mean()), float(tstd.mean())

def temporal_diff(frs):
    return float(np.mean([np.abs(frs[i+1] - frs[i]).mean() for i in range(len(frs)-1)]))

def _peak_and_band(F, kx, ky, rad=3, lo=6, hi=24):
    """在 FFT 幅度谱上量「周期 = 图像尺寸/kx」的那根谱线相对邻域的凸起。"""
    h, w = F.shape
    ys = [y for y in (ky - rad, ky, ky + rad) if 0 <= y < h]
    xs = [x for x in (kx - rad, kx, kx + rad) if 0 <= x < w]
    peak = max(float(F[y, x]) for y in ys for x in xs)
    vals = []
    for dy in range(-hi, hi + 1):
        for dx in range(-hi, hi + 1):
            d = abs(dx) + abs(dy)
            if d < lo or d > hi: continue
            y, x = ky + dy, kx + dx
            if 0 <= y < h and 0 <= x < w: vals.append(float(F[y, x]))
    band = float(np.median(vals)) if vals else 0.0
    return peak / (band + 1e-9)

def grid_peak(g, period=32.0):
    """学习式 ×2 latent 放大特有的「硬网格」检测。
    latent 上 2×2 的周期结构 → 像素空间周期 = 2 个 latent 格 = 32 px
    （H3 视频 VAE 空间压缩 16×）。真网格会在 1/32 cycles/px 处竖起一根谱线。
    返回该谱线相对邻域的凸起（x 轴 / y 轴 / 对角三处取最大）。"""
    h, w = g.shape
    x = g - cv2.blur(g, (9, 9))
    win = np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)
    F = np.abs(np.fft.rfft2(x * win))
    kx, ky = int(round(w / period)), int(round(h / period))
    if kx < 4 or ky < 4 or kx >= F.shape[1] or ky >= F.shape[0]: return 0.0
    return max(_peak_and_band(F, kx, 0), _peak_and_band(F, 0, ky), _peak_and_band(F, kx, ky))

def analyze(p):
    frs = load(p)
    n = len(frs)
    if n < 20: return None
    mid = frs[10:-10]
    l = [lap(g) for g in mid]
    flick_flat, flick_all = temporal_flat_flicker(frs[10:-10])
    # 网格伪影：在时间均值图上量（运动/噪声被平均掉，周期性结构留下）
    avg = np.mean(np.stack(frs[10:-10], 0), 0).astype(np.float32)
    grid32 = grid_peak(avg, 32.0)
    grid_ref = (grid_peak(avg, 23.0) + grid_peak(avg, 41.0)) / 2.0
    # 分时段
    segs = []
    for a in range(10, n-10, 24):
        b = min(a+24, n-10)
        segs.append([int(a), int(b), round(float(np.mean([lap(g) for g in frs[a:b]])), 1)])
    return {
        'frames': n,
        'lap': round(float(np.mean(l)), 1),
        'lap_std': round(float(np.std(l)), 1),
        'flat_hf': round(float(np.mean([flat_hf(g) for g in mid])), 3),
        'flicker_flat': round(flick_flat, 3),
        'flicker_all': round(flick_all, 3),
        'blockiness': round(float(np.mean([blockiness(g) for g in mid])), 3),
        'temporal': round(temporal_diff(frs), 3),
        'grid32': round(grid32, 2),
        'grid_ref': round(grid_ref, 2),
        'segs': segs,
    }

out = {}
for p in sys.argv[1:]:
    r = analyze(p)
    if r: out[p] = r
print(json.dumps(out))
`

const py = execFileSync('python3', ['-c', PY, ...files], { encoding: 'utf8', maxBuffer: 1 << 28 })
const data = JSON.parse(py)

const label = (f) => basename(f).replace(/\.mp4$/, '')
// 列名去重：`native-s20f124-native-s20f124_00001_` 与 `v2s20f124-v2s20f124_00001_`
// 都取尾部 14 字符会截成同一个名字，对比表就串列了——A/B 判据全靠这张表，不能含糊。
const seen = new Map()
const shortLabel = (f) => {
  const base = label(f)
  let s = base.length <= 16 ? base : base.slice(0, 7) + '…' + base.slice(-8)
  if (seen.has(s)) { const n = seen.get(s) + 1; seen.set(s, n); s = `${s}#${n}` } else seen.set(s, 1)
  return s
}
for (const f of files) shortLabel(f)   // 先按顺序分配，保证两次运行列名一致
const ROWS = [
  ['全帧锐度（Laplacian 均值）', 'lap'],
  ['锐度帧间波动 std（越低越稳）', 'lap_std'],
  ['平坦区空间高频（越低越干净）', 'flat_hf'],
  ['平坦区时间闪烁（越低越干净）★', 'flicker_flat'],
  ['全帧时间闪烁', 'flicker_all'],
  ['时间帧间差（越低越稳）', 'temporal'],
  ['块效应（1.0=无块）', 'blockiness'],
  ['32px 网格谱线凸起（学习式×2 伪影）★', 'grid32'],
  ['非网格周期参照（23/41px）', 'grid_ref'],
]

const names = Object.keys(data)
const w = 34
console.log(`\n${'指标'.padEnd(w)}${names.map((n) => label(n).slice(-14).padStart(15)).join('')}`)
for (const [zh, key] of ROWS) {
  const cells = names.map((n) => String(data[n][key]).padStart(15)).join('')
  console.log(`${zh.padEnd(w)}${cells}`)
}

console.log('\n分时段锐度（定位「后段变软」）：')
for (const n of names) {
  const segs = data[n].segs.map(([a, b, v]) => `${a}-${b}:${v}`).join('  ')
  console.log(`  ${label(n).padEnd(22)} ${segs}`)
}

console.log(`
★ 决定性判据：平坦区时间闪烁。静止平坦区里真纹理逐帧稳定，噪声才逐帧乱跳。
  用它与「平坦区空间高频」合看：
   - 空间高频高 + 时间闪烁高  ⇒ **注入颗粒**（denoise 过高）
   - 空间高频高 + 时间闪烁低  ⇒ **真恢复细节**（可接受）
   - 两者都低                ⇒ 过度平滑（denoise 过低，二遍几乎没做事）

★ 32px 网格谱线：学习式 ×2 latent 放大特有的「硬网格」伪影（latent 上 2×2 → 像素 32px 周期）。
  判读：grid32 ≈ grid_ref ⇒ 无网格；grid32 明显高于 grid_ref（>1.5×）⇒ 有网格，需抬高二遍 denoise
  或用 norm-preserving 轻模糊补救。对照组（未经学习式放大的成片）应保持 grid32 ≈ grid_ref。`)
