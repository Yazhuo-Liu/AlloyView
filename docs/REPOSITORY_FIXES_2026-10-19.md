# 全仓审阅问题修复报告（2026-10-19）

开始修改前已抓取远端 `main`，并同步到 `718a4ca8325e13b717fbbd9845e4199007a5f8a5`。本次修复对应[原审阅报告](REPOSITORY_REVIEW_2026-10-16.md)中的全部 11 项功能问题和 1 项测试问题。

## 修复内容与验证依据

| 编号 | 问题 | 修复后行为 | 回归验证 |
| --- | --- | --- | --- |
| 1 / P1 | LAMMPS dump 折回坐标后图像编号未同步 | 将 imageFlags 统一到内部 wrapped 坐标；有显式 unwrapped 坐标时以其计算图像编号。物理复制后保留正确的约 +0.2 Å 位移，平滑不再跳一个盒长。 | `tests/io-coordinate-images.test.js`：文本、字节、坐标投影、不同坐标列组合、正负边界、三斜盒、混合周期、复制与平滑。 |
| 2 / P1 | CFG 容差吸附与图像编号不一致 | 折回和图像编号共用同一容差处理，保留已有边界吸附规则；约 +0.001 Å 移动不再变成 −9.999 Å。 | 同一坐标回归文件覆盖正负整数边界、非周期方向、连续帧和物理复制。 |
| 3 / P2 | LAMMPS 标签形式质量行被识别为标题 | `Fe 55.845` 正确作为质量数据；保留 CMAP、多词扩展节，以及 PairIJ 双标签行的兼容性。 | `tests/lammps-data-poscar.test.js`：数值/标签质量、无效质量拒绝、扩展节在 Masses/Atoms/Velocities 后的边界。 |
| 4 / P2 | 数字首行注释的 POSCAR 被误判为 XYZ | 检查完整 POSCAR 头部和坐标模式，再判定 XYZ；数字注释不再阻断打开文件。 | `tests/file-sequences.test.js`、`tests/lammps-data-poscar.test.js`：VASP 4/5、Selective dynamics、数字 XYZ 物种等边界。 |
| 5 / P2 | Clusters 复用已失效的质量结果 | mass 新增、替换、移除或映射变化会使缓存及在途结果失效，并刷新当前结果；无关外部属性编辑继续复用缓存。 | `tests/cluster-tools.test.js`、`tests/external-property-controls.test.js`；真实 UI/Worker 验证替换后质心 x≈1.142857、Rg≈0.709508，且不重建预热 Workers。 |
| 6 / P2 | 时间序列保留旧的“属性缺失”记录 | 导入、重命名、替换、移除外部属性时清理受影响曲线的数值和缺失标记，并取消旧读取；保留其他曲线及显示设置。 | `tests/time-series.test.js`；真实 UI/Worker 覆盖四帧 CSV 的完整编辑流程、无关曲线保留及读取不切换显示帧。 |
| 7 / P2 | 分箱轨迹平均发布旧选择组结果 | 选择组变化会取消并重算平均；相同输入继续复用当前任务。删除选择组会停止任务并清理旧结果，迟到回包不再发布。 | `tests/binning-tools.test.js`：两帧从 1 原子改为 4 原子后统计为 8 个 atom-frame；覆盖任务复用、删除及迟到结果。 |
| 8 / P2 | 重叠原子的点击选择与可见表面不符 | 按点击位置处的球面深度排序，与实际球体绘制一致；保留微小原子的点击容差和切片处理。 | 球面深度独立 oracle、随机拾取与相机测试；真实 UI 正交/透视下均点击到遮挡前方的大球。 |
| 9 / P2 | Bottom 视角首次拖动翻转 | 从当前相机基推导极点旋转起点，保持屏幕朝向连续；零位移操作保持原相机。 | `tests/camera-precision.test.js`；真实 UI 横拖 4 px 后 right/up 点积均大于 0.999。 |
| 10 / P2 | 第二视图建切面丢失副本坐标 | 点击回调传递实际视图的拾取记录，切面使用该副本的真实世界坐标。 | `tests/camera-interactions.test.js`；真实 UI 选择 `(12,3,5)` 和 `(7,7,5)`，验证切面法向量约 `(-0.780869,0.624695,0)` 及切面位置。 |
| 11 / P2 | 非整帧电影漏掉最终关键帧 | 当包含终点时，最后一次采样固定为精确结束时间，保持既有帧数、帧率和限额规则。 | `tests/camera-path.test.js`：1.1 秒 / 24 fps、向上/向下取整、极短时长、浮点边界、关联轨迹终帧和帧数上限。 |
| 12 / P2 测试 | 并发驻留缓存测试依赖调度顺序 | 按真实 Worker 的帧驻留状态验证是否需要首次上传及是否正确复用；保留科学结果和索引复用断言。 | `tests/cpu-resident.test.js`：控制真实 Worker ACK 时序，稳定覆盖不同驻留分布；相关 3 项测试重复 20 次，60/60 通过。 |

## 性能与预热

Worker/GPU 预热入口、后台调度、计算内核及设备生命周期实现均保留。没有为使并发测试通过而向每个 Worker 预先上传全部帧；首次分配到尚未驻留的帧时，允许并验证必要的单次上传。

Clusters 通过质量列版本和映射身份判断依赖，不在每次刷新时扫描质量数组；无关属性修改不触发重复分析。分箱平均输入不变时复用在途任务。外部属性刷新只清理受影响的时间序列，保留其他曲线。

## 完整验证

全部检查通过：

- `npm test`：2223/2223 通过，0 失败、0 跳过；最后的文档与 LAMMPS 扩展节定向复核另有 13/13 通过。
- `npm run build`：静态生产站点构建通过；修复报告注册到文档构建和索引，原审阅报告注明修复状态。
- 四个新增浏览器脚本均通过生产构建验证：Clusters 外部质量、时间序列外部属性、球面拾取/Bottom 旋转、第二视图副本切面。
- `browser-cpu-warmup.mjs`：生产页面在模拟 8/16 逻辑核下，从 3072 原子到 61440 原子的物理复制会在显示前启动预热；GPU 帧驻留正常，Worker 池和 Wasm 内核跨数据源重置保留，前台计算复用原 Workers。
- `browser-gpu-recovery.mjs`：真实 WebGPU `device.destroy()` 后重建设备并恢复正确结果；重复计算复用输入与邻居索引，`exactPairs=true`；可恢复验证错误不销毁正常设备。
- `browser-configuration-restore.mjs`：生产页面配置恢复、取消和失败恢复检查通过。
- `browser-binning.mjs`：生产页面隔离/非隔离模式均通过；密度、跨帧平均、二维分箱，以及 60229 原子示例的 UI/Worker/直接计算结果一致。
- `browser-movies.mjs`：生产页面 6 种容器/编码组合各成功编码并解码 21 帧，通过独立容器解析和 ffprobe 核验；帧归档、手机布局及慢帧预览竞争检查通过。
- 已有渲染热循环浏览器回归通过：1651 次拾取与参考结果一致，上下文恢复正常、GL 错误为 0。
- `git diff --check` 通过。

新增长期回归入口：

```sh
npm test
npm run build
node scripts/browser-cluster-properties.mjs --production
node scripts/browser-time-series-properties.mjs
node scripts/browser-picking-camera.mjs --production
node scripts/browser-second-view-slice.mjs --production
```

原报告的 `docs/review-reproductions/2026-10-16/` 保留为历史证据，部分脚本有意断言旧缺陷存在；修复后的预期行为由本次正常测试和浏览器回归脚本验证。

浏览器验证使用 Chromium/SwiftShader，不能代替所有实体 GPU 驱动和超大体系的性能验证。本报告确认以上 12 项问题的修复及已执行检查，不构成仓库所有路径均无缺陷的证明。
