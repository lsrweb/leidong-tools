# Unitools 扩展功能演示

本文件演示 Unitools 扩展的各项功能使用方法。

## 1. 多行代码压缩功能演示

### HTML 内容压缩
选中以下多行 HTML 内容，右键选择 "Compress Multiple Lines"：

```html
<div class="container">
    <h1>
        标题内容
        多行显示
    </h1>
    <p>
        这是一个
        多行段落
        内容演示
    </p>
</div>
```

压缩后应该变成：
```html
<div class="container"><h1>标题内容 多行显示</h1><p>这是一个 多行段落 内容演示</p></div>
```

### JavaScript 代码压缩
选中以下多行 JavaScript 代码：

```javascript
function testFunction() {
    const variable1 = 'test';
    const variable2 = 'demo';
    
    if (variable1 === 'test') {
        console.log('Testing');
        return true;
    }
    
    return false;
}
```

### JSON 压缩
选中以下 JSON 内容：

```json
{
    "name": "test",
    "version": "1.0.0",
    "dependencies": {
        "vue": "^3.0.0"
    }
}
```

## 2. 注释压缩功能演示

### JavaScript 单行注释
选中以下多行单行注释：

```javascript
// 这是第一行注释
// 这是第二行注释  
// 这是第三行注释
```

压缩后变成：
```javascript
// 这是第一行注释 这是第二行注释 这是第三行注释
```

### JavaScript 多行注释
选中以下多行注释：

```javascript
/*
 * 这是一个多行注释
 * 包含多行内容
 * 需要压缩处理
 */
```

压缩后变成：
```javascript
/* 这是一个多行注释 包含多行内容 需要压缩处理 */
```

### HTML 注释
选中以下 HTML 注释：

```html
<!-- 
    这是 HTML 注释
    多行内容
    需要压缩
-->
```

压缩后变成：
```html
<!-- 这是 HTML 注释 多行内容 需要压缩 -->
```

### Python 风格注释
选中以下 Python 风格注释：

```python
# 这是 Python 注释第一行
# 这是 Python 注释第二行
# 这是 Python 注释第三行
```

压缩后变成：
```python
# 这是 Python 注释第一行 这是 Python 注释第二行 这是 Python 注释第三行
```

### SQL 风格注释
选中以下 SQL 注释：

```sql
-- 这是 SQL 注释第一行
-- 这是 SQL 注释第二行
-- 这是 SQL 注释第三行
```

压缩后变成：
```sql
-- 这是 SQL 注释第一行 这是 SQL 注释第二行 这是 SQL 注释第三行
```

## 3. JavaScript 自动补全功能演示

在 `.dev.js` 文件中，当你输入 `this.` 时会自动显示 Vue 组件的属性和方法：

```javascript
new Vue({
    data: {
        message: 'Hello',
        count: 0,
        selectedRobotIndex: 0,
        allGroupIds: [1, 2, 3]
    },
    methods: {
        increment() {
            this. // 这里会显示 message, count, selectedRobotIndex, allGroupIds, increment, setCurrentGroupList 等
        },
        setCurrentGroupList(item, index) {
            this.selectedRobotIndex = index; // 支持跳转到 data 中的 selectedRobotIndex
            // 复选框选中状态
            this.$nextTick(() => {
                if (this.$refs.groupTable) {
                    // 获取当前表格数据
                    const tableData = this.getCurrentRobotGroupList; // 支持跳转到计算属性
                    // 遍历当前表格数据，检查每一行是否在allGroupIds中
                    tableData.forEach(row => {
                        if (this.allGroupIds.includes(row.conversation_id)) { // 支持跳转到 data 中的 allGroupIds
                            // 如果在allGroupIds中，则设置为选中状态
                            this.$refs.groupTable.toggleRowSelection([{row, selected: true}], true);
                        }
                    });
                }
            });
        }
    },
    computed: {
        displayMessage() {
            return `Message: ${this.message}`;
        },
        getCurrentRobotGroupList() {
            // 计算属性示例
            return this.allGroupIds.filter(id => id > 0);
        }
    }
});
```

## 4. Vue 代码跳转功能演示

在 HTML 文件中：

```html
<!DOCTYPE html>
<html>
<head>
    <title>Vue Demo</title>
</head>
<body>
    <div id="app">
        <h1>{{ message }}</h1>  <!-- 光标放在 message 上按 F12 跳转到定义 -->
        <p>Count: {{ count }}</p>  <!-- 光标放在 count 上跳转 -->
        <p>Current List: {{ getCurrentRobotGroupList }}</p>  <!-- 支持跳转到计算属性 -->
        <button @click="increment">+</button>  <!-- 光标放在 increment 上跳转 -->
        <button @click="setCurrentGroupList(item, index)">设置组</button>  <!-- 支持跳转到复杂方法 -->
    </div>

    <script>
        new Vue({
            el: '#app',
            data: {
                message: 'Hello Vue!',  // message 的定义
                count: 0,               // count 的定义
                selectedRobotIndex: 0,  // selectedRobotIndex 的定义
                allGroupIds: [1, 2, 3]  // allGroupIds 的定义
            },
            methods: {
                increment() {          // increment 方法的定义
                    this.count++;
                },
                setCurrentGroupList(item, index) {    // setCurrentGroupList 方法的定义
                    this.selectedRobotIndex = index;
                    // 复杂的方法逻辑...
                }
            },
            computed: {
                getCurrentRobotGroupList() {          // 计算属性的定义
                    return this.allGroupIds.filter(id => id > 0);
                }
            }
        });
    </script>
</body>
</html>
```

## 5. 快速日志插入功能演示

### 使用快捷键
1. 选中变量 `myVariable` 或将光标置于变量名上
2. 按 `Ctrl+Alt+L` 插入 console.log
3. 按 `Ctrl+Alt+E` 插入 console.error

### 使用命令面板
1. `Ctrl+Shift+P` 打开命令面板
2. 输入 "Log Variable" 选择相应的日志类型

示例代码：
```javascript
const myVariable = 'test value';
const anotherVar = { name: 'demo', value: 123 };

// 选中 myVariable，按 Ctrl+Alt+L 会插入：
// console.log(`demo.js:3 myVariable:`, myVariable);

// 选中 anotherVar，使用命令插入 console.error：
// console.error(`demo.js:6 anotherVar:`, anotherVar);
```

## 使用技巧

1. **多行压缩**: 选中文本时，扩展会自动识别是否为注释内容并采用相应的压缩策略
2. **智能补全**: 在 JavaScript 文件中，输入 `this.` 或 `that.` 时会触发上下文相关的补全
3. **代码跳转**: 支持 `this.methodName`、`this.propertyName`、`this.computedProperty` 等格式的跳转
4. **复杂属性访问**: 支持 `this.getCurrentRobotGroupList`、`this.allGroupIds` 等复杂属性名的跳转
5. **快速日志**: 日志语句会自动包含文件名和行号，便于调试时定位

## 注意事项

- 确保 Vue 实例使用标准的 `new Vue({...})` 格式
- 支持 data 属性、methods 方法、computed 计算属性的跳转
- JavaScript 补全功能有 30 秒缓存，修改文件后稍等片刻即可获得最新补全
- 多行压缩功能会保持代码的语法正确性，但建议在压缩前备份重要代码
- 支持复杂的属性名，包括驼峰命名、下划线命名等各种格式
