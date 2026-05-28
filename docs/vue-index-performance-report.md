# Vue 索引性能问题报告与整改方案

## 问题结论

当前扩展存在过度参与 VS Code 语言服务的问题：多个 provider 在补全、Hover、定义跳转、诊断、变量索引侧边栏等路径中会按需构建 `vue-index`。这会让“打开/切换/查看文件”“触发补全”“Hover”等普通操作变成 AST 解析与磁盘扫描入口，容易造成 VS Code JS/TS/CSS/HTML 语言服务卡顿。

另外，扩展通过 `configurationDefaults` 修改了全局 Emmet 行为，把 JavaScript/TypeScript 默认映射成 HTML，并开启 Tab 展开。这属于侵入式默认配置，可能影响用户原有 Emmet、JS/TS 补全体验。

## 高风险触发点

1. 变量索引侧边栏
   - 旧逻辑在 `onDidChangeActiveTextEditor` 和 webview 初始加载时刷新。
   - HTML 文件会同步读取外部 JS，并立即调用解析器。
   - 结果是“只是查看文件/打开侧栏”也可能构建索引。

2. Vue 索引按需构建
   - `getOrCreateVueIndexFromContent(...)` 被补全、Hover、定义、引用、CodeLens、诊断等多处调用。
   - 函数名是 `getOrCreate`，缓存未命中时会构建，导致 provider 请求变成构建请求。

3. 模板索引按需构建
   - `$refs` 补全通过 `getTemplateRefs` 可能触发模板索引构建。
   - 补全路径不应做重解析。

4. 补全触发字符过多
   - JS/TS 补全 provider 监听 `< : @ { ; # -` 等大量字符。
   - 即使有短路判断，仍会高频进入扩展代码路径，和 Emmet/原生补全竞争。

5. CSS/Emmet 介入过宽
   - 扩展通过 `onLanguage:css` 激活，并给 CSS 注册额外补全/颜色 provider。
   - 全局 Emmet 默认值会改变 JavaScript/TypeScript 的补全语义。

## 整改原则

索引构建只能由明确入口触发：

- 手动命令：`Leidong Tools: Build Vue Index for Current File`
- 变量索引侧边栏刷新按钮
- 可选保存构建：`leidong-tools.indexBuildMode = "onSave"`
- 可选定时构建：`leidong-tools.indexBuildMode = "interval"`

所有语言 provider 默认只读缓存，不再因为编辑、打开、切换、Hover、补全、诊断而构建索引。

## 已实施修改

1. `vue-index` 构建策略
   - `getOrCreateVueIndexFromContent` 默认只读缓存。
   - 未命中缓存时返回空索引，不构建。
   - 只有 `force=true` 的显式入口会构建。

2. HTML 外部 JS 索引
   - `resolveVueIndexForHtml(document, force)` 新增显式构建参数。
   - 外部 JS 缓存未命中时，非强制模式不读文件、不解析。

3. 变量索引侧边栏
   - 移除切换活动编辑器时自动刷新解析。
   - 初始打开只读取缓存。
   - 点击刷新按钮才手动构建当前文件索引。

4. 模板索引
   - `$refs` 补全只读取已存在模板索引。
   - 模板索引由手动构建/保存/定时入口生成。

5. 生命周期管理
   - 保存时默认只失效缓存。
   - 新增 `indexBuildMode`：
     - `manual`：默认，只手动构建。
     - `onSave`：保存后构建当前文件。
     - `interval`：定时构建可见且未修改的文件。

6. Emmet/CSS 干扰降低
   - 移除 `onLanguage:css` 激活。
   - 移除 CSS 上的 Von 补全注册。
   - 默认不注册自定义 CSS/HTML 颜色 provider。
   - 移除扩展贡献的 Emmet 全局默认值。
   - 缩减 JS/TS 补全触发字符，只保留必要的 `.` 和引号。

## 建议测试重点

1. 打开/切换 HTML、JS、CSS 文件时，控制台不应出现 `[vue-index][build]`。
2. 编辑 HTML/JS 时，不应出现索引构建。
3. 执行 `Build Vue Index for Current File` 后，定义跳转、Hover、变量索引应读取缓存工作。
4. 变量索引侧边栏初次打开不应解析；点击刷新才构建。
5. CSS 文件中原生 CSS 补全、颜色提示、Emmet 不应被本扩展抢占。
6. JS/TS 中 Emmet 行为应回到用户/VS Code 原始配置，不再由本扩展强制映射。

