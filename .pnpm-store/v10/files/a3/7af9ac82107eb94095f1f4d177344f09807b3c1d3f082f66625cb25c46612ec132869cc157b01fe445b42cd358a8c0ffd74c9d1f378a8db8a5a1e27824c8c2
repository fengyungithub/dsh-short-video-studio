#!/usr/bin/env python3
"""
scripts/eye-crops.py — 把两条成片的对齐帧导成「眼判图」（1:1 原始像素，不缩放）。

为什么需要：频率指标（有效宽度、频带能量比）分不清「真细节」和「合成高频 / 过锐」，
而闪烁、软化、振铃这类问题最终必须靠眼睛判。所以每次 A/B 都导一组固定形态的图：

  <out>/crop-A.png / crop-B.png    同帧同区域 1:1 中心裁切
  <out>/sbs.png                    A | B 并排（红/蓝描边标出左右）
  <out>/zoom3x-sbs.png             更小区域 3× 最近邻放大，看纹理与伪影
  <out>/flicker-strip.png          各 4 连续帧横排，A 在上 B 在下（看闪烁/抖动）

用法：
  python3 scripts/eye-crops.py a.mp4 b.mp4 --out e2e-out/2k-ab2 --frame mid --label-a base --label-b pdd
"""

import argparse
import os
import cv2
import numpy as np


def load(p):
    c = cv2.VideoCapture(p)
    frs = []
    while True:
        ok, f = c.read()
        if not ok:
            break
        frs.append(f)
    c.release()
    return frs


def tag(img, label):
    """左上角标注 —— 只画在眼判图上，绝不进入任何生成流程。"""
    out = img.copy()
    cv2.rectangle(out, (0, 0), (len(label) * 13 + 16, 30), (0, 0, 0), -1)
    cv2.putText(out, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('a')
    ap.add_argument('b')
    ap.add_argument('--out', default='e2e-out/eyecrops')
    ap.add_argument('--frame', default='mid', help="'mid' | 'first' | 'last' | 整数帧号")
    ap.add_argument('--label-a', default='A')
    ap.add_argument('--label-b', default='B')
    ap.add_argument('--crop', default='640x384', help='WxH，1:1 中心裁切')
    ap.add_argument('--zoom', type=int, default=192, help='3× 放大用的方形边长')
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    A, B = load(args.a), load(args.b)
    if not A or not B:
        raise SystemExit('读不到帧')
    if len(A) != len(B):
        print(f'⚠️ 帧数不同：{len(A)} vs {len(B)}，只按较短的对齐')
    n = min(len(A), len(B))
    if args.frame == 'mid':
        i = n // 2
    elif args.frame == 'first':
        i = 0
    elif args.frame == 'last':
        i = n - 1
    else:
        i = int(args.frame) % n

    cw, ch = (int(x) for x in args.crop.lower().split('x'))
    h, w = A[0].shape[:2]
    cw, ch = min(cw, w), min(ch, h)
    y0, x0 = (h - ch) // 2, (w - cw) // 2

    ca = tag(A[i][y0:y0 + ch, x0:x0 + cw], args.label_a)
    cb = tag(B[i][y0:y0 + ch, x0:x0 + cw], args.label_b)
    cv2.imwrite(f'{args.out}/crop-A.png', ca)
    cv2.imwrite(f'{args.out}/crop-B.png', cb)
    sep = np.full((ch, 4, 3), 255, np.uint8)
    cv2.imwrite(f'{args.out}/sbs.png', np.hstack([ca, sep, cb]))

    z = min(args.zoom, cw, ch)
    za = cv2.resize(A[i][(h - z) // 2:(h + z) // 2, (w - z) // 2:(w + z) // 2],
                    (z * 3, z * 3), interpolation=cv2.INTER_NEAREST)
    zb = cv2.resize(B[i][(h - z) // 2:(h + z) // 2, (w - z) // 2:(w + z) // 2],
                    (z * 3, z * 3), interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(f'{args.out}/zoom3x-sbs.png',
                np.hstack([tag(za, args.label_a), np.full((z * 3, 4, 3), 255, np.uint8), tag(zb, args.label_b)]))

    # 闪烁条：连续 4 帧，A 行在上、B 行在下。两行的帧号相同 ⇒ 眼睛直接比抖动。
    sh, sw = ch // 2, cw // 2
    idxs = [j for j in range(i, i + 4)]
    idxs = [j % n for j in idxs]
    rows = []
    for label, frs in ((args.label_a, A), (args.label_b, B)):
        strip = np.hstack([cv2.resize(frs[j][y0:y0 + sh, x0:x0 + sw], (sw, sh)) for j in idxs])
        rows.append(tag(strip, f'{label}  frames {idxs[0]}..{idxs[-1]}'))
    cv2.imwrite(f'{args.out}/flicker-strip.png', np.vstack(rows))

    print(f'已写出 {args.out}/ 下的 crop-A/B.png、sbs.png、zoom3x-sbs.png、flicker-strip.png（帧 {i}）')


if __name__ == '__main__':
    main()
