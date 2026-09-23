"""A/B 差分归因：把 |A-B| 的能量按空间尺度分开，判断「二遍改动的是细节还是结构」。

修正上一个版本的方法学错误：mean(D - blur(D)) 恒等于 0（模糊保均值），毫无信息量。
这里改用 RMS（能量），并加两个对照：
  · 边缘相关：若差异集中在边缘/纹理上 ⇒ 二遍在重绘细节；若均匀铺满 ⇒ 更像全局偏移
  · 时间稳定性：逐帧差分 RMS 是否稳定
"""
import cv2, numpy as np, sys

def load(p):
    c = cv2.VideoCapture(p); fr = []
    while True:
        ok, f = c.read()
        if not ok: break
        fr.append(cv2.cvtColor(f, cv2.COLOR_BGR2GRAY).astype(np.float32))
    c.release(); return fr

A = load(sys.argv[1]); B = load(sys.argv[2])
n = min(len(A), len(B)); A = A[:n]; B = B[:n]
print(f'对齐 {n} 帧 · {A[0].shape[1]}x{A[0].shape[0]}')

D = np.stack([np.abs(a - b) for a, b in zip(A, B)], 0)
low = np.stack([cv2.blur(d, (9, 9)) for d in D], 0)
high = D - low
rms = lambda x: float(np.sqrt((x ** 2).mean()))
print(f'|A-B| 均值 {D.mean():.3f}/255 · PSNR {10*np.log10(255**2/float(((np.stack(A)-np.stack(B))**2).mean())):.2f} dB')
print(f'差分能量 RMS：总 {rms(D):.3f} ｜ >9px 尺度 {rms(low):.3f} ｜ <9px 尺度 {rms(high):.3f}')
print(f'  ⇒ 细则尺度占比 {rms(high)**2/(rms(low)**2+rms(high)**2)*100:.1f}%')

# 边缘相关：差异是否集中在结构边缘
meanA = np.mean(np.stack(A), 0)
gx = cv2.Sobel(meanA, cv2.CV_32F, 1, 0, ksize=3); gy = cv2.Sobel(meanA, cv2.CV_32F, 0, 1, ksize=3)
edge = np.sqrt(gx**2 + gy**2)
Dm = D.mean(0)
flat = edge <= np.percentile(edge, 40)
print(f'平均差异：边缘区 {Dm[~flat].mean():.3f} ｜ 平坦区 {Dm[flat].mean():.3f}'
      f'  ⇒ 边缘/平坦比 {Dm[~flat].mean()/Dm[flat].mean():.2f}（>1 = 改在结构上，≈1 = 均匀偏移）')

per = np.array([d.mean() for d in D])
print(f'逐帧差分均值：{per.mean():.3f} ± {per.std():.3f}（变异系数 {per.std()/per.mean()*100:.1f}%）')
print('  帧 0,8,16,24,32,40,48:', ', '.join(f'{per[i]:.3f}' for i in range(0, n, 8)))
