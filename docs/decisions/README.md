# 设计决策记录

这里保存不容易从代码直接看出的长期决策。文件使用递增编号，例如 `001-d1-is-source-of-truth.md`。

每条记录建议包含：

```markdown
# 决策标题

## 状态
accepted / superseded / deprecated

## 背景

## 决定

## 影响

## 相关代码
```

不要把普通实现细节、临时 TODO 或聊天 transcript 写成决策。新决策推翻旧决策时，保留旧文件并标记 `superseded`，不要改写历史。
