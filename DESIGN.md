# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-08-31
- Primary product surfaces: 单页报销凭证上传、整理、预览、拼版、下载与打印工具
- Evidence reviewed: `https://bx.aiawen.cn/` 的可见页面结构、15 份重庆报销 PDF 的分类/尺寸/排版结果；工作区此前无既有 UI、组件或设计文档

## Brand
- Personality: 清晰、可靠、效率优先，像一张整理得很好的办公工作台
- Trust signals: 明确的页数/文件数、处理状态、模式名称、人工核对提示、空状态说明
- Avoid: 过度装饰、深色高对比大面积背景、含糊的操作文案、未经说明的自动识别结果

## Product goals
- Goals: 让用户快速上传凭证，调整顺序与版式，预览并导出适合报销流程的整理结果
- Non-goals: 本地版本不接入真实 OCR 服务、远程公司打印机或云端文件存储；编辑区 PDF 预览仅处理首页，最终导出会处理源文件全部页面
- Success signals: 上传后能看到可辨识的文件卡片；拖拽、选择、删除、切换版式、汇总编辑、裁剪和导出/打印路径均可完成

## Personas and jobs
- Primary personas: 需要整理差旅、日常采购或项目报销凭证的职员
- User jobs: 批量收集手机图片/PDF，快速排序，按 A5/A4/OA 格式生成可提交材料
- Key contexts of use: 桌面浏览器为主，也需要在窄屏下可操作

## Information architecture
- Primary navigation: 编辑工作台 → 合并结果；帮助、反馈、汇总和打印为模态层
- Core routes/screens: 单页编辑工作台、合并结果预览、帮助弹窗、汇总信息弹窗、反馈弹窗、打印选项弹窗、裁剪弹窗
- Content hierarchy: 页面标题/当前模式 → 文件与页面数量 → 上传与批量操作 → 排版选择 → 预览与下一步操作

## Design principles
- Principle 1: 先让状态可见：数量、选中、处理中、成功与空状态都要有明确反馈
- Principle 2: 一次只突出一个下一步：上传、整理、合并、下载分别保持清晰的主按钮层级
- Principle 3: 自动化必须可核对：OCR 与汇总提取都用“参考/待核对”语气，并保留编辑入口
- Tradeoffs: 优先还原工具的效率与功能密度；本地实现用轻量 `server.py` 处理 PDF 光栅化与最终拼版，不引入云端依赖

## Visual language
- Color: 温和的蓝紫主色（#5b6ee1）、青绿色成功色、暖橙提示色、浅灰蓝页面底色
- Typography: 系统中文无衬线字体，正文 13–14px，标题 16–20px；数字使用清晰的等宽感/半粗体
- Spacing/layout rhythm: 8px 基础间距；桌面采用 320px 控制栏 + 自适应预览区
- Shape/radius/elevation: 12–18px 圆角；轻边框与柔和阴影，上传区使用虚线边框突出拖放语义
- Motion: 上传、排序、处理状态使用短促淡入/位移动画；尊重 `prefers-reduced-motion`
- Imagery/iconography: 以 emoji/简洁线性符号作为工具图标；上传文件预览使用真实图片缩略图或 PDF 占位

## Components
- Existing components to reuse: 无；工作区为空
- New/changed components: AppHeader、UploadDropzone、ToggleRow、FileList、FileCard、LayoutTabs、PreviewBoard、PaperSheet、Modal、Toast
- Variants and states: empty、selected、dragging、processing、result、disabled、success、error
- Token/component ownership: `styles.css` 的 `:root` 变量拥有全局视觉 token；`app.js` 管理状态与组件渲染

## Accessibility
- Target standard: WCAG 2.1 AA 级基础实践
- Keyboard/focus behavior: 所有按钮、标签、文件选择入口和模态关闭入口可聚焦；模态打开时提供明确标题与关闭按钮
- Contrast/readability: 正文和按钮文字保持足够对比；状态不只依靠颜色传达
- Screen-reader semantics: 使用原生 button、label、input、dialog 语义与 aria-label/aria-live
- Reduced motion and sensory considerations: 通过 CSS 媒体查询关闭非必要过渡

## Responsive behavior
- Supported breakpoints/devices: 1280px 桌面为主，≤900px 平板，≤640px 手机
- Layout adaptations: 桌面双栏；平板控制栏缩窄；手机纵向堆叠，顶部操作允许换行，预览缩放到容器宽度
- Touch/hover differences: 卡片拖拽保留原生 drag 事件，同时提供上移/下移按钮作为触控与键盘兜底

## Interaction states
- Loading: 合并时显示处理中遮罩/进度条和明确等待文案
- Empty: 文件列表、预览区显示可操作的空状态与下一步提示
- Error: 不支持的文件类型、无文件导出用 toast 解释原因
- Success: 合并完成后进入结果预览，下载/打印动作给出 toast
- Disabled: 合并、批量删除和结果操作在没有文件或正在处理时禁用
- Offline/slow network, if applicable: 文件不上传到互联网；本地 `server.py` 用 `pdftoppm` 转换 PDF 首页，转换失败时回退浏览器内嵌预览

## Content voice
- Tone: 简短、具体、友好，接近办公软件
- Terminology: 统一使用“凭证”“文件”“页面”“排版”“汇总”“合并”
- Microcopy rules: 自动识别旁边始终提示“结果仅供参考，请人工核对”；按钮以动词开头或直接说明结果

## Implementation constraints
- Framework/styling system: 无框架依赖的 HTML/CSS/JavaScript 单页；使用 `server.py` 提供静态页面与本地 PDF 预览接口
- Design-token constraints: 颜色、阴影、圆角和间距集中在 `styles.css` 顶部变量
- Performance constraints: 不上传文件到网络；图片使用对象 URL；编辑区只生成首页 PNG，最终 PDF 按需生成；避免大体积第三方库
- Compatibility constraints: 现代桌面/移动浏览器；文件输入、拖放、打印和下载使用标准 Web API
- Test/screenshot expectations: 启动本地服务后验证空状态、上传、排序、删除、版式、汇总、合并结果与响应式布局

## Open questions
- [x] 真实 PDF 拼版与 OCR 服务的后端协议 / owner: 产品或后端 / impact: 本地版本已通过 `server.py` 提供 PDF 拼版，OCR 仍为前端模拟
- [ ] 公司打印机远程接口与鉴权字段 / owner: 企业 IT / impact: 当前仅保留本地打印入口与演示表单
