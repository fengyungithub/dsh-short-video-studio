#!/usr/bin/env python3
"""
scripts/analyze-2k-pair.py — 两条**同为 2K** 的成片做同尺度画质对比。

为什么不用 analyze-2k-detail.mjs：那个脚本的判据是「真 2K vs 原生 bicubic 放大」，
需要一条**原生 1344×768** 的基线来校准尺子。两个 2K 变体都在 2688×1536 上，
没有原生臂可校准，套那个脚本会得到一个无意义的读数。

这里改做**同尺度直接对比**，并刻意把「合成高频」和「真细节」分开报：

  1) 有效分辨率（等价宽度，像素）—— 绝对量，两边用**同一个 floor** 量。
     注意这把尺子偏好高频能量、不偏好干净，过锐/振铃也会把它推高，所以只作参考。
  2) 平坦区锐度（Laplacian 方差）—— 过锐/振铃的指纹。
  3) 高频带能量比 [0.25,0.5] —— 谁在 2K 网格的高频段能量更高。
  4) 时域闪烁（相邻帧差）—— 少步蒸馏采样器的典型失效模式就是闪烁。
  5) 逐帧 MAD —— 两条片子同 seed 同 prompt，逐帧差异有多大（同 seed 才有意义）。

用法：
  python3 scripts/analyze-2k-pair.py <a.mp4> <b.mp4> [--label-a A] [--label-b B] [--json out.json]
"""

import sys, json
import numpy as np
import cv2


def load(p):
    c = cv2.VideoCapture(p)
    frs = []
    while True:
        ok, f = c.read()
        if not ok:
            break
        frs.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32))
    c.release()
    return frs


def radial_profile(g, nb=40):
    h, w = g.shape
    x = g - cv2.blur(g, (9, 9))
    win = np.outer(np.hanning(h), np.hanning(w)).astype(np.float32)
    F = np.abs(np.fft.fft2(x * win)) ** 2
    F = np.fft.fftshift(F)
    fy = np.fft.fftshift(np.fft.fftfreq(h))[:, None]
    fx = np.fft.fftshift(np.fft.fftfreq(w))[None, :]
    r = np.sqrt(fy ** 2 + fx ** 2)
    edges = np.linspace(0, 0.5, nb + 1)
    prof = np.array([float(F[(r >= edges[i]) & (r < edges[i + 1])].mean()) for i in range(nb)])
    return (edges[:-1] + edges[1:]) / 2, np.convolve(prof, np.ones(3) / 3, mode='same')


def band_energy(g, lo, hi):
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


def effective_width(g, floor, width):
    centers, sm = radial_profile(g)
    above = centers[sm >= sm.max() * floor]
    return float(above.max()) / 0.5 * width if len(above) else 0.0


def flat_region_sharpness(g):
    """平坦区锐度：只统计局部方差最低的 30% 区块，避开真实边缘。"""
    lap = cv2.Laplacian(g, cv2.CV_32F)
    b = 64
    h, w = g.shape
    vals = []
    for y in range(0, h - b + 1, b):
        for x in range(0, w - b + 1, b):
            blk = g[y:y + b, x:x + b]
            lb = lap[y:y + b, x:x + b]
            if blk.std() < 6:
                vals.append(float(lb.var()))
    return float(np.median(vals)) if vals else float('nan')


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    opt = {}
    argv = sys.argv[1:]
    for i, a in enumerate(argv):
        if a.startswith('--') and i + 1 < len(argv):
            opt[a[2:]] = argv[i + 1]
    if len(args) < 2:
        print(__doc__)
        sys.exit(1)
    pa, pb = args[0], args[1]
    la = opt.get('label-a', 'A')
    lb = opt.get('label-b', 'B')

    A, B = load(pa), load(pb)
    if len(A) != len(B):
        print(json.dumps({'error': f'帧数不一致：{la} {len(A)} vs {lb} {len(B)}'}, ensure_ascii=False))
        sys.exit(0)
    if A[0].shape != B[0].shape:
        print(json.dumps({'error': f'尺寸不一致：{la} {A[0].shape} vs {lb} {B[0].shape}'}, ensure_ascii=False))
        sys.exit(0)
    H, W = A[0].shape
    idx = list(range(4, len(A) - 4, max(1, (len(A) - 8) // 12)))
    idx = idx[:12] or list(range(4, max(4, len(A) - 4)))
    if not idx:
        idx = list(range(len(A)))

    # ---- 有效宽度：固定几档 floor 分别量（同一把尺子量两边），并给出跨档的稳健比值。
    # 刻意**不**挑「使两读数最接近」的 floor —— 那是拿结论挑阈值，会把差异抹平。
    # 跨 floor 的有效宽比值中位数才是稳健量；单档读数只作趋势参考。
    FLOORS = [0.002, 0.005, 0.01, 0.02, 0.04]
    ew = {}
    ratios = []
    for fl in FLOORS:
        ra = float(np.median([effective_width(A[i], fl, W) for i in idx[:4]]))
        rb = float(np.median([effective_width(B[i], fl, W) for i in idx[:4]]))
        ew[f'{fl}'] = {la: round(ra, 1), lb: round(rb, 1)}
        if np.isfinite(ra) and ra > 0 and np.isfinite(rb):
            ratios.append(rb / ra)

    bands = {}
    for lo, hi in [(0.03, 0.08), (0.08, 0.16), (0.16, 0.25), (0.25, 0.4), (0.4, 0.5)]:
        rs = [band_energy(B[i], lo, hi) / (band_energy(A[i], lo, hi) + 1e-12) for i in idx]
        bands[f'{lo}-{hi}'] = round(float(np.median(rs)), 3)

    sharp_a = float(np.median([flat_region_sharpness(A[i]) for i in idx]))
    sharp_b = float(np.median([flat_region_sharpness(B[i]) for i in idx]))

    def flicker(frs):
        d = [float(np.abs(frs[i + 1] - frs[i]).mean()) for i in range(len(frs) - 1)]
        return round(float(np.median(d)), 4)

    mad = float(np.median([np.abs(A[i] - B[i]).mean() for i in idx]))

    out = {
        'size': f'{W}x{H}',
        'frames': len(A),
        'effective_width_by_floor': ew,
        'effective_width_ratio_median': round(float(np.median(ratios)), 3) if ratios else None,
        'flat_sharpness': {la: round(sharp_a, 2), lb: round(sharp_b, 2),
                           'ratio_b_over_a': round(sharp_b / sharp_a, 3) if sharp_a else None},
        'highfreq_band_ratio_b_over_a': bands,
        'flicker': {la: flicker(A), lb: flicker(B)},
        'frame_mad': round(mad, 3),
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    if opt.get('json'):
        with open(opt['json'], 'w') as f:
            json.dump(out, f, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
