# 旧版升级入口的导出目录

v2.0 以前的 `ops update` 会从目标提交导出 `scripts/deploy/upgrade.sh`、`scripts/lib`、`scripts/runtime` 和 `Dockerfile`。本目录保留该导出路径，使旧入口能够运行升级说明脚本。

该脚本提示在新目录全新部署后退出，保留原服务、代码和数据。切换步骤见[从更早的版本切换](../../docs/data-migrations.md#从更早的版本切换)。