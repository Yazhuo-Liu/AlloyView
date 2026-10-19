# AlloyView 全仓审阅记录（2026-10-16，America/New_York）

审阅基线：`77b24ad397781d6a80425b22a82d99baa40ade22`，审阅时已用 `git ls-remote` 确认与远端 `main` 一致。日期按 America/New_York 记录，对应 UTC 2026-10-17。审阅确认 11 项功能问题和 1 项测试问题；审阅过程未修改应用代码。本文及复现材料随后归档到该提交的修订版。审阅时应用源代码及 Worker/GPU 预热保持基线状态；前轮已修复的三项问题不重复计入。

更新（2026-10-19）：以下 12 项发现现已修复，详见[修复报告与回归验证](REPOSITORY_FIXES_2026-10-19.md)。本页保留原始触发条件、根因和审阅时结果，复现脚本亦作为历史证据保留。

优先级：P1 表示应优先修复的科学数据错误；P2 表示特定操作或输入会触发的功能错误。

## 1. **[P1] LAMMPS dump 坐标折回后，周期图像编号未同步，复制和平滑产生整盒误差。**

   位置：[lammps-dump.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/io/lammps-dump.js#L489)。在 10 Å 周期盒中，原子从 `x=9.9, ix=0` 到 `x=10.1, ix=0`；源位移为约 `+0.2 Å`，开启 `2×1×1` 物理复制后，两个副本的默认位移均变为约 `−9.8 Å`。原因是 parser 把 fractional 折回了盒内，却保留原始 imageFlags，破坏了后续处理中 wrapped/image/unwrapped 的一致性。两个相同的越界坐标帧做平滑也会跳一个盒长。

   这类输入合法：[LAMMPS 官方 dump 文档](https://docs.lammps.org/dump.html)说明周期边界只在重建邻居表的时间步执行，dump 坐标可能略在盒外；本轮取得了官方仓库文档源码并核实。修复应统一内部坐标和 imageFlags，不应要求用户修改合法输入。

## 2. **[P1] CFG 边界容差吸附与 imageFlags 使用不同的整数，造成整盒跳跃。**

   位置：[cfg.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/io/cfg.js#L248)。fractional `1.999999` 被容差逻辑吸附到 2 并折回 0，image 却仍取原值的 `floor=1`。10 Å 盒中的 unwrapped x 得到 10 Å，而应接近 20 Å。连续两帧 `1.9999→1.999999` 本应只移动约 `+0.001 Å`，实际得到约 `−9.999 Å`；物理复制后的位移也受影响。应让折回、图像编号和 unwrapped 坐标共享一致的容差处理。

## 3. **[P2] 标签形式的 LAMMPS Masses 行被当成 section，质量静默丢失。**

   位置：[lammps-data.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/io/lammps-data.js#L159)。定义 `Atom Type Labels` 中的 `1 Fe` 后，`Masses` 中合法的 `Fe 55.845` 被识别成节标题，原子质量变成 `NaN`；改为 `1 55.845` 则正常。[官方 read_data 文档](https://docs.lammps.org/read_data.html)明确支持已定义的类型标签。应按已知 section 语法识别节标题，保留标签形式的数据行。

## 4. **[P2] 数字注释开头的合法 POSCAR 被误判为 XYZ，无法打开。**

   位置：[file-sequences.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/io/file-sequences.js#L40)。完整合法的 POSCAR 第一行若为 `123`，直接 POSCAR parser 可以读取，但自动检测优先返回 XYZ。通过真实 structure-worker 加载名为 `POSCAR` 的文件也报 `Frame 1 is truncated`。应结合完整头部布局判别格式。

## 5. **[P2] 替换外部 mass 属性后，Clusters 再次运行仍复用旧质心和回转半径。**

   位置：[cluster-tools.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/cluster-tools.js#L259)，关联 [app.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/app.js#L2449)。无原生 mass 的结构导入质量 CSV 并运行 Clusters，然后移除文件、导入不同质量的新 CSV，再运行 Clusters。缓存键只记录是否有质量列，不记录内容身份或修订；外部属性更新也未失效该缓存。实际只分析一次，第一团簇质心 x 仍为 3.5，正确值应为 1.142857；回转半径仍为 1.707825，正确应为 0.709508。仅移除质量列时，界面也继续展示旧的 mass-weighted 结果。复现使用实际外部属性 Worker handler、原样提取的应用刷新函数和现有控制器 fixture。应把质量修订纳入依赖，并刷新缓存和在途任务。

## 6. **[P2] 时间序列首次导入新属性后，仍跳过此前标记为缺失的帧。**

   位置：[time-series.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/time-series.js#L60)。先添加不存在的 `Mean.energy` 并执行 Read file values，再导入覆盖全轨迹的 energy CSV。首次创建对应 series 时没有清除 unavailable，后续读取被 `settled()` 全部跳过。实际可用均值 `[10,11,12]`，结果仍为 `[10,undefined,undefined]`，第二次读取的帧列表为空。需要使属性可用性/导入变更同步失效缺失缓存。

## 7. **[P2] 轨迹平均进行中修改选择组，最终发布旧组的统计结果。**

   位置：[binning-tools.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/binning-tools.js#L428)。`refresh()` 在 averaging 时直接返回，正在运行的任务继续使用旧 group。用两帧数据，把同一组从 1 个原子改为 4 个原子，任务结束后仍报告总计 2 个 atom-frame，而应为 8。选择面板已经显示新成员，结果和 CSV 却对应旧成员。应只在输入 key 未变时复用平均任务，成员变化时失效或重算。

## 8. **[P2] 可见球体与点击选中的原子不一致。**

   位置：[webgl-renderer.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/render/webgl-renderer.js#L1791)。拾取按球心深度排序，没有使用点击位置处的球面深度。两个不同半径的原子投影重叠时，大球表面遮住小球，但点击仍选择球心更靠前的小球。真实 UI 中将 Fe/Ni 半径设为 3/0.5 Å，画布中心是红色 Fe，点击后详情却为被遮挡的 Ni/ID 2。影响原子信息、测量与外观编辑。

## 9. **[P2] Bottom 预设第一次轻微拖动会翻转近 180°。**

   位置：[webgl-renderer.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/render/webgl-renderer.js#L1697)，关联 orbit pitch 限制位于同文件 1339 行。精确底视角使用全局 Y 为 upHint；拖动后 pitch 被夹离极点，upHint 突然改为全局 Z，屏幕方向反转。真实 UI 点击 Bottom 后横拖 4 CSS px，前后 right/up 点积分别约 `−0.999488/−0.999456`。应在预设与连续旋转之间保持相机基连续。

## 10. **[P2] 第二视图拾取显示副本建切面时，使用了主视图的拾取信息。**

    位置：[app.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/app.js#L515)，第二视图入口为 [atomeye-tools.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/atomeye-tools.js#L757)。回调只传原子索引，处理函数固定读取主 renderer.lastPick。真实 UI 中在 a 方向显示复制两次，在第二视图选原子 1 的副本 `(12,3,5)` 和原子 2 的本体 `(7,7,5)`，点击 Between 2 atoms，正确法向量应为 `(-0.780869,0.624695,0)`，实际为 `(0.780869,0.624695,0)`；切面位置也错误，导致裁剪方向和位置不符。第二视图自身记录的副本信息正确，应沿回调传入实际拾取来源和坐标。

## 11. **[P2] 非整帧时长的相机电影漏掉最终关键帧。**

   位置：[camera-path.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/src/camera-path.js#L245)。`round(duration*fps)+1` 与 `index/fps` 组合，不能总是采到终点。两个关键帧为 `0→1.1 秒`、yaw `0→1`，24 fps 导出 27 帧，但最后采样时间为 `1.083333 秒`、yaw `0.984848`，即使 includeEnd=true 也没有终点姿态。应保证 includeEnd 的最后一次采样为 duration。

## 12. **[P2，测试] 并发缓存测试依赖 Worker 调度顺序，会随机阻断测试/CI。**

    位置：[cpu-resident.test.js](https://github.com/Yazhuo-Liu/AlloyView/blob/77b24ad397781d6a80425b22a82d99baa40ade22/tests/cpu-resident.test.js#L105)。测试假设两帧并发分析后每个 Worker 都缓存了两帧，因此重复分析必须零上传；动态调度并不保证该分布。两个 Worker 合法缓存为 `[1,2]` 和 `[2]` 时，第二轮 Worker 首次接到帧 1，补传一次后断言失败。本轮定向测试实际出现 `1 !== 0`；仅延迟一个真实 Worker 的成功 ACK 100ms 可以稳定复现，所有 CNA/CSP 数值仍与串行 oracle 一致。应按实际驻留情况校验上传，不能为满足测试而强制增加所有 Worker 的预热上传。

审阅覆盖：所有自有主要模块，包括 `src/io`、`src/data`、CPU 分析与 native/Wasm 调用边界、GPU host/shader 与路由、Worker 池和缓存、渲染和拾取、相机与切片、主应用和工具控制器、配置与恢复、外部属性与表达式、时间序列、统计/图片/视频导出、脚本接口，以及构建、静态部署与 CI。采用模块划分审查、跨模块调用链核对和疑点复现，并非对第三方算法进行逐行数学证明。

本轮验证结果：

- 现有解析相关 38 项测试通过；新增的 4 项 IO 最小回归断言全部失败，印证现有覆盖缺口。
- 导出、脚本、属性和时间序列相关 123 项定向测试通过。
- CPU/native 科学与调度相关 153 项定向测试中，152 项通过，1 项为上述已诊断的缓存调度误报。
- 独立暴力枚举核对 160 个随机斜晶胞和混合周期条件：1920 次邻居/配位查询、1280 次最近参考位点查询一致。
- Chromium/SwiftShader 的 23 项 CPU/GPU 数值对照通过，预热精度自检 exactPairs=true。本轮未发现新的可证实 GPU 主流程缺陷。
- 浏览器实际鼠标操作确认拾取、Bottom 翻转和第二视图副本建切面问题；上下文恢复、第二视图共享与 8 组渲染对比检查通过。

限制：本轮未重跑完整测试套件；未覆盖实体 GPU 驱动、真实显存耗尽和所有超大体系；第三方 native 科学库重点检查集成边界。本报告仅包含已复现的问题，不能据此证明其他路径没有缺陷。

复现材料已归档到 `docs/review-reproductions/2026-10-16/`。这些是审阅基线的证据脚本，不纳入常规自动测试；部分脚本断言缺陷仍存在，IO 回归脚本则断言正确行为并在该基线产生 4 项失败。后续修复时应依据新的预期行为改写为回归测试。

- [四项 IO 回归断言](review-reproductions/2026-10-16/alloyview-review-io-regressions.mjs)、[CFG 下游影响](review-reproductions/2026-10-16/alloyview-review-cfg-consequences.mjs)。
- [选择组与平均任务](review-reproductions/2026-10-16/alloyview-review-binning.mjs)。
- [外部质量与 Clusters 缓存](review-reproductions/2026-10-16/alloy-cluster-external-mass.mjs)。
- [真实 UI 拾取和 Bottom 拖动](review-reproductions/2026-10-16/alloyview-review-ui-render.mjs)。
- [第二视图副本与切面](review-reproductions/2026-10-16/alloyview-review-second-slice.mjs)。
- [电影终点](review-reproductions/2026-10-16/alloyview-review-endpose.mjs)、[新属性与时间序列](review-reproductions/2026-10-16/alloyview-review-series-import.mjs)。
- [Worker 调度误报](review-reproductions/2026-10-16/alloy-residency-schedule.mjs)、[GPU 数值对照](review-reproductions/2026-10-16/alloyview-gpu-review-parity.mjs)。

从仓库根目录运行，例如：

```sh
node docs/review-reproductions/2026-10-16/alloyview-review-io-regressions.mjs
node docs/review-reproductions/2026-10-16/alloyview-review-endpose.mjs
node docs/review-reproductions/2026-10-16/alloyview-review-ui-render.mjs
```

Node 脚本使用仓库自身模块；浏览器脚本还需要 Chrome/Chromium 和 Node 22 以上版本，可通过 `CHROME_PATH` 指定浏览器。本次环境使用 Node 24 和 Chromium/SwiftShader。归档保留原始复现逻辑，仅调整模块路径以便在其他检出目录运行；Clusters 脚本包含审阅基线的 `refreshExternalProperties` 函数副本及显示依赖 stub，不能替代未来对实际页面的回归验证。
