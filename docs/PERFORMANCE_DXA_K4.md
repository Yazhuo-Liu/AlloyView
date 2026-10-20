# K4：DXA 数据布局与有序网格查找改进

基线为远端 `main` 的 `ea9245d`。本轮沿用全局 DXA、完整周期邻居、
原有搜索和浮点运算顺序；Worker、Wasm、GPU 预热及 CPU 配额策略继续开启。

## 改动与验证原则

追踪工作区使用地址稳定的分页存储，跨起点复用搜索记录。每页 1,024 条记录，
两次搜索之间保留至多 1 MiB 对应的完整页；单次大搜索可以继续扩展，结束后
释放超额页。所有记录字段仍在入队前赋值，原来的 FIFO、前驱、搜索发现状态、
回路交点标记及节点清理顺序保留。

弹性映射在构建时使用整数边编号，随后转成连续邻接行和独立的向量载荷，
释放构建期端点及链表记录。邻接行保留原来的 leaving→arriving 顺序，
边保留首次发现的方向；查找只扫描邻居编号，命中后再读取向量。Worker
快照继续使用原来的边与晶体变换遍历顺序。

网格使用连续 ghost 面查找表替换树节点，以键和创建编号排序去重，保留原
映射表首次插入的语义。网格编号、回调、周期边错误和半边连接继续按原顺序
处理；已有的并行分类和边界掩码预处理保留。共享这个辅助类的普通 Surface
路径也覆盖完整输出字节比较。

这些结构调整不按空间切开位错网络，不跳过此前返回空网络的输入，也不改变
Geogram 的随机种子、几何谓词、插点或拓扑选择规则。

## 测量方法

新增的可选 `Module.onDxaProfile` 回调记录 Delaunay、边构建、分类、
网格准备及追踪工作区的细分诊断。正式计时关闭该回调；诊断使用另一次
完整提取，并核对同一个科学结果哈希。

基准对每个结构预热一次，保留两个版本的模块和堆，再交替运行。科学哈希
包含全部原子标签、晶体、位错线点、结点与 Burgers 向量，只排除已有的
并行工作量计数。内存报告分别标注数据结构容量和 Wasm 堆容量，两者均
不等于浏览器或 Worker 的进程峰值内存。

固定拓扑的四线程比较仍使用单线程 Delaunay，仅从边构建开始启用四线程。
该模式验证和测量下游重构，不代表完整四线程 PDEL 的端到端提速。

环境为 Node 24.19.0、Emscripten 3.1.69、AMD EPYC 9V74，容器配额为
4 个 CPU。每组保留三次交替样本，报告中位数；共享宿主机的其他负载仍可能
影响结果，几毫秒的单次差异不能单独证明收益。

## 候选筛选

首先独立构建 scratch＋紧凑边的候选，保留旧网格路径；
[原始结果](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-k4-core.json)
记录三组真实结构的三次交替提取和完整科学输出哈希。

初始完整候选 B 加入连续 ghost 面查找及面批处理。在四线程诊断中，
HEA 的 4,510 个面被分成 6 批、Fe 的 348 个面分成 12 批、NiGB 的
23,132 个面分成 47 批，所有批次都未达到 2,048 面。因此三者均没有实际
并行准备面载荷，却各分配了 393,312 字节计划容量和 721,424 字节载荷容量。
后续候选 C 先扫描已有掩码判断批次密度，稀疏网格沿用直接路径，消除了
这些可选分配。其批次上限为 32,768 个填充单元、4,099 个面；
不足 2,048 面的小批次直接计算。

但在 6,080 原子的密集 screw 对照中，C 实际并行准备了 2,812 个面，
七次交替提取仍没有收益：

| 与仅保留连续面查找的 A 比较 | A | C | 变化 |
| --- | ---: | ---: | ---: |
| 完整提取中位数 | 114.959 ms | 115.594 ms | +0.55% |
| 网格阶段中位数 | 11.671 ms | 12.846 ms | +10.1% |
| 额外计划与载荷容量 | 0 | 1,114,736 B | 增加 |

因此最终采用 **A：连续面查找，保留直接有序提交**。B／C 的面载荷批处理、
密度准入及其工作区均未进入最终源码和产物。单次诊断中的提交阶段变快，
不足以抵消正式计时中的准备与调度开销。
[A→C 原始记录](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-k4-face-preparation.json)、
[C 单线程](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-k4-candidate-c-one-thread.json)、
[C 四线程](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-k4-candidate-c-four-thread.json)
保留用于复核。

初始版本的原始测量保留用于说明选择过程，不冒充最终产物结果：
[单线程](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-k4-initial-one-thread.json)、
[四线程](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-k4-initial-four-thread.json)、
[细分诊断](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-k4-initial-diagnostics.json)。
HEA 普通内核的首次三样本整体耗时为 +2.09%，随后
[七样本复核](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-k4-initial-hea-confirmation.json)
为 −3.17%；两次网格阶段均改善，但整体结果说明不能承诺所有输入均提速。

## 最终版本测量

最终采用 A 的生产产物单独重建和测量。以下为完整原生提取中位数，单位为
毫秒；负值表示耗时下降，括号内为原子数。四线程仍按上述固定拓扑协议运行。

| 内核／下游线程数 | 结构（原子数） | `ea9245d` | 最终 A | 耗时变化 |
| --- | --- | ---: | ---: | ---: |
| 普通内核／1 线程 | HEA（28,800） | 729.55 | 616.86 | −15.45% |
| 普通内核／1 线程 | Fe（60,229） | 1749.86 | 1643.38 | −6.09% |
| 普通内核／1 线程 | NiGB（259,808） | 12444.99 | 11682.68 | −6.13% |
| 线程内核／1 线程 | HEA（28,800） | 639.88 | 594.78 | −7.05% |
| 线程内核／1 线程 | Fe（60,229） | 1709.55 | 1574.79 | −7.88% |
| 线程内核／1 线程 | NiGB（259,808） | 12391.69 | 11930.86 | −3.72% |
| 线程内核／4 线程 | HEA（28,800） | 499.69 | 489.06 | −2.13% |
| 线程内核／4 线程 | Fe（60,229） | 1379.22 | 1303.79 | −5.47% |
| 线程内核／4 线程 | NiGB（259,808） | 10014.60 | 9614.08 | −4.00% |

全部 54 次正式提取、18 次预热和 6 次另行诊断提取均通过完整科学输出哈希比较。
[单线程原始记录](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-k4-adopted-one-thread.json)
与[四线程原始记录](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-k4-adopted-four-thread.json)
保存每次样本、阶段时间、堆容量和最终产物 SHA-256。

主要收益来自接口网格阶段。普通内核三组样本的该阶段分别为
149.40→106.02、429.83→331.25、3524.83→2462.85 ms。
但并非每个阶段都更快：例如 Fe 普通内核的边构建由 128.05 增至
139.61 ms。未改算法的 Delaunay 阶段也有测量波动，例如普通内核 HEA
下降 12.22%，因此整体差值不能全部归因于重构。表中记录本轮真实样本的
观测结果，不承诺所有输入或硬件均有相同收益；尤其四线程 HEA 的 2.13%
差异仍接近共享环境的波动量级。

## 内存与适用范围

追踪工作区的保留上限不是单次搜索的硬限制，也不是常驻 Worker 缓存。
默认 14／9 搜索参数下，HEA、Fe、NiGB 的最大搜索记录数分别为
127、9、88，均小于一页的 1,024 条。因此，这些真实样本不能证明页分配次数
减少；多页复用和超额释放由原生压力测试验证。

Wasm32 下的紧凑边表仍需约每边 48 字节，加顶点偏移等结构；
收益主要来自查找时连续访问邻居编号。构建期链表与最终向量载荷错开存活，
但不承诺整个 Wasm 堆缩小。并行路径工作条目由指针改成两个整数，
262,144 边的临时映射批次约从 3 MiB 增至 4 MiB。报告分别保留构建期
结构容量、最终边表容量和 Wasm 堆容量，避免混用。最终版本不分配被拒绝
候选的面计划与载荷缓冲。

单线程测量中，两种内核均记录到 HEA 堆容量为 38.44→38.44 MiB，
Fe 为 79.81→83.00 MiB，NiGB 为 457.88→454.06 MiB。Fe 的容量增加，
因此本轮不能概括为“全程更省内存”；这也是保留完整容量记录的原因。
四线程下 HEA 为 46.13→46.13 MiB、Fe 为 95.81→83.00 MiB，NiGB
与单线程相同。堆按需增长且保留，增长档位也会影响这些容量。

最终边结构的容量由独立诊断记录；旧版数字来自只加入诊断的基线副本，
不参与正式计时：

| 结构 | 旧版保留边结构（B） | 最终保留边结构（B） | 最终 ghost 面查找容量（B） |
| --- | ---: | ---: | ---: |
| HEA | 10,454,016 | 9,898,564 | 131,072 |
| Fe | 20,929,064 | 20,718,780 | 8,192 |
| NiGB | 90,158,848 | 89,452,196 | 524,288 |

三组默认样本每次完整提取都各分配 6 页追踪记录，与旧版相同；峰值均为
122,880 B，没有触发超额页释放。这里的 6 页分布在不同搜索深度遍历中，
并不代表同时驻留 6 页。

## 正确性验证

新增 8 项冻结基线回归覆盖混合周期边界 screw、FCC/HCP twins、倾斜晶胞
角点空洞和足够大的 screw。比较内容包括四组 Worker 快照数组、全部科学
JSON、缺陷网格顶点与索引，以及共享 Surface 路径的完整输出与五组缓冲区。
大型用例检查并行分类与顺序拓扑构建，覆盖单线程→四线程→单线程及同一堆
复用；另有取消后恢复验证。被拒绝候选的并行准备计数保留在原始实验记录中。

最终生产产物通过全部 **2,332 项 Node 测试**，无失败、取消或跳过；
61 项 DXA／Surface 针对性测试也通过，生产构建成功。
额外的原生工作区测试在优化构建及
ASan／UBSan 下通过，覆盖 100 次复用、26 页增长、稳定地址、超额释放、
页分配失败和存储页所有权的向量分配失败。可选诊断的两项测试检查计数重置、
取消、移除回调和科学输出不变。

Chromium 154／SwiftShader 下的 **8 组浏览器检查全部通过**，无失败或重试：
普通与隔离 DXA、DXA 可视化、Surface、打包运行环境、DXA 并行与故障恢复、
CPU 预热、应用冒烟。它们覆盖真实 HEA／Fe 数据、共享几何、导出、
线程池扩展和复用、启动失败、取消后恢复及 204,800 原子 CFG 的显示与拾取。
CPU 预热检查分别模拟 8／16 核，确认保留 Worker 和内核；这不是实体 GPU
性能测量。

## 重现

先完成普通及线程版 Wasm 构建，再分别运行；计时期间不并行执行构建、测试
或其他基准：

```bash
npm run build:dxa
npm run build:dxa:threaded
npm run benchmark:dxa-k4 -- --baseline-ref ea9245d --kernel both --threads 1 --repetitions 3 --diagnostics no --output /tmp/dxa-k4-one-thread.json
npm run benchmark:dxa-k4 -- --baseline-ref ea9245d --kernel threaded --threads 4 --repetitions 3 --diagnostics yes --output /tmp/dxa-k4-four-thread.json
c++ -std=c++17 -O2 tests/native/dxa-tracing-scratch.cpp -o /tmp/dxa-tracing-scratch
/tmp/dxa-tracing-scratch
```

脚本默认从 Git 提取旧版产物，不需要切换当前工作区。
`--baseline-dir`／`--current-dir` 可指定候选产物；每份记录保存两个版本的
JS／Wasm SHA-256，指定目录时应以产物哈希确定版本，不能只看基线提交名。
`--circuit` 和 `--stretch` 支持其他搜索深度。

旧版没有细分诊断接口，独立诊断采用只加计时和计数的旧版副本。
[诊断补丁](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-k4-baseline-profile.patch.gz)
可解压后应用到 `git archive ea9245d` 的副本，校验 vendored manifest 后构建
普通 Wasm，再用 `--baseline-dir` 和 `--diagnostics-only yes` 比较。
该旧版补丁额外遍历追踪队列以统计页数，故诊断运行的耗时不用于性能结论。

面准备的独立对照使用候选 A 作为基线，即本次采用的最终算法。将本次提交
归档到独立目录，应用
[被拒绝的面准备补丁](https://github.com/Yazhuo-Liu/AlloyView/blob/main/docs/benchmarks/dxa-k4-rejected-face-preparation.patch.gz)
并重建线程版，即可用最终生产目录的 `src/analysis` 作为 `--baseline-dir`，
补丁目录的 `src/analysis` 作为 `--current-dir`，
配合 `--dataset screw --kernel threaded --threads 4 --repetitions 7` 重现。
这个 6,080 原子的未松弛弹性 screw 只用于验证实际并行面准备；
`--dataset all` 始终只运行 HEA、Fe 和复制后的 NiGB 三个真实文件。

## 尚未改变的算法

全局 Delaunay 仍使用原 Geogram 算法；新增诊断分别测量周期点准备、
构造器、`set_vertices`、ghost 分类和编号。Geogram 内部排序与插点尚未再
拆开计时。晶体遍历、Burgers 搜索、junction 合并和拓扑提交仍包含串行工作。
本轮完成上述数据结构与有序查找重构，进一步的全局算法改造仍列在
[K4 待办](TODO.md#k4-dxa-further-global-algorithm-work)。
