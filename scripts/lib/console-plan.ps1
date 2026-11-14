# Fresh console operations carry explicit choices; recovery uses the recorded transaction instead.
function Assert-ConsoleLifecycle([string]$Operation, [string]$ProjectRoot, [string]$Branch = 'main') {
    if ($env:MIXIN_OPS_CONSOLE -cne '1') { return }
    if ($env:MIXIN_OPS_LIFECYCLE -cne $Operation -or -not $env:MIXIN_OPS_TASK_ID) {
        throw '控制台部署缺少明确选择或任务记录；服务尚未停止'
    }
    if ($env:MIXIN_OPS_SWITCH_MAIN -cnotin @('0','1')) { throw '必须明确选择是否允许切换分支；服务尚未停止' }
    if ($Operation -ceq 'update' -and $Branch -cne 'main' -and $env:MIXIN_OPS_SWITCH_MAIN -cne '1') { throw '未允许切换到 main；服务尚未停止' }
    $saved = Test-Path -LiteralPath (Join-Path $ProjectRoot 'data/config/directory.json')
    switch -CaseSensitive ($env:MIXIN_OPS_DIRECTORY) {
        'saved' { if (-not $saved -or $env:BOT_DIRECTORY_SCOPE) { throw '已保存的通讯录范围与确认不符；服务尚未停止' } }
        'all' { if ($saved -or $env:BOT_DIRECTORY_SCOPE -cne 'all') { throw '首次通讯录范围与确认不符；服务尚未停止' } }
        'selected' { if ($saved -or $env:BOT_DIRECTORY_SCOPE -or -not $env:MIXIN_OPS_DIRECTORY_INPUT -or -not $env:MIXIN_OPS_DIRECTORY_APP) { throw '部门选择与确认不符；服务尚未停止' } }
        default { throw '必须明确选择通讯录范围；服务尚未停止' }
    }
    # 首次部署（install）的配置来自网页确认的草稿，由 console-stage.ts 暂存；重新部署和升级沿用已有配置。
    if ($Operation -ceq 'install') {
        if ($env:MIXIN_OPS_DIRECTORY -ceq 'saved' -or -not $env:MIXIN_OPS_APP_DRAFT -or -not $env:MIXIN_OPS_MODELS_DRAFT) { throw '首次部署缺少已确认的配置草稿或通讯录范围；服务尚未停止' }
        return
    }
    if ($env:MIXIN_OPS_APP_DRAFT -or $env:MIXIN_OPS_MODELS_DRAFT) { throw '只有首次部署使用网页配置草稿；服务尚未停止' }
    if ($env:MIXIN_OPS_REPLACE_SERVICE) { throw '只有首次部署可以移除本机已有的机器人服务；服务尚未停止' }
    foreach ($required in @('data/config/models.json','data/config/app-bot.json','data/runtime/pi/settings.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot $required) -PathType Leaf)) { throw '缺少已有配置，请先完成首次部署；服务尚未停止' }
    }
}

# 控制台部署任务在入口里的操作：首次部署（install）还是重新部署（deploy）。只看控制台导出的选择，终端部署不受影响。
function Get-ConsoleLifecycle {
    if ($env:MIXIN_OPS_CONSOLE -ceq '1' -and $env:MIXIN_OPS_LIFECYCLE -ceq 'install') { 'install' } else { 'deploy' }
}
