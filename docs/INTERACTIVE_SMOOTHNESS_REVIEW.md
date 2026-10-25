# AlloyView 与 OVITO 的交互流畅度审阅

日期：2026-10-25（America/New_York）。AlloyView 基线：远端最新 `main`，`2b80367d60f9e9e8c54fbad2ee96ee9fc1d2bbb5`；生产构建 `9bb5615e43e49f39`。

本文记录实施前的基线审阅及复现，所列问题描述针对上述提交。后续完整实施和验证见 [流畅度改进报告](INTERACTIVE_SMOOTHNESS_IMPLEMENTATION.md)。机器可读基线记录见 [交互复现记录](benchmarks/interactive-smoothness-2026-10-25.json)。

## 结论

用户观察是准确的：OVITO 的结构识别 modifier 有明确的交互路径，可以把旧分类与颜色映射到新帧粒子上，先显示新位置，正式计算完成后再更新。它还支持暂留上一份完整 pipeline 输出。这些机制缩短的是“没有可用显示”的时间，并不代表后台计算已经完成。

AlloyView 已有结构优先显示、Worker/CPU/GPU 预热、共享解析、跳帧取消和 RAF 刷新合并。主要差距是缺少独立的临时外观状态：新结构出现后，计算字段缺失就回退元素色，分类过滤也暂时消失，随后多个分析分别触发全场景刷新。另有结果刷新打断相机拖动、播放时钟累加等待等可直接复现的问题。

优先建设独立的显示快照，保留颜色、显示过滤和图例；同时修复相机手势与播放调度。单纯增加 Worker 或加速某个内核，不能消除这些过渡问题。

## OVITO 的实际机制

本次读取官方公开仓库 `https://gitlab.com/stuko/ovito`，固定提交 `8c76f5262598135dfcbdf04778a2e7bf93dee4eb`（master，开发版本 3.17.1）。未运行 OVITO GUI，因此以下是源码对照，不能当成同机速度对比，也不能保证用户安装版本的每一项行为完全一致。官网在线文档被代理返回 403；下面的源码及仓库内手册已实际读取。

| 场景 | 源码确认的行为 | 对 AlloyView 的启示 |
| --- | --- | --- |
| 手动切帧，结构识别仍在计算 | 在当前上游粒子上采用旧 StructureType、Color 属性，保留新的 Position | 新位置可以配临时旧外观；无需先退回元素色 |
| 当前时间还没有完整输出 | 交互查询可以返回上一份 interactive state | 不能安全复用单项属性时，可暂留完整旧场景 |
| 粒子顺序变化 | 按粒子 ID 映射；新粒子用默认值；身份信息不兼容时拒绝复用 | 不能按数组下标直接复制 RGB 或 mask |
| 最终计算完成 | 更新最终视口，并抑制部分重复的末级 preliminary 通知 | 合并发布，避免同一结果多次重建外观 |
| 连续播放 | 暂停中间视口更新，显示最终 pipeline 输出；等待当前帧显示完成 | 手动预览和连续播放应采用不同提交策略 |
| 播放定时 | 从目标帧间隔中扣除本帧准备与渲染耗时 | 不能在计算结束后再完整等待一个帧间隔 |

关键证据：

- [StructureIdentificationModifier.cpp:94](https://gitlab.com/stuko/ovito/-/blob/8c76f5262598135dfcbdf04778a2e7bf93dee4eb/src/ovito/particles/modifier/analysis/StructureIdentificationModifier.cpp#L94)：交互查询复用旧结果；[245](https://gitlab.com/stuko/ovito/-/blob/8c76f5262598135dfcbdf04778a2e7bf93dee4eb/src/ovito/particles/modifier/analysis/StructureIdentificationModifier.cpp#L245) 具体采用分类与颜色，并保留当前粒子位置。
- [PropertyContainer.cpp:862](https://gitlab.com/stuko/ovito/-/blob/8c76f5262598135dfcbdf04778a2e7bf93dee4eb/src/ovito/stdobj/properties/PropertyContainer.cpp#L862)：属性复用的 ID 映射及拒绝条件。
- [PipelineCache.cpp:535](https://gitlab.com/stuko/ovito/-/blob/8c76f5262598135dfcbdf04778a2e7bf93dee4eb/src/ovito/core/dataset/pipeline/PipelineCache.cpp#L535)：交互查询允许返回时间范围之外的旧状态；[271](https://gitlab.com/stuko/ovito/-/blob/8c76f5262598135dfcbdf04778a2e7bf93dee4eb/src/ovito/core/dataset/pipeline/PipelineCache.cpp#L271) 区分正式缓存与临时状态。
- [Pipeline.cpp:216](https://gitlab.com/stuko/ovito/-/blob/8c76f5262598135dfcbdf04778a2e7bf93dee4eb/src/ovito/core/dataset/scene/Pipeline.cpp#L216)：避免 preliminary/final 双重刷新。
- [SceneAnimationPlayback.cpp:68](https://gitlab.com/stuko/ovito/-/blob/8c76f5262598135dfcbdf04778a2e7bf93dee4eb/src/ovito/core/dataset/scene/SceneAnimationPlayback.cpp#L68)：播放仅显示最终输出；[165](https://gitlab.com/stuko/ovito/-/blob/8c76f5262598135dfcbdf04778a2e7bf93dee4eb/src/ovito/core/dataset/scene/SceneAnimationPlayback.cpp#L165) 的定时器扣除本帧已用时间。
- [general_settings.rst:49](https://gitlab.com/stuko/ovito/-/blob/8c76f5262598135dfcbdf04778a2e7bf93dee4eb/doc/manual/reference/app_settings/general_settings.rst#L49)：pipeline 各阶段缓存、共享不变数据。不能将此解读为默认预先计算全部轨迹帧。

## 已复现的问题

### 1. 颜色和分类过滤一起闪回

`src/app.js:1998–2006` 为目标帧立即生成 palette 并调用 `renderer.setFrame()`；`2797–2809` 在所选计算字段或取向结果不存在时返回 `colorsByType()`。计算结束后 `3380–3384` 再发布属性、重建颜色。

更明显的问题是显示过滤：`src/ui/view/crystal-visibility-controls.js:80–87` 在当前帧没有分类属性时返回空 mask。原本隐藏的 FCC/BCC/HCP 会短暂重现；标量范围过滤也可能暂时失效。图例随默认 palette 改变。只保留 RGB 无法解决这种“整块材料闪出来”的现象。

生产版复现使用 3 帧、每帧 256 个 FCC Cu 原子。完成 CNA 并隐藏 FCC；控制下一帧 CNA 的完成时间，但之后仍运行真实计算：

- 旧帧显示原子数为 0。
- 新帧 CNA 未完成时，一次真实 render 显示 256 个原子，颜色也切成元素色。
- CNA 完成后，原子数回到 0，颜色回到分类色。
- 回到已计算且缓存仍在的旧帧，新增分析调用为 0，未出现上述默认色过渡。

改进：临时外观同时保留颜色、分类/标量显示过滤、图例和相关外观设置；按可靠原子 ID 映射。正式科学属性仍保持目标帧独立。

### 2. 结果刷新会打断用户正在进行的旋转

调用链：`src/app.js:2756 → 2784` 调用 `renderer.setVisibility()`；`src/render/webgl-renderer.js:740 → 1683` 调用 `cancelSelectionGesture()`；`src/render/camera-interactions.js:26–32` 的 `reset()` 清空鼠标拖动和触摸状态、释放 pointer capture。即使可见性内容没有改变也如此。

生产版页面中，按住鼠标移动后 yaw 为 −0.70；在按住期间释放 CNA 结果，再继续移动，yaw 仍为 −0.70。独立真实方法复现中，预期继续拖动应达到约 −0.78；原 mask 与新建等值 mask 均会中断。

改进：分离框选/晶体拖动的失效与普通相机手势；颜色或相同过滤刷新不重置 orbit/pan/pinch。源关闭、canvas 释放、真正需要结束的模式切换仍正确取消。

### 3. 无关结果完成也重建当前颜色与可见性

`src/app.js:3383` 不区分结果是否影响当前显示，统一申请 `applyColors()`；`2746–2767` 生成 palette、可见性、图例与多个面板刷新。`src/render/webgl-renderer.js:652–663,731–752` 无条件上传颜色/可见性。

生产版页面当前按 CNA 着色，单独释放固定 12 邻居 CSP 的计算结果后，记录到额外 2 次 `setColors()`，虽然 CNA 数据和所选着色量均未改变。这一数量是本次受控场景记录，不表示所有工具始终都是 2 次。

另外，`setVisibility()` 会无条件增加 `voronoiDisplayRevision`，使 `src/render/voronoi-cell-layer.js:740–751` 的复用条件失效，可能带来额外位置/mask 纹理准备。

改进：用明确的显示依赖与 revision 触发更新。未显示字段完成时只更新对应状态和统计；所选颜色、过滤、半径或叠加层的输入确实变化时才重建相应缓冲。

现有 `requestRender()` 已按 RAF 合并 draw；`display-refresh.js` 也有批处理，首帧 palette seed 还能避免立即重复上传。这里的问题是跨异步完成时刻的无关工作，不是每次 setter 都单独绘制。

### 4. 自动播放额外累加一秒等待

`src/app.js:2317` 等待 `showFrame()`，后者在 `1959–1963` 等待 `displayFrame()`；`2068` 又等待所有自动分析。结束后 `2320` 才开启下一次 1000 ms 定时器。因此显示间隔约为“准备/分析时间 + 1000 ms”。未显示的昂贵工具也会拖慢播放。

生产版受控测试额外扣住 CNA 600 ms，记录到该帧与下一帧结构提交间隔 1665.5 ms。此为调度政策验证，不能当作 CNA 耗时或硬件性能基准。

改进：拆分结构可用、当前外观可用、所有分析完成三个阶段。默认完整播放等待必要正式结果，但用绝对时钟或扣除已用时间来安排下一帧；可以另提供明确的快速预览模式。电影/数据导出继续等待正式结果，不能拿临时外观替代。

### 5. 单帧已知 Unwrap 仍会在计算结束后发生位置跳动

当前用户主动选 Unwrapped 后，`src/app.js:2406–2437` 在尚未物化数组时先显示 File fallback；`2068–2075` 等全部分析结束才准备 Unwrap。即使当前 CFG 已有 `ix/iy/iz`，也会受无关分析阻挡。

生产版两帧 CFG 复现：第二帧保存 x=2 Å、ix=1、盒长 10 Å。扣住 CNA 时，显示 x=2 Å，imageFlags 已在帧上，Unwrap 请求数为 0；释放 CNA 后，才发出 `infer:false` 请求，显示位置变成 x=12 Å。

改进：用户已明确选择 Unwrapped 时，当前帧自带的 image flags 或连续越界坐标应在首次结构提交前直接准备。缺少 image flags 的历史推断继续遵守独立开关；默认 File 模式继续无需 Unwrap 或历史扫描。

## 其他已确认的改进空间

| 项目 | 代码证据与当前行为 | 处理方向 |
| --- | --- | --- |
| 分析叠加层先消失再出现 | `webgl-renderer.js:535–565` 切帧时清除键、矢量、位错、表面、Voronoi；多个工具随后各自重建 | 按展示依赖整体提交。世界坐标网格/位错不能盲贴到新位置；必要时保留完整旧场景 |
| 一帧失败可能丢失用户着色意图 | `app.js:2694–2730` Failed 后移除待算选项，将 `state.colorMode` 改为 type；选择着色量只在非 automatic 分支执行（3254–3264），后续自动成功不会恢复用户选择 | 分离 requestedColorMode 与当前实际 fallback，下一帧可自动恢复 |
| 最新跳帧可能等过期同步解析 | `frame-parser-pool.js:143–160` 取消后等待 Worker ACK 才释放槽位；`workers/frame-parser.js:18` 中数值解析是同步函数 | 分块解析与合作式取消，保留预热 Worker；不能假释放 CPU 许可 |
| 预取尚未覆盖下一帧分析输出 | `app.js:2178,2293` 预读的是结构；CPU/GPU 准备的是模块/输入 | 当前帧稳定且资源空闲后，仅低优先级预测下一帧可见着色量所需计算 |
| DXA 回看仍重算 | `ui/analysis/dxa-tools.js:178–187,270–277` 只保留最新一份网络，还会移除旧属性 | 采用有真实字节预算的小型结果缓存；不能无限保留全部网络 |
| 普通部署取消 DXA 会损失部分预热 | `analysis/dxa-client.js:376–393` 非隔离环境运行同步串行内核时，需要终止 Worker | 改善隔离部署或内核取消粒度；不能直接去掉安全终止 |
| 缓存估算可能被大帧/变原子数轨迹打破 | `data/cache-policy.js:60–63` 至少三帧；`frame-cache.js` 按帧数逐出 | 真实字节 LRU，固定当前显示帧，分别限制结构、结果和显示快照 |
| 自动色标每帧变化 | `render/palette.js:247–289` 当前帧极值决定 RGB 范围 | 增加明确的当前帧/固定范围策略；全轨迹范围扫描必须显式执行，不能阻挡加载 |
| 短加载提示也会闪 | `app.js:1941,5011` 未缓存导航立即显示加载提示 | 约 100–150 ms 延迟显示，完成即隐藏，不增加导航等待 |
| 大帧主线程准备仍需测量 | palette/可见性扫描、半径扫描及缓冲转换/上传仍有 O(N) 工作 | 单独测量 input→首个可用绘制、主线程长任务、上传次数，不能只测 Worker 内核 |

同步解析取消已有确定性 fake Worker 复现：取消 frame 50 后，frame 150 等待旧帧 ACK 才在原 Worker 开始。保留旧许可至 ACK 是正确的 CPU 预算约束；改进应发生在任务可中断性。

上表其余项来自代码路径审阅，并未全部进行单独浏览器时间测量。自动色标变化是可解释的显示策略，不是计算错误。DXA 缓存和取消也是为内存与正确性作出的取舍。

## 建议的完整实现

### 第一阶段：消除可见闪烁与交互中断

1. 新增独立显示快照，记录结构帧号、外观来源帧号、source/processing/settings revision、原子身份、颜色、显示 mask、图例、半径和可复用叠加层。科学结果仍在各自真实帧上。
2. 手动切帧时保留旧场景直到目标结构到达；有可靠身份对应则显示新位置配上一次完成外观，并轻量提示“计算中”。结果就绪后，同一个 RAF 提交当前颜色、过滤和图例。
3. 相同 source、复制/平滑处理及着色/过滤参数才允许外观复用；有可靠唯一 ID 时按 ID 重排。新增原子用明确默认外观；无可靠对应或身份冲突时保留完整旧场景直到新快照就绪，不能仅因原子数相同就默认 CFG 行序稳定。
4. 无需等待相邻帧：任意跳帧可使用兼容的已完成外观。缓存命中目标帧正式结果时直接使用目标结果。
5. 计算失败保留用户请求的着色方式，显示失败状态；下一帧成功自动恢复，不永久降为 Atom type。
6. 修复显示更新重置相机手势的问题，并跳过无变化的可见性上传。
7. 已开启 Unwrap 时，单帧可精确得到的显示坐标进入首次提交；历史推断继续独立、默认关闭。
8. 加载指示延迟出现；快速成功的缓存/解析切帧不闪提示。

临时分类/过滤只能进入显示层。当前帧详情、统计、表达式、以可见原子为输入的表面/分箱等分析仍等待当前帧正式依赖。截图、电影与科学数据导出必须等待对应正式状态；中止、失败和超时要清楚返回，不能默默导出借来的旧结果。

### 第二阶段：减少等待和重复刷新

1. 将切帧接口的三个阶段显式暴露：geometryReady、appearanceReady、analysesReady。手动浏览不被无关分析阻挡；严格导出仍等待必要正式结果。
2. 播放采用可选目标帧率与正确时钟。完整模式每帧只发布正式快照，并扣除准备耗时；快速预览模式允许跟随目标时间、合并过期帧请求，不发布错误科学结果。昂贵计算超过帧预算时必须如实减速，不能承诺固定流畅帧率。
3. 保留现有 RAF 队列，对颜色、过滤、图例、半径、矢量和复杂几何分别追踪输入依赖；无关结果只刷新对应 UI。
4. 在当前可见分析结束、资源空闲后，按导航方向低优先级准备下一帧的必要分析。用户跳帧立即提升/取消相关任务。预计算键必须包括来源、处理版本、帧、参数、参考、选择组、外部属性及相关后端约定。
5. 为结构、科学结果与显示快照设独立的实际字节预算；显示帧固定，少量最近帧/DXA 结果可回访，不强制全部轨迹计算。

### 第三阶段：大结构与复杂叠加层

1. CFG/LAMMPS/XYZ 数值解析分块，定期让出 Worker 事件循环并检查取消。缓存命中快速路径保持简短，避免每小块固定定时开销。
2. 在绘制和数据准备中使用可复用缓冲、revision 和差量上传；先测量大结构长任务，再决定是否转移 palette/可见性准备到 Worker。
3. 对表面、DXA、Voronoi 等建立一致的场景提交策略。相容的逐原子矢量可按 ID 预览；旧世界坐标网格随旧场景保留，直到新几何可提交。
4. 检查隔离与普通部署两条取消路径。保留现有 Worker、CPU、GPU 预热；能合作式取消的任务复用 Worker，确实无法安全中断的同步内核保留正确回退。

现有 AO 控制器已有保留旧因子、150 ms 防抖、12 ms 增量预算和导出等待的实现（`render/ambient-occlusion.js:526,587–591,640–680`），可以借鉴调度方式，但新的外观快照还必须处理原子 ID 映射。

## 验证要求

实施时需验证以下条件，不能只比较总计算时间：

- CNA/PTM 分类色、IPF、标量色在等待期间没有元素色回闪；隐藏体相不短暂重现；图例不先换类型再换回。
- 正在旋转、平移、缩放的鼠标或触屏手势跨越分析完成仍连续。
- 乱序 ID、增删原子、源切换、物理复制、参数改变、随机远跳时预览映射正确；不可靠对应拒绝按索引复用。
- 旧请求、旧参数和旧源的延迟结果不能覆盖当前帧；单帧失败后用户着色选择可恢复。
- 已有 flags 的 Unwrap 不被其他分析延后；默认 File 和未授权历史推断仍没有扫描。
- 手动切帧与播放、导出采用各自明确的等待策略；电影和 CSV 不包含临时借用值。
- 不影响当前外观的计算完成时，颜色/可见性 GPU 上传次数为零；已缓存完整结果回访不重算。
- 记录 input→结构首个绘制、input→完整外观、p50/p95/p99 帧间隔、超过 50 ms 的主线程任务、GPU 上传字节、峰值内存、取消延迟、重复计算数和预热资源复用。
- 在 165 帧目录、变原子数、大原子数、双视图、GPU 开/关、普通/隔离部署和手机布局分别检查。软件 GPU 用于行为验证，实体 GPU 才用于硬件速度结论。

## 本轮验证记录

- `git fetch origin` 后 fast-forward 检查：本地与 `origin/main` 均为 `2b80367`，没有待同步提交。
- `npm run build` 成功，构建 `9bb5615e43e49f39`。
- 9 个相关测试文件共 66 项测试通过，零失败/跳过/取消：frame-navigation-controls、frame-parser-pool、shared-frame-requests、playback、frame-cache、display-refresh、crystal-visibility、dxa-tools、color-quantities。
- 生产版 Chromium：分类/过滤闪回、正在拖动时完成分析、无关 CSP 完成重复上传、缓存回访、600 ms 受控分析延迟下的播放调度均已复现；GL error 为 0。
- 生产版 Chromium：单帧已有 image flags 的 Unwrap 被 CNA 延后，显示 x=2 Å 后跳到 x=12 Å，调用 `infer:false`；GL error 为 0。
- 未进行 OVITO GUI 与 AlloyView 的同机帧率或实体 GPU 性能对比；本轮不报告“快多少倍”。

临时复现脚本和完整日志位于工作环境 `/tmp/alloyview-smoothness-review.mjs`、`/tmp/alloyview-unwrap-smoothness-review.mjs`、`/tmp/alloyview-camera-refresh-repro.mjs` 及同名前缀日志；关键输出已保存到上面的仓库 JSON 记录。构建和测试没有修复上述问题，实施后的验收应基于这些复现条件重新检查。
