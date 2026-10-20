# T9、G3、G4 优化报告

基线：远端 `main` 的 `c93a58f`。本轮修改覆盖 PNG 序列导出、薄盒 GPU
邻居计算和 GPU 轨迹预取；保留 Worker、Wasm、GPU 预热和邻近帧预取。

## T9：PNG 编码与 CRC 移入 Worker

轨迹逐帧 ZIP 和电影 PNG 序列共用最多两帧的编码队列。页面传递
`ImageBitmap`，Worker 优先用 `bitmaprenderer.transferFromImageBitmap()`
直接接收位图，避免再绘制一次；不支持该上下文时使用 CPU 2D 暂存画布。
随后用 `OffscreenCanvas.convertToBlob()` 编码并计算
CRC，返回不可变 Blob。归档按照捕获顺序写入，结束时不再遍历全部 PNG。

Worker 不可用、创建失败、传输失败或编码失败时，使用保留的原始画布在
页面重试。取消、错误和源替换均清理队列、画布和 Worker；原有相机／帧恢复
规则和导出大小限制保留。

## G3：薄盒和高占用网格采用较小 GPU 批次

邻居索引记录实际最大网格占用量，以此缩小首次及后续派发批次。
完整邻居集合、周期图像搜索、规范排序和精度修正不变。PTM 邻居准备及
Voronoi 紧凑输出路径也遵守该限制。已测批量通过独立提示传递，避免 RDF
和键统计的外层循环反复按密度缩小批次。

单格占用最多 16,384、相对参考占用的密度倍数最多 256，保守估计的单原子
候选工作量最多 12,800,000；超过时使用原有 CPU 回退。内容相关拒绝绑定输入修订，不会阻止更新结构后重新尝试。

## G4：限定 GPU 预取窗口与 Worker 输入保留

预取最多五个邻近帧，包含当前帧，并受内存预算限制。GPU 内存预算依据
适配器缓冲区能力及可用的 `navigator.deviceMemory` 信息估计，仍检查
实际分配失败并保留 CPU 回退。

GPU 驻留与 Worker 原始输入分别确认。后台帧可保留 GPU 缓冲区，同时释放
不再需要的 CPU 坐标／类型及其他强引用；进入前台计算时按需重传精度修正
输入，复用已有 GPU 上传。当前输入、前台参考帧及已接收的排队任务输入
受到保护。切源、失效、取消和设备恢复保持一致。

## G3 正确性结果与范围

在 Chromium / SwiftShader 上使用实际 NiGB 文件复制 2×2×2，保留完整
1,039,232 个原子和全部邻居。初始搜索半径 3.784 Å 的最大网格占用为 30，
没有触发旧上限；扩大至 6.055 Å 后，占用为 80，超过旧上限 44。对归档基线
`c93a58f` 实际执行同一请求确认旧版本拒绝，新版本继续计算。

| 检查 | 范围与结果 |
| --- | --- |
| NiGB 自适应 CNA | 在原始及复制区域各检查 64 个中心原子，标签与 CPU 完全一致；这 128 个中心均使用了原有 CPU 精度修正 |
| NiGB 中心对称性 | 同样 128 个中心，14 个邻居；最大绝对误差 2.98×10⁻⁸，零修正 |
| 薄 FCC 的 RDF | 全部 1,728 原子；占用 48 超过旧上限 44，直方图及归一化值与 CPU 完全一致 |
| 开放真空层 Voronoi | 全部 2,048 邻居输入中的 16 个表面中心；拓扑一致，最大体积误差 4.16×10⁻⁵ Å³、表面积误差 4.84×10⁻⁶ Å²，零修正 |
| 极限网格 | 同一网格 16,384 原子的链表完整且按规范顺序排列；16,385 个时安全拒绝 |

百万原子验证显式给软件适配器设置 512 MiB 预算，以单独验证占用限制；
日常软件适配器仍使用至多 128 MiB，不会为通过测试而放宽默认内存限制。
本次消除了占用造成的拒绝，没有声称完整百万原子 CNA 能避开独立的精度修正
预算，也没有声称已经完成全部原子的 CNA／CSP／Voronoi 数值比较。
这些是执行与正确性验证；软件 GPU 的耗时不能证明实体 GPU 加速，显式
GPU Voronoi 在该适配器上仍很慢，默认 CPU 路由保留。

原始结果：[修改后](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/gpu-thin-cells-g3.json)、
[归档基线](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/gpu-thin-cells-g3-baseline.json)。

## G4 内存与读取量实测

使用 Chromium 154 / SwiftShader，在相同的显式 2 GiB 测试预算下，交替
运行基线与修改版各三次。轨迹为 160 帧，每帧 130,000 个原子，坐标为
Float64、类型为 Uint16。显式预算用于复现旧版填满整条轨迹的行为；两个
版本在这台软件适配器上的默认预算都是 128 MiB。

| 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 后台读取次数 | 159 | 4 |
| GPU 驻留帧数 | 160 | 5 |
| GPU 帧缓冲区 | 714.1 MiB | 22.3 MiB（−96.875%） |
| Worker 保留的输入数组 | 515.8 MiB | 3.22 MiB（−99.375%） |
| 完成这些预取的中位耗时 | 1,783.6 ms | 62.1 ms |

耗时不包含绘图、分析及正常的每次 40 ms 后台等待，收益来自减少预取工作，
不是 GPU 内核提速。输入数组统计不等于整个 Worker 堆。各次测试均检查
Worker 与预热管线被保留。真实浏览器还验证了进入预取帧时预先恢复 CPU
输入、不重复上传 GPU 坐标，窗口外参考位移与 CPU 逐值一致，取消过时
读取及清空源后保留设备／管线。

原始数据：[gpu-prefetch-g4.json](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/gpu-prefetch-g4.json)。

## T9 完整导出实测

使用同一 WebGL 渲染器、60,000 原子场景、1050×928 图片和 12 帧序列，
基线及最终方案交替各运行三次，使用 Chromium 154 / SwiftShader。计时
包含捕获图片、PNG 编码、CRC、ZIP 组装和每次导出的 Worker 启动；不含
加载轨迹及分析。

| 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 完整导出中位耗时 | 18,994 ms | 17,652 ms（−7.1%） |
| 每帧中位耗时 | 1,583 ms | 1,471 ms |
| 捕获图片的中位累计耗时 | 17,207 ms | 16,889 ms |
| 同时保留的待编码图片 | 1 | 最多 2 |

全部运行的整个 ZIP SHA-256 一致。捕获图像仍占主要时间，软件渲染存在
明显波动；这个结果没有复现历史实体显卡的 147 ms/帧，也没有证实旧待办中
70–80 ms/帧的估算。最大页面心跳间隔未改善，不能声称整个导出已消除
主线程长任务；本次移走的是 PNG 编码／CRC，WebGL 捕获仍在页面执行。

比较中，使用额外 2D 绘制中转的两个候选方案分别出现约 19% 和 9% 的
中位耗时增加，因此最终采用直接位图转移。原始样本保留，避免把降低
编码开销误报为所有环境中都能得到的总耗时改善：
[最终方案](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/png-worker-t9.json)、
[普通 2D 候选](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/png-worker-t9-original.json)、
[CPU 2D 候选](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/png-worker-t9-cpu2d.json)。

## 复现与集成验证

基线使用 `git archive c93a58f` 的独立目录；性能测试独占运行，没有同时
执行构建或其他测试。环境为 Linux x64、Node 24.19.0、Chromium 154，
WebGPU/WebGL 使用 SwiftShader。所有结果仅代表注明的执行范围。

```bash
npm test -- --test-concurrency=4
npm run build
node scripts/browser-png-worker.mjs --production
node scripts/browser-archive-logo.mjs
node scripts/browser-movies.mjs
node scripts/browser-gpu-thin-cells.mjs
node scripts/browser-gpu-prefetch.mjs
node scripts/benchmark-png-worker.mjs --baseline=/path/to/c93a58f --atoms=60000 --frames=12 --trials=3 --width=1050 --height=928
node scripts/benchmark-gpu-prefetch.mjs --baseline=/path/to/c93a58f --trials=3
```

专项测试覆盖不透明／透明 RGBA、文字、当前和自定义尺寸 WebGL 图片、
完整 ZIP 字节一致性、Worker 失败回退、最多两帧的有序队列、取消、
最后一帧编码中切源、资源释放，以及 GPU 的当前／参考输入、迟到消息、
设备丢失和预热保留。

最终全量单测 **2,322 项全部通过**，零失败、取消或跳过；生产构建及文档
链接检查通过。**14 套相关浏览器测试全部通过**：GPU 主套件、Voronoi、
确定性、设备恢复、输入修订、回退缓存、薄盒专项、预取专项、导出尺寸、
电影、轨迹 ZIP、生产 Worker 加载、生产 PNG Worker，以及 CPU 预热。
其中 GPU 主套件包含 261 项数值、12 项取消、8 项位移验证和 19 项应用检查。

浏览器首轮发现两处旧缓存协议假设：等待全部六帧驻留，以及要求后台子集
仍保留 CPU 输入。更新后的检查严格验证五帧窗口及其滑动、CPU 输入恢复时
不重复上传 GPU 缓冲、紧接着再次计算时两层输入均复用，原有数值对照保留；
两个完整套件随后复测通过。
