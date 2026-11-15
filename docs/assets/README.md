# 截图维护

[返回项目首页](../../README.md) · [网页控制台](../console.md) · [开发指南](../development.md)

截图展示当前界面布局与操作位置，使用演示数据，不包含真实成员、群资料或凭据。日期、构建号和用量为示例值。导航分组或通用布局变化时，应重新生成全部截图。

| 图片 | 展示内容 | 更新时机 |
| --- | --- | --- |
| [console-overview.png](console-overview.png) | 总览：运行状态、事件 Stream、通讯录同步、部署与版本 | 总览布局或状态项变化 |
| [console-stats.png](console-stats.png) | 统计：筛选、指标卡片、对比、趋势、排行 | 统计页布局、指标名称或统计口径变化 |
| [console-stats-import.png](console-stats-import.png) | 统计导入：主机文件与本机上传入口 | 导入入口或表单变化 |
| [console-picker.png](console-picker.png) | 路径选择框：在主机上选取统计文件 | 选择框布局或位置列表变化 |
| [console-conversations.png](console-conversations.png) | 会话：成员列表、对话、工具调用与用量 | 会话页布局或消息展示方式变化 |
| [console-maintain.png](console-maintain.png) | 维护：恢复、启停、升级、重新部署、后台任务、备份清理、卸载 | 维护页的操作或任务展示变化 |
| [console-confirm.png](console-confirm.png) | 确认面板：步骤、计划内容与有效期 | 确认面板布局或步骤变化 |
| [console-upgrade.png](console-upgrade.png) | 检查更新：已部署版本与最新正式发布 | 版本检查界面变化 |
| [console-upgrade-confirm.png](console-upgrade-confirm.png) | 升级确认：目标版本与执行步骤 | 升级预览变化 |
| [console-relay.png](console-relay.png) | 外链：配置摘要、存储测试、文件与清理 | 外链页布局或操作变化 |
| [console-relay-edit.png](console-relay-edit.png) | 外链配置表单与 MB 上限 | 配置字段、单位或校验变化 |
| [console-relay-mobile.png](console-relay-mobile.png) | 外链页窄屏布局 | 响应式布局变化 |

## 重新生成

在项目目录运行（需要本机安装 Chrome 或 Edge）：

```sh
bun tests/helpers/console-screenshots.ts
```

脚本在 `tmp/` 下创建独立演示部署，写入统计和对话，启动机器人的只读接口与控制台，用无界面浏览器生成上表的 12 张截图，结束后清理临时目录。模型回复为预设内容，页面中的后台任务、升级计划、外链配置和目录选择均为演示数据；不调用真实模型，也不读取或修改项目的 `data/`。

可选参数：`--out <目录>` 改变输出位置，`--browser <路径>` 指定浏览器。不要手工修改截图中的界面文字或数值。
