# 全仓复审与修复报告（2026-10-19）

开始前已抓取远端 `main` 并确认工作区同步到
`812ea64014702baa133dd0e8180d68f4f6100ac5`。本轮按用户确认的范围：
**修复所有本轮可复现缺陷，并核对历史性能待办的现状**。
此前审阅的 11 项功能问题和 1 项测试问题已在
[上一份修复报告](REPOSITORY_FIXES_2026-10-19.md)结项，本报告记录继续复审的结果。

审阅覆盖解析和坐标投影、序列与复制、CPU/Worker 缓存、GPU 邻居索引和生命周期、
分析控制器、属性依赖、相机与拾取、图像导出、脚本、配置恢复、构建和部署约束。
对当前源码、历史待办、真实 Worker 和浏览器结果交叉验证；没有将未来优化或既定
输入限制冒充成功修复的缺陷。

## 修复内容

共修复 **18 项功能缺陷和 1 项浏览器测试缺陷**。表中小规模输入和测试文件均可用于
复现；新增回归在相应旧实现上观察到失败，在修复后通过。

| 编号 / 优先级 | 问题与复现 | 修复与长期回归 |
| --- | --- | --- |
| R01 / P2 | XYZ 整数辅助列使用 Float32，`16777217` 静默变成 `16777216`，文本和字节解析均受影响。 | 仅 `I` 列使用 Float64，保留安全整数精度；R/L 列类型不变。`io-integer-properties.test.js` 覆盖正负安全整数边界、真实 parser Worker、投影和物理复制。 |
| R02 / P2 | LAMMPS data 分子编号 `mol` 有同样的 Float32 舍入问题。 | `mol` 改为 Float64；其他实数辅助列不变。同一整数属性回归覆盖。 |
| R03 / P2 | LAMMPS data 的图像编号 `2147483648`，或 `2147483647` 加越界坐标折回次数，写入 Int32 后回绕，破坏周期图像一致性。 | 在读取和归一化相加时检查可表示范围，明确报错；不把错误编号继续用于复制/平滑。`lammps-data-poscar.test.js`。 |
| R04 / P3 | LAMMPS data 的 Velocities 重复同一 ID，覆盖已有速度并让遗漏原子保留 NaN。 | 拒绝重复速度 ID；`lammps-data-poscar.test.js`。 |
| R05 / P2 | CFG 序列只验证首帧显式 ID；后帧含 unwrapped 坐标时还绕过身份集合检查。后帧换成 ID 2，或移除 id 辅助列，仍错误接到 ID 1。 | 每帧都要求显式稳定 ID，先验证身份再采用文件 unwrapped 坐标；保留合法行重排与显式图像。`trajectory.test.js`。 |
| R06 / P2 | Binning 轨迹平均在外部列更改后复用旧结果，手动 Run 也仍显示旧均值；速度分量更改同样遗漏。已缓存表达式还可能混用新旧帧值。 | 相关列编辑立即取消旧平均并清空结果/导出；逐帧附加当前外部列版本；计算属性按依赖传递刷新。速度平均覆盖分量变更。按照已有公开契约，轨迹平均拒绝分析/表达式列，单帧可用。`binning-tools.test.js`、`analysis-dependencies.test.js` 和真实 UI `browser-binning-properties.mjs`。 |
| R07 / P2 | Grains 已完成后添加或替换 `atomicVolume`，CSV 仍使用旧的均匀体积估计。例如原两晶粒体积约 10724/9378，加单位原子体积后应为 956/836。 | 单独刷新派生体积和来源，保留 PTM、晶粒分割与 merge 模型缓存；删除列会回退或清除体积。`grain-tools.test.js` 覆盖不再次 Run 的 CSV。 |
| R08 / P2 | Binning Worker 只按 fractional 数组判断驻留身份。共用坐标但改变 cell 后密度仍为 `0.0104166`，正确应为 `0.0052083`；PBC 更改也失效。 | 缓存键纳入 cell 数值、PBC 和 geometryRevision；复用同一 Worker。`spatial-binning.test.js` 使用真实 Worker 验证。 |
| R09 / P2 | Selection expansion Worker 同样只识别 fractional 数组，cell/PBC 改变后继续使用旧邻居索引。 | 补齐相同几何依赖，不重建预热 Worker；`selection-expansion-client.test.js` 使用真实 Worker 覆盖 cell、PBC 和坐标修订。 |
| R10 / P2 | Surface 可见掩码仅以 32 位哈希判断相同；两组均为 `70f7f8bc` 的掩码分别选中 787/785 原子，却复用同一几何。 | 保存规范化掩码快照，哈希相同后仍精确比较；可见性变化取消在途计算并拒绝晚回包。`surface-tools.test.js` 覆盖完成缓存和在途结果。 |
| R11 / P2 | 应变参考帧的共享读取使用首个调用者的取消信号，一个消费者取消会让其他标签/导出消费者一并失败。 | 复用 `SharedFrameRequests`，消费者独立取消，最后一个离开才中止底层读取；`global-attributes.test.js`。 |
| R12 / P2 | 旧参考帧晚回包可覆盖新选参考，导致 `Strain.*` 暂时消失；reset/restore 后也可能写回旧缓存。 | set/restore/reset 清理旧请求，header 和完整帧两条路径均检查取消及当前 reference key；即使解析器忽略取消也不写回。`global-attributes.test.js`。 |
| R13 / P2 | 脚本 PNG 捕获第 1 帧后，异步捕获/编码期间导航到第 2 帧，文件错误命名为第 2 帧。 | 捕获前固定文件名，覆盖 `export png` 和 `image.png`。保留文档规定的 Stop 等当前命令结束语义；`script-host.test.js`。 |
| R14 / P2 | 六视图导出期间换源或编辑相机，仍完成旧截图并恢复旧相机；也可与帧 ZIP 同时运行。 | 共用导出生命周期、互斥执行、准备标签并停止播放；每个 await 后检查任务/源/帧，取消时保留新视图并释放画布。`atomeye-multiview.test.js`、真实浏览器导出回归。 |
| R15 / P2 | 帧 ZIP 在恢复原帧的 await 期间换源，finally 仍把新源相机覆盖为旧相机。 | 恢复相机前再次检查任务与源身份；`atomeye-routing-batch.test.js`。 |
| R16 / P2 | 相机进入大球或其中心面落到近裁剪面之前，真实像素显示后方蓝球，拾取仍选红球。 | 标准投影下按实际中心面裁剪和夹紧后的片元深度排序；保留 3 px 容差及任意投影兼容路径。`picking-surface-depth.test.js`、`browser-picking-clipping.mjs` 对照真实像素。 |
| R17 / P2，历史 B34 | GPU 原子通过 atomic insertion 加入邻居链表，链表顺序随调度改变。2048 原子 FCC 四次重建均为 12288 键，但相对首次的键索引分别有 1585/830/1975 个位置不同。 | GPU 按原子索引对每个 bin 的链表作降序归并排序，之后所有邻居消费者使用同一顺序；无需额外原子数组或 CPU 排序。`browser-gpu-determinism.mjs` 覆盖重建、独立设备、CPU 对照和排序边界。 |
| R18 / P2 | 即使复用同一个已排序邻居索引，GPU bond-statistics 的修正队列仍由不同原子并发 append；2048 FCC 的连续 8 次计算产生 8 份不同汇总，角度均值跨度约 `1.7e-12`。 | 回读后按中心原子作稳定线性分桶，保留单个原子 invocation 内的记录顺序，然后累加；8 次汇总完全相同。`gpu-bond-statistics.test.js` 验证不同交错排列；确定性浏览器回归同时验证汇总和 CPU 容差。 |
| T01 / P2 测试 | GPU 主浏览器测试只收集 analyzing 进度；页面的 requestAnimationFrame 合并可将末批 analyzing(20000) 合为 complete(20000)，正确结果仍偶发失败。 | 接受既有合并契约中的 analyzing/complete，仍要求中间批次 16384 与最终 20000；保留 runtime 逐批单测。`scripts/browser-gpu.mjs`。 |

## 数值、性能与预热

XYZ 整数列和 data 分子编号恢复应有精度，属于有意修正错误数值；图像范围和重复 ID
现在明确拒绝。GPU 邻居顺序由不稳定变为固定，历史不稳定结果的末位可能因此改变。
不承诺不同显卡/驱动、CPU/GPU、不同 CPU Worker 分区的浮点结果逐字节相同。

保留现有 Worker/Wasm/GPU 启动预热、上传、驻留缓存、后台预取、共享 CPU 配额、
GPU 设备恢复和 opt-in Voronoi 策略。新排序管线加入既有预热，排序只在邻居索引构建时
执行，后续计算复用索引。统计修正记录分桶只增加与当前批次和记录数成正比的临时空间，
不改变 GPU dispatch 或 CPU Worker 分区。Grains 只更新体积；无关普通属性导入保留 Binning 平均；
几何缓存修复只更新驻留数据，不通过销毁所有 Worker 避免问题。

最终生产回归中，SwiftShader 上新排序的暖启动中位耗时约 2.1–2.6 ms，对应完整索引初建约
5.1–14.2 ms，含测试调度和完成等待。这是小规模软件适配器测量，不能作为实体 GPU
或大体系速度承诺。排序正确性还覆盖 0–770 长度中的 17 种边界链表。

## 历史待办核对

下表描述当前实现。旧 TODO 中的机器耗时和提速预测仍是历史证据，不代表本轮重新测量。

| 待办 | 当前结论 |
| --- | --- |
| 旧审阅 12 项 | 已修复，继续由正常测试覆盖；旧缺陷复现脚本只作历史证据。 |
| B34 | 邻居 atomic insertion 顺序问题本轮修复，详见 R17 和验证记录；不扩展为跨硬件确定性承诺。 |
| Movie 换源后范围残留疑点 | 当前成功换源/关闭会 reset，生命周期测试覆盖，未保留为未修复缺陷。 |
| compound 复制 ID 的数字表达式 | 文档明确非数字 `ID` 返回 NaN；保留完整复本身份，不擅自映射成重复的源 ID。属于输入限制和未来功能决策。 |
| C10 CPU Voronoi | `collect()` 已用；逐原子初始平面、字符串 index label 及传输优化仍待做。 |
| T7 复制 ID | 轨迹处理器已有局部 intern；页面复制帧仍构造字符串 ID，缓存体积估算仍扫描 ID。 |
| T8 gzip | 仍先完整解压再索引，流式首帧发布尚未实现。 |
| T9 PNG Worker | 归档已增量计算 CRC/保存 Blob；PNG 仍用主线程 canvas.toBlob 调度，尚无 ImageBitmap/OffscreenCanvas 编码队列。 |
| T10 parser 摘要 | 渲染侧已有 bounds/radius 局部优化；解析器尚无统一 typeCounts/bounds 摘要。 |
| S6 standby structure Worker | 仍创建候选 Worker，提交时关闭旧 Worker；未来复用必须保留候选源事务和 CPU 配额。 |
| G3 薄盒 GPU | 密度/邻居占用保护仍可能触发 CPU 回退；属于性能路由优化，保留正确回退。 |
| G4 GPU 预取 | 仍按可用容量邻近优先预取；默认实体 GPU 预算 2 GiB，软件适配器 128 MiB。小窗口/硬件自适应预算未实现，预取保留。 |
| R1 MSAA capless bonds | 仍保留 MSAA/离屏的带盖圆柱，已有像素反例，不能为提速删去保护。 |
| R7 conservative depth | 编译探测及回退已实现；仍需支持该 qualifier 的实体 GPU 验证图像和加速。 |
| R9 / R10 / R11 | AO 仍读回后由 CPU 计数；Voronoi 几何仍分块绘制；软件 GPU 专用非实例化球体路径未实现。 |
| K1 Grains | 并行准备和 merge 模型复用已完成；有序 graph/MST merge 仍待进一步优化。 |
| K3 / K4 | 局部剪切仍进行两次邻居搜索；DXA 仍有依赖访问顺序的串行 tracing/合并阶段。 |
| G5 / G6 | 双浮点保护与 GPU Voronoi 重设计仍待性能研究；不删除精度保护，也不在无更快硬件证据时重写。 |
| C11 | CPU 分区 Welford 矩仍随 Worker 分区产生末位差别；固定分块属于需明确数值策略的性能工作。 |
| S4 CDN | 仓库已生成 exact-hash 缓存规则；访问生产站点的 CONNECT 请求被执行代理以 403 拒绝，无法核实外部 Cloudflare 规则是否生效。本轮没有修改 CDN。 |

## 验证与边界

`npm test` **2258/2258 通过**，0 失败、0 跳过；生产构建通过。
生产版 GPU 确定性、完整页面冒烟、分箱属性、拾取、预热、设备恢复和配置恢复均通过。
定向浏览器与预热验证结果见本轮 [VALIDATION.md](VALIDATION.md) 记录。
新增可重复入口：

```sh
npm test
npm run build
npm run test:browser:binning-properties
npm run test:browser:picking-clipping
npm run test:browser:gpu-determinism
npm run test:gpu
```

浏览器计算/像素验证使用 Chromium/SwiftShader；没有用它冒充实体 GPU 的驱动兼容性、
早深度加速或大体系性能证明。现有预编译 Wasm 通过运行测试使用，本轮没有重新编译
全部 C++ 内核。本报告确认上述复现与修复，不能证明所有输入和设备上均无其他缺陷。
