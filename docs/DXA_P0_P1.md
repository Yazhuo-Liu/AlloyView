# DXA 内部诊断与全局验证（P0／P1）

日期：2026-10-21。基线：`d1bfe2f4f810c4c204bc0ddad417332fafbd7368`。

本轮落实[全局算法计划](DXA_GLOBAL_ALGORITHM_PLAN.md)的 P0／P1：细分诊断、
真实 PDEL 对照、完整科学状态读取及回归基础。Worker、Wasm、GPU 预热和
共享 CPU 配额继续保留。

本轮的目标是让后续算法改造有可靠的热点证据和科学验收门槛。全局插点、
精确谓词、随机扰动、追踪顺序和有序拓扑提交仍使用原来的算法。
P2–P6、周期表示 R1 和跨帧增量拓扑 R2 继续作为独立工作包。

## 1. P0：诊断覆盖与读数含义

`Module.onDxaProfile` 继续作为唯一的诊断开关。普通分析不设置此回调；
关闭时不读诊断时钟，不为 PDEL Worker 分配诊断对象，也不执行诊断专用的拓扑遍历。
热循环中仍存在关闭状态的条件分支，固定会话诊断存储也有所增加，因此不能
把“关闭诊断”解释为理论上的零开销；正式前后对照专门使用关闭状态。

| 范围 | 新增可观察内容 |
| --- | --- |
| Geogram 排序 | BRIO 初始化／随机化、Hilbert 排序及总排序时间 |
| BDEL／PDEL 构建 | 初始容量、bootstrap、插点、各 BRIO 层、串行补插尾部、压缩、有限／无限单元排序与邻接重编号 |
| 线程工作量 | 每线程插点尝试与成功、已有点、定位步数／失败、冲突腔访问、新建四面体、回滚、等待、池耗尽与容量增长 |
| 数值谓词 | 当前无权重路径的 orientation／in-sphere 调用和精确回退次数 |
| 追踪 | 主搜索、扩展、真实 junction 合并、secondary 创建、ring／merge／cleanup、逐深度工作量与拒绝原因 |
| 网格 | alpha／region 分类、面提交、半边连接，以及只读静态接口连通分布 |
| 晶体与映射 | cluster BFS／重定向、映射 context 建立、并行／延迟搜索、有序提交和 transition 查询／搜索 |

PDEL Worker 使用私有累加器，全部 Worker 结束后由协调线程汇总。固定存储为
2,048 个计时项和 4,096 个计数项；64 线程、100／100 搜索参数的保守静态上界
为 1,359／2,706 项。所有动态
诊断名称都具有模块级寿命；超出容量会显式设置 `overflow`，基准遇到该标记
会失败。逐线程计数覆盖 bootstrap、并行轮次和串行尾部；只有看到实际并行层
和非零 Worker 工作量，才能证明对应样本执行了并行插点。

`timingsMs` 中的嵌套 scope 互相包含，不能相加得到总耗时。`mesh.*.cpuMs`、
`mapping.contextConstructionCpuMs` 和 Geogram Worker 汇总都是线程经过时间的和，
包含调度或等待影响，不是 CPU 利用率。池指标是 slot 数／索引及容量，不能称为
实时峰值内存。基准的 heap 字段也是 Wasm 保留容量，不是 RSS 峰值。

公开进度名保持兼容：“Connect dislocation junctions” 调用的是
`finishDislocationSegments()`，真正的 `joinSegments()` 在追踪阶段中。
新的内部计时分别报告两者。静态接口连通分布也只描述现有网格，不能证明
P5 中的搜索、periodic circuit 或 cluster transition 可以彼此独立执行。

正常计算的取消边界没有改变。输入／阶段边界、已有可取消循环和科学读回遵守现有取消
协议；Geogram 的插点与串行尾部没有新增内部取消检查，仍可能等到下一个安全
边界才响应。测试验证取消后的同一 heap／线程池恢复，没有把“阶段入口取消”
冒充为“插点中途立即取消”。
诊断专用的静态连通遍历另外每 4,096 个顶点检查取消，避免诊断本身长时间阻塞。

失败计数按原条件链的第一个失败原因分类，不能与所有尝试原因重复累计。
`primaryStoppedSeeds` 包含遇到相交回路后停止的种子；真正创建线段的种子另用
`primarySeedsWithSegment` 统计。transition 诊断覆盖协调线程的真实查询，Worker
内部的只读直接扫描仍属于 mapping 阶段工作，不能把两者计数混为一谈。

## 2. P1：完整科学读回与比较

新增 `_alloy_dxa_science_snapshot(budgetBytes)` 和
`_alloy_dxa_release_science_snapshot()`。它们只用于 retained staged session：
在 `begin` 完成映射后或 `finish` 后、`dispose` 前调用。完整 `_analyze` 已释放
原生会话，不能再读取这份内部状态。

schema 1 包含全部原子的 cluster 归属、全部 cluster 的结构／成员数／方向／
symmetry／质心／parent transition，以及缓存中的全部有向 transition 和反向
矩阵、面积、距离。矩阵显式使用 row-major；原生 atom cluster 列按真实的
64 位整数类型读取。读取不会创建 transition，也不会修改科学图。

序列化先计数、后写入，只分配最终输出，预算包括 NUL 终止符。预算不足、
取消或分配错误只清理诊断输出，保留有效会话；下次读回、release、finish、
prepare 或 dispose 会使旧指针失效。该预算约束输出缓冲区，不能用作整个分析
的内存峰值上限。

旧版原始 Wasm 用于正式计时。它没有新增读回 API，因此完整内部科学对照另用
仅添加读回与 export 的旧版参考构建；该构建不进入性能数据。可复现的补丁见
[参考读回补丁](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-p0p1-baseline-readback.patch.gz)。
补丁应用到完整基线 SHA 后分别构建两种内核，不能拿本轮所有诊断修改替换旧版。

比较器首先检查数据完整性和有效性，再判断等价。它检查所有原子标签、
完整折线与周期绕行、Burgers 向量、完整互反结点图、cluster 成员集合与元数据、
全部 transition 和完整缺陷网格。严格哈希只排除 `parallelEdgePasses` 执行计数。
测试故意修改中间曲线点、结点连接、晶体矩阵、网格索引等，确保不能通过只看
总长度或线段数量来蒙混过关。

| 状态 | 含义 |
| --- | --- |
| `exact` | 完整规范化数据完全一致，且要求的覆盖项存在 |
| `equivalent` | 在预先声明的容差内，已证明只是编号、方向、允许的周期平移或折线采样表示差异 |
| `different` | 结构标签、归属、Burgers、连接等存在可确认差异，或输出无效 |
| `inconclusive` | 数据缺失、匹配预算耗尽，或真实折线／网格变化超出已实现证明能力 |

本轮正式矩阵预设所有容差为零。比较器不为通过测试而放宽阈值；任意不同的
PDEL 曲线、不同网格三角化、未建模的科学字段变化不会自动判为等价。闭环
起点规范化只适用于已证明独立的闭环。默认验收要求所有比较通过，遇到
`different` 或 `inconclusive` 以非零状态退出。

## 3. 几何、网络与外部参考

几何测试使用固定输入，覆盖全部 8 个 PBC mask、倾斜／混合 PBC、薄晶胞、
真空层、重复坐标和近共球点。binary64 坐标转成精确 dyadic 整数，以 BigInt
行列式验证方向、相邻单元的空球条件、共享面两侧关系及唯一互反邻接；无需
人为扩大接近零时的 epsilon。重复坐标沿用原先的合法行为；过薄配置沿用原先
拒绝条件，并验证拒绝后恢复。

现有 Worker snapshot 对无限单元不导出真实顶点，因此几何检查覆盖全部邻接图
及有限单元几何，明确返回 `infiniteFaceGeometry: 'not-exported'`。它不宣称证明
完整凸包面几何。固定 BDEL 单元和原有 K4 的完整边／网格顺序哈希继续使用。

外部 oracle 固定 OVITO 3.9.4，与 vendored 核心版本一致。导出所有线段、所有
折线点、原子标签、可获取的晶体信息、全部生成网格及半边拓扑；junction 来自
原生 CA ring，不能通过“端点坐标接近”猜测。JSON 中列出 CA 文本的十进制精度
和外部 API 不公开的内部字段，保留完整 CA 原文供追溯。

新增双螺位错和双交叉网络参考分别包含 9,216／25,600 个原子，得到 2 条周期线
以及 7 条线段、两个四臂结点。它们由解析 Volterra 位移构造，并已通过独立
OVITO 提取；这是未弛豫的弹性网络压力样本，不能称作平衡结点或真实 MD 轨迹。
真实 HEA、BCC Fe loop 和 NiGB 数据另进入完整基准，避免仅依赖合成样本。

另外新增 6,912 原子的解析 Shockley partial dipole：相反的 `a/6<112>` edge
partial 在一个 `(111)` 面上包围 intrinsic stacking-fault ribbon。旧版、
新版及独立 OVITO 都得到两条周期 partial；逐原子标签为 FCC 5,736、HCP 216、
其他 960，HCP 位于相邻两层，各 108 个。理想 Burgers 使用整数晶格单位验证，
只容许 `64 × Number.EPSILON` 的算术末位误差；完整曲线比较仍使用零容差。
真实 HEA 参考只有一条 perfect screw，不把它当作 partial 覆盖。

网络测试比较完整节点—边 incidence；新增“一个六节点环／两个三节点环”负例，
确保度数及 Burgers 直方图相同的不同网络不会通过。完整参考及输入／输出哈希
见 [OVITO 清单](https://github.com/Yazhuo-Liu/AlloyView/blob/main/tests/fixtures/dxa-ovito394-manifest.json)。
独立通过的范围是全部原子标签、理想晶格 Burgers、完整 incidence、结点守恒、
周期 winding 和层错带。严格完整比较的结果必须分别保留：

| 外部 OVITO／native 对照 | 零容差完整比较 | 已定位差异 |
| --- | --- | --- |
| Screw pair | `inconclusive` | 完整 core 折线不同 |
| 双交叉网络 | `different` | 空间 Burgers 有末位差，最大绝对差约 `8.88e-16` |
| Shockley partial | `different` | 空间／局部 Burgers 有末位差，分别约 `4.44e-16`／`1.11e-16` |

这些差值是定位记录，不能反过来用它们制定通过容差，也不能宣称完整曲线、
晶体图或网格已证明等价。外部全量数据保留供进一步研究。

短序列在同一内核执行 `1→4→1`，覆盖平移及跨周期边界、微扰、晶胞改变、
vacancy 和返回原帧；逐帧检查完整输入／科学结果哈希和固定 BDEL 拓扑。
vacancy 验证的是几何拓扑变化，不是位错产生／湮灭。Surface 使用倾斜周期角点
空洞和有限覆盖的辅助角点，检查旧版完整 buffer 哈希、PDEL 每个有向面／region
及闭合拓扑；浮点标量使用按运算量给出的归约误差界。

原有 HCP／diamond／hex-diamond 理想晶体、FCC/HCP twins 与完整 transition
测试继续保留，它们不等于这些材料的非零位错网络验证。真实弛豫多 junction
反应、跨帧位错反应、整个点集趋近共面的极限、无限单元凸包几何和真实
8／16 核扩展性仍需后续专门样本与环境。

## 4. 验证与实测

两套 Wasm 已用 Emscripten 3.1.69 重建。最终全仓 **2,380 项测试全部通过**，
无失败、跳过或取消，比基线增加 48 项。新增验证包括 23 项几何／网络／Surface、
18 项比较器破坏性用例、4 项科学读回、2 项外部导出测试，并扩充真实 PDEL
诊断测试。旧版 readback-only 参考的 4 项读回测试也通过。

测量环境为 AMD EPYC 9V74、实际 cgroup **4 核配额**、Node 24.19.0。
真实数据矩阵包含 90 次正式提取、30 次预热和 60 次独立完整审计。
下表为三次正式提取的中位数，单位 ms；正号表示本轮更慢。

| 内核 | 数据 | 线程 | 原始基线 | 本轮 | 变化 |
| --- | --- | --- | ---: | ---: | ---: |
| 普通 | HEA | 1 | 669.23 | 678.64 | +1.41% |
| 普通 | FE | 1 | 1632.89 | 1696.75 | +3.91% |
| 普通 | NIGB | 1 | 12345.57 | 12377.05 | +0.25% |
| 线程 | HEA | 1 | 626.02 | 629.79 | +0.60% |
| 线程 | HEA | 2 | 460.34 | 450.60 | -2.12% |
| 线程 | HEA | 4 | 377.45 | 356.31 | -5.60% |
| 线程 | HEA | 1（恢复） | 595.23 | 599.05 | +0.64% |
| 线程 | FE | 1 | 1650.64 | 1634.93 | -0.95% |
| 线程 | FE | 2 | 1145.84 | 1078.63 | -5.87% |
| 线程 | FE | 4 | 690.14 | 657.81 | -4.68% |
| 线程 | FE | 1（恢复） | 1635.06 | 1681.17 | +2.82% |
| 线程 | NIGB | 1 | 13098.48 | 12912.39 | -1.42% |
| 线程 | NIGB | 2 | 7998.81 | 7609.39 | -4.87% |
| 线程 | NIGB | 4 | 5374.07 | 5357.94 | -0.30% |
| 线程 | NIGB | 1（恢复） | 11671.23 | 11679.86 | +0.07% |

普通版中位数增加 0.25%–3.91%；线程版变化为 −5.87% 至 +2.82%。本轮没有
修改算法，这些小样本数据不能用来宣称算法提速，也不能证明诊断关闭时完全
无成本。原始范围和重复样本全部保留；后续优化需要在同一协议下重新对照。
真正四线程的本轮完整提取约为单线程首次测量的 1.77／2.49／2.41 倍速度，
这是已有 PDEL 路径的扩展性观察，不是本轮新增收益，也不外推到 8／16 核。

[真实数据原始记录](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-p0p1-global.json)
保留全部测量、同版本重复比较、完整科学档案路径及诊断。
真实数据矩阵的 420 次比较中，331 次 `exact`、89 次 `inconclusive`，没有
`different`。所有 1 线程比较均为 `exact`；不确定项来自真实 PDEL 的完整折线
或缺陷网格差异，包含原始旧版自身的重复变化。完整读回覆盖齐全，但严格
`allComparisonsPassed` 和 `fullScienceAuditPassed` 均为 `false`。矩阵完成不能
代替这两个验收字段。

[16 个生成样本的完整记录](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-p0p1-fixtures.json)
另执行线程序列 `1,4,1`、每节点一次正式测量和两次完整审计，包含 96 次正式
提取、96 次预热及 192 次审计。960 次比较中 882 次 `exact`、69 次
`inconclusive`、9 次 `different`；全部 640 次单线程比较均为 `exact`。
9 次严格不同都出现在 Shockley partial 的多线程 Burgers 匹配，包括旧版、
新版各自重复运行及审计对正式网络的比较；末位差没有自动放行。完整字段覆盖
为真，两个严格通过字段均为假。上述物理不变量测试通过与这里严格比较未通过
并不矛盾，它们的验收范围不同。

P0 数据已经能缩小下一步候选范围：

- 两次 HEA 四线程诊断均记录 1 次池耗尽和 2,770 个串行补插点；Fe 和 NiGB
  对应样本没有尾部或池耗尽。P3 的池策略候选应先针对 HEA 验证，不能泛化。
- 普通版 NiGB 主搜索有 69,396 个种子、约 258 万条记录及 1,561 万次边检查，
  最终没有成功种子；空输出不代表没有追踪成本。静态接口有 4 个连通分量，
  最大包含 3,928／11,566 个顶点，但这不是按工作量加权的独立性证明。
- 普通版 HEA／Fe 的 transition 查询全部是 self transition。NiGB 的约 184 万
  次查询中约 179 万次为 self，其余在 isolated-source 条件返回；这三份诊断没有
  进入真正的 depth-two 搜索。不能仅凭总查询耗时就优先重写图搜索。

细粒度计数会扰动诊断耗时。例如普通版 NiGB 的诊断主搜索约 5.5 秒，明显高于
关闭诊断的生产 tracing 阶段；这里使用它的工作量和失败原因选择问题，而不把
它当作未插桩的耗时。后续候选必须仍用关闭诊断的完整提取确认收益。

生产构建通过；Chromium 154／SwiftShader 上的八条浏览器命令依次通过：
`browser-dxa.mjs`（普通与 `--isolated`）、`browser-dxa-visual.mjs`、
`browser-surface-mesh.mjs`、`browser-bundled-runtime.mjs`、
`browser-dxa-parallel.mjs`、`browser-cpu-warmup.mjs`、`browser-smoke.mjs`。
覆盖真实分析、两种托管方式、Surface、并行池增长／启动失败／取消恢复、
已有预热与 CPU 配额，以及 204,800 原子的显示／拾取。
[浏览器执行记录](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-p0p1-browser.json)
保留命令与退出状态；软件渲染测试不证明实体 GPU 性能。

564 次基准运行对应 154 份去重科学档案，压缩合计约 3.88 MB；所有路径、
原始 JSON／gzip 哈希、大小及当前 JS／Wasm 产物哈希均再次核验通过。
vendored `SHA256SUMS` 和差异格式检查也通过。



测试外部导出器需要可执行的 `python3`，标准库即可；普通应用不需要 Python。
生成真实外部参考使用 Python 3.11.17、OVITO 3.9.4、NumPy 1.26.4 和
PySide6 6.6.3.1，依赖只安装在研究环境中。

### 复现协议

在完整基线源码中应用上面的 readback-only 补丁，执行 `npm run build:dxa`
及 `npm run build:dxa:threaded`。将该目录作为 `--baseline-science-dir`，然后
在本轮源码目录运行：

```bash
node scripts/benchmark-dxa-global.mjs \
  --baseline-ref d1bfe2f \
  --baseline-science-dir /tmp/alloyview-p0p1-baseline-readback/src/analysis \
  --dataset all --kernel both --threads 1,2,4,1 \
  --repetitions 3 --audit-repetitions 2 \
  --geometry-tolerance 0 --burgers-tolerance 0 --cluster-tolerance 0 \
  --require-equivalence no \
  --output docs/benchmarks/dxa-p0p1-global.json
```

这里显式使用 `--require-equivalence no` 是为记录既有 PDEL 差异；退出码 0
只说明矩阵跑完，不是严格科学验收通过。候选算法准入应保留默认的 `yes`，
未通过时退出码为 2。报告中的 `complete`、`fullScienceCoverageAvailable`、
`fullScienceAuditPassed` 和 `allComparisonsPassed` 分别描述完成、覆盖及通过状态。

每个样本／线程序列节点各预热旧、新模块一次，再交替执行三次正式测量。
计时范围是完整原生 `_analyze`，包括会话释放；不含模块启动、输入上传、JSON
解码、比较及归档。defect mesh 在正式计时关闭；全部正式计时结束后另用模块
进行开启网格和 P0 的 staged 完整审计，并与同版本正式网络比较。

所有运行保留完整 JSON 的 gzip 档案，只按原始 JSON 哈希去重。报告同时记录
每次运行的独立标签、JSON／gzip／科学哈希，完整输入参数及坐标哈希，旧新
JS／Wasm 哈希、工具链和 CPU 配额。`--dataset fixtures` 可运行生成样本；
`--snapshot yes` 额外保存各几何缓冲区的大小和哈希，这不能替代精确几何检查。
默认拒绝请求超过真实 CPU 配额的线程数。

## 5. 后续算法工作

本轮没有采用新的周期图像策略、改变插点顺序、提前填充 transition 缓存或并行
提交追踪结果。后续应按本轮工作量证据选择 P2/P3/P4/P5 候选，各自保留完整
旧版对照与严格验收。真实 PDEL 中尚未证明等价的差异需要继续研究，不能因为
旧版也有非确定性就把所有新差异放行。实体 GPU 性能也不在本轮 CPU/Wasm
诊断与软件浏览器验证的证明范围内。
