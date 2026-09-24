#!/usr/bin/env python3
"""
scripts/compare-crops.py — 同区域多臂 1:1 对照图（给**人眼**看，不是给人看指标）。

为什么需要它：有效分辨率是自校准频谱读数，能说明"高频能量变多了"，但不能说明"看起来更好"。
逐帧 CNN 超分有可能把噪声/块效应一起放大，只有 1:1 裁切才看得出来。

排布（上下两排，同一归一化区域）：
  上排「1:1 像素」：各臂裁同一归一化区域、按原始像素铺开 ⇒ 看**信息量**（宽臂能铺开更大面积）
  下排「同显示宽」：同一批裁切都缩到同一显示宽度 ⇒ 看**同尺寸下的观感**（谁更实、谁更糊）

用法：
  python3 scripts/compare-crops.py --out e2e-out/4k/compare-4arms-1to1.png \\
      --frame 60 --x0 0.34 --x1 0.60 --y0 0.28 --y1 0.66 \\
      "原生 1344x768=e2e-out/2k/native-s20f124-native-s20f124_00001_.mp4" \\
      "U1 2K 2688x1536=e2e-out/2k/v2s20f124-v2s20f124_00001_.mp4" \\
      "原生→U3x4 4032=e2e-out/4k/ab-native-u3-x4-4k-ab-native-u3-x4-4k_00001_.mp4" \\
      "U1→U3x2 4032=e2e-out/4k/u3-4k-area-f124-u3-4k-area-f124_00001_.mp4"
"""
import argparse
import os
import sys

import cv2
import numpy as np


def grab(path, frame_idx):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit("打不开：" + path)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    k = frame_idx if frame_idx >= 0 else max(0, total + frame_idx)
    cap.set(cv2.CAP_PROP_POS_FRAMES, k)
    ok, fr = cap.read()
    cap.release()
    if not ok:
        raise SystemExit(f"取不到第 {k} 帧：{path}")
    return fr


def label(img, text, pad=6):
    """在图上贴一行等宽标签（足够看清，不做花哨排版）。"""
    h, w = img.shape[:2]
    bar = np.full((26 + pad, w, 3), 16, np.uint8)
    cv2.putText(bar, text, (8, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (240, 240, 240), 1, cv2.LINE_AA)
    return np.vstack([bar, img])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("arms", nargs="+", help="名字=路径（名字里别放 =）")
    ap.add_argument("--out", default="e2e-out/4k/compare-arms-1to1.png")
    ap.add_argument("--frame", type=int, default=60)
    ap.add_argument("--x0", type=float, default=0.34)
    ap.add_argument("--x1", type=float, default=0.60)
    ap.add_argument("--y0", type=float, default=0.28)
    ap.add_argument("--y1", type=float, default=0.66)
    ap.add_argument("--display-width", type=int, default=640)
    args = ap.parse_args()

    crops = []
    for arm in args.arms:
        if "=" not in arm:
            raise SystemExit("参数要写成 名字=路径：" + arm)
        name, path = arm.split("=", 1)
        if not os.path.exists(path):
            raise SystemExit("文件不存在：" + path)
        fr = grab(path, args.frame)
        h, w = fr.shape[:2]
        x0, x1 = int(round(w * args.x0)), int(round(w * args.x1))
        y0, y1 = int(round(h * args.y0)), int(round(h * args.y1))
        crop = fr[y0:y1, x0:x1].copy()
        crops.append((name, fr, crop))
        print(f"{name:<22} 源 {w}×{h} · 裁 {crop.shape[1]}×{crop.shape[0]}（归一化 x {args.x0}-{args.x1} / y {args.y0}-{args.y1}）")

    # 上排：1:1 原像素，左侧对齐、补白到最宽
    W = max(c.shape[1] for _, _, c in crops)
    H = max(c.shape[0] for _, _, c in crops)
    row1 = []
    for name, fr, c in crops:
        canvas = np.full((H, W, 3), 16, np.uint8)
        canvas[: c.shape[0], : c.shape[1]] = c
        row1.append(label(canvas, f"{name}  1:1 (crop {c.shape[1]}x{c.shape[0]})"))
    top = np.hstack(row1)

    # 下排：同一批裁切缩到同一显示宽度
    dw = args.display_width
    row2 = []
    for name, fr, c in crops:
        dh = max(1, int(round(c.shape[0] * dw / c.shape[1])))
        small = cv2.resize(c, (dw, dh), interpolation=cv2.INTER_AREA)
        row2.append(label(small, f"{name}  缩到 {dw}px 宽"))
    h2 = max(r.shape[0] for r in row2)
    row2 = [np.vstack([r, np.full((h2 - r.shape[0], r.shape[1], 3), 16, np.uint8)]) for r in row2]
    bottom = np.hstack(row2)

    # 两排宽度不同：补白到同宽再拼
    W2 = max(top.shape[1], bottom.shape[1])
    def pad_w(x):
        if x.shape[1] == W2:
            return x
        return np.hstack([x, np.full((x.shape[0], W2 - x.shape[1], 3), 16, np.uint8)])
    out = np.vstack([pad_w(top), np.full((10, W2, 3), 16, np.uint8), pad_w(bottom)])

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    cv2.imwrite(args.out, out)
    print(f"\n已写 {args.out}（{out.shape[1]}×{out.shape[0]}）")
    print("读图提示：上排看信息量（同归一化区域，1:1 像素下宽臂铺得更开）；下排看同尺寸观感（谁更实、谁更糊/更花）。")


if __name__ == "__main__":
    sys.exit(main())
