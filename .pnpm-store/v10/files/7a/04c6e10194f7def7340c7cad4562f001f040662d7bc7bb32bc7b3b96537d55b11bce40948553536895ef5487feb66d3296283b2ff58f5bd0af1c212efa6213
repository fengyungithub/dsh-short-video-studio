/**
 * scripts/analyze-u3.mjs — U3（像素空间超分）判据。
 *
 * U3 的成败不是"能不能放大"（必然能），而是两件事：
 *   ① 有效分辨率真涨了吗？（相对"把输入 bicubic 拉大"的基线）
 *   ② **逐帧独立合成**有没有引入时间闪烁？（这是 U2/U3 相对 U1 的固有短板）
 *
 * 判据设计（关键在"同网格比较"，否则分辨率一变指标就不可比）：
 *   A  = 输入成片（例：U1 的 2K，2688×1536）
 *   B  = U3 产物（例：5376×3072）
 *   B' = 把 B 缩回 A 的网格（INTER_AREA）  → 与 A **逐像素可比**：锐度、闪烁
 *   C  = 把 A bicubic 拉到 B 的网格          → 有效分辨率的基线
 * 有效宽度用与 analyze-2k-detail 同一套"自校准"法：选阈值让 C 的读数落回 A 的像素宽度，
 * 再用同一阈值读 B。
 *
 * 用法：node scripts/analyze-u3.mjs <输入成片.mp4> <U3产物.mp4> [目标宽度]
 *   给了目标宽度就先把 U3 产物缩到该宽度（snap32）再评估——用来判断"缩到标准 4K 会不会丢细节"。
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const [a, b] = process.argv.slice(2)
if (!a || !b) { console.error('用法：node scripts/analyze-u3.mjs <输入成片.mp4> <U3产物.mp4>'); process.exit(1) }
for (const p of [a, b]) if (!existsSync(resolve(ROOT, p))) { console.error(`找不到 ${p}`); process.exit(1) }

const TARGET_W = process.env.TARGET_W || process.argv[4] || '0'
const PY = `
import cv2, numpy as np, sys, json

def load(p):
    c = cv2.VideoCapture(p); f = []
    while True:
        ok, x = c.read()
        if not ok: break
        f.append(cv2.cvtColor(x, cv2.COLOR_BGR2GRAY).astype(np.float32))
    c.release(); return f

def radial(g):
    h, w = g.shape
    x = g - cv2.blur(g, (9, 9))
    win = np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)
    F = np.abs(np.fft.fft2(x * win)) ** 2
    F = np.fft.fftshift(F)
    fy = np.fft.fftshift(np.fft.fftfreq(h))[:, None]
    fx = np.fft.fftshift(np.fft.fftfreq(w))[None, :]
    r = np.sqrt(fy**2 + fx**2); nb = 40; e = np.linspace(0, 0.5, nb+1)
    p = np.array([float(F[(r >= e[i]) & (r < e[i+1])].mean()) for i in range(nb)])
    return (e[:-1]+e[1:])/2, np.convolve(p, np.ones(3)/3, mode='same')

def eff(g, floor):
    c, p = radial(g); a = c[p >= p.max()*floor]
    return (float(a.max()) if len(a) else 0.0) / 0.5 * g.shape[1]

def flicker_flat(frames):
    """平坦区时间闪烁：先用时间均值定"平坦"（空间梯度低）的像素，再量这些像素的时间 std。"""
    st = np.stack(frames)
    mu = st.mean(0)
    gx = cv2.Sobel(mu, cv2.CV_32F, 1, 0, ksize=3); gy = cv2.Sobel(mu, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.sqrt(gx**2 + gy**2)
    flat = grad <= np.percentile(grad, 40)          # 最平坦的 40%
    ts = st.std(0)
    return float(ts[flat].mean()), float(st.std(0).mean())

def sharp(frames):
    return float(np.mean([cv2.Laplacian(f, cv2.CV_32F).var() for f in frames]))

A = load(sys.argv[1]); B = load(sys.argv[2])
TW = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] != '0' else None
if TW:
    # 把 U3 产物缩到目标宽度再评估：回答"缩到标准 4K 还留得住细节吗"
    th = int(round(B[0].shape[0] * TW / B[0].shape[1] / 32) * 32)
    B = [cv2.resize(f, (TW, th), interpolation=cv2.INTER_AREA) for f in B]
n = min(len(A), len(B)); A, B = A[:n], B[:n]
HA, WA = A[0].shape; HB, WB = B[0].shape
idx = list(range(2, n-2, max(1, (n-4)//10)))[:10]

# B' = B 缩回 A 的网格；C = A 拉到 B 的网格
Bp = [cv2.resize(B[i], (WA, HA), interpolation=cv2.INTER_AREA) for i in range(n)]
C  = [cv2.resize(A[i], (WB, HB), interpolation=cv2.INTER_CUBIC) for i in range(n)]

# 有效分辨率（阈值自校准：让基线 C 的读数落回输入像素宽度 WA）
FLOORS = [float(x) for x in np.geomspace(0.0006, 0.09, 48)]
cal = {}
for fl in FLOORS:
    cal[fl] = [eff(C[i], fl) for i in idx[:4]]
best = min(FLOORS, key=lambda fl: abs(float(np.median(cal[fl])) - WA))
eff_C = float(np.median([eff(C[i], best) for i in idx]))
eff_B = float(np.median([eff(B[i], best) for i in idx]))

fa, ga = flicker_flat(A); fb, gb = flicker_flat(Bp)
print(json.dumps({
  'frames': n, 'input_size': f'{WA}x{HA}', 'u3_size': f'{WB}x{HB}',
  'eff_input_baseline': round(eff_C), 'eff_u3': round(eff_B), 'cal_floor': best,
  'eff_gain': round(eff_B / eff_C, 3),
  'sharp_input': round(sharp(A), 1), 'sharp_u3_downscaled': round(sharp(Bp), 1),
  'flicker_flat_input': round(fa, 3), 'flicker_flat_u3_down': round(fb, 3),
  'flicker_all_input': round(ga, 3), 'flicker_all_u3_down': round(gb, 3),
  'flicker_ratio': round(fb / (fa + 1e-9), 3),
}))
`

const out = JSON.parse(execFileSync('python3', ['-c', PY, resolve(ROOT, a), resolve(ROOT, b), TARGET_W], { encoding: 'utf8', maxBuffer: 1 << 28 }))
const verdict = out.flicker_ratio > 1.25 ? '✗ U3 明显更闪（逐帧合成的时间不稳定）'
  : out.flicker_ratio > 1.08 ? '△ U3 略闪，需人眼复核'
  : '✓ 时间稳定性与输入基本一致'

console.log(`
U3 判据（输入 ${out.input_size} → U3 ${out.u3_size}，${out.frames} 帧）

【① 有效分辨率】同一套自校准阈值法（阈值 ${out.cal_floor.toExponential(2)}，校准到基线读数 = 输入像素宽）
  把输入 bicubic 拉大的基线   ≈ ${out.eff_input_baseline} px   ← 信息上限 = 输入的像素宽 ${out.input_size.split('x')[0]}
  U3 产物                     ≈ ${out.eff_u3} px
  增益                        × ${out.eff_gain}
  ⇒ ${out.eff_gain > 1.1 ? 'U3 确实造出了输入像素网格装不下的能量（**合成**高频，不等于真实细节）' : 'U3 与"只把输入拉大"在信息量上无差别（纯放大，没造细节）'}

【② 时间稳定性】把 U3 缩回输入网格后**同网格**比较（避免分辨率变化污染指标）
  平坦区闪烁  输入 ${out.flicker_flat_input} → U3 ${out.flicker_flat_u3_down}   （比值 ×${out.flicker_ratio}）
  全帧闪烁    输入 ${out.flicker_all_input} → U3 ${out.flicker_all_u3_down}
  平坦区锐度  输入 ${out.sharp_input} → U3 缩回 ${out.sharp_u3_downscaled}
  ⇒ ${verdict}

判读：U3 是**逐帧**超分，没有跨帧先验。有效分辨率涨了也只说明"合成了高频"，
      合得稳不稳要看②；②不达标时它只能当"交付尺寸放大器"，不能当"细节提升器"。`)
