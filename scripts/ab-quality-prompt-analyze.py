#!/usr/bin/env python3
"""AB 实验抽帧对比 + 客观指标（cv2 / PIL）。"""
import sys, os, json, math
import numpy as np
import cv2
from PIL import Image, ImageDraw

root, session, results_file, out_dir = sys.argv[1:5]
with open(results_file, 'r', encoding='utf-8') as f:
    results = json.load(f)

os.makedirs(out_dir, exist_ok=True)
CELL_W, CELL_H = 300, 170
LABEL_H = 48
HEADER_H = 54
COLS = 5
rows = len(results)
sheet = Image.new('RGB', (COLS * (CELL_W + 12) + 12, HEADER_H + rows * (CELL_H + LABEL_H + 12) + 12), (20, 22, 28))
draw = ImageDraw.Draw(sheet)
draw.text((12, 14), 'AB: tier-specific prompt vs quality prompt for all tiers  |  S01 · single-view refs · seed 424242 · 124f', fill=(235, 238, 245))

def hasler_colorfulness(img):
    b, g, r = cv2.split(img.astype('float32'))
    rg = np.abs(r - g); yb = np.abs(0.5 * (r + g) - b)
    std = np.sqrt(rg.std() ** 2 + yb.std() ** 2)
    mean = np.sqrt(rg.mean() ** 2 + yb.mean() ** 2)
    return float(std + 0.3 * mean)

metrics = []
for row, item in enumerate(results):
    path = item.get('absPath') or os.path.join(root, *str(item.get('media', '')).split('/'))
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise RuntimeError('无法打开视频: ' + path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 24
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    fractions = [0.0, 0.25, 0.5, 0.75, 0.97]
    frames = []
    sharp = []
    for frac in fractions:
        idx = max(0, min(total - 1, int(round((total - 1) * frac))))
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok:
            # 末尾偶尔读不到，往前退一帧
            cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, idx - 2))
            ok, frame = cap.read()
        if not ok:
            frame = np.zeros((h or 480, w or 832, 3), dtype=np.uint8)
        frames.append(frame)
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        sharp.append(float(cv2.Laplacian(gray, cv2.CV_64F).var()))
    # 相邻采样帧差（运动 + 闪烁的混合，仅参考）
    diffs = []
    for a, b in zip(frames[:-1], frames[1:]):
        if a.shape != b.shape:
            b = cv2.resize(b, (a.shape[1], a.shape[0]))
        diffs.append(float(np.mean(np.abs(a.astype('float32') - b.astype('float32')))))
    cap.release()
    m = {
        'key': item['key'], 'tier': item['tier'], 'promptTier': item['promptTier'],
        'nodeId': item['nodeId'], 'resolution': f'{w}x{h}', 'fps': round(fps, 2), 'frames': total,
        'sharpness_mean': float(np.mean(sharp)), 'colorfulness': float(np.mean([hasler_colorfulness(f) for f in frames])),
        'frame_diff_mean': float(np.mean(diffs)) if diffs else 0.0,
    }
    metrics.append(m)

    label = f"{item['key']}  |  {item['tier']} + {item['promptTier']} prompt  |  {w}x{h}"
    y0 = HEADER_H + row * (CELL_H + LABEL_H + 12)
    draw.text((12, y0 - 18), label, fill=(220, 225, 235))
    for col, (frac, frame) in enumerate(zip(fractions, frames)):
        x0 = 12 + col * (CELL_W + 12)
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        im = Image.fromarray(rgb)
        # 保持比例装进固定格，黑底 letterbox
        scale = min(CELL_W / im.width, CELL_H / im.height)
        nw, nh = max(1, int(im.width * scale)), max(1, int(im.height * scale))
        im = im.resize((nw, nh), Image.LANCZOS)
        cell = Image.new('RGB', (CELL_W, CELL_H), (8, 9, 12))
        cell.paste(im, ((CELL_W - nw) // 2, (CELL_H - nh) // 2))
        sheet.paste(cell, (x0, y0 + 18))
        draw.text((x0, y0 + 18 + CELL_H + 2), f'{frac*100:.0f}%  ·  t={frac*total/fps:.2f}s', fill=(160, 168, 180))
    # 每行单独存一张，便于画布/文件细看
    row_img = sheet.crop((0, y0 - 20, sheet.width, min(sheet.height, y0 + CELL_H + LABEL_H + 2)))
    row_img.save(os.path.join(out_dir, f"contact-{item['key']}.png"))

sheet.save(os.path.join(out_dir, 'contact-sheet.png'))
with open(os.path.join(out_dir, 'metrics.json'), 'w', encoding='utf-8') as f:
    json.dump(metrics, f, ensure_ascii=False, indent=2)

print('contact sheet:', os.path.join(out_dir, 'contact-sheet.png'))
for m in metrics:
    print(f"{m['key']:<12} {m['resolution']:<9} sharp={m['sharpness_mean']:.1f} color={m['colorfulness']:.1f} frameDiff={m['frame_diff_mean']:.2f}")
