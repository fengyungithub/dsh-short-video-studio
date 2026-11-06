# 阿里云函数计算 FC 3.0（中国站）GPU 实例运行时约束与工程可行性

> 研究对象：把 ComfyUI（MiniMax H3 音视频模型，int8 UNet ≈21GB + 32B 文本编码器 ≈18GB + VAE，模型文件合计 ≈45–50GB）搬到 FC GPU 上跑。
> 基线性能：单镜 1344×768 / 124 帧（约 5.2s 成片）在 A800 80GB 上约 166 秒/镜。
> 调研时间：2026-11-05。所有「页面更新时间」取自 help.aliyun.com 文档页内嵌的 `lastModifiedTime` 字段（页面正文头部显示的"更新时间"为空，故以页面元数据为准）。
> 标注「推算」的数字是本报告基于官方吞吐数据做的算术推导，非官方原文；标注「未找到官方说明」的是在 FC 产品文档与 llms.txt 全量索引里检索后确认无对应条目。

---

## 一、结论速览

1. **技术上可行，但必须换卡型与加载路径**：FC GPU 单卡最大显存档位是 `fc.gpu.hopper.1` 96GB / `fc.gpu.hopper.2` 141GB，**没有 80GB 卡**；48GB 档（ada.1/ada.3）装不下 ≈45–50GB 模型 + 1344×768×124 帧的激活，应选 **Hopper 整卡 1 卡**（显存与 A800 80GB 相当或更宽）。
2. **镜像装不下模型，模型必须外置**：GPU 函数镜像上限官方口径 **15GB**（未解压），模型 45–50GB 只能放 NAS/OSS 挂载。镜像里只放 ComfyUI 代码 + 依赖。
3. **最常见的踩坑点是 120 秒启动健康检查**：平台要求容器内 HTTP Server **120 秒内**启动完成，超时直接 `FunctionNotStarted`。45–50GB 模型从存储加载要约 77–85s（NAS 性能型 600MB/s），因此**必须"先起 WebServer，再把模型加载放进 `/initialize` 生命周期回调"**（Initializer 上限 300s）。
4. **浅休眠确实保留显存现场**：官方定义为实例冻结、GPU 资源被冻结、唤醒"热启动效率通常大于 2 秒"，官方实测表 SD 类负载唤醒 2s、LLM 3s；技术博客说明实现方式是**把显存整块迁移到外部存储、唤醒时回迁**，因此模型逻辑上"仍然已加载"，不需要重新读盘。**前提是设置最小实例数 ≥ 1**（设置后系统自动启用浅休眠，无需额外开关）。
5. **"深休眠"在云函数（含 GPU 函数）不存在**：只有 FC Agent Sandbox（云沙箱）有 `pause()`/深休眠语义（且暂停恢复需白名单）。GPU 函数可选项只有：弹性实例（有冷启动）/ 常驻实例（无冷启动）/ 混合模式。
6. **冷启动是"分钟级"，不是秒级**：官方原话"GPU 业务平均冷启动效率为分钟级别，取决于模型大小与加载速度"。对本方案（45–50GB 模型）应预期 **1.5–3 分钟**首次响应。
7. **166 秒/镜相对 86400s 执行上限毫无压力，但不能用同步短连接裸调**：函数执行超时默认 60s、最长 86400s；同步调用**没有**单独的「15 分钟/600s」硬性缩短（官方未列出），但自定义镜像要求服务端 keep-alive/请求超时 ≥15 分钟，且网关/客户端可能提前断。**推荐异步调用 + 异步任务模式**（消息存活上限 604800s、重试 0–8 次、可查询/可终止）。
8. **长连接可用**：HTTP 触发器支持 WebSocket（WSS，监听 `0.0.0.0:9000`），ComfyUI 的 `/ws` 能跑；但连接一旦超过函数执行超时会被强制断开（客户端收 1006），需要 Ping/Pong 保活；计费按连接存续时长。
9. **卡数配额是硬墙**：账号地域级 GPU 物理卡默认 **30 卡**（官方 FAQ 与离线异步场景文档口径；配额中心另有分卡型默认值 10/3/0，需核实）。实例并发度=1 时，地域级同时只能跑 **30 个 GPU 容器**；166s/镜 × 串行意味着并行度上限=30 镜同时出片。
10. **成本关键杠杆是"5 分钟延时释放 + 浅休眠"**：2025-11-12 起全 GPU 卡型逐步开放实例延时释放（默认 5 分钟），请求结束后 5 分钟内再来的请求可复用实例（按活跃/浅休眠自动判定计费），显著降低冷启动频率。

---

## 二、约束表

### 2.1 计算与规格

| 限制项 | 值 | 对本方案的影响 | 来源 |
|---|---|---|---|
| 单实例最大卡数 | Tesla 4 卡；**Ampere / Ada / Hopper / Blackwell 8 卡**；Xpu.1 16 卡 | 模型需 ≥48GB 显存，选 hopper.1（96GB）单卡即可；多卡并行无官方 NCCL 说明 | [实例类型和规格](https://help.aliyun.com/zh/functioncompute/instance-types-and-specifications)（2026-09-21） |
| 可用卡型与显存 | tesla.1 16GB / ampere.1 24GB / ada.1 48GB / ada.2 24GB / ada.3 48GB / hopper.1 96GB / hopper.2 141GB / blackwell.1 32GB / xpu.1 96GB | **无 80GB 档**；48GB 档装 45–50GB 模型 + 124 帧激活大概率 OOM | 同上 |
| vCPU / 内存（单卡） | Hopper.1：4 核→16–32GB、8 核→32–64GB、16 核→64–96GB、24 核→96–120GB；内存调整步长 4–16GB | 建议 16 核 / 64–96GB：模型 45–50GB 走 safetensors mmap + PageCache 需要内存余量 | 同上 |
| 最大申请内存 | 32GB（CPU 与 GPU 同）——注意这是**函数配置项"内存"之外**的运行资源上限口径 | 与"内存可选 64–120GB"口径冲突，见「不确定项」 | [配额与使用限制](https://help.aliyun.com/zh/functioncompute/limits-of-usage)（2026-09-07） |
| 函数最长执行时长 | **86400s（24h）**，不支持调整 | 166s/镜 远低于上限；单请求可串行跑多镜（约 500 镜/24h） | 同上；[离线异步任务场景](https://help.aliyun.com/zh/functioncompute/offline-asynchronous-task-scenario)（2026-09-18） |
| 执行超时默认值 | **默认 60s**，最长 86400s | 默认值必须改，否则 166s 的镜子必失败 | [创建自定义镜像函数](https://help.aliyun.com/zh/functioncompute/create-a-custom-container-function-in-a-container-runtime) |
| Initializer 上限 | **300s** | 模型加载放这里，45–50GB 在 NAS 上 77–85s 可通过 | [配额与使用限制](https://help.aliyun.com/zh/functioncompute/limits-of-usage) |
| PreStop 上限 | 90s（支持调整） | 收尾/落盘（视频写 OSS）要在此窗口内完成 | 同上 |
| 进程与线程总数 | 1024 | ComfyUI + torch + 多 worker 线程需留意；不是主要瓶颈 | 同上 |
| 文件描述符 | 100000 | 无压力 | 同上 |
| 实例交付速度 | 300 个/分钟（支持调整） | 突发批量出片时扩容速度受限 | 同上 |
| 单实例并发度 | 1–200（不支持调整），**GPU 默认 1**，官方建议计算密集型保持 1 | 同一张卡多请求只会争抢同一份显存/算力；GPU 场景应保持 1 | [配置单实例并发度](https://help.aliyun.com/zh/functioncompute/configure-the-concurrency-of-a-single-instance)（2026-08-21）；[离线异步任务场景](https://help.aliyun.com/zh/functioncompute/offline-asynchronous-task-scenario) |
| 地域推理并发度 | = 地域 GPU 卡数上限 × 实例并发度（并发度 1 → 30，并发度 5 → 150） | 卡数配额是真实瓶颈，不是实例数 | [实例类型和规格](https://help.aliyun.com/zh/functioncompute/instance-types-and-specifications) |

### 2.2 镜像、磁盘、存储

| 限制项 | 值 | 对本方案的影响 | 来源 |
|---|---|---|---|
| 镜像大小（GPU） | **15GB**（未解压；ACR 个人版/企业版基础、标准、高级版同） | 45–50GB 模型**不能**进镜像，必须外置 | [自定义镜像（Custom Container）](https://help.aliyun.com/zh/functioncompute/custom-container)（2026-10-30）；[实例类型和规格](https://help.aliyun.com/zh/functioncompute/instance-types-and-specifications) |
| 镜像大小（另一口径） | 配额中心「GPU 镜像大小上限 30GB（压缩后）」；GPU FAQ「通常压缩前 <20GB 可正常部署」 | 三处口径不一致，规划按最保守 15GB | [配额与使用限制](https://help.aliyun.com/zh/functioncompute/limits-of-usage)；[GPU实例FAQ](https://help.aliyun.com/zh/functioncompute/faq-about-gpu-accelerated-instances-1)（2026-01-29） |
| 镜像架构 | **仅 linux/amd64** | Apple Silicon 上构建需 `--platform linux/amd64` | [自定义镜像（Custom Container）](https://help.aliyun.com/zh/functioncompute/custom-container) |
| 镜像仓库 | 仅 ACR 个人版/企业版（基础/标准/高级）；**不支持经济版**（无镜像加速）；企业版只能选非加速镜像；不支持跨账号公开镜像 | 需同地域 ACR，且开通镜像加速 | 同上；[创建自定义镜像函数](https://help.aliyun.com/zh/functioncompute/create-a-custom-container-function-in-a-container-runtime) |
| 容器启动健康检查 | **120 秒内** HTTP Server 必须起来（`FunctionNotStarted: health check failed on port xxx in 120 seconds`） | **本方案第一大工程约束**：必须先起 Server，模型加载放 `/initialize` | [GPU实例FAQ](https://help.aliyun.com/zh/functioncompute/faq-about-gpu-accelerated-instances-1) |
| 监听端口 | `CAPort`，默认 9000，必须监听 `0.0.0.0:CAPort`（不能 127.0.0.1） | ComfyUI 需改监听地址/端口 | [自定义镜像（Custom Container）](https://help.aliyun.com/zh/functioncompute/custom-container) |
| HTTP Server 长连接要求 | keep-alive 开启，**服务端请求超时 ≥15 分钟** | 一次出片 166s + 排队，必须长连接或异步 | 同上 |
| 磁盘大小 | 512MB（默认）或 **10–200GB，步长 10GB**；10GB 免费额度 | 输出视频/中间帧可落盘；模型不要落盘（每次实例重建会丢） | [实例类型和规格](https://help.aliyun.com/zh/functioncompute/instance-types-and-specifications) |
| 临时磁盘空间上限 | GPU 实例 **60GB**（CPU 10GB），不支持调整 | 与"磁盘可配 200GB"口径冲突，见「不确定项」 | [配额与使用限制](https://help.aliyun.com/zh/functioncompute/limits-of-usage) |
| 磁盘生命周期 | 与实例同生命周期，实例回收即丢；**无跨调用持久性** | 输出必须写 OSS/NAS，不能只留在本地 | [函数存储选型](https://help.aliyun.com/zh/functioncompute/selection-of-function-storage)（2026-09-21） |
| NAS 挂载点 | 单函数最多 **5 个 NAS**（不支持调整）；仅 **NFS 协议**，不支持 SMB | 模型盘挂 1 个即可 | [配额与使用限制](https://help.aliyun.com/zh/functioncompute/limits-of-usage)；[配置NAS文件系统](https://help.aliyun.com/zh/functioncompute/configure-a-nas-file-system-for-fc)（2026-09-09） |
| OSS 挂载点 | 单函数最多 **5 个 OSS**；FUSE（ossfs）实现 | 适合放输出与冷模型；模型加载见 §3 | 同上 |
| NAS 远端目录规则 | 通用型 NAS 必须以 `/` 开头；**极速型 NAS 必须以 `/share` 开头** | 建挂载点时容易踩 | [配置NAS文件系统](https://help.aliyun.com/zh/functioncompute/configure-a-nas-file-system-for-fc) |
| NAS 挂载前提 | 必须打通 VPC；建 VPC 通道会额外增加**秒级**冷启动耗时 | 冷启动预算里要算这 1–3s | 同上；[GPU实例模型存储最佳实践](https://help.aliyun.com/zh/functioncompute/gpu-instance-model-storage-best-practices)（2026-09-21） |
| NAS 多实例共享 | 支持（多函数/多实例挂同一 NAS；用同一 UID/GID 保证权限一致） | 可做模型只读共享盘；官方未提供挂载级 `readOnly` 开关（NAS 侧用 UID/GID + 目录权限控制） | [配置NAS文件系统](https://help.aliyun.com/zh/functioncompute/configure-a-nas-file-system-for-fc) |
| NAS 类型支持 | **通用型 NAS（推荐"性能型"）/ 极速型 NAS**；CPFS **未在 FC 挂载文档中出现**（API 侧另有 PolarFS 挂载配置，未见于控制台挂载文档） | 选通用型性能型（初始读带宽 ≈600MB/s） | 同上；见「不确定项」 |

### 2.3 调用、排队、配额

| 限制项 | 值 | 对本方案的影响 | 来源 |
|---|---|---|---|
| 同步调用正文 | ≤32MB | 出片请求体很小，OK | [配额与使用限制](https://help.aliyun.com/zh/functioncompute/limits-of-usage) |
| 异步调用正文 | ≤128KB（可申请到 256KB） | prompt/参数足够；不要把 base64 图塞进异步 body | 同上 |
| 异步消息最大存活时长 | [1, **604800**] 秒，默认 86400 | 长任务排队的兜底窗口 | [异步调用](https://help.aliyun.com/zh/functioncompute/fc-asynchronous-invocation)（2026-09-18） |
| 异步重试次数 | [0, 8]，默认 3 | 失败重试会重复扣 GPU 时长，建议设 0–1 并靠自己的状态机 | 同上 |
| 并发超限行为 | 排队；返回 `ResourceExhausted` / `ResourceThrottled`；异步侧以二进制指数退避**最长重试 5 小时** | 出片高峰期会排队而不是失败，但排队不计费、可能拖很久 | 同上；[GPU实例FAQ](https://help.aliyun.com/zh/functioncompute/faq-about-gpu-accelerated-instances-1) |
| 异步任务状态查询 | 仅保留 **7 天** | 任务台账要自己落库 | [异步任务](https://help.aliyun.com/zh/functioncompute/asynchronous-task)（2026-08-04） |
| GPU 卡数配额 | 账号地域级 **30 卡**（FAQ/离线场景口径）；配额中心分卡型默认：Tesla 10 卡、Ada.1 3 卡、Ampere 3 卡、其他 0 卡 | 开箱即用可能只有 1–3 卡，**上量前必须提配额** | [GPU实例FAQ](https://help.aliyun.com/zh/functioncompute/faq-about-gpu-accelerated-instances-1)；[配额与使用限制](https://help.aliyun.com/zh/functioncompute/limits-of-usage) |
| 地域实例数上限 | 配额中心"实例数上限"默认 300；同步调用/并发度文档写"默认 100" | 口径不一致，见「不确定项」；对 GPU 而言卡数先到顶 | [配额与使用限制](https://help.aliyun.com/zh/functioncompute/limits-of-usage)；[同步调用](https://help.aliyun.com/zh/functioncompute/synchronous-invocations) |
| 带宽 | 1–5 Gbit/s（随规格，不支持调整） | 拉 50GB 模型的理论下限 ≈ 80s@5Gbps，与 NAS 600MB/s 同量级 | [配额与使用限制](https://help.aliyun.com/zh/functioncompute/limits-of-usage) |
| 出网 | 默认可访问公网；固定出口 IP 需 NAT 网关 + EIP；GPU 函数"既访问公网又访问 VPC"时，公网走函数网络、VPC 走非 100 网段，**不支持 PrivateZone 解析**（需工单） | 若要回源公司内网服务需注意 | [配置网络](https://help.aliyun.com/zh/functioncompute/configure-network-settings)（2026-10-15） |
| 触发器数 | 单函数 ≤50；单版本/别名下 HTTP 触发器**只能 1 个** | 一个函数一个 HTTP 入口 | [配额与使用限制](https://help.aliyun.com/zh/functioncompute/limits-of-usage)；[HTTP触发器概述](https://help.aliyun.com/zh/functioncompute/http-triggers-overview)（2026-09-21） |

### 2.4 运行时行为（休眠 / 常驻 / 长连接）

| 限制项 | 值 | 对本方案的影响 | 来源 |
|---|---|---|---|
| 浅休眠启用条件 | **最小实例数 ≥1 后系统自动启用**，无独立开关 | 想用浅休眠就必须付"常驻 min=1"的钱 | [基本概念](https://help.aliyun.com/zh/functioncompute/terms-of-fc)（2026-08-04） |
| 浅休眠语义 | 实例不被销毁，**GPU 资源被冻结**；"冻结的资源快速解冻，热启动效率通常大于 2 秒（因模型大小而异）" | 模型无需重载，但唤醒有 2s+ 成本 | 同上；[实时推理场景](https://help.aliyun.com/zh/functioncompute/real-time-inference-scenarios-1)（2026-04-17） |
| 浅休眠唤醒延迟（官方典型值） | OCR/NLP 0.5–1s；**Stable Diffusion 2s**；LLM 3s；技术博客实测 ComfyUI+Flux **≈500ms–2s** | 与本方案同类的扩散模型负载约 2s | [实时推理场景](https://help.aliyun.com/zh/functioncompute/real-time-inference-scenarios-1)；[给显卡按下"暂停键"（开发者社区，2026-01-27）](https://developer.aliyun.com/article/1708851) |
| 浅休眠是否保留显存 | 是。博客原文：休眠时"将 GPU 显存中的所有数据（含模型参数、中间状态）完整迁移至外部存储"，唤醒时"回迁并重建状态，避免重复的模型加载"；框架无感 | **模型算"已加载"**，不产生 45–50GB 重读盘 | [同上博客](https://developer.aliyun.com/article/1708851)（非产品文档，见「不确定项」） |
| 浅休眠附加约束 | 需**整卡**使用 GPU；**不支持登录实例**；推荐 CUDA ≤12.2、容器内 root 运行；建议关闭推理框架自带 Metrics Server | ComfyUI 的 Web 端口可正常服务，但不能 ssh 进去调试 | [实时推理场景](https://help.aliyun.com/zh/functioncompute/real-time-inference-scenarios-1) |
| 浅休眠计费 | vCPU 不收费；GPU 按浅休眠单价（**0.00004 元/CU**，活跃 GPU 阶梯 0 为 0.00011 元/CU） | 约为活跃的 1/3（官方另有"1/5""11.7%–23%"表述，见定价报告） | [浅休眠 GPU 计费项](https://help.aliyun.com/zh/functioncompute/the-idle-gpu-usage-billable-item-is-added-to-function-compute)（2025-12-08） |
| 深休眠 | **云函数无此能力**；仅 FC Agent Sandbox（云沙箱）支持 `pause()`→深休眠（免 vCPU/内存费、收磁盘费），且暂停恢复需白名单 | 不要指望"深休眠把 50GB 显存冻结到零成本" | [休眠与恢复（云沙箱文档）](https://help.aliyun.com/zh/functioncompute/hibernation-and-recovery) |
| 实例延时释放 | 2025-11-12 起全 GPU 卡型按地域逐步开放，**默认 5 分钟**，期间按活跃/浅休眠自动判定计费 | 5 分钟内的连续出片可复用实例，是省钱+免冷启动的关键 | [产品变更：GPU 实例延时释放全面开放](https://help.aliyun.com/zh/functioncompute/product-update-function-compute-now-fully-supports-the-delayed-release-feature-for-gpu-accelerated-instances)（2025-12-08） |
| 常驻实例 | 仅 GPU 函数；需先购专属资源池；**仅 Ada / Ada.2 / Ada.3 / Hopper / Xpu.1 可绑**；无冷启动；超出即流控 | 稳定量产（如每天固定出片量）应走常驻；Blackwell/Tesla 不能绑 | [实例类型和规格](https://help.aliyun.com/zh/functioncompute/instance-types-and-specifications) |
| 混合模式 | 仅 GPU；专属资源池承载稳态 + 弹性兜底突发（弹性部分仍有冷启动） | 适合"日间稳定出片 + 夜间批量" | 同上 |
| WebSocket | 支持，经 HTTP 触发器（WSS）；监听 `0.0.0.0:9000`；**连接时长超过函数执行超时会被强制关闭，客户端收 1006**；无流量时可能被 NAT 断开，需 Ping/Pong 保活；计费=连接存续时长（并发>1 不重复计费） | ComfyUI `/ws` 可用；长连接看进度需把执行超时设大 | [配置HTTP触发器并使用WebSocket触发](https://help.aliyun.com/zh/functioncompute/configure-an-http-trigger-for-a-function-that-is-triggered-by-websocket-requests-1)（2026-08-24） |
| 自定义容器 | **GPU 函数仅支持自定义镜像（Custom Container）交付**，且镜像内必须带 HTTP Server | 不能用内置 Python 运行时直接跑 | [离线异步任务场景](https://help.aliyun.com/zh/functioncompute/offline-asynchronous-task-scenario) |
| systemd / 多进程守护 | **未找到官方说明**。可确认的相关事实：容器默认 root 运行、进程线程上限 1024、必须由 CAPort 上的 HTTP Server 接管请求 | 不需要 systemd；用 entrypoint 直接拉起 uvicorn/ComfyUI 即可 | [自定义镜像（Custom Container）](https://help.aliyun.com/zh/functioncompute/custom-container) |
| Docker-in-Docker / 特权容器 | **未找到官方说明**（FC 文档无 privileged / 嵌套容器 / docker.sock 相关条目） | 视为不支持：不能在里面起 docker build | — |
| GPU 驱动 | 平台注入驱动 **580.95.05 / CUDA 用户态 13.0**；镜像内**不要**打包驱动或 `libcuda.so`；CUDA Toolkit 建议 ≥11.8 | ComfyUI 基础镜像按 CUDA 12.x 构建即可 | [GPU实例FAQ](https://help.aliyun.com/zh/functioncompute/faq-about-gpu-accelerated-instances-1) |

---

## 三、冷启动与模型加载

### 3.1 官方给出的冷启动定性结论

- 「CPU 业务平均冷启动效率为百毫秒级别……**GPU 业务平均冷启动效率为分钟级别**，取决于模型大小与加载速度。」——[配置最小实例数弹性策略](https://help.aliyun.com/zh/functioncompute/configure-launch-snapshot-and-auto-scaling-rules)（2026-10-13）
- 冷启动链路 = 代码/镜像下载 → 启动实例容器 → 运行时初始化 → 代码初始化（Initializer）；平台侧已做镜像缓存，用户侧靠"精简代码/选轻语言/加大内存/用 Initializer"优化——[函数计算冷启动优化最佳实践](https://help.aliyun.com/zh/functioncompute/best-practice-for-reducing-cold-start-latencies)。**该文没有 GPU 专项数字。**
- 自定义镜像函数用**函数状态**表示资源准备：`Pending`（镜像缓存中，调用会失败）→ `Active`（可调用）；长时间（数周）浅休眠后缓存会被回收进入 `Inactive`，调用失败，需重新部署/触发唤醒——[自定义镜像函数状态及调用](https://help.aliyun.com/zh/functioncompute/states-of-custom-container-functions)（2026-08-26）。
- 镜像加速：ACR 加速镜像 + 平台侧缓存；**镜像越大，加速转换越久，可能超时失败**，可在控制台"编辑并保存函数配置"重新触发转换——[GPU实例FAQ](https://help.aliyun.com/zh/functioncompute/faq-about-gpu-accelerated-instances-1)。端到端延迟波动大时，官方第一条排查项就是"确认镜像加速准备状态为可用"。

### 3.2 模型存储最佳实践（官方文档结论 + 数字）

文档：[GPU实例模型存储最佳实践](https://help.aliyun.com/zh/functioncompute/gpu-instance-model-storage-best-practices)（2026-09-21）

三条路线的官方取舍：

| 方式 | 官方结论 | 对本方案 |
|---|---|---|
| 打进镜像 | 只适合"模型尺寸相对较小，例如百兆字节左右"、变更不频繁；镜像越大，平台镜像加速预处理越久，且受镜像大小上限约束 | **不可用**（45–50GB ≫ 15GB） |
| NAS 挂载 | POSIX 兼容最好；容量 PiB 级；缺点：必须打通 VPC（建通道**秒级**冷启动开销）、不支持多 AZ、"大量容器同时启动加载模型容易触及 NAS 带宽瓶颈，导致启动耗时增加甚至超时失败" | **推荐**，但必须选**通用型 NAS 性能型** |
| OSS 挂载（ossfs） | 带宽上限高、不易争抢、可叠 OSS 加速器；配置简单（无需 VPC）；成本更优。缺点：用户态 FUSE 占实例 CPU/内存/临时盘；受 OSS API 吞吐与时延限制；**只适合少量大文件的顺序读**；随机读要把内容预热到 PageCache | 备选；适合"多地域/多实例并发拉模型"场景 |

**官方给出的关键吞吐数字**（测试环境：Ada 卡型 8 核 64GB；OSS 加速器 10T ⇒ 3000MB/s；NAS 通用性能型 ⇒ 600MB/s）：

- 通用性能型 NAS 初始读带宽 **约 600MB/s**；OSS 普通 Endpoint 读吞吐"**经常可达 600MB/s 或以上**"；OSS 加速器可到 **3000MB/s（10T 档）/ 24000MB/s（80T 档）**。
- 大文件（flux1-dev，22.2GB）在 4/8/16 并发下：OSS 加速器"吞吐能力更可达到预期值"；**普通 OSS 在高并发下加载时延更低但标准差更高**；**NAS 比普通 OSS 更可预期**（波动小）。
- 随机读：普通 OSS 对随机的敏感度明显高于 NAS；NAS 在随机读场景"表现得更可预期"。
- 官方最佳实践三句话：① 对文件系统 API 兼容性要求高、或随机读无法转成 PageCache 访问 → **通用性能型 NAS**；② **大并发同时启动** → **OSS + OSS 加速器（OSS ACCL）**；③ 多地域单元化部署 → OSS + OSS 加速器。

**官方"模型加载耗时优化"要点**：
- safetensors 用**按 offset 顺序读**的版本可大幅缩短从 OSS 挂载点加载的耗时（官方引 huggingface/safetensors PR #571）；
- 无法调整 IO 模式时，加载前先顺序读一遍把文件预热进 PageCache，应用后续从 PageCache 加载；
- 模型预热统一放 `/initialize`（见 3.3）。

### 3.3 本方案的加载路径与耗时推算（推算，非官方）

约束链：**120s 健康检查**是硬门（先起 WebServer）+ **Initializer 300s** 是模型加载预算。

| 存储 | 有效吞吐（官方/推算） | 45GB | 50GB | 是否压进 120s |
|---|---|---|---|---|
| 通用型 NAS 容量型 | 显著低于性能型（官方明确"不推荐容量型"） | 未找到官方数值 | — | 高风险 |
| 通用型 NAS **性能型** | 600MB/s（官方） | ≈77s | ≈85s | 加 WebServer 启动（约 10–30s，推算）后**刚好在 120s 边缘** |
| OSS 普通 Endpoint | ≥600MB/s（官方实测常值），高并发下方差大 | ≈77s | ≈85s | 同上，波动更大 |
| OSS + 加速器（10T，3000MB/s） | 3000MB/s（官方） | ≈15s | ≈17s | 轻松通过 |

**推荐落地形态**：
1. entrypoint 只拉起 ComfyUI 的 HTTP Server（秒级返回 `/health`），**不**在启动阶段加载权重；
2. 注册 `/initialize`（Initializer 回调），在其中按顺序读 safetensors 并 `load_state_dict`/`from_pretrained`，完成后才接流量（官方："仅当 `/initialize` 方法完成后，模型才会真正接入生产流量"）；
3. 模型盘 = 通用型 NAS 性能型（或 OSS+加速器）；`/tmp`/磁盘只放输出与临时帧；
4. 镜像 <15GB（ComfyUI 代码 + torch + 依赖，CUDA 12.x，不打包驱动）。

**冷启动总时长预期**（推算）：镜像拉取/缓存命中（秒级–十几秒，取决于加速准备） + VPC 通道建立（秒级） + WebServer 启动（10–30s） + 模型加载（15–85s 视存储） + 首次 CUDA/算子编译（数十秒，未找到官方数值） ⇒ **合计约 1.5–3 分钟**，与官方"分钟级"定性一致。走常驻实例或浅休眠可把这部分全部消掉。

---

## 四、不确定项

1. **浅休眠是否真的保留 45–50GB 显存现场、唤醒是否仍是 2s 级**：官方产品文档只说"冻结 GPU 资源/快速解冻/热启动通常 >2s"，**"显存数据迁移到外部存储再回迁"这一机制只出现在阿里云开发者社区博客**（[给显卡按下"暂停键"](https://developer.aliyun.com/article/1708851)，2026-01-27，署名为官方账号但非产品文档），且**没有给出 40GB+ 显存规模下的迁移耗时**。45–50GB 显存的冻结/回迁可能远慢于 2s，必须实测。
2. **GPU 显存迁移的存储开销与配额**：若显存真的外迁，是否占用磁盘/网络带宽、是否计入计费、单实例上限多少——均**未找到官方说明**。
3. **"深休眠"是否存在未公开的 GPU 版本**：云函数文档全量检索无"深休眠"字样（仅云沙箱有），但产品可能在灰度。需向 FC 侧确认。
4. **GPU 卡数配额到底是 30 还是 3/10**：[GPU FAQ](https://help.aliyun.com/zh/functioncompute/faq-about-gpu-accelerated-instances-1) 与[离线异步任务场景](https://help.aliyun.com/zh/functioncompute/offline-asynchronous-task-scenario) 都写"默认 30 卡"，而[配额与使用限制](https://help.aliyun.com/zh/functioncompute/limits-of-usage) 的分卡型表是 Tesla 10 / Ada.1 3 / Ampere 3 / 其他 0。两处口径冲突，**必须登录配额中心看实际值**（`quotas.console.aliyun.com/products/fc/quotas`）。
5. **镜像大小上限三处不一致**：15GB（实例规格 & Custom Container）、30GB（配额中心"GPU镜像大小上限"）、"压缩前 <20GB 通常可用"（GPU FAQ）。以实际推送为准。
6. **磁盘上限 60GB vs 200GB**：[配额与使用限制](https://help.aliyun.com/zh/functioncompute/limits-of-usage) 写"临时磁盘空间 GPU 60GB（不支持调整）"，[实例类型和规格](https://help.aliyun.com/zh/functioncompute/instance-types-and-specifications) 写"512MB 或 10–200GB 步长 10GB"。是"可配磁盘"与"临时盘"两个概念还是文档滞后，**未找到官方说明**。
7. **内存上限 32GB vs 64–120GB**：配额文档"函数最大申请内存 32GB"与 GPU 规格表"内存可选 64–120GB"冲突；本方案需要 ≥64GB 内存做 PageCache，需实测能否配置。
8. **同步调用是否有 <86400s 的隐含上限**：官方文档**没有**给出"同步 15 分钟 / 600s"之类的限制，只说超时由函数配置决定（默认 60s，最长 86400s）。但真实链路上还有 ALB/自定义域名/客户端 keep-alive 等环节，**实际可用的同步时长需压测**（166s 的镜大概率可行，但没有官方保证）。
9. **多卡并行（NCCL / GPUDirect / RDMA / NVLink 拓扑）**：实例规格表给出单实例最多 8 卡（Hopper/Ada/Ampere/Blackwell），但**全量 FC 文档无 NCCL、无卡间互联拓扑、无多卡训练相关说明**。多卡能否线性加速 ComfyUI/H3 推理未验证。
10. **NAS 类型支持边界**：FC 挂载文档只写通用型/极速型 NAS（NFS），**CPFS 未出现**；API 侧存在 `PolarFsMountConfig`（PolarFS 挂载）但控制台文档未覆盖。CPFS 是否能挂、吞吐如何，**未找到官方说明**。
11. **NAS 只读挂载**：控制台 NAS 配置项未见 `readOnly` 开关（OSS 有），只读只能靠 UID/GID + 目录权限实现；多实例共享只读的官方推荐做法**未找到官方说明**。
12. **浅休眠 + 常驻实例组合**：常驻实例本身无冷启动，是否还能叠加浅休眠冻结省 GPU 费——文档未明确（浅休眠计费项说明是"配置预留实例数策略时申请启用"）。
13. **ComfyUI 的 `/ws` 长连接与 166s/镜的实际体验**：WebSocket 支持已确认，但 ComfyUI 前端在浏览器断线重连、`/ws` 心跳与 FC 网关 NAT 超时的交互**无官方数据**。
14. **冷启动中的 CUDA 首次编译/算子 autotune 耗时**：官方无数字；对 H3 这类自定义算子可能有较大一次性开销。
15. **页面更新时间口径**：help.aliyun.com 文档页正文"更新时间"为空，本报告日期取自页面内嵌 `lastModifiedTime`（毫秒时间戳），与页面展示可能有出入。

---

## 附：调研方法与可复现路径

- 文档索引：`https://help.aliyun.com/zh/functioncompute/llms.txt`（官方 agent 友好索引，含全部 FC 文档标题与摘要，可直接定位 slug）。
- 单页正文（干净 markdown）：把文档 URL 的路径追加 `.md`，如 `https://help.aliyun.com/zh/functioncompute/custom-container.md`。
- 页面更新时间：页面内嵌 `window.__ICE_PAGE_PROPS__` → `docDetailData.storeData.data.lastModifiedTime`。
- 已排除的误导项：`https://help.aliyun.com/zh/functioncompute/hibernation-and-recovery`（休眠与恢复）属于**云沙箱 FC Agent Sandbox**，不适用于云函数 GPU 实例；`public-network-access`（公网访问）同属云沙箱文档。
