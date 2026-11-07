# ComfyUI 原生补帧（VFI）探针报告

探测时间：2026-10-26 15:25–15:50（Asia/Shanghai）｜探针：teammate `comfy-vfi-probe`｜任务：task-1

目标：把「这台 ComfyUI 能不能补帧、怎么接图、代价多少」变成可复核事实。**未对服务器做任何写入**（未装权重、未装自定义节点、未改任何文件）；本机临时脚本与产物在 `e2e-out/fps-probe/`。

环境（实测，`curl -s localhost:8188/system_stats`）：
- ComfyUI **0.42.1**，Python 3.14.4，PyTorch 2.15.0.dev+cu132，argv `--listen --port 8188 --disable-xformers`（⇒ 无 `--gpu-only`、无 `--fp16-intermediates`）。
- 宿主 = `t0-server`（172.16.190.20，`ssh t0-server` 免密可用），ComfyUI 跑在 **docker 容器**里（`ps` 显示 `/sbin/docker-init -- bash -c python3.14 ./ComfyUI/main.py …`，容器内 root）。
- 端口 8188 是本机 → 172.16.190.20:22 的 **ssh 隧道**（`lsof -nP -iTCP:8188`）。
- 容器挂载（`sudo cat /proc/<pid>/mountinfo`）：代码 `/data/comfyui/storage/ComfyUI`；**模型 `/data/comfyui/storage-models/models` → `/root/ComfyUI/models`**；输入 `/data/comfyui/storage-user/input`（733 个文件）→ `/root/ComfyUI/input`；输出 `…/storage-user/output`。
- 双卡 **本机单卡**，ComfyUI 用 cuda:0；探测时另一路 H3 渲染在跑，`vram_free` 15.2 GB。
- **本机与宿主机都没有 ffmpeg/ffprobe**（`which ffmpeg` 空；容器内未知，见 §10）。ComfyUI 的视频解码/编码走容器内 PyAV，不需要 ffmpeg CLI。

## TL;DR

1. **今天跑不通，唯一硬阻塞是权重**：原生补帧节点在，`models/frame_interpolation/` 不存在/为空 ⇒ `FrameInterpolationModelLoader` 的下拉选项是 `[]` ⇒ `/prompt` 直接 **400 校验失败**，图根本提交不进去（不是运行时报错）。**实测**，见 §5.1。
2. 除此之外的链路**全部成立且已实测**：`LoadVideo → Video Slice → GetVideoComponents → ImageScale → CreateVideo(fps 注入, audio 直通) → SaveVideo`，24 帧 512×288 单次 **375 ms**（含两个 SaveVideo），输出帧数/fps/音轨与源码契约一致。**实测**，见 §5.2–5.4。
3. **最少用户动作 = 放一个 65.7 MB 的文件**（`film_net_fp16.safetensors`）到宿主 `…/storage-models/models/frame_interpolation/`，**不用改代码、不用重启 ComfyUI**（目录 mtime 会让 `folder_paths` 缓存自动失效）。之后 `multiplier=2` + `CreateVideo fps=48` 就是 24→48。清单见 §9。
4. **两个交付结论（已由实测+源码支撑）**：
   - **模型节点只能整数倍**：`multiplier: INT 2..16`，`24→48/72/96` 可以；`24→30/60` 是非整数比，**任何原生节点都做不到**，必须外部 ffmpeg（今天本机与宿主都没有 ffmpeg ⇒ 30/60fps 交付目前无路）。
   - **48fps 逐镜补帧必须有权重**：`CreateVideo(fps=48)` 只是**改标签**，不复制帧——24 帧输入仍然是 24 帧输出，时长从 1.0 s 变 0.5 s（**实测**，见 §5.3）。
5. 音频在真实补帧（fps×2）下**会被剪掉最后一帧左右（≈20.8 ms）**：`CreateVideo` 的音频轨 = `min(输入音频, 画面时长)`，不拉伸不循环。**实测**（三臂），见 §5.4。

## 1. 节点事实表（源码级）

来源：`/data/comfyui/storage/ComfyUI/comfy_extras/nodes_frame_interpolation.py`（与 [v0.42.1 上游](https://github.com/comfyanonymous/ComfyUI/blob/v0.42.1/comfy_extras/nodes_frame_interpolation.py) 同）；实例 schema 用 `object_info` 复核。

| 节点 | 输入 | 输出 | 关键行为（源码） |
|---|---|---|---|
| `FrameInterpolationModelLoader` | `model_name: COMBO`（选项 = `folder_paths.get_filename_list("frame_interpolation")`） | `INTERP_MODEL` | `load_torch_file(path, safe_load=True)`；`should_use_fp16(本机)=True` ⇒ 模型走 **fp16**；包进 `CoreModelPatcher` |
| `FrameInterpolate` | `interp_model: INTERP_MODEL`、`images: IMAGE`、`multiplier: INT`（default 2，**min 2 / max 16**） | `IMAGE` | 见 §6 算术；**`num_frames < 2` 或 `multiplier < 2` ⇒ 原样返回输入（静默 no-op，无报错）** |
| `OpticalFlowLoader` | `model_name: COMBO`（`optical_flow` 目录，only `raft_large.pth`） | `OPTICAL_FLOW` | **与补帧无关**：全实例只有一个消费者 `VOIDWarpedNoise`（生成训练数据用）。别为补帧去下 raft（`object_info` 交叉核对） |
| `LoadVideo` | `file: COMBO`（input 目录文件，`upload: video`） | `VIDEO` | 返回**惰性** `VideoFromFile`（PyAV 打开，不解码） |
| `GetVideoComponents` | `video: VIDEO` | `IMAGE, AUDIO, FLOAT(fps), bit_depth, color_space` | **一次性解码整段**：`torch.stack(frames)`（fp32，`gbrpf32le`）⇒ 显存/内存随帧数线性，无帧数上限参数 |
| `Video Slice` | `video, start_time, duration, strict_duration` | `VIDEO` | 裁剪窗口，**不重编码**；下游 `GetVideoComponents` 只解这一段（实测 24fps × 1.0 s = 恰好 24 帧） |
| `CreateVideo` | `images: IMAGE, fps: FLOAT(1..120), audio?: AUDIO` | `VIDEO` | 只给帧序列打 `frame_rate` 标签；**不复制/不重采样帧** |
| `SaveVideo` | `video, filename_prefix, format: COMBO(auto/mp4/mkv/webm), codec: COMBO(auto/h264/av1)` | `VIDEO` | 兼容源流时**remux 零重编码**；否则转码。**`format` 是 API 提交的必填参数**（漏传 → `SaveVideo.execute() missing 1 required positional argument: 'format'`，实测踩到） |
| `ConcatenateVideo` | `videos: AUTOGROW(1..100)`, `codec`, `complete_audio?` | `VIDEO` | 硬切拼接；可整体替换音轨 |

权重格式支持（`folder_paths.py:10`，实测服务器源码）：`{'.ckpt','.pt','.pt2','.bin','.pth','.safetensors','.pkl','.sft'}`；目录注册在 `folder_paths.py:61`（`frame_interpolation`）、`:65`（`optical_flow`）。**只吃 state_dict，不吃 TorchScript**。

## 2. 权重事实表（能否被识别 = 源码里的两条分支）

`FrameInterpolationModelLoader._detect_and_load()` 只有两条路，认不出就抛 `ValueError("Unrecognized frame interpolation model format")`：

| 家族 | 判定条件（源码） | 备注 |
|---|---|---|
| **FILM** | `"extract.extract_sublevels.convs.0.0.conv.weight" in sd` ⇒ `FILMNet()` | 支持任意 `t`（`forward_multi_timestep`，每个帧对只算一次光流，融合按 t 重复）；`pad_align=1`（不 padding）；激活显存系数 **1700·H·W·itemsize** |
| **RIFE** | 否则：先 `state_dict_prefix_replace({"module.":"", "flownet.":""})`、`block{i}.* → blocks.{i}.*`、丢弃 `teacher.`/`caltime.`；再 `detect_rife_config` 要求 `encode.cnn3.weight` + 5 个 `blocks.{i}.conv0.1.0.weight` | 失败信息两种：`Unsupported RIFE model: expected 5 blocks…` / `Unrecognized…`；`pad_align=64`（reflect pad）；激活系数 **300·H·W·itemsize** |

官方权重（模板 [utility_video_frame_interpolation.json](https://github.com/Comfy-Org/workflow_templates/blob/v0.11.89/templates/utility_video_frame_interpolation.json) 的 `properties.models` 明写 URL + 目录；HF 仓库 [Comfy-Org/Frame-Interpolation](https://huggingface.co/Comfy-Org/Frame-Interpolation) 文件表实测拉取）：

| 文件 | 大小（实测 Content-Length） | 说明 |
|---|---|---|
| `frame_interpolation/film_net_fp16.safetensors` | **68,882,302 B = 65.7 MB** | **官方模板默认值**，FILM |
| `frame_interpolation/rife_v4.25.safetensors` | 22,674,688 B = 21.6 MB | RIFE |
| `frame_interpolation/rife_v4.25_heavy.safetensors` | 86,669,816 B = 82.7 MB | RIFE heavy |
| `frame_interpolation/rife_v4.25_lite.safetensors` | 22,506,384 B = 21.5 MB | RIFE lite |
| `frame_interpolation/rife_v4.26.safetensors` | 22,674,688 B = 21.6 MB | RIFE |
| `frame_interpolation/rife_v4.26_heavy.safetensors` | 22,908,216 B = 21.8 MB | RIFE heavy |

放置路径（模板 note 原文）：`ComfyUI/models/frame_interpolation/<文件名>`；本机实机对应宿主 **`/data/comfyui/storage-models/models/frame_interpolation/`**（容器内 `/root/ComfyUI/models/frame_interpolation/`）。
官方蓝图 `blueprints/Frame Interpolation.json` 里 `FrameInterpolationModelLoader.widgets_values = ['film_net_fp16.safetensors']`，**文件名不参与解析，只是取值**（COMBO 校验要求文件确实在目录里）。

## 3. 服务器放置通道与网络可达性（只读探测）

| 通道 | 结论 | 证据 |
|---|---|---|
| **ssh + sudo（可行，唯一现实通道）** | `ssh t0-server` 免密可达；`sudo -n true` **rc=0**（免密 sudo）；`models/` 与 `storage-models/` 属 **root:root**，因此 `sudo cp` 是必须的 | `ssh t0-server 'sudo -n true; echo $?'` |
| HTTP `/upload/image`、`/upload/mask` | **不能放权重**：只写 input/temp/output | `server.py:533/550` |
| HTTP `GET /models/{folder}` | 只读列表，无写接口；核心 `server.py` **没有**下载模型的路由 | `server.py:412` |
| ComfyUI-Manager | 已装 **V3.41**（`GET /api/manager/queue/status` → 200 `{…}`），理论上可拉自定义节点/模型，但**本次未使用**（要动服务器） | `curl -s localhost:8188/api/manager/version` |
| 目录缓存 | **加文件不用重启**：`folder_paths.get_filename_list` 按目录 `mtime` 失效（`folder_paths.py:493-517`），强缓存 `CacheHelper.active=False` | 服务器源码 |
| 服务器出网 | `huggingface.co` **000（连不上）**；**`hf-mirror.com` 200 / 0.75 s ✅**，能解析到该权重文件（307 → 大写仓库名，`content-length: 124` 的是跳转体） | `ssh t0-server 'curl -sI -m 12 https://hf-mirror.com'` |
| 本机出网 | 同样 `huggingface.co` 不通、`hf-mirror.com` 200；`github.com` 200 | `for u in …; do curl -so /dev/null -w "%{http_code}" $u; done` |

⇒ 下载必须走镜像：`https://hf-mirror.com/Comfy-Org/Frame-Interpolation/resolve/main/frame_interpolation/film_net_fp16.safetensors`

## 4. 精确 graph（JSON，API 格式）

### 4.1 官方 blueprint 的接法（源码证据）

`blueprints/Frame Interpolation.json`（v0.42.1）里的子图，逐条连线：

```
FrameInterpolationModelLoader(model_name) ─┐
GetVideoComponents(images) ───────────────┼→ FrameInterpolate(interp_model, images, multiplier)
PrimitiveInt(multiplier 2) ───────────────┘
FrameInterpolate(out) ─┐
GetVideoComponents(audio) ────────────────┼→ CreateVideo(images, fps, audio)
ComfySwitchNode(fps | fps*mult) ──────────┘        fps 由 ComfyMathExpression `min(abs(b),16)*a` 生成
CreateVideo(out) ────────────────────────────────→ SaveVideo
```

⇒ **「fps 乘不乘」是显式开关**：乘 = 真补帧（帧率变高、时长不变）；不乘 = 慢动作（帧率不变、时长 ×mult）。**任务假说成立**（`CreateVideo(fps=源, audio=源)` 那一支是慢动作）。

### 4.2 补帧（24→48）最小可提交图

```json
{
  "1": {"class_type": "LoadVideo", "inputs": {"file": "S11-endcard.mp4"}},
  "2": {"class_type": "Video Slice", "inputs": {"video": ["1", 0], "start_time": 0.0, "duration": 5.2, "strict_duration": false}},
  "3": {"class_type": "GetVideoComponents", "inputs": {"video": ["2", 0]}},
  "4": {"class_type": "ImageScale", "inputs": {"image": ["3", 0], "upscale_method": "bilinear", "width": 512, "height": 288, "crop": "center"}},
  "5": {"class_type": "FrameInterpolationModelLoader", "inputs": {"model_name": "film_net_fp16.safetensors"}},
  "6": {"class_type": "FrameInterpolate", "inputs": {"interp_model": ["5", 0], "images": ["4", 0], "multiplier": 2}},
  "7": {"class_type": "CreateVideo", "inputs": {"images": ["6", 0], "fps": 48.0, "audio": ["3", 1]}},
  "8": {"class_type": "SaveVideo", "inputs": {"video": ["7", 0], "filename_prefix": "vfi/out", "format": "auto"}}
}
```

- `4` 是本次探针的降尺寸步骤；生产上删掉 `4`（保持 1344×768）。
- `2` 的 `Video Slice` 是可选的：不加就是整段（内存随帧数走，见 §7）。
- `fps` 必须写**源 fps × multiplier**；写源 fps 就是慢动作。
- **`format` 必填**（见 §1 踩坑）。

## 5. 实测数据（全部 ≤512×288、≤24 帧、单次 <1 s GPU 时间）

源片：`S11-endcard.mp4`（ComfyUI 报 `width 1344, height 768, duration 3.0417, fps 24.0, frame_count 73`；与自写 MP4 box 解析器一致）。测试脚本：`e2e-out/fps-probe/run_graph.py`、`probe_mp4.py`；产物：`e2e-out/fps-probe/out/`。

### 5.1 阻塞点（实测，零 GPU 成本）

```
$ python3 e2e-out/fps-probe/run_graph.py e2e-out/fps-probe/graph-validate.json
POST /prompt -> 400 {"error": {"type": "prompt_outputs_failed_validation", …},
  "node_errors": {"5": {"errors": [{"type": "value_not_in_list",
    "details": "model_name: 'film_net_fp16.safetensors' not in []", …}]}}}
```

⇒ 权重不在目录里时，**连提交都过不了**（COMBO 校验）。复核：`curl -s localhost:8188/models/frame_interpolation` → `[]`。

### 5.2 链路计时（实测）

| 图 | 节点 | server_exec | 结果 |
|---|---|---|---|
| plumbing（含 2 个 SaveVideo） | LoadVideo + Slice + GetVideoComponents + ImageScale + CreateVideo + 2×SaveVideo | **375 ms** | 输出两个文件，见下 |
| arm-A（1 SaveVideo） | 同上单存 | **133 ms** | 512×288 / 24 帧 / 24 fps / 1.0 s |
| arm-C | 同上 | **292 ms** | 512×288 / 24 帧 / 24 fps / 1.0 s |

（`wall_s` 里含排队；上表用 `/history` 的 `execution_start→execution_success` 时间戳，不含排队。）

### 5.3 `CreateVideo(fps=48)` 只改标签（实测）

| 图 | 输入 | 输出（`probe_mp4.py` 解析） |
|---|---|---|
| 24 帧（1.0 s 切片）→ fps=48 | 24 帧 | **512×288，24 帧，48.0 fps，0.5 s** |

⇒ 帧数不变、时长减半。**补帧的「帧」只能来自 `FrameInterpolate`（需要权重）**；核心节点里也没有「按帧复制/交织」的节点（只有 `RepeatImageBatch` = 整批重复，不是交织；`object_info` 全量扫描确认无 interleave/repeat-frame 节点）。

### 5.4 音频契约：三臂（实测）

同一源，`GetVideoComponents` 的音频分别取 1.0 s / 1.0 s / 0.5 s，画面统一 24 帧：

| 臂 | 画面 | fps | 视频时长 | 音频输入 | **输出音频轨** | 结论 |
|---|---|---|---|---|---|---|
| A | 24 帧 | 24 | 1.0 s | 1.0 s | **1.032 s**（33 pkt） | 相等时原样带回 |
| B | 24 帧 | 48 | 0.5 s | 1.0 s | **0.532 s**（17 pkt） | 音频 **被剪到画面长度** |
| C | 24 帧 | 24 | 1.0 s | 0.5 s | **0.532 s**（17 pkt） | **不拉伸、不循环**，余下静音 |

⇒ 规则：**输出音频轨 = min(输入音频, 画面时长) + AAC 包粒度（≈32 ms）**。对 24→48 真补帧：画面 `((N−1)·2+1)/48`，比原 `N/24` 短 `1/48 s ≈ 20.8 ms` ⇒ **音频尾部被剪 ~20.8 ms**（每镜独立，不累积漂移）。对慢动作（fps 不乘）：画面 ×2 长，音频只覆盖前一半，**后半段静音**。

## 6. 算术与语义（源码级，非实测）

设输入 `n` 帧、`multiplier = m (2..16)`：

- **输出帧数 = (n − 1)·m + 1**（`total_out_frames = total_pairs * multiplier + 1`）；原帧落在 0, m, 2m, … 位置，中间是 `t = k/m`（k=1..m−1）的插值帧。
- **时间戳**：`t_values = [k/m]`，均匀；FILM 支持任意 t，RIFE 的 IFNet 也把 t 当平面输入（**m>2 时 RIFE 质量未验证**，标记未知）。
- **时长**：`CreateVideo fps = f·m` ⇒ 输出时长 `((n−1)m+1)/(f·m) = (n−1)/f + 1/(f·m)`，比源 `n/f` 短 `(m−1)/(m·f)`。24 fps、m=2、n=124：**5.1667 s → 5.1458 s**。
- **静默降级**：`n<2` 或 `m<2` 直接返回输入图（不报错）⇒ 上游传错参数时**不会失败，只会悄悄不补帧**。生产接线必须自己断言 `n≥2`。
- **dtype/设备**：模型 fp16（`should_use_fp16`），逐帧搬到 GPU；**输出缓冲在 `intermediate_device() = CPU`**（因为没有 `--gpu-only`），`intermediate_dtype() = fp32`（没有 `--fp16-intermediates`）⇒ **结果占的是内存不是显存**。
- **RIFE `pad_align=64`**：非 64 对齐的尺寸会被 reflect pad 再裁回（不改变输出尺寸，白算一点边）。

## 7. 成本与显存（**未实测**：无权重，按源码公式 + 常量外推）

- 逐帧图像张量：`n·H·W·3·4 B`（`GetVideoComponents` 一次解码，fp32）。
- `FrameInterpolate` 输出：`((n−1)m+1)·H·W·3·4 B`（CPU，fp32）。**这一项与帧数线性**，是长镜头的主要风险，不是显存。
- 单帧对激活峰值（源码 `memory_used_forward`）：**FILM 1700·H·W·itemsize**、**RIFE 300·H·W·itemsize**（fp16 ⇒ itemsize=2）。与帧数**无关**，只与分辨率有关。

| 场景 | 输入张量 | 输出张量 (m=2) | 输出张量 (m=4) | 激活峰值 FILM / RIFE (fp16) |
|---|---|---|---|---|
| 512×288，n=24 | 42 MB | 83 MB | 166 MB | 0.50 GB / 0.09 GB |
| 1344×768，n=124（5.17 s） | 1.53 GB | 3.06 GB | 6.11 GB | 3.51 GB / 0.62 GB |
| 1344×768，n=372（15.5 s） | 4.61 GB | 9.21 GB | 18.4 GB | 3.51 GB / 0.62 GB |

- 显存侧：本机 单卡 80 GB，探测时 `vram_free` 只有 **15.2 GB**（别的渲染在占）。FILM 峰值 ≈ 3.5 GB + 权重 66 MB + 帧副本 ≈ **4 GB 量级**，与 124/372 帧无关 ⇒ **单镜 1344×768 不需要分块**。
- 内存侧：**372 帧 ×4 需要 18.4 GB 输出 + 4.6 GB 输入 ≈ 23 GB**（宿主 540 GB RAM，安全）。若将来开 `--gpu-only` 或 `--fp16-intermediates` 数字会变（后者减半），届时需重测。
- 时间：**不预测秒数**。可核实的成本结构：每帧对 1 次前向；m=2 时 124 帧 = **123 次前向**；m=4 时 FILM 光流只算一次/对（融合 3 次），RIFE 则 3 次完整前向（特征有缓存）。→ 需要真实数字就按 §9 跑一次 `multiplier=2, 24 帧, 512×288` 的图，读 `/history` 的 `execution_start→execution_success`（这正是 §5.2 用的方法）。

## 8. 备选路径对比

| 方案 | 现状（实测） | 接入难度 | 风险 |
|---|---|---|---|
| **A. 原生节点 + 放权重**（推荐） | 节点/图已就绪，只缺 65.7 MB 文件 | **低**：一个 workflow json + 一个 lib 模块（照 `video.upscale` 的先例），不改 ComfyUI | 需用户授权放置权重；RIFE m>2 质量未知 |
| B. `ComfyUI-Frame-Interpolation`（Fannovel16，[repo](https://github.com/Fannovel16/ComfyUI-Frame-Interpolation) / [registry](https://registry.comfy.org/nodes/comfyui-frame-interpolation)，1.18 M 下载） | **未安装**（`object_info` 里没有 `RIFE VFI`/`FILM VFI`；已装自定义节点仅 ComfyMath、Impact-Pack、LTXVideo、MiniMax-H3-PDD-Acc、SolAttn-Ampere、latent-Upscaler） | **中高**：装包 + 装依赖 + 重启容器（镜像可能需重建），权重另放它自己的目录 | 依赖冲突（torch 2.15 dev）、改镜像、多一套模型目录；收益仅是「有更多 VFI 算法」 |
| C. 外部 ffmpeg（`minterpolate`/`fps` 滤镜） | **本机无 ffmpeg、宿主无 ffmpeg**（实测）。插件已有「有 ffmpeg 走 ffmpeg，否则走 ComfyUI 节点」的先例（`video_concat`） | **低-中**：本机一条安装命令即可；但要求「操作媒体的机器上有 ffmpeg」 | 质量（minterpolate 有块状/闪烁）；要新增代码路径 |
| D. 纯节点做帧复制（无 VFI） | **做不到**：核心节点无交织/按帧复制（只有 `RepeatImageBatch` 整批重复） | — | — |
| E. 慢动作代替补帧（fps 不乘） | 可行（官方 blueprint 就带这个开关），但**音频只覆盖前一半**（§5.4 实测）+ 成片时长翻倍 | 低 | 不是「补帧」，是减速 |

**结论对齐**：`24→48/72/96` 只能走 A（或 B）；`24→30/60` 是非整数比，**模型节点无解**，只能 C（ffmpeg `fps` 滤镜做丢/复帧，或 `minterpolate` 做插帧）——而 C 今天在两个宿主上都不具备。

## 9. 「今天要跑通一次 24→48 补帧」最少清单

1. **放权重（唯一阻塞）**：
   ```bash
   # 在有 hf-mirror 网的机器上下载（本机不通 HF，通 hf-mirror）
   curl -L -o /tmp/film_net_fp16.safetensors \
     https://hf-mirror.com/Comfy-Org/Frame-Interpolation/resolve/main/frame_interpolation/film_net_fp16.safetensors
   # 宿主上建目录并放入（目录 root 所有 ⇒ 需要 sudo；免密 sudo 已验证）
   ssh t0-server 'sudo mkdir -p /data/comfyui/storage-models/models/frame_interpolation'
   scp /tmp/film_net_fp16.safetensors t0-server:/tmp/
   ssh t0-server 'sudo cp /tmp/film_net_fp16.safetensors /data/comfyui/storage-models/models/frame_interpolation/ && ls -l /data/comfyui/storage-models/models/frame_interpolation/'
   ```
2. **不需要重启 ComfyUI**。验收两条命令：
   ```bash
   curl -s localhost:8188/models/frame_interpolation          # 期望: ["film_net_fp16.safetensors"]
   curl -s localhost:8188/object_info | python3 -c 'import json,sys; print(json.load(sys.stdin)["FrameInterpolationModelLoader"]["input"]["required"]["model_name"][1]["options"])'
   ```
3. **提交 §4.2 的图**（删掉节点 4，`multiplier=2`、`fps=48`、`format="auto"`），先跑 24 帧小样确认不 OOM，再一次跑整镜。
4. 成片验收：帧数应为 `(N−1)·2+1`、fps=48、音频轨 ≈ 画面时长（尾部少 ~20.8 ms）。

（可选的更省事路径：ComfyUI 前端打开原生模板 `utility_video_frame_interpolation`，它带 `properties.models` 自动下载 65.7 MB。但**容器直连 HF 不通**，走这条路要先让容器能访问 hf-mirror——该环境变量在 0.42.1/Manager V3.41 上是否生效**未验证**，不要依赖它。）

## 10. 未知 / 未验证（明确列出）

1. **补帧速度与真实显存峰值**：无权重 ⇒ 未实测，本报告只给公式与量级。
2. **容器内是否有 ffmpeg**：宿主没有（实测）；容器内无法只读确认（无 docker 组权限：`docker ps` → `permission denied`）。PyAV 自带解码器，与 ffmpeg CLI 无关。
3. **RIFE m≥3 的质量**：`t = k/m` 偏离 0.5，未实测。4. **Manager 自动下载在镜像网络下是否可用**：未测（要动服务器）。
5. **`--fp16-intermediates`/`--gpu-only` 下的数字**：当前 argv 没开，开则需重测。6. **本机 ffmpeg 方案**：本次未安装（遵守约束）。

## 附：本次探针的复现入口（都在 `e2e-out/fps-probe/`）

| 文件 | 用途 |
|---|---|
| `run_graph.py` | 提交 API 图、轮询 `/history`、打印 `execution_start→success` 与输出元数据 |
| `probe_mp4.py` | 无 ffprobe 的 MP4 box 解析（时长/fps/帧数/宽高/音轨时长） |
| `graph-validate.json` / `graph-plumbing.json` / `graph-arm-A.json` / `graph-arm-C.json` | 复现 §5.1 的 400 阻塞证据、§5.2–5.4 |
| `out/*.mp4`、`src/*.mp4`；`object_info.json`、`nodes_frame_interpolation.py`、`film_net.py`、`ifnet.py`、`blueprint.json` | 实测产物/源片；节点与实现的快照 |
